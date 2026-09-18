import sys,json,math
from pathlib import Path
sys.path.insert(0,str(Path('rl/python').resolve()))
from tavern_rl.native_rules import NativeRules
r=NativeRules(); failures=[]
def same(a,b,path=''):
 if isinstance(a,(int,float)) and isinstance(b,(int,float)) and not isinstance(a,bool) and not isinstance(b,bool):
  return None if math.isclose(a,b,abs_tol=2e-15,rel_tol=2e-15) else (path,a,b)
 if type(a)!=type(b):return(path,a,b)
 if isinstance(a,dict):
  if set(a)!=set(b):return(path+'.keys',list(a),list(b))
  for k in a:
   e=same(a[k],b[k],path+'.'+k)
   if e:return e
 elif isinstance(a,list):
  if len(a)!=len(b):return(path+'.length',len(a),len(b))
  for i,(x,y)in enumerate(zip(a,b)):
   e=same(x,y,path+f'[{i}]')
   if e:return e
 elif a!=b:return(path,a,b)
for line in Path('native/target/parity/observation.jsonl').read_text().splitlines():
 c=json.loads(line)
 try: result=r.call(**c['request']);err=same(result,c['expected'])
 except Exception as e:err=str(e)
 if err:failures.append((c['name'],err))
print(json.dumps({'cases':542,'failures':len(failures),'first':failures[:12]},ensure_ascii=False));sys.exit(bool(failures))
