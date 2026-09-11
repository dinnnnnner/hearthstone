"""Package the built /tavern/ app and lightweight game lobby for static hosting."""
import gzip, json, shutil, hashlib
from pathlib import Path
root = Path(__file__).resolve().parent.parent
built = root / 'dist'
if '"/tavern/assets/' not in (built / 'index.html').read_text():
 raise SystemExit('Build for /tavern/ first: TAVERN_BASE=/tavern/ npm run build')
site = root / 'site-dist'
if site.exists(): shutil.rmtree(site)
shutil.copytree(root / 'deploy/home', site)
shutil.copytree(built, site / 'tavern')
for p in list(site.rglob('*')):
 if p.suffix in {'.html', '.css', '.js', '.svg', '.json', '.wav'}:
  p.with_name(p.name + '.gz').write_bytes(gzip.compress(p.read_bytes(), compresslevel=9, mtime=0))
files = {str(p.relative_to(site)): hashlib.sha256(p.read_bytes()).hexdigest() for p in site.rglob('*') if p.is_file()}
(site / 'release-manifest.json').write_text(json.dumps(files, indent=2))
print(f'Packaged {len(files)} files in {site}')
