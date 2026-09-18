"""Rule labels plus actual completed combat/income outcomes; never shaped rank rewards."""
import math
import hashlib
from pathlib import Path
import torch
from torch.nn import functional as F
from .bridge import ROOT, Simulator
from .ledger_model import VERSION, ECONOMY

COEFFICIENTS = dict(card=.1, economy=.05, combat=.1, future=.05)


class LedgerTargets:
    def __init__(self, meta):
        self.simulator = Simulator(ROOT/'rl-dist/ledger-evaluation.cjs')
        try:
            self.meta = self.simulator.meta
            if self.meta['version'] != 'minion-ledger-targets-v1' or self.meta['entitySchema'] != meta['entitySchema'] or tuple(self.meta['economy']) != ECONOMY:
                raise ValueError('Ledger target schema differs from simulator')
        except BaseException:
            self.close(); raise

    def score(self, rows):
        result = []
        for start in range(0,len(rows),256):
            result.extend(self.simulator.call('evaluate', rows=rows[start:start+256]))
        if len(result) != len(rows): raise ValueError('Ledger target count differs')
        return result

    def close(self): self.simulator.close()


def configure(config, args, model, meta):
    from .basic_feedback import CONFLICTS
    for name in (*CONFLICTS, 'basic_feedback'):
        if config.get(name) or getattr(args,name,None) is True:
            raise ValueError(f'Ledger training uses placement PPO with supervised heads; incompatible with {name}')
    with_targets = LedgerTargets(meta)
    try:
        network_hash = hashlib.sha256()
        for name in ('ledger_model.py','ledger_training.py','recurrent.py'):
            network_hash.update(name.encode())
            network_hash.update(Path(__file__).with_name(name).read_bytes())
        settings = dict(version=VERSION, coefficients=COEFFICIENTS.copy(), implementation_hash=with_targets.meta['implementationHash'],
                        network_hash=network_hash.hexdigest())
        if config.get('ledger') and config['ledger'] != settings:
            raise ValueError('Ledger target implementation/settings changed; start a new experiment')
        config['ledger'] = settings
        config['reward_mode'] = 'placement_only'
    finally: with_targets.close()


def attach_outcomes(game, snapshot, turn):
    """Snapshot is label-only. Only a real end decision gets a combat label.

    This prevents crediting a board at the start of recruitment with the battle
    strength of cards that the policy bought later in that round.
    """
    for seat, player in enumerate(snapshot['room']['seats']):
        if game['controllers'][seat] != -1: continue
        state = player['game']
        battle = next((b for b in state.get('battles',[]) if b['turn'] == turn), None)
        for row in game['ledger_targets'][seat]:
            if row['turn'] != turn: continue
            if battle and row['end']:
                row['combat'] = {'win':0, 'loss':1, 'tie':2}[battle['result']]
            if state['turn'] == turn+1 and state['health'] > 0:
                row['future'] = [state['gold'], state['tier'], state['season'].get('nextGold',0)]


def supervision_loss(model, encoded, memory, labels, settings):
    rows = [i for i,label in enumerate(labels) if label is not None]
    if not rows: raise ValueError('Ledger PPO batch lacks supervised targets')
    predicted = model.ledger_from(encoded[rows], memory[rows])
    selected = [labels[i] for i in rows]
    device = memory.device
    def tensor(data, dtype=torch.float32): return torch.tensor(data,dtype=dtype,device=device)
    card_mask = tensor([[v is not None for v in row['cards']] for row in selected],torch.bool)
    if not torch.equal(card_mask,predicted['present']): raise ValueError('Ledger label/entity masks differ')
    card_targets = tensor([[math.log1p(v) if v is not None else 0. for v in row['cards']] for row in selected])
    card_loss = F.smooth_l1_loss(predicted['body_log'][card_mask],card_targets[card_mask]) if card_mask.any() else predicted['body_log'].sum()*0
    economy_loss = F.smooth_l1_loss(predicted['economy_log'],tensor([[math.log1p(v) for v in row['economy']] for row in selected]))
    combats = [i for i,row in enumerate(selected) if row.get('combat') is not None]
    combat_loss = F.cross_entropy(predicted['combat_logits'][combats],tensor([selected[i]['combat'] for i in combats],torch.long)) if combats else predicted['combat_logits'].sum()*0
    futures = [i for i,row in enumerate(selected) if row.get('future') is not None]
    future_loss = F.smooth_l1_loss(predicted['future_log'][futures],tensor([[math.log1p(v) for v in selected[i]['future']] for i in futures])) if futures else predicted['future_log'].sum()*0
    losses = dict(card=card_loss,economy=economy_loss,combat=combat_loss,future=future_loss)
    return sum(settings['coefficients'][name]*loss for name,loss in losses.items()), {
        **{name+'_loss':float(loss.detach()) for name,loss in losses.items()},
        'card_labels':int(card_mask.sum()),'combat_labels':len(combats),'future_labels':len(futures)}
