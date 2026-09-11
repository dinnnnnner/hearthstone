"""Publish the original Battlegrounds cues with known matching interactions."""
import hashlib
import json
from pathlib import Path
import shutil
import numpy as np
import soundfile as sf
from audio_audition import write_audition

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "references/battlegrounds-original"
MAPPING = {
    "heroSelect": ("BG_SelectHero", "选择英雄"),
    "round": ("Recruit_Popup", "招募回合"),
    "combat": ("Combat_Popup", "开战"),
    "heroHit": ("BG_StarImpact_1", "英雄受击"),
    "bloodGem": ("BG20_GEM_BloodGem", "鲜血宝石"),
    "matchFirst": ("BGSPopup_Victory_1", "整局第一名"),
    "matchTopFour": ("BGSPopup_Victory_234", "整局第二至四名"),
    "matchDefeat": ("BGSPopup_Defeat_5678", "整局第五至八名／练习失败"),
}
sources = {c["name"]: c for c in json.loads((SOURCE / "sources.json").read_text())["clips"]}
assets_path = ROOT / "src/table/soundAssets.json"
assets = json.loads(assets_path.read_text())
records = {}
for kind, (name, label) in MAPPING.items():
    row = sources[name]
    source = SOURCE / row["file"]
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    assert digest == row["wavSha256"], name
    data, rate = sf.read(source)
    gain = min(1., .056 / np.sqrt(np.mean(data * data)), .5 / np.max(np.abs(data)))
    path = f"audio/battlegrounds/{name}-{digest[:12]}.wav"
    output = ROOT / "public" / path
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, output)
    previous = assets.get(kind)
    if previous and previous.startswith(f"audio/clean/{kind}-"):
        (ROOT / "public" / previous).unlink(missing_ok=True)
    assets[kind] = path
    records[kind] = {**row, "label": label, "path": path, "gain": float(gain)}
assets_path.write_text(json.dumps(assets, indent=2) + "\n")
gains_path = ROOT / "src/table/originalSoundGains.json"
gains = json.loads(gains_path.read_text()) if gains_path.exists() else {}
gains.update({k: r["gain"] for k, r in records.items()})
gains_path.write_text(json.dumps(gains, indent=2) + "\n")
(ROOT / "docs/battlegrounds-audio-active.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
(ROOT / "public/audio/battlegrounds/sources.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
write_audition(ROOT)
print(f"Installed {len(records)} byte-identical originals; {len(assets)} total cues")
