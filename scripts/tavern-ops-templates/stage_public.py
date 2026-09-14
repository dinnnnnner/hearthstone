import hashlib,json,shutil,subprocess
from pathlib import Path
base=Path('/opt/bobs-tavern');work=Path('/tmp/tavern-ops-__TAG__');old=(base/'current').resolve();new=base/'releases/__TAG__-models'
assert not new.exists()
shutil.copytree(old,new)
for name in ['inference-models.json','model-verification.json','activate_public.py']:shutil.copy2(work/name,new/name)
r=dict(previousRelease=str(old),backendSha256=hashlib.sha256((old/'server.cjs').read_bytes()).hexdigest())
assert hashlib.sha256((new/'server.cjs').read_bytes()).hexdigest()==r['backendSha256']
(new/'model-rollback.json').write_text(json.dumps(r,indent=2)+'\n')
subprocess.run(['chown','-R','root:bobs-tavern',str(new)],check=True)
print(json.dumps(r))
