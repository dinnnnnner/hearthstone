import json,os,subprocess,time,urllib.request
from pathlib import Path
base=Path.home()/'.local/share/tavern-models';incoming=base/'incoming-__TAG__'
rollback=json.loads((incoming/'rollback.json').read_text());ids=list(rollback)
def ctl(*args):subprocess.run(['systemctl','--user',*args],check=True)
def point(ident,target):
 link=base/ident/'current.next';link.symlink_to(target);os.replace(link,base/ident/'current')
for ident,old in rollback.items():assert str((base/ident/'current').resolve())==old
ctl('stop',*[f'tavern-model@{ident}' for ident in ids])
try:
 for ident in ids:point(ident,base/ident/'releases/__TAG__')
 ctl('start',*[f'tavern-model@{ident}' for ident in ids])
 for ident,port in zip(ids,[18890,18892,18894]):
  expected=json.loads((base/ident/'current/metadata.json').read_text())
  for attempt in range(30):
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=2) as r:m=json.load(r)
    assert m['ok'] and m['checkpointSha256']==expected['checkpointSha256'];break
   except Exception:
    if attempt==29:raise
    time.sleep(1)
 print(json.dumps({'ok':True,'models':ids}))
except Exception:
 ctl('stop',*[f'tavern-model@{ident}' for ident in ids])
 for ident,target in rollback.items():point(ident,target)
 ctl('start',*[f'tavern-model@{ident}' for ident in ids]);raise
