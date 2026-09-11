#!/usr/bin/env python3
"""Rebuild short interaction samples from timestamped gameplay recordings.

uv run --with numpy --with scipy --with soundfile python scripts/sample-game-audio.py \
  --sources /tmp/tavern-audio-reference
Source recordings remain outside the repository. See docs/audio-sampling.md.
"""
import argparse
import hashlib
import html
import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import ndimage, signal

ROOT = Path(__file__).resolve().parents[1]
RATE = 44100


def suppress_background(audio, background, strength):
    """Soft spectral subtraction using an adjacent background-only interval."""
    _, _, spectrum = signal.stft(audio, RATE, nperseg=1024, noverlap=896)
    _, _, bed = signal.stft(background, RATE, nperseg=1024, noverlap=896)
    power = np.abs(spectrum) ** 2
    floor = np.quantile(np.abs(bed) ** 2, 0.7, axis=1, keepdims=True)
    mask = np.maximum(0.015, 1 - strength * floor / np.maximum(power, 1e-16))
    mask = ndimage.gaussian_filter(mask, sigma=(0.7, 0.6))
    _, clean = signal.istft(spectrum * mask, RATE, nperseg=1024, noverlap=896)
    return clean[:len(audio)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--recipe', type=Path, default=ROOT / 'docs/audio-samples.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/audio')
    parser.add_argument('--review', type=Path, default=Path('/tmp/tavern-audio-review'))
    args = parser.parse_args()
    recipe = json.loads(args.recipe.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    args.review.mkdir(parents=True, exist_ok=True)
    sources = {}
    for name, source in recipe['sources'].items():
        recording = args.sources / source['file']
        decoded = args.sources / f'{name}-decoded.wav'
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', str(recording), '-vn',
                        '-ar', str(RATE), '-ac', '1', str(decoded)], check=True)
        sources[name] = sf.read(decoded)[0]
    report, rows = [], []
    for sample in recipe['samples']:
        audio = sources[sample['source']]
        start, end = sample['start'], sample['end']
        a, b = sample['background']
        raw = audio[round(start * RATE):round(end * RATE)]
        bed = audio[round(a * RATE):round(b * RATE)]
        if not len(raw) or len(bed) < 1024:
            raise ValueError(f"Invalid sample interval: {sample['kind']}")
        clean = suppress_background(raw, bed, sample.get('strength', 2.5))
        sos = signal.butter(2, [75, 11000], fs=RATE, btype='bandpass', output='sos')
        clean = signal.sosfiltfilt(sos, clean)
        # Fixed gain per clip preserves its attack and decay; no loudness pumping.
        target = 10 ** (sample.get('peakDb', -10) / 20)
        gain = min(target / max(np.max(np.abs(clean)), 1e-9), 500)
        clean *= gain
        fade_in, fade_out = min(132, len(clean)//4), min(1103, len(clean)//4)
        clean[:fade_in] *= np.linspace(0, 1, fade_in)
        clean[-fade_out:] *= np.linspace(1, 0, fade_out)
        name = sample['kind'] + '.wav'
        sf.write(args.output / name, clean, RATE, subtype='PCM_16')
        sf.write(args.review / name, clean, RATE, subtype='PCM_16')
        # Match comparison gains so background reduction is not confused with loudness.
        sf.write(args.review / ('raw-' + name), np.clip(raw * gain, -1, 1), RATE, subtype='PCM_16')
        report.append({**sample, 'file': name, 'duration': round(len(clean)/RATE, 4),
                       'peakDbFS': round(20*np.log10(max(np.max(np.abs(clean)), 1e-9)), 2),
                       'sha256': hashlib.sha256((args.output/name).read_bytes()).hexdigest()})
        rows.append(f'<tr><td>{html.escape(sample["kind"])}</td><td>{start:.3f}–{end:.3f}s</td>'
                    f'<td><audio controls src="raw-{name}"></audio></td>'
                    f'<td><audio controls src="{name}"></audio></td></tr>')
    (args.output / 'sources.json').write_text(json.dumps({'sources': recipe['sources'], 'samples': report}, ensure_ascii=False, indent=2)+'\n')
    (args.review / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>音效采样对照</title>'
        '<style>body{font:16px system-ui;background:#201a16;color:#eee;padding:24px}td,th{padding:12px;text-align:left}audio{width:270px}</style>'
        '<h1>音效采样对照</h1><p>左侧是原始切片，右侧是降噪后的游戏音效。两者采用相同增益。</p>'
        '<table><tr><th>操作</th><th>录像时间</th><th>原始</th><th>处理后</th></tr>'+''.join(rows)+'</table>')
    print(f'Wrote {len(report)} samples to {args.output}; comparison: {args.review / "index.html"}')


if __name__ == '__main__':
    main()
