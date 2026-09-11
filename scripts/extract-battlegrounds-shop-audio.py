"""Export shop interaction audio components referenced by the installed client.

Requires UnityPy 1.25.3 and soundfile. Reads bundles without modifying the client.
Exports original WAVs and a grouped audition page, without composing game cues.
"""
import argparse
import hashlib
import html
import io
import json
from pathlib import Path
import warnings

import soundfile as sf
import UnityPy

CORE = "initial_base_global-64194cb9-prefab-0.unity3d"
BASE = "essential_base_global-prefab-0.unity3d"
BG = "initial_base_global-e70f171c-prefab-0.unity3d"
GROUPS = {
    "sell": ("出售", [
        ("initial_base_global-ffbd77eb-prefab-11.unity3d", -7764571626953304889, "出售金币"),
    ]),
    "buy": ("购买", [
        (CORE, -524392124726337089, "金币飞行"),
        (BASE, 9122487940136582291, "金币命中提示"),
        ("initial_base_global-f4c0b6f1-prefab-1.unity3d", 1395166537394949437, "金币袋底声"),
    ]),
    "refresh": ("刷新", [
        (BASE, -1309217977194182999, "随从出现"),
        *[(BASE, ref, f"落桌变体 {i}") for i, ref in enumerate([
            8252197464281458970, -3259001109173926916, -4964456221999031061,
            -5252783853466478613, 4638778653581165975,
        ], 1)],
    ]),
    "triple": ("三连", [
        (BG, 7876605156130182355, "变金阶段"),
        (BG, -4221417846849817805, "合成卡牌显现"),
        (BASE, -6461385766613166340, "卡牌入手变体"),
    ]),
    "freeze": ("冻结", [
        (BASE, 7198322678668642453, "冻结主音"),
    ]),
    "thaw": ("冻结外观解除", [
        ("initial_base_global-2ebe64b8-prefab-2.unity3d", 5800018870951527884, "碎冰变体"),
    ]),
}
FSM_REFS = [(CORE, ref) for ref in [
    -6712124945369835678, 302446810203310067, 3658462939387760554,
    8964268380008794937, 5379025552405481021, 7600830342359556894, 2482171102457274815,
]] + [("initial_base_global-2ebe64b8-prefab-2.unity3d", 2788878057917171148)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client", type=Path)
    parser.add_argument("--output", type=Path, default=Path("references/battlegrounds-shop-actions"))
    args = parser.parse_args()
    UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.62f2"
    warnings.filterwarnings("ignore", category=UserWarning)
    root = args.client / "Data/Win"
    args.output.mkdir(parents=True, exist_ok=True)
    cache, hashes = {}, {}

    def bundle(name):
        if name not in cache:
            raw = (root / name).read_bytes()
            hashes[name] = hashlib.sha256(raw).hexdigest()
            env = UnityPy.load(raw)
            cache[name] = (env, {o.path_id: o for o in env.objects})
        return cache[name]

    manifest = next(o.read_typetree() for o in bundle("asset_manifest.unity3d")[1].values()
                    if o.type.name == "MonoBehaviour" and "m_assets" in o.read_typetree())
    locations = {r["guid"]: manifest["m_bundleNames"][r["bundleId"]] for r in manifest["m_assets"]}
    records, sounddefs, actions = [], [], []
    for group, (title, definitions) in GROUPS.items():
        for source, path_id, label in definitions:
            definition = bundle(source)[1][path_id].read_typetree()
            sounddefs.append({"group": group, "bundle": source, "pathId": path_id,
                              **{k: v for k, v in definition.items() if k.startswith("m_Random") or k == "m_AudioClip"}})
            clips = [r["m_Clip"] for r in definition["m_RandomClips"]] or [definition["m_AudioClip"]]
            for index, reference in enumerate(clips, 1):
                filename, guid = reference.rsplit(":", 1)
                name = Path(filename).stem
                audio_bundle = locations[guid]
                clip_ptr = bundle(audio_bundle)[0].container[guid]
                clip = clip_ptr.read()
                assert clip.m_Name == name
                decoded = clip.samples
                assert len(decoded) == 1, name
                raw = next(iter(decoded.values()))
                data, rate = sf.read(io.BytesIO(raw), always_2d=True)
                assert abs(len(data) / rate - clip.m_Length) < .002, name
                peak = float(abs(data).max())
                assert peak > 0, name
                filename = name + ".wav"
                (args.output / filename).write_bytes(raw)
                records.append({"group": group, "label": label + (f" {index}" if len(clips) > 1 else ""),
                                "name": name, "file": filename, "guid": guid, "bundle": audio_bundle,
                                "pathId": clip_ptr.path_id, "seconds": len(data) / rate,
                                "sampleRate": rate, "channels": data.shape[1], "peak": peak,
                                "wavSha256": hashlib.sha256(raw).hexdigest()})

    for source, path_id in FSM_REFS:
        objects = bundle(source)[1]
        data = objects[path_id].read_typetree()
        prefab = objects[data["m_GameObject"]["m_PathID"]].read().m_Name
        for state in data["fsm"]["states"]:
            a = state["actionData"]
            audio = [{"action": n.rsplit(".", 1)[-1], "enabled": bool(enabled)}
                     for n, enabled in zip(a["actionNames"], a["actionEnabled"]) if "Audio" in n]
            if audio:
                refs = [v["value"] for v in a["fsmObjectParams"] if v.get("typeName") == "SoundDef"] + a["unityObjectParams"]
                externals = {ref["m_FileID"]: objects[path_id].assets_file.externals[ref["m_FileID"] - 1].path
                             for ref in refs if ref["m_FileID"]}
                actions.append({"bundle": source, "prefab": prefab, "pathId": path_id, "state": state["name"],
                                "audioActions": audio,
                                "externalFiles": externals,
                                "ownerRefs": a["fsmOwnerDefaultParams"],
                                "soundRefs": [v["value"] for v in a["fsmObjectParams"] if v.get("typeName") == "SoundDef"],
                                "objectRefs": a["unityObjectParams"]})
    report = {"client": str(args.client), "unityVersion": "2022.3.62f2", "unityPyVersion": UnityPy.__version__,
              "processing": "Decode only; no trimming, mixing, resampling, or gain changes.",
              "status": "References verified in client configuration; runtime timing and perceptual matching not yet reproduced.",
              "bundleSha256": hashes, "soundDefs": sounddefs, "actions": actions, "clips": records}
    (args.output / "sources.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    sections = []
    for group, (title, _) in GROUPS.items():
        rows = "".join(f'<li><b>{html.escape(r["label"])}</b><small>{html.escape(r["name"])}</small>'
                       f'<audio controls preload="none" src="{html.escape(r["file"])}"></audio></li>'
                       for r in records if r["group"] == group)
        sections.append(f'<section id="{group}"><h2>{title}</h2><ul>{rows}</ul></section>')
    (args.output / "index.html").write_text('''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>酒馆操作音效素材</title>
<style>body{max-width:760px;margin:32px auto;padding:0 20px;font:16px system-ui;background:#20170f;color:#f2dfb5}h1{font-size:26px}ul{padding:0}li{list-style:none;padding:14px 0;border-bottom:1px solid #58452c}small{display:block;color:#c9b694;margin:6px 0}audio{width:100%}</style>
<h1>酒馆操作音效素材</h1><p>购买、刷新、三连、冻结及冻结外观解除的原始分层文件。落桌、入手和碎冰声各有随机变体，游戏会择一播放。这里逐条试听，尚未按游戏动画组合。</p>'''
        + "".join(sections) + '''<script>document.addEventListener('play',e=>{for(const a of document.querySelectorAll('audio'))if(a!==e.target){a.pause();a.currentTime=0}},true)</script></html>''')
    print(f"Exported and verified {len(records)} original WAVs to {args.output}")


if __name__ == "__main__":
    main()
