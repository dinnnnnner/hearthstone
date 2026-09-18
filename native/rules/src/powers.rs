use crate::{Result, abilities, arr, catalog, def, num, str_field, tribe, truth};
use serde_json::{Value, json};
pub fn equipped(s: &Value) -> Vec<Value> {
    if s["season"]["powers"].is_array() {
        arr(&s["season"]["powers"]).to_vec()
    } else {
        vec![s["hero"].clone()]
    }
}
pub fn has(s: &Value, key: &str) -> bool {
    equipped(s).iter().any(|id| id == &format!("s14_{key}"))
}
pub fn progress(s: &Value, id: &str) -> Value {
    let st = &s["season"];
    if st["powers"].is_array() {
        return st["powerProgress"]
            .get(id)
            .cloned()
            .unwrap_or(json!({"uses":0,"turnUses":0,"elementalsPlayed":0}));
    }
    let limit = if ["s14_blackthorn", "s14_inge"].contains(&id) {
        2.
    } else {
        1.
    };
    json!({"uses":num(&st["heroPowerUses"]),"turnUses":st["heroPowerUsesTurn"].as_f64().unwrap_or(if truth(&s["powerUsed"]){limit}else{0.}),"elementalsPlayed":num(&st["elementalsPlayed"])})
}
pub fn eligible(s: &Value, id: &str) -> bool {
    let key = id.strip_prefix("s14_").unwrap_or(id);
    let tier = num(&s["tier"]);
    let turn = num(&s["turn"]);
    if [
        "finley",
        "nguyen",
        "genn",
        "patchwerk",
        "curator",
        "nzoth",
        "afk",
        "cookie",
        "eudora",
        "cthun",
        "ragnaros",
        "aranna",
        "marin",
        "buttons",
        "edwin",
        "cariel",
        "flurgl",
    ]
    .contains(&key)
    {
        return false;
    }
    if ["millificent", "alexstrasza"].contains(&key) && tier < 4. {
        return false;
    }
    if key == "jailer" && tier < 2. {
        return false;
    }
    if ["shudderwock", "sylvanas", "akazamzarakScholar", "yogg"].contains(&key) && turn < 3. {
        return false;
    }
    if ["drekthar", "vanndar"].contains(&key) && turn < 7. {
        return false;
    }
    if (key == "voone" && turn % 3. != 0.) || (key == "xavius" && turn % 4. != 0.) {
        return false;
    }
    let uses = num(&progress(s, id)["uses"]);
    if (["reno", "zerek", "kragg"].contains(&key) && uses >= 1.) || (key == "zephrys" && uses >= 3.)
    {
        return false;
    }
    !(key == "snakeEyes" && num(&s["season"]["counters"]["snakeUnlock"]) > turn)
}
pub fn save(s: &mut Value, id: &str, p: Value) {
    if s["season"]["powers"].is_array() {
        if !s["season"]["powerProgress"].is_object() {
            s["season"]["powerProgress"] = json!({});
        }
        s["season"]["powerProgress"][id] = p.clone();
    }
    if equipped(s).first().is_some_and(|x| x == id) {
        s["season"]["heroPowerUses"] = p["uses"].clone();
        s["season"]["heroPowerUsesTurn"] = p["turnUses"].clone();
        s["season"]["elementalsPlayed"] = p["elementalsPlayed"].clone();
    }
}
pub fn equip(mut s: Value, ids: &[Value]) -> Result<Value> {
    let first = ids
        .first()
        .and_then(Value::as_str)
        .ok_or("At least one power is required")?;
    for id in ids {
        definition(&s, id.as_str().ok_or("Invalid power id")?)?;
    }
    if !s["season"]["powers"].is_array() {
        let id = str_field(&s, "hero")?.to_owned();
        s["season"]["powerProgress"] = json!({id.clone():progress(&s,&id)});
    }
    let was = has(&s, "millhouse");
    s["season"]["powers"] = json!(ids);
    if num(&s["tier"]) < 6. && was != has(&s, "millhouse") {
        s["upgrade"] = json!((num(&s["upgrade"]) + if was { -1. } else { 1. }).max(0.));
    }
    let p = progress(&s, first);
    save(&mut s, first, p);
    Ok(s)
}
pub fn definition(s: &Value, id: &str) -> Result<Value> {
    if id == "s14_trinket" {
        let data = &catalog().data;
        let first = arr(&data["heroPool"]).first().ok_or("Missing hero pool")?;
        let mut h = arr(&data["powerDefinitions"])
            .iter()
            .find(|h| h["id"] == *first)
            .ok_or("Missing hero definition")?
            .clone();
        let item = arr(&data["rawTrinkets"])
            .iter()
            .find(|t| t["id"] == s["season"]["trinketPower"]);
        h["id"] = json!(id);
        h["name"] = json!("饰品技能");
        h["power"] = item.map(|t| t["name"].clone()).unwrap_or(json!("饰品"));
        h["text"] = item.map(|t| t["text"].clone()).unwrap_or(json!(""));
        h["cost"] = json!(0);
        h["passive"] = json!(true);
        if truth(&s["season"]["trinketPower"]) {
            h["art"] = s["season"]["trinketPower"].clone();
        }
        return Ok(h);
    }
    arr(&catalog().data["powerDefinitions"])
        .iter()
        .find(|h| h["id"] == id)
        .cloned()
        .ok_or(format!("Unknown hero power: {id}"))
}
pub fn state(s: &Value, id: &str) -> Result<Value> {
    let h = definition(s, id)?;
    let key = id.strip_prefix("s14_").unwrap_or(id);
    let st = &s["season"];
    let turn = num(&s["turn"]);
    let tier = num(&s["tier"]);
    let p = progress(s, id);
    let item_count = arr(&st["trinkets"])
        .iter()
        .filter(|x| *x == "BG35_MagicItem_801")
        .count() as f64;
    let limit = if ["blackthorn", "inge", "malygos"].contains(&key) {
        2.
    } else {
        1.
    } + item_count;
    let exhausted = (["reno", "zerek", "kragg"].contains(&key) && num(&p["uses"]) > 0.)
        || (key == "zephrys" && num(&p["uses"]) >= 3.);
    let remaining = if exhausted {
        0.
    } else {
        (limit - num(&p["turnUses"])).max(0.)
    };
    let discount = if ["togwaggle", "nobundo", "patches"].contains(&key) {
        num(&st["counters"][format!("{key}Discount")])
    } else {
        0.
    };
    let cost =
        (num(&h["cost"]) + if key == "elise" { num(&p["uses"]) } else { 0. } - discount).max(0.);
    let groups = &catalog().data["powerTargets"];
    let in_group = |group: &str| arr(&groups[group]).iter().any(|x| x == key);
    let needs = ["drestagath", "lich", "george", "xyrella", "reno", "inge"].contains(&key)
        || in_group("board")
        || in_group("shop")
        || in_group("mixed");
    let board = arr(&s["board"]);
    let shop = arr(&s["shop"]);
    let spell_shop = arr(&st["spellShop"]);
    let mut ts: Vec<&Value> = if key == "xyrella" {
        shop.iter().collect()
    } else if key == "reno" {
        board.iter().collect()
    } else {
        board.iter().chain(shop).collect()
    };
    if key == "drestagath" {
        ts = arr(&s["hand"]).iter().collect();
    }
    if in_group("board") {
        ts = board.iter().collect();
    }
    if in_group("shop") {
        ts = shop.iter().collect();
        if ["bazhial", "maiev"].contains(&key) {
            ts.extend(spell_shop);
        }
    }
    if key == "malygos" {
        ts = board.iter().chain(shop).collect();
        for m in arr(&s["hand"]) {
            if def(str_field(m, "id")?)?["kind"] == "spell" {
                ts.push(m);
            }
        }
        ts.extend(spell_shop);
    }
    let mut targets = vec![];
    for m in ts {
        if ["reno", "jandice"].contains(&key) && truth(&m["golden"]) {
            continue;
        }
        if key == "george" && arr(&m["keywords"]).iter().any(|k| k == "圣盾") {
            continue;
        }
        if key == "jailer" && !tribe(m, "亡灵")? {
            continue;
        }
        if key == "shudderwock" && !abilities(m)?.iter().any(|a| a["event"] == "battlecry") {
            continue;
        }
        if key == "galakrond" && num(&def(str_field(m, "id")?)?["tier"]) >= 6. {
            continue;
        }
        if key == "mutanus" && !board.iter().any(|x| x["uid"] != m["uid"]) {
            continue;
        }
        targets.push(m.clone());
    }
    let snake = num(&st["counters"]["snakeUnlock"]);
    let locked = (["millificent", "alexstrasza"].contains(&key) && tier < 4.)
        || (["shudderwock", "sylvanas", "akazamzarakScholar"].contains(&key) && turn < 3.)
        || (key == "jailer" && tier < 2.)
        || (key == "snakeEyes" && snake > turn);
    let used = remaining == 0.;
    let status = if key == "genn" {
        format!("第4回合选择两个技能 · 还剩{}回合", (4. - turn).max(0.))
    } else if exhausted {
        "本局已使用".into()
    } else if used {
        "本回合已使用".into()
    } else if locked {
        if key == "snakeEyes" {
            format!("第{snake}回合可用")
        } else if ["millificent", "alexstrasza"].contains(&key) {
            "酒馆4星解锁".into()
        } else if key == "jailer" {
            "酒馆2星解锁".into()
        } else {
            "第3回合解锁".into()
        }
    } else if key == "inge" {
        format!(
            "{} +{tier} · 剩余{remaining}次",
            if turn % 2. != 0. {
                "攻击力"
            } else {
                "生命值"
            }
        )
    } else if limit == 2. {
        format!("本回合剩余{remaining}次")
    } else if key == "elise" {
        format!("当前费用 {cost} 金币")
    } else if key == "reno" {
        "本局剩余1次".into()
    } else if key == "chenvaala" {
        format!("再使用{}张元素减费", 3. - num(&p["elementalsPlayed"]) % 3.)
    } else if truth(&h["passive"]) {
        "被动技能".into()
    } else {
        String::new()
    };
    let reason: Option<String> = if !equipped(s).iter().any(|x| x == id) {
        Some("你没有这个英雄技能。".into())
    } else if truth(&st["powerChoice"]) {
        Some("请先选择英雄技能。".into())
    } else if truth(&h["passive"]) {
        Some("这是被动技能，持续生效。".into())
    } else if used {
        Some(format!("{status}英雄技能。"))
    } else if locked {
        Some(format!("{status}。"))
    } else if num(&s["gold"]) < cost {
        Some(format!("英雄技能需要{cost}枚金币。"))
    } else if needs && targets.is_empty() {
        Some("没有可用的英雄技能目标。".into())
    } else if [
        "xyrella",
        "pyramid",
        "elise",
        "alexstrasza",
        "blackthorn",
        "hollidae",
        "millificent",
    ]
    .contains(&key)
        && arr(&s["hand"]).len() + arr(&s["rewards"]).len() >= 10
    {
        Some("请先腾出一个手牌位置。".into())
    } else {
        None
    };
    let mut out = json!({"definition":h,"id":id,"cost":cost,"remaining":remaining,"used":used,"status":status,"needsTarget":needs,"targets":targets});
    if let Some(r) = reason {
        out["reason"] = json!(r);
    }
    Ok(out)
}
