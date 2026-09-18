use crate::{Result, abilities, arr, catalog, def, has, num, str_field, tribe};
use serde_json::{Value, json};
use tavern_combat_prototype::Random;
fn counter(s: &Value, k: &str) -> f64 {
    num(&s["season"]["counters"][k])
}
fn types(id: &str) -> &'static [Value] {
    arr(&catalog().data["trinketTypes"][id]["types"])
}
fn owns_type(m: &Value) -> Result<bool> {
    for t in arr(&catalog().data["tribes"]) {
        if tribe(m, t.as_str().ok_or("Invalid tribe")?)? {
            return Ok(true);
        }
    }
    Ok(false)
}
pub fn cost(s: &Value, id: &str) -> Value {
    if !s["season"]["trinketOfferCosts"][id].is_null() {
        return s["season"]["trinketOfferCosts"][id].clone();
    }
    arr(&catalog().data["trinkets"])
        .iter()
        .find(|t| t["id"] == id)
        .map(|t| t["cost"].clone())
        .unwrap_or(json!(0))
}
pub fn eligible(s: &Value, id: &str) -> Result<bool> {
    let board = arr(&s["board"]);
    let hand = arr(&s["hand"]);
    let st = &s["season"];
    let mut owned: Vec<&Value> = board.iter().collect();
    for m in hand {
        if def(str_field(m, "id")?)?["kind"] != "spell" {
            owned.push(m);
        }
    }
    let power = |key: &str| crate::powers::has(s, key);
    if id == "BG36_MagicItem_411" && crate::powers::equipped(s).len() >= 2 {
        return Ok(false);
    }
    if [
        "BG30_MagicItem_888",
        "BG30_MagicItem_891",
        "BG32_MagicItem_271",
    ]
    .contains(&id)
        && (power("marin") || power("buttons"))
    {
        return Ok(false);
    }
    if id == "BG32_MagicItem_400" && board.len() < 6 {
        return Ok(false);
    }
    if [
        "BG35_MagicItem_152",
        "BG30_MagicItem_701",
        "BG30_MagicItem_541",
    ]
    .contains(&id)
    {
        let mut found = false;
        for m in board {
            found |= has(m, "rewind")?;
        }
        if !found {
            return Ok(false);
        }
    }
    if ["BG35_MagicItem_301", "BG35_MagicItem_741"].contains(&id) && num(&s["tier"]) < 3. {
        return Ok(false);
    }
    if id == "BG35_MagicItem_815" && owned.len() >= 5 {
        return Ok(false);
    }
    if id == "BG35_MagicItem_817" {
        let mut found = false;
        for m in board {
            found |= num(&def(str_field(m, "id")?)?["tier"]) == 3.;
        }
        if !found {
            return Ok(false);
        }
    }
    if id == "BG30_MagicItem_998" && arr(&st["tribes"]).iter().any(|t| t == "恶魔") {
        return Ok(false);
    }
    if ["BG35_MagicItem_861", "BG36_MagicItem_390"].contains(&id) && counter(s, "soldBaller") == 0.
    {
        return Ok(false);
    }
    if ["BG35_MagicItem_154", "BG35_MagicItem_156"].contains(&id)
        && !st["buffs"].as_object().is_some_and(|o| {
            o.iter().any(|(k, v)| {
                k.to_lowercase().contains("shop") && num(&v["attack"]) + num(&v["health"]) > 0.
            })
        })
    {
        return Ok(false);
    }
    if id == "BG35_MagicItem_754" {
        let mut found = false;
        for m in hand {
            found |= def(str_field(m, "id")?)?["kind"] != "spell" && num(&m["attack"]) >= 10.;
        }
        if !found {
            return Ok(false);
        }
    }
    if id == "BG32_MagicItem_306" {
        let mut found = false;
        for m in board {
            found |= abilities(m)?.iter().any(|a| a["event"] == "death");
        }
        if !found {
            return Ok(false);
        }
    }
    if id == "BG35_MagicItem_820" && num(&s["health"]) + num(&st["armor"]) >= 16. {
        return Ok(false);
    }
    if [
        "BG30_MagicItem_422",
        "BG30_MagicItem_422t",
        "BG32_MagicItem_801t",
    ]
    .contains(&id)
        && num(&st["buffs"]["spell"]["attack"]) + num(&st["buffs"]["spell"]["health"]) <= 0.
    {
        return Ok(false);
    }
    if id == "BG35_MagicItem_812" && power("clockwork") {
        return Ok(false);
    }
    if ["BG35_MagicItem_821", "BG35_MagicItem_821t"].contains(&id) && power("voone") {
        return Ok(false);
    }
    if ["BG30_MagicItem_847", "BG30_MagicItem_996"].contains(&id) && power("gallywix") {
        return Ok(false);
    }
    if id == "BG30_MagicItem_821" && power("greybough") {
        return Ok(false);
    }
    if id == "BG36_MagicItem_370" && board.is_empty() {
        return Ok(false);
    }
    if id == "BG30_MagicItem_403" {
        let mut n = 0;
        for m in owned {
            if !owns_type(m)? {
                n += 1;
            }
        }
        if n < 3 {
            return Ok(false);
        }
    }
    Ok(true)
}
fn pick_index(rng: &mut Random, len: usize) -> usize {
    ((rng.next_u32() as f64 / 4294967296.) * len as f64).floor() as usize
}
pub fn offer(mut s: Value, school: &str, seed: u32) -> Result<Value> {
    let mut rng = Random {
        state: seed,
        draws: 0,
    };
    let threshold = if school == "LESSER_TRINKET" { 2 } else { 3 };
    let mut owned: Vec<&Value> = arr(&s["board"]).iter().collect();
    for m in arr(&s["hand"]) {
        if def(str_field(m, "id")?)?["kind"] != "spell" {
            owned.push(m);
        }
    }
    let hero_types: Vec<Value> = crate::powers::equipped(&s)
        .iter()
        .filter_map(|id| id.as_str())
        .map(|id| catalog().data["heroTribes"][id].clone())
        .collect();
    let mut in_types = vec![];
    for t in arr(&catalog().data["tribes"]) {
        let mut n = 0;
        for m in &owned {
            if tribe(m, t.as_str().ok_or("Invalid tribe")?)? {
                n += 1;
            }
        }
        if n >= threshold || hero_types.contains(t) {
            in_types.push((t.clone(), n));
        }
    }
    let maximum = in_types.iter().map(|(_, n)| *n).max().unwrap_or(0);
    let tied: Vec<Value> = in_types
        .iter()
        .filter(|(_, n)| *n == maximum)
        .map(|(t, _)| t.clone())
        .collect();
    let majority = tied.get(pick_index(&mut rng, tied.len())).cloned();
    let mut pool: Vec<&Value> = vec![];
    for t in arr(&catalog().data["trinkets"]) {
        let id = str_field(t, "id")?;
        let races = types(id);
        if t["school"] != school
            || arr(&s["season"]["trinkets"]).iter().any(|x| x == id)
            || !eligible(&s, id)?
        {
            continue;
        }
        if !races.is_empty()
            && !races
                .iter()
                .any(|r| arr(&s["season"]["tribes"]).contains(r))
        {
            continue;
        }
        if id == "BG36_MagicItem_390" && counter(&s, "soldBaller") <= 0. {
            continue;
        }
        pool.push(t);
    }
    for i in (1..pool.len()).rev() {
        let j = pick_index(&mut rng, i + 1);
        pool.swap(i, j);
    }
    let mut costs = serde_json::Map::new();
    for t in &pool {
        let id = str_field(t, "id")?;
        let races = types(id);
        let discount =
            if !races.is_empty() && !races.iter().any(|r| in_types.iter().any(|(t, _)| t == r)) {
                2.
            } else {
                0.
            };
        costs.insert(id.into(), json!((num(&t["cost"]) - discount).max(0.)));
    }
    let travel = [
        "BG30_MagicItem_888",
        "BG30_MagicItem_891",
        "BG32_MagicItem_271",
    ];
    let mut offers: Vec<&Value> = vec![];
    // Four preference passes preserve shuffled ordering and all compatibility checks.
    for pass in 0..7 {
        if pass == 0 && majority.is_none() {
            continue;
        }
        if pass == 2
            && offers
                .iter()
                .any(|t| num(&costs[t["id"].as_str().unwrap()]) <= 2.)
        {
            continue;
        }
        if pass >= 3 && offers.len() >= 4 {
            break;
        }
        let found = pool
            .iter()
            .find(|t| {
                let id = t["id"].as_str().unwrap();
                let races = types(id);
                let preferred = match pass {
                    0 => races.iter().any(|r| Some(r) == majority.as_ref()),
                    1 => races.is_empty(),
                    2 => num(&costs[id]) <= 2.,
                    _ => true,
                };
                preferred
                    && !offers.contains(t)
                    && !(travel.contains(&id)
                        && offers
                            .iter()
                            .any(|o| travel.contains(&o["id"].as_str().unwrap())))
                    && !races.iter().any(|race| {
                        Some(race) != majority.as_ref()
                            && offers
                                .iter()
                                .any(|other| types(other["id"].as_str().unwrap()).contains(race))
                    })
            })
            .copied();
        if let Some(t) = found {
            offers.push(t);
        } else if pass >= 3 {
            break;
        }
    }
    let mut offer_types = serde_json::Map::new();
    let mut offer_costs = serde_json::Map::new();
    for t in &offers {
        let id = str_field(t, "id")?;
        offer_costs.insert(id.into(), costs[id].clone());
        if str_field(t, "text")?.contains("92") {
            let ty = if let Some(t) = &majority {
                Some(t.clone())
            } else {
                let ts = arr(&s["season"]["tribes"]);
                ts.get(pick_index(&mut rng, ts.len())).cloned()
            };
            if let Some(t) = ty {
                offer_types.insert(id.into(), t);
            }
        }
    }
    s["season"]["trinketOfferTypes"] = Value::Object(offer_types);
    s["season"]["trinketOfferCosts"] = Value::Object(offer_costs);
    s["season"]["trinketOffers"] =
        json!(offers.iter().map(|t| t["id"].clone()).collect::<Vec<_>>());
    Ok(json!({"state":s,"rng":rng.state,"draws":rng.draws}))
}
