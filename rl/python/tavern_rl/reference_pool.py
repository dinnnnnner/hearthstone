"""Bounded, source-bound recruitment-start references from real self-play only."""
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
from .counterfactual import digest


class ReferencePool:
    def __init__(self,path,source_hash,capacity=24):
        if capacity<3:raise ValueError('Reference capacity too small')
        self.root=Path(path)/source_hash;self.root.mkdir(parents=True,exist_ok=True)
        self.source_hash=source_hash;self.capacity=capacity
    def offer(self,snapshot):
        if snapshot['sourceHash']!=self.source_hash:raise ValueError('Reference game rules mismatch')
        turn=snapshot['room']['turn']
        if snapshot.get('truncated') or snapshot['room']['stage']!='recruit':return 0
        # Only initial recruitment states, never after one of the policies has
        # begun buying. This matches the future branch's first own decision.
        if any(snapshot['actionsInTurn']):return 0
        path=self.root/f'turn-{turn:03d}.json';added=0
        with (self.root/f'turn-{turn:03d}.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            rows=json.loads(path.read_text()) if path.exists() else []
            prior={r['key'] for r in rows}
            for seat,player in enumerate(snapshot['room']['seats']):
                if player.get('left') or player['game']['health']<=0:continue
                key=f"{snapshot['seed']}:{seat}:{turn}"
                game=deepcopy(player['game']);game['pool']={}
                # Keep game mechanics state; discard replay frames only.
                if game.get('battle'):game['battle']['frames']=[]
                row=dict(key=key,seed=snapshot['seed'],seat=seat,turn=turn,phase='recruit_start',
                    priority=digest(self.source_hash,'reference',key),game=game)
                # A repeated seed may have a newer policy. Replace its entry.
                rows=[r for r in rows if r['key']!=key];rows.append(row)
            rows.sort(key=lambda r:(r['priority'],r['key']));rows=rows[:self.capacity]
            added=len({r['key'] for r in rows}-prior)
            temporary=path.with_suffix(f'.{os.getpid()}.next');temporary.write_text(json.dumps(rows,separators=(',',':')));temporary.replace(path)
        return added
    def panel(self,turn,root_seed,priority,count):
        path=self.root/f'turn-{turn:03d}.json'
        rows=json.loads(path.read_text()) if path.exists() else []
        rows=[r for r in rows if r['seed']!=root_seed and r['turn']==turn and r['phase']=='recruit_start']
        rows.sort(key=lambda r:digest(priority,'reference-panel',turn,r['key']))
        return deepcopy(rows[:count]) if len(rows)>=count else []
