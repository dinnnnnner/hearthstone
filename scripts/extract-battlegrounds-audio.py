"""Export a named Battlegrounds reference set from an installed Hearthstone client.

Reads client bundles only. Outputs decoded WAVs without trimming, gain, or synthesis.
Requires UnityPy 1.25.3. The Unity version can be overridden for a newer client.
"""
import argparse
import hashlib
import html
import json
from pathlib import Path
import warnings

import UnityPy

NAMES = {
    "BG_SelectHero": "战棋选英雄",
    "BG_HeroDescend": "战棋英雄落下",
    "BG_HeroSocket": "战棋英雄入位",
    "BG_OppsFanOut": "对手列表展开",
    "BG_OppsToLeft": "对手列表移至左侧",
    "Recruit_Popup": "招募提示",
    "Combat_Popup": "战斗提示",
    "CornerFlipTo_Recruit": "切至招募阶段",
    "CornerFlipTo_Combat": "切至战斗阶段",
    "BG_BuddySystem_Burst": "伙伴系统特效",
    "BGSPopup_Victory_1": "战棋第一名结算",
    "BGSPopup_Victory_234": "战棋第二至四名结算",
    "BGSPopup_Defeat_5678": "战棋第五至八名结算",
    "BG20_GEM_BloodGem": "鲜血宝石",
    "Bacon_Treasure_Celebration_sound": "战棋宝藏庆祝特效",
    "Bacon_Treasure_Deck_small_sound": "战棋宝藏牌堆小特效",
    "Bacon_Treasure_Deck_large_sound": "战棋宝藏牌堆大特效",
    "BaconFX_Quest_Choice_Reveal_Burst_sound": "战棋任务选项揭示",
    "BaconFX_Quest_Choice_Reveal_Textblock_sound": "战棋任务文字揭示",
    **{f"BG_Star{part}_{i}": f"战棋星星{label} {i}" for part, label in
       [("Burst", "爆发"), ("Missile", "飞行"), ("Impact", "命中")] for i in [1, 2, 3]},
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client", type=Path, help="Hearthstone installation directory")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--unity-version", default="2022.3.62f2")
    args = parser.parse_args()
    UnityPy.config.FALLBACK_UNITY_VERSION = args.unity_version
    warnings.filterwarnings("ignore", category=UserWarning)
    args.output.mkdir(parents=True, exist_ok=True)
    root = args.client / "Data/Win"
    # These bundle families contain the reference set in the inspected client.
    patterns = ["initial_base_global-e70f171c-audio-*.unity3d",
                "initial_bgs_global-e70f171c-audio-*.unity3d",
                "soundspell_base_global-ffbd77eb-audio-13.unity3d",
                "soundspell_base_global-ffbd77eb-audio-14.unity3d"]
    records = []
    for pattern in patterns:
        for bundle in sorted(root.glob(pattern)):
            blob = bundle.read_bytes()
            env = UnityPy.load(blob)
            for obj in env.objects:
                if obj.type.name != "AudioClip":
                    continue
                clip = obj.read()
                if clip.m_Name not in NAMES:
                    continue
                for filename, data in clip.samples.items():
                    filename = Path(filename).name
                    (args.output / filename).write_bytes(data)
                    records.append({"name": clip.m_Name, "label": NAMES[clip.m_Name],
                                    "file": filename, "seconds": clip.m_Length,
                                    "bundle": bundle.name, "pathId": obj.path_id,
                                    "bundleSha256": hashlib.sha256(blob).hexdigest(),
                                    "wavSha256": hashlib.sha256(data).hexdigest()})
    found = {r["name"] for r in records}
    if missing := NAMES.keys() - found:
        raise SystemExit("Missing clips; client layout may have changed: " + ", ".join(sorted(missing)))
    records.sort(key=lambda r: list(NAMES).index(r["name"]))
    (args.output / "sources.json").write_text(json.dumps({"client": str(args.client),
        "unityVersion": args.unity_version, "unityPyVersion": UnityPy.__version__,
        "processing": "Decode only; original duration, channels and gain preserved.",
        "mappingStatus": "Labels inferred from original names; buying, selling, refreshing, freezing, upgrading and tripling not yet mapped.",
        "clips": records}, ensure_ascii=False, indent=2) + "\n")
    rows = "".join(f'<li><p>{html.escape(r["label"])}<br><small>{html.escape(r["file"])}</small></p><audio controls preload="none" src="{html.escape(r["file"], quote=True)}"></audio></li>' for r in records)
    (args.output / "index.html").write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>战棋原始音效</title><style>body{max-width:760px;margin:36px auto;padding:0 20px;font:16px system-ui;background:#20170f;color:#eadabb}ul{padding:0}li{list-style:none;border-bottom:1px solid #604c36;padding:12px 0}small{color:#b7a387}audio{width:100%}</style><h1>战棋原始音效</h1><p>从本机炉石客户端导出，未经剪切、调音或混音。中文说明按原始文件名整理。</p><ul>''' + rows + '''</ul><script>document.addEventListener('play',e=>{for(const a of document.querySelectorAll('audio'))if(a!==e.target){a.pause();a.currentTime=0}},true)</script></html>''')
    print(f"Exported {len(records)} original clips to {args.output}")


if __name__ == "__main__":
    main()
