#![recursion_limit = "256"]
//! Shared native rules implementation. Incomplete migration is reported explicitly.
mod action_space;
mod observation;
mod recruit_flow;
mod hero_effects;
mod trinket_events;
mod rounds;
mod preview;
mod environment;
mod environment_pairing;
mod expanded;
mod gifts;
mod lifecycle;
mod powers;
mod prices;
mod primitives;
mod recruit;
mod recruit_effects;
#[cfg(test)]
mod recruit_tests;
mod stats;
mod targets;
mod trinkets;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::OnceLock};

pub type Result<T> = std::result::Result<T, String>;
static CATALOG: OnceLock<Catalog> = OnceLock::new();
pub struct Catalog {
    pub data: Value,
    cards: HashMap<String, Value>,
}
pub fn catalog() -> &'static Catalog {
    CATALOG.get_or_init(|| {
        let data: Value = serde_json::from_str(include_str!("../../data/catalog.json"))
            .expect("generated catalog JSON");
        let cards = data["cards"]
            .as_array()
            .expect("catalog cards")
            .iter()
            .map(|c| (c["id"].as_str().expect("card id").to_owned(), c.clone()))
            .collect();
        Catalog { data, cards }
    })
}
pub fn def(id: &str) -> Result<&'static Value> {
    catalog()
        .cards
        .get(id)
        .ok_or_else(|| format!("Unknown card: {id}"))
}
pub fn str_field<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str()
        .ok_or_else(|| format!("Missing string field {k}"))
}
pub fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
pub fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().unwrap_or(0.) != 0.,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub fn abilities(m: &Value) -> Result<Vec<Value>> {
    let d = def(str_field(m, "id")?)?;
    Ok(arr(&d["abilities"])
        .iter()
        .filter(|a| !truth(&m["counters"]["chosenSpell"]) || a["event"] != "cast")
        .chain(arr(&m["extraAbilities"]))
        .cloned()
        .collect())
}
pub fn has(m: &Value, op: &str) -> Result<bool> {
    Ok(abilities(m)?.iter().any(|a| a["op"] == op))
}
pub fn tribe(m: &Value, t: &str) -> Result<bool> {
    let d = def(str_field(m, "id")?)?;
    Ok(d["tribe"] == t
        || d["tribe"] == "全部"
        || arr(&d["races"]).iter().any(|x| x == t)
        || arr(&m["extraTribes"]).iter().any(|x| x == t || x == "全部")
        || m["gift"] == "BG36_MidGameEffect_000t22")
}
pub fn validate_minion(m: &Value) -> Result<()> {
    def(str_field(m, "id")?)?;
    str_field(m, "uid")?;
    if !m["attack"].is_number()
        || !m["health"].is_number()
        || !m["golden"].is_boolean()
        || !m["copies"].is_object()
        || !m["keywords"].is_array()
    {
        return Err("Malformed minion".into());
    }
    Ok(())
}
pub fn dispatch(request: Value) -> Result<Value> {
    let command = str_field(&request, "command")?;
    if [
        "recruitBatch",
        "canOfferTrinket",
        "trinketCost",
        "offerTrinkets",
        "eligibleGifts",
        "attachDarkGift",
        "targets",
        "powerState",
        "nguyenPowerEligible",
        "equipPowers",
        "applyGlobal",
        "syncStats",
        "prices",
        "assertPool",
        "drawMinion",
    ]
    .contains(&command)
    {
        let state = &request["state"];
        if !state.is_object() || !state["season"].is_object() {
            return Err("Native rule operation requires a season state".into());
        }
    }
    match command {
        "envMeta"|"envCreate"|"envReset"|"envStep"|"envView"|"envSnapshot"|"envRestore"|"envReplay"|"envClose" => environment::dispatch(&request),
        "createSeason" => Ok(recruit::Recruit::create(&request)?.result(vec![])),
        "endEffects" | "advanceRecruit" | "releasePlayerCards" => {let mut ctx=recruit::Recruit::new(&request)?;match command {"endEffects"=>ctx.end_effects()?,"advanceRecruit"=>ctx.advance_recruit()?,_=>ctx.release_player()?};Ok(ctx.result(vec![]))},
        "observe" => observation::observe(&request["state"], num(&request["steps"]), num(&request["limit"])),
        "observeEntities" => observation::entities(&request["state"], num(&request["steps"]), num(&request["limit"])),
        "actionCandidates" => action_space::candidates(&request["state"], truth(&request["endOnly"])),
        "actionSchema" => Ok(json!(action_space::actions())),
        "entitySchema" => Ok(observation::entity_schema()),
        "meta" => {
            let migration:Value=serde_json::from_str(include_str!("../../data/migration.json")).map_err(|e|e.to_string())?;
            Ok(json!({"schema":"tavern-rust-kernel-v1","abi":1,"patch":catalog().data["patch"],"fullEngineReady":false,
                "runtimes":["python-native","node-wasm","browser-wasm"],"catalogSha256":migration["catalogSha256"],
                "counts":migration["counts"],"recruitBatchVersion":1,"recruitEffects":recruit_effects::SUPPORTED_EFFECTS.iter().chain(expanded::EFFECTS).collect::<Vec<_>>(),"commands":["meta","recruitBatch","canOfferTrinket","trinketCost","offerTrinkets","giftTierRange","eligibleGifts","attachDarkGift","targets","powerState","nguyenPowerEligible","equipPowers","makeMinion","makeGolden","mergeTriple","copyAbility","prices","applyGlobal","syncStats","assertPool","drawMinion","combatSubset"],
                "pending":["full recruit transition","effect dispatch","hero powers","trinkets","gifts","deities","full combat","eight-seat environment","observations and action mask"]}))
        },
        "recruitBatch" => recruit::batch(&request),
        "canOfferTrinket" => Ok(json!(trinkets::eligible(&request["state"],str_field(&request,"id")?)?)),
        "trinketCost" => Ok(trinkets::cost(&request["state"],str_field(&request,"id")?)),
        "offerTrinkets" => trinkets::offer(request["state"].clone(),str_field(&request,"school")?,request["seed"].as_u64().ok_or("Missing seed")? as u32),
        "giftTierRange" => Ok(json!(gifts::tiers(num(&request["turn"])))),
        "eligibleGifts" => gifts::eligible(&request["state"],&request["minion"]),
        "attachDarkGift" => gifts::attach(&request["state"],request["minion"].clone(),str_field(&request,"id")?),
        "targets" => targets::targets(&request["state"],&request["minion"],request["event"].as_str().unwrap_or("battlecry")),
        "powerState" => powers::state(&request["state"],str_field(&request,"id")?),
        "nguyenPowerEligible" => Ok(json!(powers::eligible(&request["state"],str_field(&request,"id")?))),
        "equipPowers" => powers::equip(request["state"].clone(),arr(&request["ids"])),
        "makeMinion" => primitives::make(str_field(&request,"id")?,str_field(&request,"uid")?,truth(&request["golden"]),truth(&request["fromPool"])),
        "makeGolden" => primitives::golden(request["minion"].clone()),
        "mergeTriple" => primitives::merge(arr(&request["parts"]),str_field(&request,"uid")?,!truth(&request["clockwork"])),
        "copyAbility" => primitives::copy_ability(&request["minion"],&request["ability"]),
        "applyGlobal" => stats::global(&request["state"],request["minion"].clone()),
        "syncStats" => stats::sync(&request["state"],request["minion"].clone(),truth(&request["onBoard"])),
        "prices" => prices::prices(&request["state"],&request["minion"]),
        "assertPool" => primitives::assert_pool(&request["state"]),
        "drawMinion" => primitives::draw(&request),
        "combatSubset" => {
            let case=serde_json::from_value(request["case"].clone()).map_err(|e|e.to_string())?;
            let prepared=tavern_combat_prototype::prepare(&case)?;
            serde_json::to_value(tavern_combat_prototype::combat(&prepared,true)).map_err(|e|e.to_string())
        },
        "reset"|"step"|"action"|"combat"|"restore"|"snapshot" => Err("RUST_ENGINE_INCOMPLETE: full-rule migration has not passed parity; refusing TS fallback".into()),
        command => Err(format!("Unknown native command: {command}")),
    }
}
pub fn request(bytes: &[u8]) -> Vec<u8> {
    let result = serde_json::from_slice(bytes)
        .map_err(|e| e.to_string())
        .and_then(dispatch);
    let reply = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    serde_json::to_vec(&reply).expect("serializable native response")
}
