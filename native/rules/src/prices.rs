use crate::{Result, abilities, arr, def, has, num, str_field, tribe, truth, validate_minion};
use serde_json::{Value, json};
fn counter(s: &Value, k: &str) -> f64 {
    num(&s["season"]["counters"][k])
}
fn item(s: &Value, id: &str) -> usize {
    arr(&s["season"]["trinkets"])
        .iter()
        .filter(|v| *v == id)
        .count()
}
fn power(s: &Value, key: &str) -> bool {
    let id = format!("s14_{key}");
    if s["season"]["powers"].is_array() {
        arr(&s["season"]["powers"]).iter().any(|v| v == &id)
    } else {
        s["hero"] == id
    }
}
fn progress(s: &Value, hero: &str, key: &str) -> f64 {
    counter(s, &format!("power:{hero}:{key}"))
}
pub fn prices(s: &Value, m: &Value) -> Result<Value> {
    validate_minion(m)?;
    let st = &s["season"];
    if !st.is_object() || !s["board"].is_array() {
        return Err("Prices require a season state".into());
    }
    let turn = s["turn"].as_u64().ok_or("Invalid turn")?;
    let d = def(str_field(m, "id")?)?;
    let minion = if tribe(m, "海盗")?
        && item(s, "BG32_MagicItem_957") > 0
        && counter(s, &format!("pirateBought:{turn}")) == 0.
    {
        0.
    } else if let Some(cost) = m["counters"]["shopCost"].as_f64() {
        cost
    } else if truth(&d["magnetic"]) && item(s, "BG35_MagicItem_743") > 0 {
        2.
    } else if power(s, "aranna")
        && progress(s, "aranna", "attacks") >= 14.
        && arr(&st["boughtTurn"]).is_empty()
    {
        0.
    } else if power(s, "sindragosa") || counter(s, "prizeMinionCost") != 0. {
        2.
    } else if item(s, "BG36_MagicItem_202") > 0
        && num(&st["trinketBuys"]) < 2.
        && abilities(m)?.iter().any(|a| a["event"] == "battlecry")
    {
        0.
    } else if power(s, "millhouse") {
        2.
    } else {
        3.
    };
    let mut discount = 0.;
    for x in arr(&s["board"]) {
        if has(x, "timewarpSpellDiscount")?
            && num(&x["counters"][format!("spellDiscount:{turn}")])
                < if truth(&x["golden"]) { 4. } else { 2. }
        {
            discount += 2.;
        }
    }
    let spell = if power(s, "taethelan") && progress(s, "taethelan", "boughtSpells") % 3. == 2. {
        0.
    } else {
        (num(&d["cost"])
            - num(&st["spellDiscount"])
            - counter(s, &format!("prizeDiscount:{turn}"))
            - discount)
            .max(0.)
    };
    let eye = item(s, "BG30_MagicItem_701") > 0 && counter(s, "eyePurchases") % 4. == 3.;
    let minion_health = truth(&m["counters"]["healthPurchase"])
        || eye
        || (tribe(m, "恶魔")?
            && counter(s, &format!("demonHealth:{turn}")) < (item(s, "BG32_MagicItem_821") as f64));
    let spell_health = has(m, "healthCost")?
        || eye
        || counter(s, &format!("spellHealth:{turn}")) < (item(s, "BG32_MagicItem_822") as f64);
    let mut spent = num(&st["healthRefreshes"]);
    let mut remaining = 0.;
    let mut source = None;
    for x in arr(&s["board"]) {
        if has(x, "healthRefresh")? {
            let uid = str_field(x, "uid")?;
            let max = if truth(&x["golden"]) { 4. } else { 2. };
            let used = if st["healthRefreshUses"].is_object() {
                num(&st["healthRefreshUses"][uid])
            } else {
                let used = spent.min(max);
                spent -= used;
                used
            };
            let left = (max - used).max(0.);
            remaining += left;
            if source.is_none() && left > 0. {
                source = Some(uid);
            }
        }
    }
    let free = num(&st["freeRefresh"]) > 0.
        || power(s, "nozdormu") && st["nozdormuRefreshTurn"].as_u64().unwrap_or(turn) != turn;
    let mut refresh = json!({"gold":if free||source.is_some(){0}else if power(s,"millhouse"){2}else{1},"health":if !free&&source.is_some(){1}else{0},"remaining":remaining});
    if !free && let Some(uid) = source {
        refresh["source"] = json!(uid);
    }
    Ok(
        json!({"minionCost":minion,"spellCost":spell,"minionUsesHealth":minion_health,"spellUsesHealth":spell_health,"refreshPayment":refresh}),
    )
}
