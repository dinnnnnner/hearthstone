import hashlib,json,math
from pathlib import Path
from tavern_rl.serve import Policy
for name,digest in json.loads(Path('hashes.json').read_text()).items():
 assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==digest
p=Policy('model.pt')
assert p.metadata==json.loads(Path('metadata.json').read_text())
data=json.loads((Path.home()/'.local/share/tavern-models/incoming-1c52af64/preflight.json').read_text())
memory=[0.]*128
for row in data['rows']:
 result=p.predict({'contract':data['contract'],'rows':[dict(entities=row['entities'],legal=row['legal'],previous=row['previous'],memory=memory)]})['rows'][0]
 assert result['action'] in row['legal']
 memory=result['memory'];assert len(memory)==128 and all(math.isfinite(v) for v in memory)
r={'depth':p.metadata['policyDepth'],'checkpointSha256':p.metadata['checkpointSha256'],'steps':len(data['rows']),'meanMs':p.elapsed/p.decisions,'ok':True}
Path('preflight.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r))
