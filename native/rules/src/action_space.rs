use crate::{Result, arr, def, num, powers, prices, targets, truth};
use serde_json::{Value, json};
pub const SIZES: [usize; 8] = [7, 16, 10, 7, 4, 2, 4, 4];
pub fn actions() -> Vec<Value> {
    let mut out = vec![];
    for (t, n, m, p) in [
        ("end", 1, 1, 1),
        ("refresh", 1, 1, 1),
        ("freeze", 1, 1, 1),
        ("upgrade", 1, 1, 1),
        ("reward", 1, 1, 1),
        ("darkGift", 1, 1, 1),
        ("buy", 16, 1, 1),
        ("buySpell", 7, 1, 1),
        ("sell", 7, 1, 1),
        ("move", 7, 1, 7),
        ("play", 10, 41, 8),
        ("cast", 10, 41, 1),
        ("activate", 7, 41, 1),
        ("power", 2, 41, 1),
        ("discover", 4, 41, 1),
        ("choosePower", 4, 1, 1),
        ("buyTrinket", 4, 1, 1),
    ] {
        for source in 0..n {
            for target in 0..m {
                for position in 0..p {
                    out.push(json!({"type":t,"source":source,"target":target,"position":position}));
                }
            }
        }
    }
    out
}
pub fn bounds(s: &Value) -> Result<()> {
    let ps = powers::equipped(s);
    let zones = [
        &s["board"],
        &s["shop"],
        &s["hand"],
        &s["season"]["spellShop"],
        &s["discovery"],
        &json!(ps),
        &s["season"]["powerChoice"]["offers"],
        &s["season"]["trinketOffers"],
    ];
    for (i, name) in [
        "board",
        "shop",
        "hand",
        "spellShop",
        "discovery",
        "powers",
        "powerChoice",
        "trinketOffers",
    ]
    .iter()
    .enumerate()
    {
        if arr(zones[i]).len() > SIZES[i] {
            return Err(format!(
                "Unsupported {name} size {}; update action schema before training",
                arr(zones[i]).len()
            ));
        }
    }
    Ok(())
}
pub fn usage(s: &Value) -> Value {
    if s["aiActionUsage"]["turn"] == s["turn"] {
        s["aiActionUsage"].clone()
    } else {
        json!({"turn":s["turn"],"freezes":0,"moves":0})
    }
}
pub fn freeze_offers(s: &Value) -> Result<Value> {
    let mut shop = vec![];
    let mut spells = vec![];
    for (i, m) in arr(&s["shop"]).iter().enumerate() {
        if num(&prices::prices(s, m)?["minionCost"]) > num(&s["gold"]) {
            shop.push(i)
        }
    }
    for (i, m) in arr(&s["season"]["spellShop"]).iter().enumerate() {
        let p = prices::prices(s, m)?;
        if !truth(&p["spellUsesHealth"]) && num(&p["spellCost"]) > num(&s["gold"]) {
            spells.push(i)
        }
    }
    Ok(json!({"shop":shop,"spellShop":spells}))
}
pub fn ai_error(s: &Value, a: &Value) -> Result<Option<String>> {
    if !truth(&s["aiActionUsage"]) {
        return Ok(None);
    }
    let u = usage(s);
    let t = a["type"].as_str().unwrap_or("");
    let error = if truth(&u["freezeClosing"]) && t != "end" && t != "continue" {
        Some("人机已确认冻结收尾，请结束招募。")
    } else if t == "freeze" {
        if num(&u["freezes"]) >= 1. {
            Some("人机本回合只能确认一次冻结收尾。")
        } else if !truth(&s["frozen"]) && {
            let f = freeze_offers(s)?;
            arr(&f["shop"]).is_empty() && arr(&f["spellShop"]).is_empty()
        } {
            Some("没有因金币不足而买不起的商店牌，无需冻结。")
        } else {
            None
        }
    } else if t == "move" {
        if num(&u["moves"]) >= 6. {
            Some("人机本回合最多换位6次。")
        } else {
            let mut ids: Vec<Value> = arr(&s["board"]).iter().map(|m| m["uid"].clone()).collect();
            let orig = ids.clone();
            if let (Some(from), Some(to)) =
                (ids.iter().position(|x| x == &a["uid"]), a["to"].as_i64())
            {
                let id = ids.remove(from);
                ids.insert(to.max(0).min(ids.len() as i64) as usize, id);
                if ids == orig {
                    Some("换位没有改变站位。")
                } else if arr(&u["previousMoveOrder"]) == ids {
                    Some("人机不能立即撤销上一次换位。")
                } else {
                    None
                }
            } else {
                Some("无效的换位目标。")
            }
        }
    } else {
        None
    };
    Ok(error.map(str::to_string))
}
pub fn public_limits(s: &Value) -> Result<Value> {
    if !truth(&s["aiActionUsage"]) {
        return Ok(Value::Null);
    }
    let u = usage(s);
    let mut result = json!({"version":2,"freezeRemaining":(1.-num(&u["freezes"])).max(0.),"moveRemaining":(6.-num(&u["moves"])).max(0.),"freezeClosing":truth(&u["freezeClosing"]),"freezeOffers":freeze_offers(s)?});
    if let Some(order) = u["previousMoveOrder"].as_array() {
        let mapped: Vec<i64> = order
            .iter()
            .map(|uid| {
                arr(&s["board"])
                    .iter()
                    .position(|m| &m["uid"] == uid)
                    .map(|x| x as i64)
                    .unwrap_or(-1)
            })
            .collect();
        if mapped.len() == arr(&s["board"]).len() && mapped.iter().all(|x| *x >= 0) {
            result["undoOrder"] = json!(mapped)
        }
    }
    Ok(result)
}
pub fn candidates(s: &Value, end_only: bool) -> Result<Value> {
    bounds(s)?;
    let specs = actions();
    let mut out = Vec::new();
    let mut target_slots = vec![Value::Null];
    for (z, n) in [
        (&s["board"], 7),
        (&s["shop"], 16),
        (&s["season"]["spellShop"], 7),
        (&s["hand"], 10),
    ] {
        for i in 0..n {
            target_slots.push(z[i]["uid"].clone())
        }
    }
    let target_index = |m: &Value| -> Result<usize> {
        target_slots
            .iter()
            .position(|v| v == &m["uid"])
            .ok_or("Unencoded target zone".into())
    };
    let mut put = |a: Value, source: usize, target: usize, position: usize| -> Result<()> {
        if ai_error(s, &a)?.is_none() {
            let id = specs
                .iter()
                .position(|x| {
                    x["type"] == a["type"]
                        && x["source"] == source
                        && x["target"] == target
                        && x["position"] == position
                })
                .ok_or("Action encoding overflow")?;
            out.push(json!([id, a]));
        }
        Ok(())
    };
    let st = &s["season"];
    if truth(&st["powerChoice"]) {
        for (i, uid) in arr(&st["powerChoice"]["offers"]).iter().enumerate() {
            put(json!({"type":"choosePower","uid":uid}), i, 0, 0)?
        }
        return Ok(json!(out));
    }
    if !arr(&s["discovery"]).is_empty() {
        for (i, m) in arr(&s["discovery"]).iter().enumerate() {
            let ts = if st["discoveryKind"] == "choose" {
                targets::targets(s, m, "cast")?
            } else {
                json!([])
            };
            if arr(&ts).is_empty() {
                put(json!({"type":"discover","uid":m["uid"]}), i, 0, 0)?
            } else {
                for t in arr(&ts) {
                    put(
                        json!({"type":"discover","uid":m["uid"],"target":t["uid"]}),
                        i,
                        target_index(t)?,
                        0,
                    )?
                }
            }
        }
        return Ok(json!(out));
    }
    if !arr(&st["trinketOffers"]).is_empty() {
        for (i, uid) in arr(&st["trinketOffers"]).iter().enumerate() {
            put(json!({"type":"buyTrinket","uid":uid}), i, 0, 0)?
        }
        return Ok(json!(out));
    }
    put(json!({"type":"end"}), 0, 0, 0)?;
    if end_only || (truth(&s["aiActionUsage"]) && truth(&usage(s)["freezeClosing"])) {
        return Ok(json!(out));
    }
    for t in ["refresh", "freeze", "upgrade", "reward", "darkGift"] {
        put(json!({"type":t}), 0, 0, 0)?
    }
    for (t, z) in [("buy", &s["shop"]), ("buySpell", &st["spellShop"])] {
        for (i, m) in arr(z).iter().enumerate() {
            put(json!({"type":t,"uid":m["uid"]}), i, 0, 0)?
        }
    }
    for (i, m) in arr(&s["board"]).iter().enumerate() {
        put(json!({"type":"sell","uid":m["uid"]}), i, 0, 0)?;
        for j in 0..arr(&s["board"]).len() {
            if i != j {
                put(json!({"type":"move","uid":m["uid"],"to":j}), i, 0, j)?
            }
        }
        let ts = targets::targets(s, m, "activate")?;
        if arr(&ts).is_empty() {
            put(json!({"type":"activate","uid":m["uid"]}), i, 0, 0)?
        } else {
            for t in arr(&ts) {
                put(
                    json!({"type":"activate","uid":m["uid"],"target":t["uid"]}),
                    i,
                    target_index(t)?,
                    0,
                )?
            }
        }
    }
    for (i, m) in arr(&s["hand"]).iter().enumerate() {
        let d = def(m["id"].as_str().ok_or("Missing card id")?)?;
        let spell = d["kind"] == "spell";
        let ts = targets::targets(s, m, if spell { "cast" } else { "battlecry" })?;
        if spell {
            if arr(&ts).is_empty() {
                put(json!({"type":"cast","uid":m["uid"]}), i, 0, 0)?
            } else {
                for t in arr(&ts) {
                    put(
                        json!({"type":"cast","uid":m["uid"],"target":t["uid"]}),
                        i,
                        target_index(t)?,
                        0,
                    )?
                }
            }
        } else {
            let mut choices = arr(&ts).to_vec();
            if truth(&d["magnetic"]) || choices.is_empty() {
                choices.insert(0, Value::Null)
            }
            for t in choices {
                let positions = if truth(&d["magnetic"]) && !t.is_null() {
                    1
                } else {
                    arr(&s["board"]).len().min(7) + 1
                };
                for p in 0..positions {
                    let mut a = json!({"type":"play","uid":m["uid"],"position":p});
                    if !t.is_null() {
                        a["target"] = t["uid"].clone()
                    }
                    put(a, i, if t.is_null() { 0 } else { target_index(&t)? }, p)?
                }
            }
        }
    }
    for (i, id) in powers::equipped(s).iter().enumerate() {
        let p = powers::state(s, id.as_str().ok_or("Invalid power id")?)?;
        if truth(&p["reason"]) {
            continue;
        }
        if !truth(&p["needsTarget"]) {
            put(json!({"type":"power","powerId":id}), i, 0, 0)?
        } else {
            for t in arr(&p["targets"]) {
                put(
                    json!({"type":"power","powerId":id,"target":t["uid"]}),
                    i,
                    target_index(t)?,
                    0,
                )?
            }
        }
    }
    Ok(json!(out))
}
