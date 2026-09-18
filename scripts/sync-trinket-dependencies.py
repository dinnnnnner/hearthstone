"""Extract trinket dependency cards from the same pinned build as snapshot.json.

Usage: python3 scripts/sync-trinket-dependencies.py [cached-zhCN-cards.json]
Pool membership is curated in trinket-pool.json, not inferred from historical tags.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

rules = json.loads(Path("src/season/current-rules.json").read_text())
# Dependencies retain the live baseline until the scheduled 36.6.1 update.
BUILD = rules["build"] if rules.get("preview") else rules["baseBuild"]
cache = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(f"/tmp/hearthstone-{BUILD}-zhCN.json")
if not cache.exists():
    subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--user-agent", "Mozilla/5.0", f"https://api.hearthstonejson.com/v1/{BUILD}/zhCN/cards.json", "--output", str(cache)], check=True)
cards = json.loads(cache.read_text())
by_dbf = {card["dbfId"]: card for card in cards}

def clean(text):
    return re.sub(r"<[^>]+>", "", text or "").replace("[x]", "").replace("\n", "")

def convert(card):
    golden = by_dbf.get(card.get("battlegroundsPremiumDbfId"), {})
    return dict(id=card["id"], name=card["name"], tier=card.get("techLevel", 1),
                attack=card.get("attack", 0), health=card.get("health", 0), cost=card.get("cost", 0),
                text=clean(card.get("text")), races=card.get("races", []), mechanics=card.get("mechanics", []),
                goldenText=clean(golden.get("text")), goldenAttack=golden.get("attack", card.get("attack", 0) * 2),
                goldenHealth=golden.get("health", card.get("health", 0) * 2))

timewarp = [card for card in cards if card.get("battlegroundsTimewarpCard") and card.get("type") == "MINION"
            and card.get("cost") == 2 and not card.get("battlegroundsNormalDbfId") and not card.get("isBattlegroundsDuosExclusive")]
extra = [card for card in cards if card["id"] in ["BG34_Giant_314", "TB_BaconShop_HERO_33_Buddy"]]
Path("src/season/trinket-dependencies.json").write_text(json.dumps({"timewarp": [c["id"] for c in timewarp], "cards": [convert(c) for c in timewarp + extra]}, ensure_ascii=False, indent=2) + "\n")
seven = [card["id"] for card in cards if card.get("isBattlegroundsPoolMinion") and card.get("techLevel") == 7 and not card.get("isBattlegroundsDuosExclusive")]
if rules.get("preview"):
    pool = json.loads(Path("src/season/preview-pool.json").read_text())
    seven = [card["id"] for card in cards if card["id"] in pool["minions"] and card.get("techLevel") == 7] + [id for id in seven if id not in pool["minions"] and "NAGA" not in next(c for c in cards if c["id"] == id).get("races", [])]
Path("src/season/tier-seven-pool.json").write_text(json.dumps(seven, ensure_ascii=False, indent=2) + "\n")
races = dict(BEAST="野兽", DEMON="恶魔", DRAGON="龙", ELEMENTAL="元素", MECHANICAL="机械", MURLOC="鱼人", NAGA="纳迦", PIRATE="海盗", QUILBOAR="野猪人", UNDEAD="亡灵", ABERRATION="畸变怪")
types = {card["id"]: {"types": [races[t] for t in card.get("battlegroundsAssociatedRaces", []) if t in races]} for card in cards if card.get("type") == "BATTLEGROUND_TRINKET" and not card.get("isBattlegroundsDuosExclusive")}
Path("src/season/trinket-types.json").write_text(json.dumps(types, ensure_ascii=False, indent=2) + "\n")
print(f"{len(timewarp)} Timewarp dependencies, {len(seven)} Tier 7 minions")
