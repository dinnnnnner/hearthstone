use crate::{Result, abilities, arr, catalog, def, num, str_field, tribe, truth, validate_minion};
use serde_json::{Value, json};
pub fn targets(s: &Value, m: &Value, event: &str) -> Result<Value> {
    validate_minion(m)?;
    let d = def(str_field(m, "id")?)?;
    let board = arr(&s["board"]);
    let shop = arr(&s["shop"]);
    if truth(&d["magnetic"]) && event == "battlecry" {
        let mut out = vec![];
        for x in board {
            if tribe(x, "机械")? || (d["sourceId"] == "BG_DEEP_015" && tribe(x, "亡灵")?) {
                out.push(x.clone());
            }
        }
        return Ok(json!(out));
    }
    let all = abilities(m)?;
    let Some(a) = all.iter().find(|a| {
        a["event"] == event
            && ["selected", "selectedShop", "selectedHand"]
                .iter()
                .any(|t| a["target"] == *t)
    }) else {
        return Ok(json!([]));
    };
    if a["target"] == "selectedHand" {
        return Ok(s["hand"].clone());
    }
    if a["target"] == "selectedShop" {
        return Ok(json!(
            shop.iter()
                .chain(arr(&s["season"]["spellShop"]))
                .collect::<Vec<_>>()
        ));
    }
    let op = str_field(a, "op")?;
    let mut possible: Vec<&Value> = board.iter().collect();
    if event == "cast" && !["consume", "butchering", "sellTransfer"].contains(&op) {
        possible.extend(shop);
    }
    let mut out = vec![];
    for x in possible {
        if x["uid"] == m["uid"] {
            continue;
        }
        if let Some(t) = a["tribe"].as_str()
            && !tribe(x, t)?
        {
            continue;
        }
        if ["battlecry", "rally"].contains(&op) && !abilities(x)?.iter().any(|b| b["event"] == op) {
            continue;
        }
        let on_board = board.iter().any(|b| std::ptr::eq(b, x));
        if m["id"] == "s14_BG35_911" && !on_board {
            continue;
        }
        let xd = def(str_field(x, "id")?)?;
        if op == "golden"
            && (!on_board
                || truth(&x["golden"])
                || num(&xd["tier"]) > a["tier"].as_f64().filter(|n| *n != 0.).unwrap_or(6.))
        {
            continue;
        }
        if op == "deathrattle"
            && (!on_board || !abilities(x)?.iter().any(|b| b["event"] == "death"))
        {
            continue;
        }
        if op == "trinketCopy"
            && num(&xd["tier"]) > a["tier"].as_f64().filter(|n| *n != 0.).unwrap_or(3.)
        {
            continue;
        }
        if ["destroyUndead", "trinketDestroyUndead"].contains(&op) && !on_board {
            continue;
        }
        if op == "darkmoonPrize"
            && (!on_board || (str_field(m, "id")?.ends_with("034") && truth(&x["golden"])))
        {
            continue;
        }
        if op == "copyShop"
            && (!shop.iter().any(|b| std::ptr::eq(b, x))
                || num(&x["counters"]["zarjiraTurn"]) == num(&s["turn"]))
        {
            continue;
        }
        if ["buffType", "tribeShop", "tribeRefresh"].contains(&op) {
            let mut has_tribe = false;
            for t in arr(&catalog().data["tribes"]) {
                has_tribe |= tribe(x, t.as_str().ok_or("Invalid tribe")?)?;
            }
            if !has_tribe {
                continue;
            }
        }
        if op == "evolve" && num(&xd["tier"]) >= 6. {
            continue;
        }
        if op == "sellTransfer" {
            let mut found = false;
            for other in board {
                if other["uid"] != x["uid"] && (a["key"] != "elemental" || tribe(other, "元素")?)
                {
                    found = true;
                    break;
                }
            }
            if !found {
                continue;
            }
        }
        out.push(x.clone());
    }
    Ok(json!(out))
}
