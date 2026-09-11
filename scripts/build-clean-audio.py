"""Render game cues from isolated Hearthstone effects, without video audio or synthesis."""
import argparse
import hashlib
import io
import json
from pathlib import Path
from math import gcd
import zipfile

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parent.parent
RATE = 44100
SOURCE = "https://sounds.spriters-resource.com/pc_computer/hearthstone/asset/396767/"
# Each entry is an original file, onset in seconds, and relative mix gain.
# These are newly assigned/composed cues, not verified original Battlegrounds mappings.
CUES = {
    "select": [("UI_MouseClick_01", 0, 1)],
    "pickup": [("FX_MinionSummon01_DrawFromHand_01", 0, 1)],
    "move": [("collection_manager_drop_card", 0, 1)],
    "buy": [("FX_MulliganCoin03_CoinFlip", 0, 1), ("Card_Transition_In", .045, .45)],
    "sell": [("Card_Transition_Out", 0, .45), ("FX_MulliganCoin01_HeroCoinDrop", .025, 1)],
    "refresh": [("FX_MulliganCoin09_DeckShuffle", 0, 1)],
    "play": [("play_card_from_hand_1", 0, 1)],
    "spell": [("Holy_Smite_Cast_01", 0, 1)],
    "power": [("hero_power_icon_flip_on", 0, 1)],
    "freeze": [("FX_FreezeEvent_SpellImpact", 0, 1)],
    "thaw": [("FX_FreezeEvent_StateEnd", 0, 1)],
    "upgrade": [("level_up", 0, 1)],
    "discover": [("forge_rarity_card_appears", 0, 1)],
    "attack": [("Card_Transition_Out", 0, 1)],
    "shield": [("WoW_unarmedparrymetala", 0, .65), ("FX_FreezeEvent_StateEnd", 0, .45)],
    "hit": [("Shared_DoubleClawSlash_Impact_1", 0, 1)],
    "heroHit": [("WoW_m2haxehitmetalshieldcrit", 0, 1)],
    "death": [("unselected_cards_dissipate", 0, 1)],
    "triple": [("forge_rarity_card_appears", 0, .7), ("game_end_reward", .1, 1)],
    "combat": [("forge_hero_portrait_plate_descend_and_impact", 0, 1)],
    "round": [("ALERT_YourTurn_0v2", 0, 1)],
    "win": [("game_end_reward", 0, 1)],
    "lose": [("Shrink_Down", 0, 1)],
    "tie": [("FX_EndTurn_Up", 0, 1)],
    "error": [("card_limit_lock", 0, 1)],
    "tick": [("tiny_button_press_2", 0, 1)],
}
LABELS = dict(zip(CUES, ["选中", "拿牌", "移动", "购买", "出售", "刷新", "出牌", "施法", "英雄技能", "冻结", "解冻", "升级", "发现", "攻击起手", "破盾", "命中", "英雄受击", "死亡", "三连", "开战", "招募回合", "胜利", "失败", "平局", "操作无效", "倒计时"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    output = ROOT / "public/audio/clean"
    output.mkdir(parents=True, exist_ok=True)
    # This directory contains only this script's generated files.
    for old in output.glob("*.wav"):
        old.unlink()
    files, manifest = {}, {}
    with zipfile.ZipFile(args.archive) as archive:
        names = {Path(name).name: name for name in archive.namelist()}

        def read(name):
            blob = archive.read(names[name + ".ogg"])
            x, sr = sf.read(io.BytesIO(blob), always_2d=True)
            x = x.mean(axis=1)
            if sr != RATE:
                div = gcd(sr, RATE)
                x = resample_poly(x, RATE // div, sr // div)
            peak = np.max(np.abs(x))
            if peak < 1e-6:
                raise ValueError(f"Silent source: {name}")
            active = np.flatnonzero(np.abs(x) > peak * .005)
            first = max(0, active[0] - int(.003 * RATE))
            last = min(len(x), active[-1] + int(.06 * RATE))
            x = x[first:last]
            # Balance isolated source layers, preserving their original pitch and texture.
            x *= min(10, .06 / max(1e-6, np.sqrt(np.mean(x * x))))
            return x, {"file": name + ".ogg", "sha256": hashlib.sha256(blob).hexdigest(), "trimStart": first / RATE, "trimEnd": last / RATE}

        for kind, layers in CUES.items():
            rendered, inputs = [], []
            for name, at, gain in layers:
                x, info = read(name)
                rendered.append((int(at * RATE), x * gain))
                inputs.append({**info, "at": at, "gain": gain})
            x = np.zeros(max(at + len(y) for at, y in rendered))
            for at, y in rendered:
                x[at:at + len(y)] += y
            target = {"select": -35, "pickup": -29, "move": -28, "attack": -30, "tick": -35,
                      "hit": -22, "heroHit": -21, "shield": -25, "death": -28}.get(kind, -25)
            gain = min(10 ** (target / 20) / np.sqrt(np.mean(x * x)), .5 / np.max(np.abs(x)))
            x *= gain
            fade_in, fade_out = min(88, len(x)), min(882, len(x))
            x[:fade_in] *= np.linspace(0, 1, fade_in)
            x[-fade_out:] *= np.linspace(1, 0, fade_out)
            buf = io.BytesIO()
            sf.write(buf, x, RATE, format="WAV", subtype="PCM_16")
            blob = buf.getvalue()
            digest = hashlib.sha256(blob).hexdigest()
            filename = f"{kind}-{digest[:12]}.wav"
            (output / filename).write_bytes(blob)
            files[kind] = "audio/clean/" + filename
            manifest[kind] = {"label": LABELS[kind], "path": files[kind], "seconds": len(x) / RATE,
                              "peak": float(np.max(np.abs(x))), "sha256": digest, "mixGain": gain, "inputs": inputs}
    (ROOT / "src/table/soundAssets.json").write_text(json.dumps(files, indent=2) + "\n")
    provenance = {"source": SOURCE, "sourceArchiveSha256": hashlib.sha256(args.archive.read_bytes()).hexdigest(),
                  "description": "Composed from isolated Hearthstone general SFX; not exact Battlegrounds action mappings. No livestream audio or oscillator synthesis.",
                  "cues": manifest}
    (ROOT / "public/audio/clean/sources.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n")
    (ROOT / "docs/clean-audio.json").write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n")
    cards = "\n".join(f'<li><span>{LABELS[k]}</span><audio controls preload="none" src="clean/{Path(v).name}"></audio></li>' for k, v in files.items())
    (ROOT / "public/audio/listen.html").write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>酒馆音效试听</title>
<style>body{font:16px system-ui;background:#20170f;color:#f2dfb5;max-width:760px;margin:40px auto;padding:0 20px}a{color:#e7bc67}ul{padding:0}li{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #58452c;padding:14px 0}audio{width:min(65vw,420px)}h1{font-size:26px}</style>
<a href="../">返回酒馆</a><h1>酒馆音效试听</h1><p>点击播放，单独试听各项操作的声音。</p><ul>''' + cards + '''</ul><script>document.addEventListener('play',e=>{for(const a of document.querySelectorAll('audio'))if(a!==e.target){a.pause();a.currentTime=0}},true)</script></html>''')
    print(f"Rendered {len(files)} cues, {sum(p.stat().st_size for p in output.glob('*.wav'))} bytes")


if __name__ == "__main__":
    main()
