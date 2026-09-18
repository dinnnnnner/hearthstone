use crate::{Result, abilities, arr, catalog, def, has, num, str_field, truth, validate_minion};
use serde_json::{Map, Value, json};

pub fn make(id: &str, uid: &str, golden: bool, pool: bool) -> Result<Value> {
    let d = def(id)?;
    let stat = |key: &str, g: &str| {
        if golden {
            d[g].as_f64().unwrap_or(num(&d[key]) * 2.)
        } else {
            num(&d[key])
        }
    };
    Ok(
        json!({"uid":uid,"id":id,"attack":stat("attack","goldenAttack"),"health":stat("health","goldenHealth"),"golden":golden,
        "keywords":d.get("keywords").cloned().unwrap_or(json!([])),"copies":if pool {json!({id:if golden {3}else{1}})}else{json!({})}}),
    )
}
pub fn golden(mut m: Value) -> Result<Value> {
    validate_minion(&m)?;
    if truth(&m["golden"]) {
        return Ok(m);
    }
    let d = def(str_field(&m, "id")?)?;
    if m["id"] != "s14_BG36_205" {
        let a = d["goldenAttack"].as_f64().unwrap_or(num(&d["attack"]) * 2.) - num(&d["attack"]);
        let h = d["goldenHealth"].as_f64().unwrap_or(num(&d["health"]) * 2.) - num(&d["health"]);
        m["attack"] = json!((num(&m["attack"]) + a).max(0.));
        m["health"] = json!(num(&m["health"]) + h);
        if !m["counters"]["deathStatsHealth"].is_null() {
            m["counters"]["deathStatsHealth"] = json!(num(&m["counters"]["deathStatsHealth"]) + h);
        }
    }
    m["golden"] = json!(true);
    Ok(m)
}
fn unique(values: impl Iterator<Item = Value>) -> Value {
    let mut out = Vec::new();
    for v in values {
        if !out.contains(&v) {
            out.push(v)
        }
    }
    json!(out)
}
pub fn merge(parts: &[Value], uid: &str, reward: bool) -> Result<Value> {
    if !(2..=3).contains(&parts.len()) {
        return Err("Triple needs two or three supplied parts".into());
    }
    for m in parts {
        validate_minion(m)?;
        if truth(&m["golden"]) || truth(&m["learnedSpell"]) {
            return Err("Golden/learned-spell minions cannot form triples".into());
        }
    }
    let id = str_field(&parts[0], "id")?;
    for part in parts.iter().skip(1) {
        if part["id"] != id
            && !(crate::tribe(&parts[0], "元素")? && has(part, "elementalWildcard")?)
        {
            return Err("Unrelated triple parts".into());
        }
    }
    let mut g = make(id, uid, true, false)?;
    for key in ["attack", "health"] {
        let mut bonus = 0.;
        for p in parts {
            bonus += num(&p[key]) - num(&def(str_field(p, "id")?)?[key]);
        }
        g[key] = json!(num(&g[key]) + bonus);
    }
    g["magneticCount"] = json!(parts.iter().map(|p| num(&p["magneticCount"])).sum::<f64>());
    let mut keys = vec![
        "hammerAttack".to_owned(),
        "hammerHealth".into(),
        "volumizerAttack".into(),
        "volumizerHealth".into(),
        "discardGift".into(),
    ];
    for a in abilities(&g)?.iter().filter(|a| a["op"] == "globalStats") {
        for suffix in ["Attack", "Health"] {
            keys.push(format!("{}{suffix}", str_field(a, "key")?));
        }
    }
    if id == "s14_BG25_008" {
        keys.extend([
            "eternalPortraitAttack".into(),
            "eternalPortraitHealth".into(),
        ]);
    }
    if has(&g, "lowHeroHealth")? {
        keys.extend(["lowHeroHealthAttack".into(), "lowHeroHealthHealth".into()]);
    }
    let counters: Map<String, Value> = keys
        .into_iter()
        .map(|k| {
            let n = parts.iter().map(|p| num(&p["counters"][&k])).sum::<f64>();
            (k, json!(n))
        })
        .collect();
    g["counters"] = json!(counters);
    for key in ["keywords", "extraTribes"] {
        g[key] = unique(parts.iter().flat_map(|p| arr(&p[key]).iter().cloned()));
    }
    if let Some(part) = parts.iter().find(|p| truth(&p["gift"])) {
        for key in ["gift", "giftTurn"] {
            if let Some(value) = part.get(key) {
                g[key] = value.clone();
            }
        }
    }
    g["rebornNext"] = json!(parts.iter().any(|p| truth(&p["rebornNext"])));
    g["extraAbilities"] = json!(
        parts
            .iter()
            .flat_map(|p| arr(&p["extraAbilities"]).iter().cloned())
            .collect::<Vec<_>>()
    );
    let temporary: Vec<_> = parts.iter().filter_map(|p| p.get("temporary")).collect();
    if !temporary.is_empty() {
        g["temporary"] = json!({"attack":temporary.iter().map(|p|num(&p["attack"])).sum::<f64>(),"health":temporary.iter().map(|p|num(&p["health"])).sum::<f64>(),
            "keywords":unique(temporary.iter().flat_map(|p|arr(&p["keywords"]).iter().cloned()))});
    }
    for p in parts {
        for (id, n) in p["copies"].as_object().ok_or("Invalid pool copies")? {
            g["copies"][id] = json!(num(&g["copies"][id]) + num(n));
        }
    }
    g["reward"] = json!(reward);
    Ok(g)
}
pub fn copy_ability(m: &Value, a: &Value) -> Result<Value> {
    validate_minion(m)?;
    str_field(a, "op")?;
    str_field(a, "event")?;
    let factor = if truth(&m["golden"]) && !truth(&a["noScale"]) {
        2.
    } else {
        1.
    };
    let mut copy = a.clone();
    for key in ["attack", "health"] {
        if !a[key].is_null() {
            copy[key] = json!(num(&a[key]) * factor)
        }
    }
    let amount = a["amount"].as_f64().unwrap_or(1.);
    if a["op"] == "summon" {
        copy["amount"] = json!(if factor == 2. {
            a["goldenAmount"].as_f64().unwrap_or(amount)
        } else {
            amount
        });
        copy["summonGolden"] = json!(a["summonGolden"].as_bool().unwrap_or(factor == 2.));
    } else {
        copy["amount"] = json!(amount * factor)
    }
    copy["noScale"] = json!(true);
    Ok(copy)
}
pub fn assert_pool(s: &Value) -> Result<Value> {
    let initial = s["season"]["initialPool"]
        .as_object()
        .ok_or("Missing season initialPool")?;
    let mut held = Vec::new();
    for key in ["shop", "hand", "board", "discovery"] {
        held.extend(arr(&s[key]));
    }
    held.extend(arr(&s["season"]["pendingTrinketCards"]));
    if s["season"]["activeDiscovery"]["creationPart"].is_object() {
        held.push(&s["season"]["activeDiscovery"]["creationPart"]);
    }
    for r in arr(&s["season"]["pendingDiscoveries"]) {
        if r["creationPart"].is_object() {
            held.push(&r["creationPart"]);
        }
    }
    for o in arr(&s["opponents"]) {
        held.extend(arr(&o["board"]));
    }
    for (id, total) in initial {
        let n = num(&s["pool"][id]);
        let current = n + held.iter().map(|m| num(&m["copies"][id])).sum::<f64>();
        if n < 0. || current != num(total) {
            return Err(format!("Season pool mismatch {id}: {current}/{total}"));
        }
    }
    if arr(&s["hand"]).len() + arr(&s["rewards"]).len() > 10 {
        return Err("Season hand overflow".into());
    }
    Ok(json!(true))
}
pub fn draw(r: &Value) -> Result<Value> {
    let mut pool = r["pool"].as_object().ok_or("Missing pool")?.clone();
    let seed = r["seed"]
        .as_u64()
        .filter(|s| *s <= u32::MAX as u64)
        .ok_or("Seed must be uint32")?;
    let tier = r["tier"]
        .as_u64()
        .filter(|t| (1..=7).contains(t))
        .ok_or("Tier must be 1..7")?;
    let mut eligible = Vec::new();
    for id in arr(&catalog().data["minionPool"]) {
        let id = id.as_str().ok_or("Invalid catalog id")?;
        let d = def(id)?;
        let n = num(pool.get(id).unwrap_or(&Value::Null));
        if n > 0. && num(&d["tier"]) <= tier as f64 {
            eligible.push((id, n));
        }
    }
    let mut rng = tavern_combat_prototype::Random::new(seed as u32);
    let total: f64 = eligible.iter().map(|(_, n)| n).sum();
    let mut n = rng.next_u32() as f64 / 4294967296. * total;
    let mut picked = Value::Null;
    for (id, weight) in eligible {
        n -= weight;
        if n < 0. {
            pool.insert(id.into(), json!(weight - 1.));
            picked =
                crate::stats::global(&r["state"], make(id, str_field(r, "uid")?, false, true)?)?;
            break;
        }
    }
    Ok(json!({"pool":pool,"minion":picked,"rng":rng.state,"draws":rng.draws}))
}
