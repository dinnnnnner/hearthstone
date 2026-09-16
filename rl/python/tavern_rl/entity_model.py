from __future__ import annotations
import math
import torch
from torch import nn
from torch.distributions import Categorical
from torch.nn.utils.rnn import pack_padded_sequence
from .features import pack_entities


class StringEncoder(nn.Module):
    """Ordered UTF-8 bytes encode arbitrary effect keys/values without hash collisions."""
    def __init__(self, width=24):
        super().__init__()
        self.bytes = nn.Embedding(257, 12, padding_idx=0)
        self.gru = nn.GRU(12, width, batch_first=True)
        self.width = width
        self.cache = {}

    def train(self, mode=True):
        self.cache.clear()
        return super().train(mode)

    def forward(self, strings, device):
        cached = not self.training and not torch.is_grad_enabled()
        if cached and len(self.cache) > 20000: self.cache.clear()
        missing = [s for s in strings if not cached or s not in self.cache]
        values = {}
        if missing:
            encoded = [list(s.encode('utf8')) or [0] for s in missing]
            lengths = torch.tensor([len(s) for s in encoded], dtype=torch.long)
            if lengths.max() > 4096: raise ValueError('Unexpectedly long public symbol')
            # Build bytes on the CPU, then transfer once instead of launching a
            # device copy/add kernel for every previously unseen public string.
            data = torch.zeros(len(missing), int(lengths.max()), dtype=torch.long)
            for i, row in enumerate(encoded): data[i, :len(row)] = torch.tensor(row) + 1
            data = data.to(device)
            packed = pack_padded_sequence(self.bytes(data), lengths, batch_first=True, enforce_sorted=False)
            _, hidden = self.gru(packed)
            values = dict(zip(missing, hidden[0].unbind(0)))
            if cached:
                self.cache.update(values)
        return torch.stack([self.cache[s] if cached else values[s] for s in strings])


class EntityActorCritic(nn.Module):
    observation_kind = 'entities'
    recurrent = True

    def __init__(self, entity_schema, actions, hidden=128, heads=4, layers=2, architecture='entity-gru'):
        super().__init__()
        if hidden % heads: raise ValueError('hidden must be divisible by heads')
        self.schema, self.actions = entity_schema, actions
        # Schema definitions are immutable for this model. Cache parsing only,
        # never parameter-dependent embeddings or dynamic board observations.
        self._definition_groups = {}
        self.hidden, self.heads, self.layers = hidden, heads, layers
        self.action_size = len(actions)
        self.identity = nn.Embedding(len(entity_schema['ids']) + 1, hidden, padding_idx=0)
        self.zone = nn.Embedding(len(entity_schema['sizes']), hidden)
        self.position = nn.Embedding(max(entity_schema['sizes']), hidden)
        self.symbol = StringEncoder()
        self.field_type = nn.Embedding(5, 8)
        self.field = nn.Sequential(nn.Linear(24*2+4+8, hidden), nn.Tanh(), nn.Linear(hidden, hidden))
        self.group = nn.Sequential(nn.Linear(hidden+24+1, hidden), nn.Tanh())
        layer = nn.TransformerEncoderLayer(hidden, heads, hidden*2, dropout=0., activation='gelu', batch_first=True, norm_first=True)
        self.attention = nn.TransformerEncoder(layer, layers, enable_nested_tensor=False)
        self.input_norm = nn.LayerNorm(hidden)
        self.previous_action = nn.Embedding(self.action_size+1, hidden)
        self.memory = nn.GRUCell(hidden*2, hidden)
        self.critic = nn.Linear(hidden, 1)
        types = list(dict.fromkeys(a['type'] for a in actions))
        self.types = types
        # Conditional heads avoid giving every card/target/position combination an unrelated output weight.
        self.action_type = nn.Linear(hidden, len(types))
        self.type_embedding = nn.Embedding(len(types), hidden)
        self.source_query = nn.Linear(hidden, hidden)
        self.target_query = nn.Linear(hidden, hidden)
        self.position_query = nn.Linear(hidden, 8)
        self.source_index = nn.Embedding(16, hidden)
        self.target_index = nn.Embedding(41, hidden)
        sizes, offsets = entity_schema['sizes'], entity_schema['offsets']
        self.register_buffer('zone_ids', torch.tensor([i for i,n in enumerate(sizes) for _ in range(n)]))
        self.register_buffer('position_ids', torch.tensor([j for n in sizes for j in range(n)]))
        source_zone = {'buy':2,'buySpell':3,'sell':1,'move':1,'play':4,'cast':4,'activate':1,'power':8,'discover':5,'choosePower':9,'buyTrinket':10}
        sources, targets = [], []
        for a in actions:
            sources.append(offsets[source_zone[a['type']]] + a['source'] if a['type'] in source_zone else 0)
            target = a['target']
            if target == 0: targets.append(0)
            elif target <= 7: targets.append(offsets[1] + target - 1)
            elif target <= 23: targets.append(offsets[2] + target - 8)
            elif target <= 30: targets.append(offsets[3] + target - 24)
            else: targets.append(offsets[4] + target - 31)
        self.register_buffer('action_types', torch.tensor([types.index(a['type']) for a in actions]))
        self.register_buffer('action_sources', torch.tensor([a['source'] for a in actions]))
        self.register_buffer('action_targets', torch.tensor([a['target'] for a in actions]))
        self.register_buffer('action_positions', torch.tensor([a['position'] for a in actions]))
        self.register_buffer('source_slots', torch.tensor(sources))
        self.register_buffer('target_slots', torch.tensor(targets))
        # Prefix indices form the exact legal conditional tree for type -> source -> target -> position.
        prefixes = [list(dict.fromkeys(tuple(a[k] for k in keys) for a in actions)) for keys in [('type',),('type','source'),('type','source','target')]]
        for level, (keys, values) in enumerate(zip([('type',),('type','source'),('type','source','target')], prefixes)):
            lookup = {key:i for i,key in enumerate(values)}
            self.register_buffer(f'prefix_{level}', torch.tensor([lookup[tuple(a[k] for k in keys)] for a in actions]))
        self.prefix_counts = [len(p) for p in prefixes]
        for level in [1, 2]:
            mapping = getattr(self, f'prefix_{level}').tolist()
            self.register_buffer(f'representatives_{level}', torch.tensor([mapping.index(i) for i in range(self.prefix_counts[level])]))
        # The legal tree is static. Nonpersistent buffers preserve old checkpoint
        # keys and avoid eight CUDA scalar synchronizations per decision batch.
        self.register_buffer('root_ids', torch.zeros_like(self.prefix_0), persistent=False)
        self.register_buffer('leaf_ids', torch.arange(self.action_size), persistent=False)
        self.tree_sizes = []
        parents = [self.root_ids, self.prefix_0, self.prefix_1, self.prefix_2]
        options = [self.prefix_0, self.prefix_1, self.prefix_2, self.leaf_ids]
        for level, (parent, option) in enumerate(zip(parents, options)):
            n_options, n_parents = int(option.max()) + 1, int(parent.max()) + 1
            self.tree_sizes.append((n_options, n_parents))
            mapping = torch.zeros(n_options, dtype=torch.long).scatter(0, option, parent)
            self.register_buffer(f'option_parent_{level}', mapping, persistent=False)
        nn.init.orthogonal_(self.critic.weight, 1); nn.init.zeros_(self.critic.bias)
        nn.init.orthogonal_(self.action_type.weight, .01); nn.init.zeros_(self.action_type.bias)

    def specification(self):
        return dict(architecture='entity-gru', entity_schema=self.schema, actions=self.actions, hidden=self.hidden, heads=self.heads, layers=self.layers) | (
            dict(auxiliary_heads='combat-economy-v1') if hasattr(self,'auxiliary') else {}) | (
            dict(card_value_head='card-cash-v1') if hasattr(self,'card_value_head') else {}) | (
            dict(action_values=dict(self.action_value_settings)) if hasattr(self,'action_value_type') else {}) | (
            dict(scene_value_head='combat-benchmark-v1') if hasattr(self,'scene_current') else {}) | (
            dict(multi_horizon='multi-horizon-v1') if hasattr(self,'horizon_embedding') else {})

    def initial_memory(self, batch, device):
        return torch.zeros(batch, self.hidden, device=device)

    def encode(self, observations, device):
        pack = pack_entities(observations, self.schema, device, definition_cache=self._definition_groups)
        symbols = self.symbol(pack['strings'], device)
        groups = torch.zeros(len(pack['group_owners']), self.hidden, device=device)
        counts = torch.zeros(len(groups), 1, device=device)
        if len(pack['field_groups']):
            fields = self.field(torch.cat([symbols[pack['field_keys']], symbols[pack['field_values']], pack['field_numbers'], self.field_type(pack['field_types'])], -1))
            groups.index_add_(0, pack['field_groups'], fields)
            counts.index_add_(0, pack['field_groups'], torch.ones(len(fields), 1, device=device))
        groups = self.group(torch.cat([groups/counts.clamp_min(1), symbols[pack['group_paths']], counts.log1p()], -1))
        owners = torch.zeros(pack['owner_count'], self.hidden, device=device)
        owners.index_add_(0, pack['group_owners'], groups)
        static = torch.zeros(len(self.schema['ids'])+1, self.hidden, device=device)
        static[pack['static_ids']] = owners[pack['static_owners']]
        ids = pack['ids']; count = self.schema['count']
        x = self.identity(ids) + self.zone(self.zone_ids) + self.position(self.position_ids)
        x = self.input_norm(x + owners[:pack['batch']*count].reshape(pack['batch'],count,self.hidden) + static[ids])
        present = ids != 0; present[:,0] = True
        return self.attention(x, src_key_padding_mask=~present)

    def recurrent_step(self, encoded, memory, previous):
        return self.memory(torch.cat([encoded[:,0], self.previous_action(previous)], -1), memory)

    def head_features(self, memory, with_value=True):
        return memory, memory if with_value else None

    def _conditional_log_probs(self, scores, parent_ids, option_ids, legal, level):
        # Scores are identical for repeated leaves under an option. Reduce to each
        # unique option before normalizing so unused positions cannot bias choices.
        batch, count = scores.shape
        options, parents = self.tree_sizes[level]
        index = option_ids.expand(batch,-1)
        option_scores = torch.full((batch,options), -1e9, device=scores.device)
        option_scores = option_scores.scatter_reduce(1,index,scores.masked_fill(~legal,-1e9),reduce='amax',include_self=True)
        option_parent = getattr(self, f'option_parent_{level}')
        parent_index = option_parent.expand(batch,-1)
        maximum = torch.full((batch,parents),-1e9,device=scores.device).scatter_reduce(1,parent_index,option_scores,reduce='amax',include_self=True)
        weights = (option_scores-maximum.gather(1,parent_index)).exp() * (option_scores > -1e8)
        total = torch.zeros(batch,parents,device=scores.device).scatter_add(1,parent_index,weights)
        normalizer = maximum + total.clamp_min(1e-30).log()
        return option_scores.gather(1,index)-normalizer.gather(1,parent_ids.expand(batch,-1))

    def distribution_from(self, encoded, memory, masks, with_value=True, with_action_values=False):
        if not masks.any(-1).all(): raise ValueError('Every decision must have a legal action')
        policy, value = self.head_features(memory, with_value=with_value or with_action_values)
        type_logits=self.action_type(policy)
        if hasattr(self,'card_value_head'):
            from .card_value import predictions
            cash_values=predictions(self,encoded,memory).detach()
            choices=[]
            for kind in ('buy','sell','play'):
                indices=getattr(self,'card_value_'+kind)
                if not len(indices):choices.append(cash_values.new_zeros(len(memory)));continue
                legal=masks[:,indices];scores=cash_values[:,self.source_slots[indices]]
                if kind=='sell':scores=-scores
                best=scores.masked_fill(~legal,-1e9).max(1).values
                choices.append(torch.where(legal.any(1),best,torch.zeros_like(best)))
            type_logits=type_logits+self.card_value_type(torch.tanh(torch.stack(choices,1)/4))
        action_type = type_logits[:,self.action_types]
        contexts = policy[:,None] + self.type_embedding.weight[None]
        one, two = self.representatives_1, self.representatives_2
        source_features = encoded[:,self.source_slots[one]] + self.source_index(self.action_sources[one])
        if hasattr(self,'card_value_head'):
            # A bounded extra feature, with a zero-initialized learned projection.
            # PPO learns how to use prices; only calibrated labels train the price
            # head itself, so policy gradients do not redefine its gold units.
            cash=cash_values[:,self.source_slots[one]]
            source_features=source_features+self.card_value_projection(torch.tanh(cash/4)[...,None])*self.card_value_actions[one][None,:,None]
        source_unique = (self.source_query(contexts)[:,self.action_types[one]]*source_features).sum(-1)/math.sqrt(self.hidden)
        target_context = contexts[:,self.action_types[one]] + source_features
        target_features = encoded[:,self.target_slots[two]] + self.target_index(self.action_targets[two])
        target_unique = (self.target_query(target_context)[:,self.prefix_1[two]]*target_features).sum(-1)/math.sqrt(self.hidden)
        positions = self.position_query(target_context[:,self.prefix_1[two]] + target_features)
        source_score = source_unique[:,self.prefix_1]
        target_score = target_unique[:,self.prefix_2]
        position_score = positions[:,self.prefix_2].gather(2,self.action_positions[None,:,None].expand(len(memory),-1,1)).squeeze(-1)
        log_probs = self._conditional_log_probs(action_type,self.root_ids,self.prefix_0,masks,0)
        log_probs = log_probs + self._conditional_log_probs(source_score,self.prefix_0,self.prefix_1,masks,1)
        log_probs = log_probs + self._conditional_log_probs(target_score,self.prefix_1,self.prefix_2,masks,2)
        log_probs = log_probs + self._conditional_log_probs(position_score,self.prefix_2,self.leaf_ids,masks,3)
        value=self.critic(value).squeeze(-1) if value is not None else None
        if hasattr(self,'action_value_type'):
            from .action_value import from_advantage
            temperature=self.action_value_settings['temperature']
            residual_type=self.action_value_type(policy)[:,self.action_types]
            residual_source=(self.action_value_source(contexts)[:,self.action_types[one]]*source_features).sum(-1)/math.sqrt(self.hidden)
            advantage=temperature*log_probs+residual_type+residual_source[:,self.prefix_1]
            if hasattr(self,'scene_current'):
                from .scene_value import adjustment
                advantage=advantage+adjustment(self,encoded,memory)
            dist,q=from_advantage(advantage,value,masks,temperature)
            return (dist,value,q) if with_action_values else (dist,value)
        if with_action_values:raise ValueError('Model does not have action-value heads')
        return Categorical(logits=log_probs.masked_fill(~masks,-1e9)), value

    def act(self, observations, masks, memory, previous, with_value=True):
        encoded = self.encode(observations, masks.device)
        memory = self.recurrent_step(encoded,memory,previous)
        dist,value = self.distribution_from(encoded,memory,masks,with_value=with_value)
        return dist,value,memory
