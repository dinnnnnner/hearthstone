"""Install verified shop audio and compose its layers for this game's animations."""
import hashlib
import io
import json
from math import gcd
from pathlib import Path
import shutil
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from audio_audition import write_audition

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'references/battlegrounds-shop-actions'
RATE = 44100
# Delays follow this app's purchase and merge animations. The source is the
# client's enabled sound references; these are not captured client waveforms.
# Layer tuple: original name, delay seconds, relative volume, playback pitch.
RECIPES = {
    'buy': [[('Coin_Missile_Sound', 0, .9, 1),
             ('mana_crystal_refresh', .35, .8, 1.2),
             ('CoinBag_Underlay_Play_2', .35, .45, 1.3)]],
    'refresh': [[('Minion_Summon_Minion_01', 0, .6, 1),
                 (f'Minion_Drop_Basic_{i}', .2, .45, 1)] for i in range(1, 6)],
    # The scene calls this at 440 ms: reveal at 600 ms, hand arrival at 760 ms.
    'triple': [[('BG_StarMissile_1', 0, .4, .9),
                ('Treasure_Cards_Appear', .16, .6 * .8, 1),
                (f'add_card_to_hand_{i}', .32, 1, 1)] for i in range(1, 4)],
    'freeze': [[('Mage_FrostNovaCast_New', 0, 1, 1)]],
    'thaw': [[(f'Shared_Frost_Impact_Small_{i}', 0, 1, 1)] for i in range(1, 4)],
    'sell': [[('GadgetzanAuctioneer_card_spawn_coins_No_Delay', 0, 1, 1)]],
}
LABELS = {'buy': '购买', 'refresh': '刷新', 'triple': '三连', 'freeze': '冻结', 'thaw': '解冻', 'sell': '出售'}
sources = {r['name']: r for r in json.loads((SOURCE / 'sources.json').read_text())['clips']}
assets_path = ROOT / 'src/table/soundAssets.json'
assets = json.loads(assets_path.read_text())
gains_path = ROOT / 'src/table/originalSoundGains.json'
gains = json.loads(gains_path.read_text())
records = {}
output = ROOT / 'public/audio/shop'
output.mkdir(parents=True, exist_ok=True)

for kind, variants in RECIPES.items():
    rendered = []
    exact = all(len(layers) == 1 and layers[0][1:] == (0, 1, 1) for layers in variants)
    for layers in variants:
        pieces = []
        for name, delay, level, pitch in layers:
            r = sources[name]
            raw = (SOURCE / r['file']).read_bytes()
            assert hashlib.sha256(raw).hexdigest() == r['wavSha256'], name
            data, rate = sf.read(io.BytesIO(raw), always_2d=True)
            if not exact:
                if data.shape[1] == 1: data = np.repeat(data, 2, axis=1)
                effective_rate = round(rate * pitch)
                common = gcd(RATE, effective_rate)
                data = resample_poly(data, RATE // common, effective_rate // common)
            pieces.append((round(delay * RATE), data * level))
        if exact:
            wave = pieces[0][1]
        else:
            wave = np.zeros((max(at + len(data) for at, data in pieces), 2))
            for at, data in pieces: wave[at:at + len(data)] += data
        rendered.append(wave)
    peak = max(float(np.max(np.abs(wave))) for wave in rendered)
    rms = max(float(np.sqrt(np.mean(wave * wave))) for wave in rendered)
    gain = min(1, .5 / peak, .056 / rms)
    gains[kind] = gain if exact else 1
    paths, outputs = [], []
    for i, (layers, wave) in enumerate(zip(variants, rendered), 1):
        if exact:
            raw = (SOURCE / sources[layers[0][0]]['file']).read_bytes()
            rate = sources[layers[0][0]]['sampleRate']
        else:
            buffer = io.BytesIO()
            sf.write(buffer, wave * gain, RATE, format='WAV', subtype='PCM_16')
            raw = buffer.getvalue(); rate = RATE
        digest = hashlib.sha256(raw).hexdigest()
        path = f'audio/shop/{kind}-{i}-{digest[:12]}.wav'
        (ROOT / 'public' / path).write_bytes(raw)
        paths.append(path)
        outputs.append({'path': path, 'seconds': len(wave) / rate, 'sha256': digest,
                        'byteIdenticalToOriginal': exact,
                        'layers': [{'name': n, 'at': at, 'volume': level, 'pitch': pitch,
                                    'sourceSha256': sources[n]['wavSha256']} for n, at, level, pitch in layers]})
    old = assets.get(kind, [])
    for path in old if isinstance(old, list) else [old]:
        if path.startswith('audio/clean/'): (ROOT / 'public' / path).unlink(missing_ok=True)
    assets[kind] = paths if len(paths) > 1 else paths[0]
    records[kind] = {'label': LABELS[kind], 'normalizationGain': gain,
                     'runtimeGain': gains[kind], 'variants': outputs}
active = {p for v in assets.values() for p in (v if isinstance(v, list) else [v])}
for p in output.glob('*.wav'):
    if p.relative_to(ROOT / 'public').as_posix() not in active: p.unlink()
assets_path.write_text(json.dumps(assets, indent=2) + '\n')
gains_path.write_text(json.dumps(gains, indent=2) + '\n')
report = {'source': 'docs/battlegrounds-shop-audio-found.json',
          'status': 'Client-referenced components; multi-layer cues adapted to this app animation timing. No perceptual equivalence claimed.',
          'cues': records}
(ROOT / 'docs/battlegrounds-shop-audio-active.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
(output / 'sources.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
write_audition(ROOT)
print(f'Installed {len(records)} shop cues / {sum(len(r["variants"]) for r in records.values())} variants; {len(active)} total audio files')
