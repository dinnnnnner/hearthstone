"""Create compact UI assets from downloaded originals. Requires ffmpeg with libwebp."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
source = root / 'public/art'
target = root / 'public/thumbs'
target.mkdir(exist_ok=True)

def build(path):
    out = target / (path.stem + '.webp')
    if out.exists() and out.stat().st_mtime >= path.stat().st_mtime:
        return
    subprocess.run([
        'ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(path),
        '-vf', 'scale=320:320:force_original_aspect_ratio=decrease',
        '-frames:v', '1', '-c:v', 'libwebp', '-quality', '80',
        '-threads', '1', str(out),
    ], check=True)

paths = sorted(source.glob('*.png'))
with ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(build, paths))
original = sum(p.stat().st_size for p in paths)
compact = sum(p.stat().st_size for p in target.glob('*.webp'))
print(f'{len(paths)} UI images: {original:,} -> {compact:,} bytes ({compact/original:.1%})')
