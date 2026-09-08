"""Run on the server with the release path whose activation should be undone."""
import json, os, shutil, subprocess, sys
from pathlib import Path
release=Path(sys.argv[1]).resolve()
if release.parent != Path('/var/www/playroom/releases'):
 raise SystemExit('Unexpected release directory')
backup=release/'rollback'
state=json.loads((backup/'state.json').read_text())
current=Path('/var/www/playroom/current')
if not current.is_symlink() or current.resolve()!=release:
 raise SystemExit('A different release is active; refusing to overwrite it')
site=Path(state['site'])
shutil.copy2(backup/'site.conf',site)
snippet=Path('/etc/nginx/snippets/playroom-sector-proxy.conf')
if state['had_snippet']:shutil.copy2(backup/'snippet.conf',snippet)
else:snippet.unlink(missing_ok=True)
if state['previous']:
 staged=current.with_name('current.rollback')
 staged.symlink_to(state['previous']);os.replace(staged,current)
else:current.unlink()
subprocess.run(['nginx','-t'],check=True)
subprocess.run(['systemctl','reload','nginx'],check=True)
print('Prior site configuration restored; SECTOR was not restarted.')
