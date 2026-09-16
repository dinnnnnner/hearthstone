"""Small, explicit milestone rewards on completed combat prefixes, plus final rank."""
import math
import os
import numpy as np
from .bridge import ROOT, Simulator


def configure(config):
    enabled=os.environ.get('TAVERN_STAGE_FEEDBACK')
    if enabled not in (None,'0','1'):raise ValueError('TAVERN_STAGE_FEEDBACK must be 0 or 1')
    if enabled=='0':config.pop('stage_feedback',None)
    elif enabled=='1':config.setdefault('stage_feedback',dict(turns=[4,7,10],weight=.1,battle_trials=4))
    if config.get('stage_feedback'):
        validate(config['stage_feedback']);config['reward_mode']='placement_and_stages'


def validate(config):
    turns=config['turns'];weight=config['weight'];trials=config['battle_trials']
    if not turns or turns!=sorted(set(turns)) or any(type(t) is not int or not 1<=t<=30 for t in turns):raise ValueError('Invalid stage turns')
    if not math.isfinite(weight) or not 0<weight<=.25 or weight*len(turns)>.5:raise ValueError('Invalid stage reward weight')
    if type(trials) is not int or not 1<=trials<=12:raise ValueError('Invalid stage battle trials')


class StageEvaluator:
    def __init__(self,config):
        validate(config);self.config=config;self.simulator=Simulator(ROOT/'rl-dist/stage-evaluation.cjs')
        if self.simulator.meta!={'version':'stage-evaluation-v1'}:
            self.close();raise ValueError('Stage evaluator version differs')
    def close(self):self.simulator.close()
    def assess(self,game,simulator,before,after):
        turn=before['info']['turn']
        if turn not in self.config['turns'] or turn in game['stages_seen'] or after.get('truncated'):return None
        if after['info']['turn']==turn and not after['terminated']:return None
        report=self.simulator.call('evaluate',snapshot=simulator.call('snapshot'),completedTurn=turn,trials=self.config['battle_trials'])
        game['stages_seen'].add(turn);report['seed']=game['seed'];report['weight']=self.config['weight']
        for row in report['seats']:
            seat=row['seat'];records=game['tracks'][seat]
            if game['controllers'][seat]!=-1 or not records:continue
            bonus=self.config['weight']*row['score'];index=len(records)-1
            game['stage_rewards'][seat][index]=game['stage_rewards'][seat].get(index,0.)+bonus
            game['stage_totals'][seat]+=bonus
        return report


def trajectory_rewards(records, terminal, stage_rewards):
    rewards=np.zeros(len(records),dtype=np.float32)
    for index,value in stage_rewards.items():
        if not 0<=index<len(records) or not math.isfinite(value):raise ValueError('Invalid stage reward event')
        rewards[index]+=value
    rewards[-1]+=terminal
    return rewards


def discounted_returns(reward, count, gamma):
    events=np.asarray(reward,dtype=np.float32)
    if events.ndim==0:
        events=np.zeros(count,dtype=np.float32);events[-1]=float(reward)
    if events.shape!=(count,) or not np.isfinite(events).all():raise ValueError('Invalid trajectory rewards')
    result=np.empty(count,dtype=np.float32);future=0.
    for i in reversed(range(count)):
        future=float(events[i])+gamma*future;result[i]=future
    return result
