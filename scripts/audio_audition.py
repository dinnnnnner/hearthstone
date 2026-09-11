"""Build the shared audition page from the active audio manifests."""
import html
import json
from pathlib import Path

def write_audition(root: Path):
    assets = json.loads((root / 'src/table/soundAssets.json').read_text())
    gains = json.loads((root / 'src/table/originalSoundGains.json').read_text())
    labels = {k: r['label'] for k, r in json.loads((root / 'docs/clean-audio.json').read_text())['cues'].items()}
    labels.update({k: r['label'] for k, r in json.loads((root / 'docs/battlegrounds-audio-active.json').read_text()).items()})
    shop = root / 'docs/battlegrounds-shop-audio-active.json'
    if shop.exists(): labels.update({k: r['label'] for k, r in json.loads(shop.read_text())['cues'].items()})
    rows = []
    for kind, value in assets.items():
        paths = value if isinstance(value, list) else [value]
        for i, path in enumerate(paths, 1):
            label = labels[kind] + (f' · 变体 {i}' if len(paths) > 1 else '')
            rows.append(f'<li><span>{html.escape(label)}</span><audio controls preload="none" data-gain="{gains.get(kind, 1)}" src="{html.escape(path.removeprefix("audio/"))}"></audio></li>')
    (root / 'public/audio/listen.html').write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>酒馆音效试听</title><style>body{font:16px system-ui;background:#20170f;color:#f2dfb5;max-width:760px;margin:40px auto;padding:0 20px}a{color:#e7bc67}ul{padding:0}li{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #58452c;padding:14px 0}audio{width:min(65vw,420px)}h1{font-size:26px}</style><a href="../">返回酒馆</a><h1>酒馆音效试听</h1><p>点击播放，单独试听各项操作的声音。标有变体的音效会在游戏中随机选择。</p><ul>''' + ''.join(rows) + '''</ul><script>for(const a of document.querySelectorAll('audio'))a.volume=Number(a.dataset.gain);document.addEventListener('play',e=>{for(const a of document.querySelectorAll('audio'))if(a!==e.target){a.pause();a.currentTime=0}},true)</script></html>''')
