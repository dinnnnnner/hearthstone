import datetime,fcntl,json,os,subprocess
from pathlib import Path
workers=16;games=16;active_members=[]
w=Path('/root/tavern-ops/__TAG__');root=Path('/root/tavern-four-hour-20260914/population');base=Path('/root/autodl-tmp/tavern-mixed-popular-20260914')
assert not (w/'resume.json').exists()
with (root/'.population.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 s=json.loads((root/'status.json').read_text());assert s['stage'] in ('time_limit','interrupted') and all(m['pid'] is None for m in s['members'])
 (w/'prior-status.json').write_text(json.dumps(s,indent=2)+'\n')
 started=datetime.datetime.now(datetime.timezone.utc);end=started+datetime.timedelta(hours=__HOURS__)
 s.update(stage='interrupted',deadline_utc=end.isoformat());temp=root/'status.json.next';temp.write_text(json.dumps(s,indent=2)+'\n');temp.replace(root/'status.json')
command=['/root/miniconda3/bin/python','-u','/root/tavern-human-current-06cd2177/population_resume.py','--resumes',*[str(root/f'member-{i}/training/latest.pt') for i in range(3)],'--output',str(root),'--deadline-utc',end.isoformat(),'--workers',str(workers),'--iterations-per-exchange','2','--games-per-iteration',str(games),'--max-per-lineage','2','--external-fraction','0.4','--unused-gold-penalty','0.01','--device','cuda',*active_members]
env=dict(os.environ,PYTHONPATH=str(base/'rl/python'),OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PATH='/root/autodl-tmp/runtime/node-v22.23.2-linux-x64/bin:'+os.environ.get('PATH',''))
with (w/'population.log').open('w') as log:p=subprocess.Popen(command,cwd=base,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
r=dict(pid=p.pid,startedUtc=started.isoformat(),deadlineUtc=end.isoformat(),hours=__HOURS__,command=command)
(w/'resume.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
