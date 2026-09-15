"""Map partial video labels to a frozen policy action vocabulary without inventing state."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .video_extract import file_hash


TARGET_BASE = {"board": (1, 7), "shop": (8, 16), "spellShop": (24, 7), "hand": (31, 10)}


def candidate_actions(event, actions):
    """Unknown slots remain marginal labels, never guessed action IDs or legality masks."""
    targets = None
    if event["target_zone"] is not None:
        if event["target_zone"] not in TARGET_BASE:
            return []
        offset, count = TARGET_BASE[event["target_zone"]]
        if event["target_slot"] is None:
            # A zone without a selected slot can describe card placement, not a
            # targeted battlecry. Retain the no-target action until disambiguated.
            targets = [0, *range(offset, offset + count)]
        elif not 0 <= event["target_slot"] < count:
            return []
        else:
            targets = [offset + event["target_slot"]]
    elif event["target_slot"] is not None:
        return []
    return [i for i, spec in enumerate(actions)
            if spec["type"] == event["type"]
            and (event["source_slot"] is None or spec["source"] == event["source_slot"])
            and (event["position"] is None or spec["position"] == event["position"])
            and (targets is None or spec["target"] in targets)]


def name_index(items):
    result = {}
    for item in items:
        result.setdefault(item["name"], []).append(item["id"])
    return result


def convert(rows, meta, catalog, meta_hash):
    actions = meta["actions"]
    if meta["actionCount"] != len(actions):
        raise ValueError("Checkpoint action count mismatch")
    cards, heroes = name_index(catalog["cards"]), name_index(catalog["heroes"])
    converted = []
    for row in rows:
        ids = candidate_actions(row["action"], actions)
        if not ids:
            continue
        observation = json.loads(json.dumps(row["observation"]))
        observation["hero_id_candidates"] = heroes.get(observation["hero_name"], [])
        for zone in ("board", "shop", "spellShop", "hand"):
            for card in observation.get(zone, []):
                card["id_candidates"] = cards.get(card["name"], [])
        # A training loader should read ONLY policy_input, never labeling_evidence.
        converted.append({"format": "tavern-video-bc-v1",
            "policy_input": {"frame": row["observation_frame"], "observation": observation},
            "label": {"candidate_action_ids": ids,
                      "kind": "exact" if len(ids) == 1 else "partial",
                      "confidence": row["action"]["confidence"]},
            "labeling_evidence": {"action": row["action"], "after_frame": row["evidence_after_frame"]},
            "source": row["source"], "chunk_key": row["chunk_key"],
            "annotation_model": row["annotation_model"], "annotation_effort": row["annotation_effort"],
            "action_meta_sha256": meta_hash, "action_version": meta.get("actionVersion"),
            "source_rules_hash": meta.get("rulesHash"), "video_patch": row["source"].get("patch", "unknown"),
            "patch_compatibility_verified": False, "legal_mask": None,
            "ppo_ready": False, "entity_policy_ready": False})
    return converted


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--meta", required=True, help="Frozen checkpoint metadata JSON containing actions")
    parser.add_argument("--catalog", required=True, help="JSON with cards and heroes name/id arrays")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    rows = [json.loads(line) for line in Path(args.input).read_text().splitlines() if line.strip()]
    mapped = convert(rows, json.loads(Path(args.meta).read_text()),
                     json.loads(Path(args.catalog).read_text()), file_hash(args.meta))
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text("".join(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n" for row in mapped))
    tmp.replace(out)
    print(json.dumps({"input_rows": len(rows), "mapped": len(mapped),
                      "exact": sum(row["label"]["kind"] == "exact" for row in mapped),
                      "unmapped": len(rows) - len(mapped), "out": str(out)}))


if __name__ == "__main__":
    main()
