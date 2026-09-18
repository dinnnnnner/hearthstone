use crate::{Result, abilities, arr, def, has, num, str_field, tribe, truth, validate_minion};
use serde_json::{Value, json};
fn count(s: &Value, k: &str) -> f64 {
    num(&s["season"]["counters"][k])
}
fn item(s: &Value, k: &str) -> f64 {
    arr(&s["season"]["trinkets"])
        .iter()
        .filter(|x| *x == k)
        .count() as f64
}
fn buff(s: &Value, k: &str) -> (f64, f64) {
    (
        num(&s["season"]["buffs"][k]["attack"]),
        num(&s["season"]["buffs"][k]["health"]),
    )
}
fn mc(m: &Value, k: &str) -> f64 {
    num(&m["counters"][k])
}
fn set_counter(m: &mut Value, k: &str, n: f64) {
    if !m["counters"].is_object() {
        m["counters"] = json!({});
    }
    m["counters"][k] = json!(n);
}
pub fn add(m: &mut Value, a: f64, h: f64) {
    if m["id"] == "s14_BG36_205" {
        return;
    }
    m["attack"] = json!((num(&m["attack"]) + a).max(0.));
    m["health"] = json!(num(&m["health"]) + h);
    if !m["counters"]["deathStatsHealth"].is_null() {
        let n = mc(m, "deathStatsHealth") + h;
        set_counter(m, "deathStatsHealth", n);
    }
}
pub fn sync(s: &Value, mut m: Value, on_board: bool) -> Result<Value> {
    validate_minion(&m)?;
    let id = str_field(&m, "id")?.to_owned();
    if ["s14_BG34_170t", "s14_BG34_170t2", "s14_BG34_170t3"].contains(&id.as_str()) {
        let (a, h) = buff(s, "volumizer");
        let da = a - mc(&m, "volumizerAttack");
        let dh = h - mc(&m, "volumizerHealth");
        add(&mut m, da, dh);
        set_counter(&mut m, "volumizerAttack", a);
        set_counter(&mut m, "volumizerHealth", h);
    }
    if id == "s14_BG34_405" {
        let shield = arr(&m["keywords"]).iter().any(|k| k == "圣盾");
        let ks = m["keywords"].as_array_mut().ok_or("Missing keywords")?;
        if shield {
            if !ks.iter().any(|k| k == "嘲讽") {
                ks.push(json!("嘲讽"));
            }
        } else {
            ks.retain(|k| k != "嘲讽");
        }
    }
    let hammer = (1. + count(s, "discarded"))
        * (item(s, "BG36_MagicItem_403") + 2. * item(s, "BG36_MagicItem_403t"));
    let hh = (1. + count(s, "discarded")) * item(s, "BG36_MagicItem_403t");
    let (a, h) = if on_board { (hammer, hh) } else { (0., 0.) };
    if a != 0. || h != 0. || mc(&m, "hammerAttack") != 0. || mc(&m, "hammerHealth") != 0. {
        m["attack"] = json!(num(&m["attack"]) + a - mc(&m, "hammerAttack"));
        m["health"] = json!(num(&m["health"]) + h - mc(&m, "hammerHealth"));
        set_counter(&mut m, "hammerAttack", a);
        set_counter(&mut m, "hammerHealth", h);
    }
    for ability in abilities(&m)?.iter().filter(|a| a["op"] == "lowHeroHealth") {
        let f = if on_board
            && num(&s["health"])
                <= ability["amount"]
                    .as_f64()
                    .filter(|x| *x != 0.)
                    .unwrap_or(15.)
        {
            if truth(&m["golden"]) { 2. } else { 1. }
        } else {
            0.
        };
        let a = num(&ability["attack"]) * f;
        let h = num(&ability["health"]) * f;
        m["attack"] = json!((num(&m["attack"]) + a - mc(&m, "lowHeroHealthAttack")).max(0.));
        m["health"] = json!(num(&m["health"]) + h - mc(&m, "lowHeroHealthHealth"));
        set_counter(&mut m, "lowHeroHealthAttack", a);
        set_counter(&mut m, "lowHeroHealthHealth", h);
    }
    if id == "s14_BG25_008" {
        let (a, h) = buff(s, "eternalPortrait");
        let da = a - mc(&m, "eternalPortraitAttack");
        let dh = h - mc(&m, "eternalPortraitHealth");
        add(&mut m, da, dh);
        set_counter(&mut m, "eternalPortraitAttack", a);
        set_counter(&mut m, "eternalPortraitHealth", h);
    }
    if m["gift"] == "BG36_MidGameEffect_000t88" {
        let n = 3. * count(s, "discarded");
        let d = n - mc(&m, "discardGift");
        add(&mut m, d, d);
        set_counter(&mut m, "discardGift", n);
    }
    if has(&m, "alwaysGolden")? {
        m = crate::primitives::golden(m)?;
    }
    for a in abilities(&m)?.iter().filter(|a| a["op"] == "globalStats") {
        let key = str_field(a, "key")?;
        let total = match key {
            "battlecries" => num(&s["season"]["battlecries"]),
            "tavernSpells" => num(&s["season"]["spellsCast"]),
            "goldenPlayed" => num(&s["season"]["goldenPlayed"]),
            _ => count(s, key),
        };
        let value = (total
            - if key == "automatonSummons" {
                mc(&m, "automatonSelf")
            } else {
                0.
            })
        .max(0.);
        let f = if truth(&m["golden"]) { 2. } else { 1. };
        let attack = value * num(&a["attack"]) * f;
        let health = value * num(&a["health"]) * f;
        let ak = format!("{key}Attack");
        let hk = format!("{key}Health");
        let da = attack - mc(&m, &ak);
        let dh = health - mc(&m, &hk);
        add(&mut m, da, dh);
        set_counter(&mut m, &ak, attack);
        set_counter(&mut m, &hk, health);
    }
    if has(&m, "shieldAtSix")? && num(&m["attack"]) >= 6. && mc(&m, "thresholdShield") == 0. {
        if !arr(&m["keywords"]).iter().any(|k| k == "圣盾") {
            m["keywords"]
                .as_array_mut()
                .ok_or("Missing keywords")?
                .push(json!("圣盾"));
        }
        set_counter(&mut m, "thresholdShield", 1.);
    }
    // Ensure the identity still resolves after native transformations.
    def(str_field(&m, "id")?)?;
    Ok(m)
}
pub fn global(s: &Value, mut m: Value) -> Result<Value> {
    validate_minion(&m)?;
    for (t, key) in [("野兽", "beast"), ("亡灵", "undead")] {
        if tribe(&m, t)? {
            let (a, h) = buff(s, key);
            add(&mut m, a, h);
        }
    }
    if m["id"] == "s14_BG28_603t" {
        let (a, h) = buff(s, "beetle");
        add(&mut m, a, h);
    }
    sync(s, m, false)
}
