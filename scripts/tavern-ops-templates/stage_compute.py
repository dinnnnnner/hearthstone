import hashlib,json,os,shutil,subprocess
from pathlib import Path
base=Path.home()/'.local/share/tavern-models';incoming=base/'incoming-__TAG__'
reports=json.loads((incoming/'deployment.json').read_text());rollback={};results=[]
for m in reports:
 ident=m['id'];old=(base/ident/'current').resolve();new=base/ident/'releases/__TAG__'
 assert not new.exists()
 rollback[ident]=str(old);shutil.copytree(old,new)
 for name,digest in m['hashes'].items():
  src=incoming/'export'/m['source']/name;assert hashlib.sha256(src.read_bytes()).hexdigest()==digest;shutil.copy2(src,new/name)
 hashes=json.loads((new/'hashes.json').read_text()) if (new/'hashes.json').exists() else {}; hashes.update(m['hashes']);(new/'hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
 for file in (old/'python').rglob('*.py'):
  assert file.read_bytes()==(new/file.relative_to(old)).read_bytes()
 env=dict(os.environ,PATH=str(Path.home()/'.local/bin')+':'+os.environ['PATH'],PYTHONPATH=str(new/'python'),OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1')
 if m['search']:
  subprocess.run([str(base/'venv/bin/python'),'-m','tavern_rl.search_benchmark',str(new/'model.pt'),str(new/'fixtures.json'),
                  '--bundle',str(new/'recruit-search.cjs'),'--output',str(new/'preflight.json')],cwd=new,env=env,check=True)
 else:
  subprocess.run([str(base/'venv/bin/python'),str(incoming/'preflight.py')],cwd=new,env=env,check=True)
 results.append(json.loads((new/'preflight.json').read_text()))
(incoming/'rollback.json').write_text(json.dumps(rollback,indent=2)+'\n')
(incoming/'preflight-results.json').write_text(json.dumps(results,indent=2)+'\n')
