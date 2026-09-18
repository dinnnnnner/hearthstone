"""Round-boundary rollout chunks, real auxiliary outcomes and recurrent reburn."""
from copy import deepcopy
import math
import os
import numpy as np
import torch
from torch import nn
from .features import prepare_entities
from .placement_rewards import reward_with_first_place_bonus


TIER_TEMPO = dict(turn=8, tier4=.05, tier5=.025)


def tier_tempo_reward(player, turn, settings):
    """One milestone after actual combat, shared by real and branch returns."""
    if not settings or turn != settings['turn']:return 0.
    game=player['game']
    if game['health']<=0 or player.get('left') or not any(b['turn']==turn for b in game.get('battles',[])):return 0.
    return (settings['tier4'] if game['tier']>=4 else 0.)+(settings['tier5'] if game['tier']>=5 else 0.)


def enable_auxiliary(model,version='combat-economy-v1'):
    if version!='combat-economy-v1' or not getattr(model,'recurrent',False):raise ValueError('Unsupported auxiliary model')
    if hasattr(model,'auxiliary'):return
    # Append parameters after both deep towers, for identical migration/reload order.
    with torch.random.fork_rng(devices=[]):
        head=nn.Linear(model.hidden,10)
        nn.init.zeros_(head.weight);nn.init.zeros_(head.bias)
    model.auxiliary=head.to(next(model.parameters()).device)


def configure(config,args,model,saved):
    enabled=getattr(args,'streaming',None)
    if enabled is None and 'TAVERN_STREAMING' in os.environ:
        raw=os.environ['TAVERN_STREAMING']
        if raw not in ('0','1'):raise ValueError('Invalid TAVERN_STREAMING')
        enabled=raw=='1'
    if enabled is False:config.pop('streaming',None)
    if enabled is True or config.get('streaming'):
        previously_streaming=bool(config.get('streaming'))
        options=dict(config.get('streaming',dict(turns=2,auxiliary_coef=.1)))
        turns=getattr(args,'stream_turns',None)
        if turns is not None:options['turns']=turns
        if type(options['turns']) is not int or not 1<=options['turns']<=8:raise ValueError('Invalid stream turns')
        if not math.isfinite(options['auxiliary_coef']) or not 0<options['auxiliary_coef']<=1:raise ValueError('Invalid auxiliary coefficient')
        tempo=getattr(args,'tier_tempo',None)
        if tempo is None and 'TAVERN_TIER_TEMPO' in os.environ:
            raw=os.environ['TAVERN_TIER_TEMPO']
            if raw not in ('0','1'):raise ValueError('Invalid TAVERN_TIER_TEMPO')
            tempo=raw=='1'
        if tempo is True:options['tier_tempo']=dict(TIER_TEMPO)
        if tempo is False:options.pop('tier_tempo',None)
        if 'tier_tempo' in options and options['tier_tempo']!=TIER_TEMPO:raise ValueError('Unsupported tier tempo settings')
        config['streaming']=options
        config.pop('gold_planning',None);config.pop('stage_feedback',None)
        if not config.get('counterfactual'):
            from .counterfactual import configure as configure_branches
            from copy import copy
            branch_args=copy(args);branch_args.counterfactual=True
            configure_branches(config,branch_args)
        if not previously_streaming and getattr(args,'branch_terminal_fraction',None) is None:
            # The live games already run to real placements. Keep auxiliary
            # comparisons short so they do not delay the next mid-game update.
            config['counterfactual']['terminal_fraction']=0.
        if config.get('gamma',1.)!=1.:raise ValueError('Streaming comparison currently requires gamma=1')
        enable_auxiliary(model)
        if saved:
            # History predating the new heads retains its original architecture.
            for entry in saved['league']:entry.setdefault('model_spec',saved['model_spec'])


def migrate_optimizer(saved,model):
    if saved is None:return None
    count=sum(len(g['params']) for g in saved['param_groups']);current=len(list(model.parameters()))
    if count==current:return saved
    auxiliary=len(list(model.auxiliary.parameters())) if hasattr(model,'auxiliary') else 0
    cards=sum(len(list(getattr(model,name).parameters())) for name in ('card_value_head','card_value_projection','card_value_type')) if hasattr(model,'card_value_head') else 0
    action_values=sum(len(list(getattr(model,name).parameters())) for name in ('action_value_type','action_value_source')) if hasattr(model,'action_value_type') else 0
    from .scene_value import MODULES
    scene=sum(len(list(getattr(model,name).parameters())) for name in MODULES) if hasattr(model,'scene_current') else 0
    from .multi_horizon import MODULES as HORIZON_MODULES
    horizons=sum(len(list(getattr(model,name).parameters())) for name in HORIZON_MODULES) if hasattr(model,'horizon_embedding') else 0
    allowed={current-auxiliary-cards-action_values-scene-horizons,current-cards-action_values-scene-horizons,current-action_values-scene-horizons,current-scene-horizons,current-horizons}
    if count not in allowed or count>=current or len(saved['param_groups'])!=1:
        raise ValueError('Optimizer migration only supports appending auxiliary heads')
    result=dict(saved);group=dict(saved['param_groups'][0]);ids=list(group['params'])
    group['params']=ids+list(range(max(ids)+1,max(ids)+1+current-count));result['param_groups']=[group]
    return result


def outcome(game,snapshot,turn):
    """Targets observed at a real combat boundary; no invented mid-game ranks."""
    tempo=game.get('tier_tempo')
    check_tempo=bool(tempo and turn==tempo['turn'] and not game.get('tempo_checked'))
    if check_tempo:game['tempo_checked']=True
    for seat,p in enumerate(snapshot['room']['seats']):
        if check_tempo:
            reward=tier_tempo_reward(p,turn,tempo)
            game['tempo_audit'].append(dict(seat=seat,turn=turn,tier=p['game']['tier'],health=p['game']['health'],reward=reward))
            if reward and game['controllers'][seat]==-1 and game['tracks'][seat]:
                game['tempo_rewards'][seat][len(game['tracks'][seat])-1]=reward
        s=p['game'];battle=next((b for b in s.get('battles',[]) if b['turn']==turn),None)
        if battle is None:continue
        extra=max(0.,float(s['gold'])-min(10,s['turn']+2)) if s['turn']>turn else 0.
        st=s['season']
        # Inventory and discounts are separate observed targets, never cash
        # equivalents or rewards for hoarding. Card identity/abilities remain in
        # the entity encoder; long-term value compares their actual opportunity cost.
        resources=[extra,len(s['hand']),len(s['board']),max(0,st.get('freeRefresh',0)),
                   max(0,st.get('spellDiscount',0)),max(0,st.get('nextGold',0))]
        game['outcomes'][seat][turn]=dict(combat={'win':0,'loss':1,'tie':2}[battle['result']],
            damage=float(battle['damage'])/40 if battle['result']=='loss' else 0.,
            resources=[math.log1p(v) for v in resources])


def reburn(model,games,device):
    """Recompute learner memory from its full public history under updated weights."""
    rows=[(g,s) for g in games for s in range(8) if g['controllers'][s]==-1 and g['history'][s]]
    if not rows:return
    histories=[g['history'][seat] for g,seat in rows]
    host=model.reburn(histories) if getattr(model,'remote',False) else reburn_histories(model,histories,device)
    for i,(g,seat) in enumerate(rows):g['memory'][seat]=host[i].copy()


def reburn_histories(model,histories,device):
    model.eval()
    with torch.inference_mode():
        memory=torch.zeros(len(histories),model.hidden,device=device)
        for start in range(0,max(map(len,histories),default=0),16):
            observations=[history[t][0] if t<len(history) else None for history in histories for t in range(start,start+16)]
            encoded=model.encode(observations,device).reshape(len(histories),16,model.schema['count'],model.hidden)
            for i,t in enumerate(range(start,start+16)):
                live=torch.tensor([t<len(history) for history in histories],device=device)
                previous=torch.tensor([history[t][6] if t<len(history) else model.action_size for history in histories],device=device)
                updated=model.recurrent_step(encoded[:,i],memory,previous)
                memory=torch.where(live[:,None],updated,memory)
        return memory.cpu().numpy()


def flush(game,simulator,snapshot,model,device,bonus):
    tracks=[];seats=[];views=[];bootstrap={}
    for seat,records in enumerate(game['tracks']):
        if game['controllers'][seat]!=-1 or not records:continue
        if snapshot['room']['seats'][seat].get('place') is None:
            own=deepcopy(snapshot);own['actor']=seat
            view=simulator.call('restore',snapshot=own)
            if view['terminated'] or view['truncated'] or not view['legalActions']:raise ValueError('Invalid streaming bootstrap state')
            seats.append(seat);views.append(view)
    if seats:
        masks=torch.zeros(len(seats),model.action_size,dtype=torch.bool,device=device)
        for i,v in enumerate(views):masks[i,v['legalActions']]=True
        with torch.inference_mode():
            _,values,_=model.act([prepare_entities(v['entities']) for v in views],masks,
                torch.tensor(np.asarray([game['memory'][s] for s in seats]),dtype=torch.float32,device=device),
                torch.tensor([game['previous'][s] for s in seats],device=device))
        bootstrap=dict(zip(seats,values.cpu().tolist()))
    simulator.call('restore',snapshot=snapshot)
    for seat,records in enumerate(game['tracks']):
        if game['controllers'][seat]!=-1 or not records:continue
        place=snapshot['room']['seats'][seat].get('place')
        rewards=np.zeros(len(records),dtype=np.float32)
        for index,reward in game.get('tempo_rewards',[{} for _ in range(8)])[seat].items():rewards[index]+=reward
        if place is not None:rewards[-1]+=reward_with_first_place_bonus((4.5-place)/3.5,place,bonus)
        aux=[game['outcomes'][seat].get(t) for t in game['record_turns'][seat]]
        value=bootstrap.get(seat,0.)
        if not math.isfinite(value):raise ValueError('Non-finite streaming bootstrap')
        tracks.append((records,dict(rewards=rewards,bootstrap=value,terminal=place is not None,auxiliary=aux)))
        game['history'][seat].extend(records)
    game['tracks']=[[] for _ in range(8)];game['record_turns']=[[] for _ in range(8)]
    game['tempo_rewards']=[{} for _ in range(8)]
    return tracks
