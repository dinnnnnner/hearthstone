import datetime,fcntl,json,os,subprocess
from pathlib import Path
workers=16;games=16;active_members=[]
performance_args=[]
use_mps=False
w=Path('/root/tavern-ops/__TAG__');root=Path('/root/tavern-four-hour-20260914/population');base=Path('/root/autodl-tmp/tavern-mixed-popular-20260914')
assert not (w/'resume.json').exists()
with (root/'.population.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 s=json.loads((root/'status.json').read_text());assert s['stage'] in ('time_limit','interrupted') and all(m['pid'] is None for m in s['members'])
 (w/'prior-status.json').write_text(json.dumps(s,indent=2)+'\n')
 started=datetime.datetime.now(datetime.timezone.utc);end=started+datetime.timedelta(hours=__HOURS__)
 s.update(stage='interrupted',deadline_utc=end.isoformat());temp=root/'status.json.next';temp.write_text(json.dumps(s,indent=2)+'\n');temp.replace(root/'status.json')
command=['/root/miniconda3/bin/python','-u','/root/tavern-human-current-06cd2177/population_resume.py','--resumes',*[str(root/f'member-{i}/training/latest.pt') for i in range(3)],'--output',str(root),'--deadline-utc',end.isoformat(),'--workers',str(workers),'--iterations-per-exchange','2','--games-per-iteration',str(games),'--max-per-lineage','2','--external-fraction','0.4','--device','cuda',*active_members,*performance_args]
env=dict(os.environ,PYTHONPATH=str(base/'rl/python'),OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1',PATH='/root/autodl-tmp/runtime/node-v22.23.2-linux-x64/bin:'+os.environ.get('PATH',''))
if use_mps:
 env.update(CUDA_MPS_PIPE_DIRECTORY='/tmp/tavern-training-mps',CUDA_MPS_LOG_DIRECTORY='/root/tavern-mps-logs')
 for key in ['CUDA_MPS_PIPE_DIRECTORY','CUDA_MPS_LOG_DIRECTORY']:Path(env[key]).mkdir(parents=True,exist_ok=True)
 check=subprocess.run(['nvidia-cuda-mps-control'],input='get_server_list\n',text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
 if check.returncode:subprocess.run(['nvidia-cuda-mps-control','-d'],env=env,check=True)
with (w/'population.log').open('w') as log:p=subprocess.Popen(command,cwd=base,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
r=dict(pid=p.pid,startedUtc=started.isoformat(),deadlineUtc=end.isoformat(),hours=__HOURS__,command=command,mps=use_mps)
(w/'resume.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
