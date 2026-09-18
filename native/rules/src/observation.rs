use crate::{Result, action_space, arr, catalog, def, num, powers, prices, truth};
use serde_json::{Value, json};
use std::collections::HashMap;
pub const ZONES: [&str; 12] = [
    "global",
    "board",
    "shop",
    "spellShop",
    "hand",
    "discovery",
    "lastEnemy",
    "opponents",
    "powers",
    "powerOffers",
    "trinketOffers",
    "trinkets",
];
pub const SIZES: [usize; 12] = [1, 7, 16, 7, 10, 4, 7, 7, 2, 4, 4, 4];
pub const OFFSETS: [usize; 12] = [0, 1, 8, 24, 31, 41, 45, 52, 59, 61, 65, 69];
pub const WARBANDS: [&str; 13] = [
    "野兽",
    "机械",
    "鱼人",
    "恶魔",
    "龙",
    "元素",
    "畸变怪",
    "海盗",
    "野猪人",
    "亡灵",
    "空场",
    "无种族",
    "混合",
];
pub fn card_ids() -> Vec<String> {
    let mut ids: Vec<_> = arr(&catalog().data["cards"])
        .iter()
        .filter_map(|c| c["id"].as_str().map(str::to_string))
        .collect();
    ids.sort();
    ids.dedup();
    ids
}
pub fn hero_ids() -> Vec<String> {
    let mut ids: Vec<_> = arr(&catalog().data["heroPool"])
        .iter()
        .filter_map(|c| c.as_str().map(str::to_string))
        .collect();
    ids.sort();
    ids
}
pub fn entity_ids() -> Vec<String> {
    let mut ids = card_ids();
    ids.extend(hero_ids());
    for k in ["trinkets", "gifts"] {
        ids.extend(
            arr(&catalog().data[k])
                .iter()
                .filter_map(|c| c["id"].as_str().map(str::to_string)),
        )
    }
    ids.push("s14_trinket".into());
    ids.sort();
    ids.dedup();
    ids
}
fn scale(n: f64, unit: f64) -> f64 {
    (if n.is_finite() { n } else { 0. } / unit).tanh()
}
fn hero_id(v: &Value) -> f64 {
    let ids = hero_ids();
    ids.iter()
        .position(|x| Some(x.as_str()) == v.as_str())
        .map(|i| (i + 1) as f64 / ids.len() as f64)
        .unwrap_or(0.)
}
fn index(v: &Value, vs: &Value) -> f64 {
    arr(vs)
        .iter()
        .position(|x| x["id"] == *v)
        .map(|i| (i + 1) as f64 / arr(vs).len() as f64)
        .unwrap_or(0.)
}
pub fn counter_features(v: &Value, size: usize) -> Vec<f64> {
    let mut buckets = vec![0.; size];
    if let Some(obj) = v.as_object() {
        for (k, v) in obj {
            let mut hash = 2166136261u32;
            for c in k.chars() {
                let code = if c as u32 > 0xffff {
                    0xd800 + ((c as u32 - 0x10000) >> 10)
                } else {
                    c as u32
                };
                hash = (hash ^ code).wrapping_mul(16777619)
            }
            buckets[hash as usize % size] += num(v)
        }
    }
    buckets.into_iter().map(|v| scale(v, 100.)).collect()
}
pub fn ranking(s: &Value) -> f64 {
    let st = if s["season"].is_object() {
        &s["season"]
    } else {
        s
    };
    num(&s["health"]) + (num(&st["armor"]) - num(&st["spellArmor"])).max(0.)
}
pub fn scouting(s: &Value, rounds: &Value) -> Result<Value> {
    let mut rs: Vec<_> = arr(rounds)
        .iter()
        .filter(|r| num(&r["turn"]) < num(&s["turn"]) && num(&r["turn"]) >= num(&s["turn"]) - 2.)
        .collect();
    rs.sort_by(|a, b| num(&b["turn"]).total_cmp(&num(&a["turn"])));
    let mut out = vec![];
    for r in rs {
        let label = r["warband"].as_str().ok_or("Invalid scouting warband")?;
        let digits = label.chars().take_while(|c| c.is_ascii_digit()).count();
        let (kind, count) = if digits > 0 && digits < label.len() {
            (
                &label[digits..],
                label[..digits].parse::<f64>().unwrap_or(0.),
            )
        } else {
            (label, 0.)
        };
        if !WARBANDS.contains(&kind) && kind != "纳迦" {
            return Err(format!("Unknown public warband: {label}"));
        }
        let mut v = json!({"turn":r["turn"],"warband":{"type":kind,"count":count}});
        let b = &r["battle"];
        if truth(b) {
            let seat = if b["opponent"] == "幽灵阵容" {
                json!(8)
            } else {
                arr(&s["opponents"])
                    .iter()
                    .find(|o| o["name"] == b["opponent"])
                    .and_then(|o| o.get("seatIndex"))
                    .or_else(|| s.get("seatIndex"))
                    .cloned()
                    .unwrap_or(json!(-1))
            };
            v["battle"] = json!({"opponentSeat":seat,"result":b["result"],"damage":b["damage"]})
        }
        out.push(v)
    }
    Ok(json!(out))
}
fn card(m: &Value, s: &Value) -> Result<Vec<f64>> {
    if m.is_null() {
        return Ok(vec![0.; 50]);
    }
    let id = m["id"].as_str().ok_or("Missing card id")?;
    let d = def(id)?;
    let ids = card_ids();
    let i = ids
        .iter()
        .position(|x| x == id)
        .ok_or_else(|| format!("Unknown observation card {id}"))?;
    let mut v = vec![
        1.,
        (i + 1) as f64 / ids.len() as f64,
        scale(num(&m["attack"]), 100.),
        scale(num(&m["health"]), 100.),
        num(&d["tier"]) / 6.,
        b(&m["golden"]),
        if d["kind"] == "spell" { 1. } else { 0. },
        b(&d["magnetic"]),
        b(&m["activated"]),
        ((num(&m["lockedUntil"]) - num(&s["turn"])).max(0.) / 10.).min(1.),
        (num(&m["lockedTier"]) / 6.).min(1.),
        b(&m["tempSpell"]),
        b(&m["expires"]),
        b(&m["reward"]),
        b(&m["rebornNext"]),
        scale(num(&m["magneticCount"]), 10.),
        scale(num(&m["gems"]["attack"]), 100.),
        scale(num(&m["gems"]["health"]), 100.),
        scale(num(&d["cost"]), 10.),
        scale(num(&d["activateCost"]), 10.),
    ];
    for k in ["嘲讽", "圣盾", "复生", "剧毒", "风怒", "烈毒", "潜行"] {
        v.push(if arr(&m["keywords"]).iter().any(|x| x == k) {
            1.
        } else {
            0.
        })
    }
    for t in arr(&catalog().data["tribes"]) {
        v.push(
            if d["tribe"] == "全部" || &d["tribe"] == t || arr(&d["races"]).contains(t) {
                1.
            } else {
                0.
            },
        )
    }
    v.extend(counter_features(&m["counters"], 8));
    v.extend([
        b(&m["bothChoices"]),
        b(&m["gift"]),
        scale(arr(&m["extraAbilities"]).len() as f64, 10.),
        scale(num(&m["temporary"]["attack"]), 100.),
        scale(num(&m["temporary"]["health"]), 100.),
    ]);
    if v.len() != 50 {
        return Err(format!("Card encoding size {}", v.len()));
    }
    Ok(v)
}
fn b(v: &Value) -> f64 {
    if truth(v) { 1. } else { 0. }
}
pub fn refresh(s: &Value) -> Result<Value> {
    let m = crate::primitives::make(
        catalog().data["minionPool"][0]
            .as_str()
            .ok_or("Empty catalog")?,
        "observation",
        false,
        false,
    )?;
    Ok(prices::prices(s, &m)?["refreshPayment"].clone())
}
pub fn observe(s: &Value, steps: f64, limit: f64) -> Result<Value> {
    action_space::bounds(s)?;
    let st = &s["season"];
    let p = refresh(s)?;
    let mut v = vec![
        num(&s["turn"]) / 50.,
        num(&s["tier"]) / 6.,
        scale(num(&s["gold"]), 10.),
        scale(num(&st["maxGold"]), 10.),
        scale(num(&s["health"]), 40.),
        scale(num(&st["armor"]), 40.),
        scale(num(&s["upgrade"]), 10.),
        b(&s["frozen"]),
        hero_id(&s["hero"]),
        scale(num(&s["triples"]), 10.),
        scale(num(&s["purchases"]), 20.),
        scale(num(&s["refreshes"]), 20.),
        num(&st["giftsUsed"]) / 3.,
        if st["giftUsedTurn"] == s["turn"] {
            1.
        } else {
            0.
        },
        (steps / limit).min(1.),
        scale(num(&p["gold"]), 10.),
        scale(num(&p["health"]), 10.),
        scale(num(&p["remaining"]), 5.),
        scale(num(&st["spellDiscount"]), 10.),
        scale(num(&st["nextGold"]), 10.),
    ];
    for t in arr(&catalog().data["tribes"]) {
        v.push(if arr(&st["tribes"]).contains(t) {
            1.
        } else {
            0.
        })
    }
    v.extend(counter_features(&st["counters"], 32));
    for (z, n) in [
        (&s["board"], 7),
        (&s["shop"], 16),
        (&st["spellShop"], 7),
        (&s["hand"], 10),
        (&s["discovery"], 4),
    ] {
        for i in 0..n {
            v.extend(card(&z[i], s)?)
        }
    }
    for (z, n, key) in [
        (&s["shop"], 16, "minionCost"),
        (&st["spellShop"], 7, "spellCost"),
    ] {
        for i in 0..n {
            v.push(if z[i].is_null() {
                0.
            } else {
                scale(num(&prices::prices(s, &z[i])?[key]), 10.)
            })
        }
    }
    for i in 0..7 {
        let o = &s["opponents"][i];
        if o.is_null() {
            v.extend([0.; 6])
        } else {
            v.extend([
                1.,
                hero_id(&o["hero"]),
                scale(num(&o["health"]), 40.),
                scale(num(&o["armor"]), 40.),
                num(&o["tier"]) / 6.,
                if num(&s["nextOpponent"]) == i as f64 {
                    1.
                } else {
                    0.
                },
            ])
        }
    }
    let ps = powers::equipped(s);
    for i in 0..2 {
        if let Some(id) = ps.get(i) {
            let p = powers::state(s, id.as_str().ok_or("Invalid power")?)?;
            v.extend([
                hero_id(id),
                scale(num(&p["cost"]), 10.),
                scale(num(&p["remaining"]), 5.),
                b(&p["reason"]),
            ])
        } else {
            v.extend([0.; 4])
        }
    }
    for i in 0..4 {
        v.push(hero_id(&st["powerChoice"]["offers"][i]));
        v.push(index(&st["trinketOffers"][i], &catalog().data["trinkets"]))
    }
    for i in 0..2 {
        v.push(index(&st["trinkets"][i], &catalog().data["trinkets"]))
    }
    for i in 0..10 {
        v.push(num(&s["rewards"][i]) / 6.)
    }
    for i in 0..7 {
        v.extend(card(&st["lastEnemy"][i], s)?)
    }
    let mut seats = vec![s];
    seats.extend(arr(&s["opponents"]));
    for i in 0..8 {
        let seat = seats.get(i).copied().unwrap_or(&Value::Null);
        let armor = if i == 0 {
            &st["spellArmor"]
        } else {
            &seat["spellArmor"]
        };
        v.extend([
            seat.get("seatIndex")
                .map(|x| (num(x) + 1.) / 8.)
                .unwrap_or(0.),
            scale(num(armor), 40.),
            scale(if seat.is_null() { 0. } else { ranking(seat) }, 40.),
        ]);
        let rounds = scouting(s, &seat["scouting"])?;
        for age in 1..=2 {
            let r = arr(&rounds)
                .iter()
                .find(|r| num(&r["turn"]) == num(&s["turn"]) - age as f64)
                .unwrap_or(&Value::Null);
            let battle = &r["battle"];
            v.extend([
                b(r),
                num(&r["turn"]) / 50.,
                num(&r["warband"]["count"]) / 7.,
            ]);
            for t in WARBANDS {
                v.push(if r["warband"]["type"] == t { 1. } else { 0. })
            }
            v.push(b(battle));
            for t in ["win", "loss", "tie"] {
                v.push(if battle["result"] == t { 1. } else { 0. })
            }
            v.push(scale(num(&battle["damage"]), 40.));
            for j in 0..9 {
                v.push(if battle["opponentSeat"] == j { 1. } else { 0. })
            }
        }
    }
    Ok(json!(v))
}
fn copy(to: &mut Value, from: &Value, keys: &[&str]) {
    for k in keys {
        if let Some(v) = from.get(*k) {
            to[*k] = v.clone()
        }
    }
}
fn card_details(m: &Value, refs: &HashMap<String, i64>, historical: bool) -> Value {
    let mut out = json!({});
    copy(
        &mut out,
        m,
        &[
            "discardGroup",
            "attack",
            "health",
            "golden",
            "keywords",
            "lockedUntil",
            "lockedTier",
            "bothChoices",
            "magneticCount",
            "learnedSpell",
            "gift",
            "giftTurn",
            "activated",
            "temporary",
            "extraAbilities",
            "expires",
            "tempSpell",
            "gems",
            "reward",
            "rebornNext",
        ],
    );
    if !historical {
        copy(&mut out, m, &["counters"]);
        if let Some(xs) = m["remembered"].as_array() {
            out["remembered"] = json!(xs.iter().map(|x| ref_uid(refs, x)).collect::<Vec<_>>())
        }
    }
    out
}
fn ref_uid(refs: &HashMap<String, i64>, uid: &Value) -> i64 {
    uid.as_str()
        .and_then(|x| refs.get(x))
        .copied()
        .unwrap_or(-1)
}
pub fn entities(s: &Value, decisions: f64, budget: f64) -> Result<Value> {
    action_space::bounds(s)?;
    let st = &s["season"];
    let ids = entity_ids();
    let identity = |id: &Value| -> Result<usize> {
        ids.iter()
            .position(|s| Some(s.as_str()) == id.as_str())
            .map(|i| i + 1)
            .ok_or_else(|| format!("Unknown entity identity {id}"))
    };
    let mut result = vec![Value::Null; 73];
    let zones = [
        &s["board"],
        &s["shop"],
        &st["spellShop"],
        &s["hand"],
        &s["discovery"],
        &st["lastEnemy"],
    ];
    let mut refs = HashMap::new();
    for (z, cs) in zones.iter().take(5).enumerate() {
        for (i, m) in arr(cs).iter().enumerate() {
            refs.insert(
                m["uid"].as_str().ok_or("Missing uid")?.to_string(),
                (OFFSETS[z + 1] + i) as i64,
            );
        }
    }
    let mut put = |zone: usize, position: usize, id: usize, details: Value| -> Result<()> {
        if position >= SIZES[zone] {
            return Err(format!("Entity overflow {}", ZONES[zone]));
        }
        result[OFFSETS[zone] + position] =
            json!({"id":id,"zone":zone,"position":position,"details":details});
        Ok(())
    };
    let mut g = json!({"decisions":decisions,"budget":budget,"spellArmor":num(&st["spellArmor"]),"rankingHealth":ranking(s),"scouting":scouting(s,&s["scouting"])?,"extraTrinkets":arr(&st["trinkets"]).iter().skip(4).collect::<Vec<_>>(),"refreshPayment":refresh(s)?});
    copy(
        &mut g,
        s,
        &[
            "turn",
            "tier",
            "gold",
            "health",
            "seatIndex",
            "upgrade",
            "frozen",
            "powerUsed",
            "triples",
            "purchases",
            "refreshes",
            "rewards",
            "pogo",
        ],
    );
    copy(
        &mut g,
        st,
        &[
            "armor",
            "deity",
            "trinketPower",
            "kiriSlot",
            "tribes",
            "freeRefresh",
            "nextGold",
            "maxGold",
            "giftsUsed",
            "giftUsedTurn",
            "discoveryKind",
            "trinketDone",
            "buffs",
            "fodder",
            "spellDiscount",
            "healthRefreshes",
            "healthRefreshUses",
            "playedTurn",
            "goldenPlayed",
            "spellsCast",
            "lastSpell",
            "battlecries",
            "deaths",
            "trinketBuys",
            "counters",
            "combatEffects",
            "goldSpentTurn",
            "boughtTurn",
            "lastDead",
            "cookieTribes",
            "powerCycle",
            "nozdormuRefreshTurn",
        ],
    );
    if !s["aiActionUsage"].is_null() {
        g["aiActionLimits"] = action_space::public_limits(s)?
    }
    g["trinketData"] = json!({});
    if let Some(obj) = st["trinketData"].as_object() {
        for (k, v) in obj {
            let mut d = json!({});
            copy(&mut d, v, &["turn", "type", "card"]);
            g["trinketData"][k] = d;
        }
    }
    g["heroMarks"] = json!({});
    if let Some(obj) = st["heroMarks"].as_object() {
        for (k, v) in obj {
            g["heroMarks"][k] = if k == "tavishId" {
                v.clone()
            } else {
                json!(ref_uid(&refs, v))
            }
        }
    }
    if let Some(xs) = st["frozenMinions"].as_array() {
        g["frozenMinions"] = json!(xs.iter().map(|x| ref_uid(&refs, x)).collect::<Vec<_>>())
    }
    if let Some(xs) = st["delayed"].as_array() {
        g["delayed"] = json!(
            xs.iter()
                .map(|x| {
                    let mut x = x.clone();
                    let uid = x
                        .as_object_mut()
                        .unwrap()
                        .remove("uid")
                        .unwrap_or(Value::Null);
                    x["target"] = json!(ref_uid(&refs, &uid));
                    x
                })
                .collect::<Vec<_>>()
        )
    }
    if let Some(v) = st["powerChoice"].get("mode") {
        g["powerChoiceMode"] = v.clone()
    }
    if let Some(v) = st["powerChoice"].get("selected") {
        g["selectedPowers"] = v.clone()
    }
    g["pendingDiscoveries"] = json!(
        arr(&st["pendingDiscoveries"])
            .iter()
            .map(|r| {
                let mut x = json!({});
                copy(
                    &mut x,
                    r,
                    &["kind", "mechanic", "tiers", "tribe", "magnetic", "both"],
                );
                x
            })
            .collect::<Vec<_>>()
    );
    if truth(&st["activeDiscovery"]) {
        let a = &st["activeDiscovery"];
        let mut x = json!({"magnetizeTarget":ref_uid(&refs,&a["magnetizeTarget"]),"replaceShop":ref_uid(&refs,&a["replaceShop"])});
        copy(
            &mut x,
            a,
            &[
                "kind",
                "mechanic",
                "both",
                "damage",
                "lockedUntil",
                "doomedTurn",
                "bothChoices",
            ],
        );
        if truth(&a["source"]) {
            let mut d = card_details(&a["source"], &refs, false);
            d["id"] = a["source"]["id"].clone();
            x["source"] = d
        }
        g["activeDiscovery"] = x
    }
    if !s["battles"][0].is_null() {
        let mut x = json!({});
        copy(&mut x, &s["battles"][0], &["turn", "result", "damage"]);
        g["lastBattle"] = x
    }
    put(0, 0, identity(&s["hero"])?, g)?;
    for (i, cards) in zones.iter().enumerate() {
        for (position, m) in arr(cards).iter().enumerate() {
            let mut d = card_details(m, &refs, i == 5);
            if i == 1 || i == 2 {
                d["buyCost"] =
                    prices::prices(s, m)?[if i == 1 { "minionCost" } else { "spellCost" }].clone()
            }
            put(i + 1, position, identity(&m["id"])?, d)?
        }
    }
    for (i, o) in arr(&s["opponents"]).iter().enumerate() {
        let mut d = json!({"health":o["health"],"armor":num(&o["armor"]),"tier":o["tier"],"next":num(&s["nextOpponent"])==i as f64,"spellArmor":num(&o["spellArmor"]),"rankingHealth":ranking(o),"scouting":scouting(s,&o["scouting"])?});
        copy(&mut d, o, &["seatIndex"]);
        put(7, i, identity(&o["hero"])?, d)?
    }
    for (i, id) in powers::equipped(s).iter().enumerate() {
        let name = id.as_str().ok_or("Invalid power")?;
        let p = powers::state(s, name)?;
        let mut d = powers::progress(s, name);
        d["cost"] = p["cost"].clone();
        d["remaining"] = p["remaining"].clone();
        d["unavailable"] = json!(truth(&p["reason"]));
        put(8, i, identity(id)?, d)?
    }
    for (z, xs) in [
        (9, &st["powerChoice"]["offers"]),
        (10, &st["trinketOffers"]),
        (11, &st["trinkets"]),
    ] {
        for (i, id) in arr(xs).iter().take(SIZES[z]).enumerate() {
            put(z, i, identity(id)?, json!({}))?
        }
    }
    Ok(json!(result))
}
pub fn entity_schema() -> Value {
    if catalog().data["entitySchema"].is_object() { return catalog().data["entitySchema"].clone(); }
    let ids = entity_ids();
    let mut ds = json!({});
    let identity = |id: &Value| {
        ids.iter()
            .position(|x| Some(x.as_str()) == id.as_str())
            .map(|i| (i + 1).to_string())
            .unwrap()
    };
    for c in arr(&catalog().data["cards"]) {
        let mut d =
            json!({"kind":c["kind"].as_str().unwrap_or("minion"),"abilities":arr(&c["abilities"])});
        copy(
            &mut d,
            c,
            &[
                "tier",
                "attack",
                "health",
                "cost",
                "effect",
                "spellSchool",
                "mechanics",
                "token",
                "tribe",
                "races",
                "keywords",
                "magnetic",
                "activateCost",
                "goldenAttack",
                "goldenHealth",
            ],
        );
        ds[identity(&c["id"])] = d
    }
    for id in hero_ids() {
        if let Some(h) = arr(&catalog().data["heroes"])
            .iter()
            .find(|h| h["id"] == id)
        {
            let mut d = json!({"kind":"hero"});
            copy(&mut d, h, &["cost", "passive"]);
            ds[identity(&json!(id))] = d
        }
    }
    for (key, kind) in [("trinkets", "trinket"), ("gifts", "gift")] {
        for c in arr(&catalog().data[key]) {
            ds[identity(&c["id"])] = json!({"kind":kind})
        }
    }
    ds[identity(&json!("s14_trinket"))] = json!({"kind":"hero","cost":0,"passive":true});
    json!({"version":3,"ids":ids,"definitions":ds,"zones":ZONES,"sizes":SIZES,"offsets":OFFSETS,"count":73})
}
