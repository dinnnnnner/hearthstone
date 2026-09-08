"""Activate an uploaded standalone server bundle on this project's target host."""
import json,os,pwd,shutil,subprocess,sys,time
from pathlib import Path
release=Path(sys.argv[1]).resolve()
base=Path('/opt/bobs-tavern')
assert release.parent==base/'releases' and (release/'server.cjs').is_file()
current=base/'current'
previous=os.readlink(current) if current.is_symlink() else None
unit=Path('/etc/systemd/system/bobs-tavern.service')
if unit.exists() and '/opt/bobs-tavern/current/server.cjs' not in unit.read_text():raise SystemExit('Existing service is not managed by this project')
if unit.exists():shutil.copy2(unit,release/'previous.service')
try:pwd.getpwnam('bobs-tavern')
except KeyError:subprocess.run(['useradd','--system','--no-create-home','--shell','/usr/sbin/nologin','bobs-tavern'],check=True)
def cmd(*args):return subprocess.run(args,check=True,capture_output=True,text=True).stdout.strip()
def link(target):
 staged=base/'current.next'
 if staged.is_symlink():staged.unlink()
 staged.symlink_to(target);os.replace(staged,current)
(release/'rollback.json').write_text(json.dumps({'previous':previous}))
try:
 shutil.copy2(release/'bobs-tavern.service',unit)
 link(release)
 cmd('systemctl','daemon-reload')
 cmd('systemctl','enable','bobs-tavern')
 cmd('systemctl','restart','bobs-tavern')
 for attempt in range(20):
  try:
   info=json.loads(cmd('curl','--noproxy','*','-fsS','--max-time','2','http://127.0.0.1:8787/tavern-api/health'))
   assert info['service']=='tavern';break
  except Exception:
   if attempt==19:raise
   time.sleep(.25)
 print('Room service activated: '+str(release))
 print(cmd('systemctl','show','bobs-tavern','-p','MainPID','-p','MemoryCurrent'))
except BaseException:
 if previous:
  link(previous)
  if (release/'previous.service').exists():shutil.copy2(release/'previous.service',unit)
  subprocess.run(['systemctl','daemon-reload'],check=True)
  subprocess.run(['systemctl','restart','bobs-tavern'],check=True)
 else:subprocess.run(['systemctl','stop','bobs-tavern'],check=False)
 raise
