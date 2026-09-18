use crate::{dispatch, primitives};
use serde_json::{Value, json};
fn state() -> Value {
    json!({"hero":"s14_lich","turn":3,"tier":1,"health":30,"gold":4,"upgrade":5,"triples":0,
        "board":[],"hand":[],"shop":[],"discovery":[],"rewards":[],"logs":[],"opponents":[],
        "pool":{"s14_BG25_001":16},"season":{"powers":[],"pendingDiscoveries":[],"pendingTrinketCards":[],"initialPool":{"s14_BG25_001":16},"spellShop":[],"trinkets":[],"tribes":["亡灵","元素","野兽","机械","龙"],"buffs":{},"counters":{},"battlecries":0,"spellsCast":0,"goldenPlayed":0,"maxGold":10,"armor":0,"nextGold":0,"freeRefresh":0,"spellDiscount":0,"fodder":0}})
}
fn request(s: Value, ops: Value) -> Value {
    json!({"command":"recruitBatch","state":s,"seed":917,"uidCounter":0,"recordLogs":false,"operations":ops})
}
fn pool(s: &Value) {
    assert_eq!(
        dispatch(json!({"command":"assertPool","state":s})).unwrap(),
        true
    );
}
#[test]
fn discovery_and_release_preserve_finite_pool() {
    let s = state();
    pool(&s);
    let r=dispatch(request(s,json!([{"op":"queueDiscovery","kind":"minion","options":{"tiers":[1]}},{"op":"nextDiscovery"}]))).unwrap();
    assert_eq!(r["state"]["discovery"].as_array().unwrap().len(), 1);
    pool(&r["state"]);
    let r = dispatch(request(
        r["state"].clone(),
        json!([{"op":"releasePlayerCards"}]),
    ))
    .unwrap();
    pool(&r["state"]);
    assert_eq!(r["state"]["pool"]["s14_BG25_001"].as_f64(), Some(16.));
}
#[test]
fn triples_inherit_first_gift_and_preserve_pool_on_overflow() {
    let mut s = state();
    let mut parts = vec![];
    for i in 0..3 {
        parts.push(primitives::make("s14_BG25_001", &format!("old-{i}"), false, true).unwrap());
    }
    parts[0]["gift"] = json!("BG36_MidGameEffect_000t13");
    parts[1]["gift"] = json!("BG36_MidGameEffect_000t22");
    parts[1]["giftTurn"] = json!(5);
    s["pool"]["s14_BG25_001"] = json!(13);
    s["hand"] = json!(parts);
    pool(&s);
    let r = dispatch(request(s, json!([{"op":"triples"}]))).unwrap();
    pool(&r["state"]);
    let merged = &r["state"]["hand"][0];
    assert_eq!(merged["gift"], "BG36_MidGameEffect_000t13");
    assert!(merged.get("giftTurn").is_none());
    assert_eq!(merged["copies"]["s14_BG25_001"].as_f64(), Some(3.));
    let mut s = r["state"].clone();
    s["rewards"] = json!([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    s["pool"]["s14_BG25_001"] = json!(12);
    let m = primitives::make("s14_BG25_001", "overflow", false, true).unwrap();
    let r = dispatch(request(s, json!([{"op":"putHand","minion":m}]))).unwrap();
    pool(&r["state"]);
    assert_eq!(r["state"]["hand"].as_array().unwrap().len(), 1);
    assert_eq!(r["results"][0]["copies"], json!({}));
}
#[test]
fn serialized_continuation_matches_one_batch() {
    let ops = json!([{"op":"drawSpell"},{"op":"queueDiscovery","kind":"minion"},{"op":"nextDiscovery"},{"op":"drawSpell"},{"op":"gold","amount":3}]);
    let full = dispatch(request(state(), ops.clone())).unwrap();
    let first = dispatch(request(state(), json!(&ops.as_array().unwrap()[..2]))).unwrap();
    let mut second = request(first["state"].clone(), json!(&ops.as_array().unwrap()[2..]));
    second["seed"] = first["rng"].clone();
    second["uidCounter"] = first["uidCounter"].clone();
    let second = dispatch(second).unwrap();
    for k in ["state", "rng", "uidCounter"] {
        assert_eq!(full[k], second[k], "{k}");
    }
    assert_eq!(
        full["draws"].as_u64().unwrap(),
        first["draws"].as_u64().unwrap() + second["draws"].as_u64().unwrap()
    );
}
#[test]
fn unsupported_effect_aborts_without_hidden_state_or_fallback() {
    let input = request(
        state(),
        json!([{"op":"gold","amount":3},{"op":"effect","minion":primitives::make("s14_BG25_001","source",false,false).unwrap(),"ability":{"event":"battlecry","op":"unmigrated"}}]),
    );
    assert_eq!(
        dispatch(input.clone()).unwrap_err(),
        "RUST_EFFECT_INCOMPLETE: unmigrated"
    );
    assert_eq!(input["state"]["gold"], 4);
    let valid = request(input["state"].clone(), json!([{"op":"gold","amount":1}]));
    assert_eq!(dispatch(valid).unwrap()["state"]["gold"].as_f64(), Some(5.));
    assert_eq!(
        dispatch(request(state(), json!([{"op":"effect","combat":true}]))).unwrap_err(),
        "RUST_EFFECT_INCOMPLETE: combat context"
    );
}
#[test]
fn recursive_rally_stops_at_reference_depth_limit() {
    let mut s = state();
    let mut m = primitives::make("s14_BG25_001", "rally", false, false).unwrap();
    m["extraAbilities"] = json!([{"event":"rally","op":"goldNext","amount":1},{"event":"rally","op":"rally","amount":1}]);
    s["board"] = json!([m]);
    let r = dispatch(request(
        s,
        json!([{"op":"runEvent","uid":"rally","event":"rally","target":"rally"}]),
    ))
    .unwrap();
    assert_eq!(r["state"]["season"]["nextGold"].as_f64(), Some(13.));
}
