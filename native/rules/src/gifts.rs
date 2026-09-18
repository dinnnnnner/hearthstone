use crate::{Result, abilities, arr, catalog, def, num, str_field, tribe, truth, validate_minion};
use serde_json::{Value, json};
pub fn tiers(turn: f64) -> Vec<u8> {
    if turn <= 3. {
        vec![2]
    } else if turn == 4. {
        vec![2, 3]
    } else if turn == 5. {
        vec![3]
    } else if turn == 6. {
        vec![3, 4]
    } else if turn == 7. {
        vec![4]
    } else if turn == 8. {
        vec![4, 5]
    } else if turn == 9. {
        vec![4, 5, 6]
    } else {
        vec![5, 6]
    }
}
pub fn eligible(s: &Value, m: &Value) -> Result<Value> {
    validate_minion(m)?;
    let d = def(str_field(m, "id")?)?;
    let a = abilities(m)?;
    let battlecry = a.iter().any(|a| a["event"] == "battlecry");
    let death = a.iter().any(|a| a["event"] == "death");
    let turn = num(&s["turn"]);
    let poison = arr(&m["keywords"])
        .iter()
        .any(|k| k == "烈毒" || k == "剧毒");
    let mut result = vec![];
    for g in arr(&catalog().data["gifts"]) {
        let n = str_field(g, "id")?.trim_start_matches("BG36_MidGameEffect_000t");
        let (min, max) = match n {
            "73" => (3., 3.),
            "74" | "75" | "51" => (3., 5.),
            "11" | "22" => (5., 99.),
            "18" => (4., 6.),
            "7" | "71" => (7., 10.),
            "69" => (7., 99.),
            "72" => (11., 99.),
            "60" => (12., 99.),
            "82" => (3., 4.),
            "10" => (6., 99.),
            "52" | "80" => (4., 5.),
            "5" => (5., 8.),
            "14" => (4., 8.),
            "4" => (6., 8.),
            _ => (3., 99.),
        };
        if turn < min || turn > max {
            continue;
        }
        if battlecry && !["11", "18", "14", "10"].contains(&n) {
            continue;
        }
        if death && ["73", "75", "51", "7", "71", "72", "4"].contains(&n) {
            continue;
        }
        if (n == "16" && !death) || (n == "10" && !battlecry) || (n == "80" && !tribe(m, "野猪人")?)
        {
            continue;
        }
        if n == "69" && (!tribe(m, "鱼人")? || poison) {
            continue;
        }
        if n == "75"
            && arr(&s["season"]["tribes"])
                .iter()
                .any(|t| t == "野猪人" || t == "纳迦")
        {
            continue;
        }
        if n == "7"
            && (arr(&s["season"]["tribes"]).iter().any(|t| t == "龙")
                || tribe(m, "野兽")?
                || tribe(m, "亡灵")?
                || d["tribe"] == "无")
        {
            continue;
        }
        if n == "71" && (d["tribe"] == "无" || poison) {
            continue;
        }
        if n == "72" && tribe(m, "龙")? {
            continue;
        }
        if n == "60" && (arr(&m["keywords"]).iter().any(|k| k == "嘲讽") || d["tribe"] == "无") {
            continue;
        }
        if n == "22" && d["tribe"] != "无" {
            continue;
        }
        if ["82", "4"].contains(&n) && d["tribe"] == "无" {
            continue;
        }
        if n == "14" && (truth(&d["activateCost"]) || num(&d["tier"]) != tiers(turn)[0] as f64) {
            continue;
        }
        result.push(g.clone());
    }
    Ok(json!(result))
}
pub fn attach(s: &Value, mut m: Value, id: &str) -> Result<Value> {
    validate_minion(&m)?;
    if !arr(&catalog().data["gifts"]).iter().any(|g| g["id"] == id) {
        return Err(format!("Unknown gift: {id}"));
    }
    m["gift"] = json!(id);
    m["giftTurn"] = s["turn"].clone();
    match id.trim_start_matches("BG36_MidGameEffect_000t") {
        "73" => crate::stats::add(&mut m, 5., 5.),
        "4" => crate::stats::add(&mut m, 4., 4.),
        "72" => m["attack"] = json!(num(&m["attack"]) + 1000.),
        "13" => {
            keyword(&mut m, "圣盾");
            keyword(&mut m, "风怒");
        }
        "69" => keyword(&mut m, "烈毒"),
        "14" => m = crate::primitives::golden(m)?,
        _ => {}
    }
    Ok(m)
}
fn keyword(m: &mut Value, k: &str) {
    let a = m["keywords"].as_array_mut().expect("validated minion");
    if !a.iter().any(|x| x == k) {
        a.push(json!(k));
    }
}
