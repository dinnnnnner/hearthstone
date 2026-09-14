import json,os,hashlib,subprocess,time,urllib.request
from pathlib import Path
base=Path('/opt/bobs-tavern');new=base/'releases/__TAG__-models'
r=json.loads((new/'model-rollback.json').read_text())
assert str((base/'current').resolve())==r['previousRelease']
assert hashlib.sha256((new/'server.cjs').read_bytes()).hexdigest()==r['backendSha256']
models=json.loads((new/'inference-models.json').read_text())
for model in models:
 with urllib.request.urlopen(model['url']+'/health',timeout=5) as response:m=json.load(response)
 assert m['ok'] and m['checkpointSha256']==model['checkpointSha256']
nextlink=base/'current.__TAG__';nextlink.symlink_to(new);os.replace(nextlink,base/'current')
subprocess.run(['systemctl','start','bobs-tavern'],check=True)
for attempt in range(30):
 try:
  with urllib.request.urlopen('http://127.0.0.1:8787/models',timeout=3) as response:options=json.load(response)['models']
  assert [m['checkpointSha256'] for m in options]==[m['checkpointSha256'] for m in models] and all(m['available'] for m in options)
  print(json.dumps({'ok':True,'models':options}));break
 except Exception:
  if attempt==29:raise
  time.sleep(1)
