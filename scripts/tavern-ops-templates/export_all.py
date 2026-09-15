import contextlib,fcntl,gc,hashlib,json,runpy,sys
from pathlib import Path
root=Path('/root/tavern-four-hour-20260914/population')
work=Path('/root/tavern-ops/__TAG__')
status=json.loads((root/'status.json').read_text())
assert status['stage'] in ('time_limit','interrupted') and all(m['pid'] is None for m in status['members'])
ids=['deep64-1480','deep256-1164','deep1024-612'];reports=[]
with contextlib.ExitStack() as stack:
 for path in [root/'.maintenance.lock',root/'.population.lock',*[root/f'member-{i}/training/.train.lock' for i in range(3)]]:
  f=stack.enter_context(path.open('a'));fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
 status=json.loads((root/'status.json').read_text())
 assert status['stage'] in ('time_limit','interrupted') and all(m['pid'] is None for m in status['members'])
 for i,ident in enumerate(ids):
  source=root/f'member-{i}/training/latest.pt';out=work/'export'/ident;out.mkdir(parents=True,exist_ok=True)
  sys.argv=['export-inference.py',str(source),'/root/tavern-repeat-live-20260914/export/schema.json',str(out/'model.pt')]
  with (out/'export.log').open('w') as log,contextlib.redirect_stdout(log): data=runpy.run_path(str(work/'export-inference.py'),run_name='__main__')
  metadata=data['metadata'];saved=data['saved']
  assert saved['config']['first_place_bonus']==1.0
  assert metadata['unusedGoldPenalty']==saved['config'].get('unused_gold_penalty',0.)
  assert metadata['adaptedDefinitions']==0
  (out/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
  hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [out/'model.pt',out/'metadata.json']}
  (out/'hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
  r=dict(id=ident,episodes=metadata['episodes'],iteration=metadata['iteration'],checkpointSha256=metadata['checkpointSha256'],firstPlaceBonus=saved['config']['first_place_bonus'],unusedGoldPenalty=metadata['unusedGoldPenalty'],imitationUpdates=metadata.get('imitationUpdates',0),demonstrationGames=metadata.get('demonstrationGames',0),hashes=hashes)
  reports.append(r);print(json.dumps(r),flush=True)
  del data,saved;gc.collect()
(work/'report.json').write_text(json.dumps(dict(status=status,models=reports),indent=2)+'\n')
