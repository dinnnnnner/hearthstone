"""Encode the existing WAV cues for browser delivery without editing their timing or gain."""
from pathlib import Path
import hashlib
import json
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
assets = json.loads((root / 'src/table/soundAssets.json').read_text())
paths = sorted({path for value in assets.values() for path in (value if isinstance(value, list) else [value])})
delivery = {}
records = []
with tempfile.TemporaryDirectory(prefix='tavern-audio-') as temporary:
    for path in paths:
        source = root / 'public' / path
        encoded = Path(temporary) / 'sample.mp3'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source),
                        '-map_metadata', '-1', '-codec:a', 'libmp3lame', '-b:a', '192k', str(encoded)], check=True)
        raw = encoded.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        target = source.with_name(source.stem + '-' + digest[:12] + '.mp3')
        target.write_bytes(raw)
        delivery[path] = target.relative_to(root / 'public').as_posix()
        records.append({'source': path, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                        'delivery': delivery[path], 'sha256': digest,
                        'sourceBytes': source.stat().st_size, 'bytes': len(raw)})
(root / 'src/table/soundDelivery.json').write_text(json.dumps(delivery, indent=2) + '\n')
report = {'codec': 'MP3 192 kbit/s', 'sourceCount': len(records),
          'sourceBytes': sum(r['sourceBytes'] for r in records), 'bytes': sum(r['bytes'] for r in records),
          'processing': 'Encoding only; source channels and sample rate retained, no trim, gain or playback-rate change.',
          'files': records}
(root / 'docs/audio-delivery.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: value for key, value in report.items() if key != 'files'}, indent=2))
