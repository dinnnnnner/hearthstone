"""Run on the target host after uploading a release. Verify, switch, check, roll back on failure."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

release = Path(sys.argv[1]).resolve()
base = Path('/var/www/playroom')
if release.parent != base / 'releases' or not (release / 'release-manifest.json').is_file():
    raise SystemExit('Expected a packaged release under /var/www/playroom/releases')
for name, expected in json.loads((release / 'release-manifest.json').read_text()).items():
    path = (release / name).resolve()
    if not path.is_relative_to(release) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise SystemExit(f'Integrity check failed: {name}')
print('All release file hashes verified.', flush=True)
site = Path('/etc/nginx/sites-enabled/sector').resolve(strict=True)
snippet = Path('/etc/nginx/snippets/playroom-sector-proxy.conf')
current = base / 'current'
if current.exists() and not current.is_symlink():
    raise SystemExit('Refusing to replace a non-symlink current directory')
previous = os.readlink(current) if current.is_symlink() else None
backup = release / 'rollback'
backup.mkdir(exist_ok=False)
shutil.copy2(site, backup / 'site.conf')
had_snippet = snippet.exists()
if had_snippet:
    shutil.copy2(snippet, backup / 'snippet.conf')
(backup / 'state.json').write_text(json.dumps({'site': str(site), 'previous': previous, 'had_snippet': had_snippet}, indent=2))

def atomic_copy(source, destination):
    staged = destination.with_name(destination.name + '.playroom-next')
    shutil.copy2(source, staged)
    os.replace(staged, destination)

def link(target):
    staged = base / 'current.next'
    if staged.is_symlink(): staged.unlink()
    staged.symlink_to(target)
    os.replace(staged, current)

def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()

def check_http(path):
    return command('curl', '--noproxy', '*', '--resolve', '8.153.150.101:443:127.0.0.1', '-fsS', '--max-time', '10', 'https://8.153.150.101'+path)

pid = command('systemctl', 'show', 'sector', '-p', 'MainPID', '--value')
try:
    snippet.parent.mkdir(exist_ok=True)
    atomic_copy(release / 'sector-proxy.conf', snippet)
    link(release)
    atomic_copy(release / 'nginx.conf', site)
    print(command('nginx', '-t'), flush=True)
    command('systemctl', 'reload', 'nginx')
    # Wait briefly for new Nginx workers, without restarting SECTOR.
    import time
    time.sleep(1)
    assert '游戏大厅 · Playroom' in check_http('/'), 'Homepage health check failed'
    assert '/tavern/assets/' in check_http('/tavern/'), 'Tavern health check failed'
    assert 'SECTOR' in check_http('/sector/'), 'SECTOR page health check failed'
    assert json.loads(check_http('/api/health'))['ok'] is True, 'SECTOR API health check failed'
    assert command('systemctl', 'show', 'sector', '-p', 'MainPID', '--value') == pid, 'SECTOR process changed'
    (release / 'activated.json').write_text(json.dumps({'sector_pid': pid, 'https_checks': ['/', '/sector/', '/tavern/', '/api/health']}, indent=2))
    print('Activated '+str(release)+'; HTTPS checks passed; SECTOR PID unchanged: '+pid, flush=True)
except BaseException:
    atomic_copy(backup / 'site.conf', site)
    if had_snippet: atomic_copy(backup / 'snippet.conf', snippet)
    else: snippet.unlink(missing_ok=True)
    if previous: link(previous)
    elif current.is_symlink(): current.unlink()
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print('Activation failed; prior Nginx config and release restored.', file=sys.stderr)
    raise
