import json,shlex,subprocess,sys,time
from pathlib import Path
w=Path('/tmp/tavern-ops-__TAG__');public='root@100.121.69.44';compute='zich@100.97.24.15'
def ssh(host,command):
 r=subprocess.run(['ssh','-o','BatchMode=yes',host,command],text=True,capture_output=True)
 if r.returncode:raise RuntimeError(f'{host}: {r.stderr}\n{r.stdout}')
 return r.stdout
while True:
 h=json.loads(ssh(public,'curl -fsS http://127.0.0.1:8787/tavern-api/health'))
 if h['rooms']==0:break
 assert '--wait-for-idle' in sys.argv,'Active rooms: deployment deferred'
 time.sleep(30)
ssh(public,'systemctl stop bobs-tavern')
try:
 ssh(public,'cp -a /var/lib/bobs-tavern/state.json /opt/bobs-tavern/releases/__TAG__-models/state-before-models.json')
 a=json.loads(ssh(compute,'python3 ~/.local/share/tavern-models/incoming-__TAG__/activate_compute.py'))
 b=json.loads(ssh(public,'python3 /opt/bobs-tavern/releases/__TAG__-models/activate_public.py'))
 (w/'activation.json').write_text(json.dumps(dict(compute=a,public=b),indent=2)+'\n')
 print(json.dumps(dict(ok=True,models=[dict(id=m['id'],episodes=m['episodes'],available=m['available']) for m in b['models']])))
except BaseException:
 rollback="""import json,os,subprocess
from pathlib import Path
base=Path.home()/'.local/share/tavern-models'
r=json.loads((base/'incoming-__TAG__/rollback.json').read_text());units=[m['unit'] for m in json.loads((base/'incoming-__TAG__/deployment.json').read_text())]
subprocess.run(['systemctl','--user','stop',*units],check=True)
for i,p in r.items():
 n=base/i/'rollback.next';n.symlink_to(p);os.replace(n,base/i/'current')
subprocess.run(['systemctl','--user','start',*units],check=True)
"""
 try:ssh(compute,'python3 -c '+shlex.quote(rollback))
 finally:
  previous=json.loads((w/'public-rollback.json').read_text())['previousRelease']
  ssh(public,'ln -sfn '+shlex.quote(previous)+' /opt/bobs-tavern/current.rollback && mv -Tf /opt/bobs-tavern/current.rollback /opt/bobs-tavern/current && systemctl start bobs-tavern')
 raise
