//! Native eight-seat self-play. Sessions stay in Rust between Python decisions.
use crate::{Result, action_space, arr, catalog, environment_pairing, num, observation, truth};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    sync::{Mutex, OnceLock},
};
use tavern_combat_prototype::Random;
static SESSIONS: OnceLock<Mutex<HashMap<u64, Value>>> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
fn sessions() -> &'static Mutex<HashMap<u64, Value>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn update_rng(e: &mut Value, r: &Value) {
    e["rng"] = r["rng"].clone();
    e["uidCounter"] = r["uidCounter"].clone()
}
fn call(e: &mut Value, command: &str, mut args: Value) -> Result<Value> {
    args["command"] = json!(command);
    args["seed"] = e["rng"].clone();
    args["uidCounter"] = e["uidCounter"].clone();
    args["recordLogs"] = json!(false);
    args["recordFrames"] = e["options"]["recordFrames"].clone();
    let r = crate::dispatch(args)?;
    update_rng(e, &r);
    Ok(r)
}
fn alive(e: &Value) -> Vec<usize> {
    arr(&e["seats"])
        .iter()
        .enumerate()
        .filter(|(_, p)| num(&p["game"]["health"]) > 0. && !truth(&p["left"]))
        .map(|(i, _)| i)
        .collect()
}
fn opponents(e: &mut Value) {
    let seats = e["seats"].clone();
    let turn = num(&e["turn"]);
    for i in 0..8 {
        let old = e["seats"][i]["game"]["opponents"]
            [num(&e["seats"][i]["game"]["nextOpponent"]) as usize]["hero"]
            .clone();
        let mut os = vec![];
        for (j, p) in arr(&seats).iter().enumerate() {
            if i == j {
                continue;
            }
            let g = &p["game"];
            let rounds: Vec<_> = arr(&g["scouting"])
                .iter()
                .filter(|r| num(&r["turn"]) < turn && num(&r["turn"]) >= turn - 2.)
                .cloned()
                .collect();
            os.push(json!({"seatIndex":j,"hero":p["hero"],"name":p["name"],"health":num(&g["health"]),"armor":num(&g["season"]["armor"]),"spellArmor":num(&g["season"]["spellArmor"]),"tier":g["tier"],"scouting":rounds,"board":[]}));
        }
        let mut next = os.iter().position(|o| o["hero"] == old).unwrap_or(0);
        if e["stage"] == "recruit" {
            if let Some(pair) = arr(&e["pairings"])
                .iter()
                .find(|p| arr(p).contains(&seats[i]["id"]))
            {
                let enemy = arr(pair).iter().find(|id| *id != &seats[i]["id"]);
                if let Some(p) = enemy.and_then(|id| {
                    arr(&seats)
                        .iter()
                        .find(|p| &p["id"] == id && num(&p["game"]["health"]) > 0.)
                }) {
                    next = os.iter().position(|o| o["hero"] == p["hero"]).unwrap_or(0)
                } else {
                    next = os
                        .iter()
                        .position(|o| o["hero"] == e["grave"]["hero"] && num(&o["health"]) <= 0.)
                        .unwrap_or(0);
                    os[next] = json!({"hero":e["grave"].get("hero").unwrap_or(&os[next]["hero"]),"name":"幽灵阵容","health":0,"armor":0,"tier":e["grave"]["tier"].as_u64().unwrap_or(1),"board":[]});
                }
            }
        }
        e["seats"][i]["game"]["opponents"] = json!(os);
        e["seats"][i]["game"]["nextOpponent"] = json!(next)
    }
}
fn plan(e: &mut Value) -> Result<()> {
    let living = alive(e);
    let members: Vec<_> = living
        .iter()
        .map(|i| e["seats"][*i]["id"].clone())
        .collect();
    if e["pairingCycle"]["members"] != json!(members) {
        let start = if e["pairingCycle"].is_null() && members.len() % 2 == 0 {
            1
        } else {
            num(&e["turn"]) as u64
        };
        e["pairingCycle"] = json!({"members":members,"startTurn":start,"meetings":{},"ghosts":{}})
    }
    let mut bottom = living;
    bottom.sort_by(|a, b| {
        observation::ranking(&e["seats"][*b]["game"])
            .total_cmp(&observation::ranking(&e["seats"][*a]["game"]))
    });
    let last = &e["lastEliminations"];
    let victim = if num(&last["turn"]) == num(&e["turn"]) - 1. && arr(&last["victims"]).len() == 1 {
        last["victims"][0].clone()
    } else {
        Value::Null
    };
    let killer = if arr(&e["seats"])
        .iter()
        .any(|p| p["id"] == victim && p["hero"] == e["grave"]["hero"])
    {
        last["killers"][victim.as_str().unwrap_or("")].clone()
    } else {
        Value::Null
    };
    let ghosts: Vec<_> = bottom
        .iter()
        .skip(bottom.len().saturating_sub(3))
        .map(|i| e["seats"][*i]["id"].clone())
        .filter(|id| id != &killer)
        .collect();
    let previous = if num(&e["lastPairings"]["turn"]) == num(&e["turn"]) - 1. {
        arr(&e["lastPairings"]["pairs"]).to_vec()
    } else {
        vec![]
    };
    let mut rng = Random::new(num(&e["rng"]) as u32);
    let c = environment_pairing::cycle(
        e["pairingCycle"].clone(),
        num(&e["turn"]) as u64,
        &ghosts,
        &mut rng,
        &previous,
    )?;
    e["rng"] = json!(rng.state);
    e["pairings"] = c["pairs"].clone();
    e["pairingCycle"] = c;
    opponents(e);
    Ok(())
}
fn eliminate(e: &mut Value, i: usize) -> Result<()> {
    if truth(&e["seats"][i]["place"]) {
        return Ok(());
    }
    e["seats"][i]["place"] = json!(alive(e).len() + 1);
    e["grave"] = json!({"hero":e["seats"][i]["hero"],"name":e["seats"][i]["name"],"board":e["seats"][i]["game"]["board"],"tier":e["seats"][i]["game"]["tier"]});
    let mut g = e["seats"][i]["game"].clone();
    g["pool"] = e["pool"].clone();
    let r = call(
        e,
        "recruitBatch",
        json!({"state":g,"operations":[{"op":"releasePlayerCards"}]}),
    )?;
    e["pool"] = r["state"]["pool"].clone();
    e["seats"][i]["game"] = r["state"].clone();
    e["seats"][i]["ended"] = json!(true);
    Ok(())
}
fn finish(e: &mut Value) -> bool {
    let living = alive(e);
    if living.len() > 1 {
        return false;
    }
    e["stage"] = json!("finished");
    for i in 0..8 {
        e["seats"][i]["game"]["phase"] = json!("over");
        if living.contains(&i) {
            e["seats"][i]["place"] = json!(1)
        }
    }
    true
}
fn damage(g: &mut Value, n: f64) {
    let armor = num(&g["season"]["armor"]);
    if truth(&g["season"]["counters"]["iceBlock"]) && n >= num(&g["health"]) + armor {
        g["season"]["counters"]["iceBlock"] = json!(0);
        return;
    }
    let absorbed = armor.min(n);
    g["season"]["armor"] = json!(armor - absorbed);
    g["season"]["spellArmor"] = json!((num(&g["season"]["spellArmor"]) - absorbed).max(0.));
    g["health"] = json!(num(&g["health"]) - (n - absorbed))
}
fn warband(board: &Value) -> Result<String> {
    if arr(board).is_empty() {
        return Ok("空场".into());
    }
    let tribes = [
        "野兽",
        "机械",
        "鱼人",
        "恶魔",
        "龙",
        "元素",
        "畸变怪",
        "纳迦",
        "海盗",
        "野猪人",
        "亡灵",
    ];
    let mut counts: Vec<(&str, usize)> = vec![];
    for m in arr(board) {
        let d = crate::def(m["id"].as_str().ok_or("Missing card")?)?;
        let races: Vec<&str> = if arr(&d["races"]).is_empty() {
            vec![d["tribe"].as_str().unwrap_or("")]
        } else {
            arr(&d["races"]).iter().filter_map(Value::as_str).collect()
        };
        let races = if races.contains(&"全部") {
            tribes.to_vec()
        } else {
            races
        };
        let mut seen = vec![];
        for t in races {
            if !tribes.contains(&t) || seen.contains(&t) {
                continue;
            }
            seen.push(t);
            if let Some(v) = counts.iter_mut().find(|x| x.0 == t) {
                v.1 += 1
            } else {
                counts.push((t, 1))
            }
        }
    }
    counts.sort_by_key(|x| std::cmp::Reverse(x.1));
    Ok(if counts.is_empty() {
        "无种族".into()
    } else if counts.len() > 1 && counts[0].1 == counts[1].1 {
        "混合".into()
    } else {
        format!("{}{}", counts[0].1, counts[0].0)
    })
}
fn record(g: &mut Value, turn: u64, label: &str, battle: &Value, enemy: &str) {
    let r = json!({"turn":turn,"warband":label,"battle":{"opponent":enemy,"result":battle["result"],"damage":battle["damage"]}});
    let mut rounds = vec![r];
    rounds.extend(
        arr(&g["scouting"])
            .iter()
            .filter(|r| r["turn"] != turn)
            .cloned(),
    );
    rounds.sort_by(|a, b| num(&b["turn"]).total_cmp(&num(&a["turn"])));
    rounds.truncate(3);
    g["scouting"] = json!(rounds);
    g["battle"] = battle.clone();
    g["battle"]["opponent"] = json!(enemy);
    g["phase"] = json!("combat");
    let mut battles =
        vec![json!({"turn":turn,"result":battle["result"],"damage":battle["damage"],"name":enemy})];
    battles.extend(arr(&g["battles"]).iter().take(59).cloned());
    g["battles"] = json!(battles)
}
fn fight(e: &mut Value) -> Result<()> {
    let before = alive(e);
    for i in before.clone() {
        let mut g = e["seats"][i]["game"].clone();
        if !arr(&g["discovery"]).is_empty()
            || truth(&g["season"]["powerChoice"])
            || !arr(&g["season"]["trinketOffers"]).is_empty()
        {
            return Err(format!(
                "Unresolved policy decision before combat, seat {i}"
            ));
        }
        g["pool"] = e["pool"].clone();
        let r = call(e, "endEffects", json!({"state":g}))?;
        e["pool"] = r["state"]["pool"].clone();
        e["seats"][i]["game"] = r["state"].clone();
        if num(&e["seats"][i]["game"]["health"]) <= 0. {
            eliminate(e, i)?
        }
    }
    opponents(e);
    if finish(e) {
        return Ok(());
    }
    if e["pairings"].is_null() {
        plan(e)?
    }
    let pairs = e["pairings"].clone();
    let turn = num(&e["turn"]) as u64;
    let mut dead = vec![];
    let mut killers = json!({});
    for pair in arr(&pairs) {
        let players: Vec<_> = arr(pair)
            .iter()
            .filter_map(|id| {
                arr(&e["seats"])
                    .iter()
                    .position(|p| &p["id"] == id && num(&p["game"]["health"]) > 0.)
            })
            .collect();
        let Some(&a) = players.first() else { continue };
        let b = players.get(1).copied();
        let mut enemy = if let Some(b) = b {
            e["seats"][b]["game"].clone()
        } else {
            let hero = e["grave"].get("hero").cloned().unwrap_or_else(|| {
                arr(&catalog().data["heroPool"])
                    .iter()
                    .find(|id| *id != &e["seats"][a]["hero"])
                    .unwrap()
                    .clone()
            });
            let r = call(
                e,
                "createSeason",
                json!({"hero":hero,"options":{"tribes":e["tribes"],"pool":{}}}),
            )?;
            let mut g = r["state"].clone();
            g["board"] = json!(
                arr(&e["grave"]["board"])
                    .iter()
                    .map(|m| {
                        let mut m = m.clone();
                        m["copies"] = json!({});
                        m
                    })
                    .collect::<Vec<_>>()
            );
            g["tier"] = json!(e["grave"]["tier"].as_u64().unwrap_or(1));
            g["pool"] = json!({});
            g
        };
        let mut own = e["seats"][a]["game"].clone();
        own["pool"] = e["pool"].clone();
        if b.is_some() {
            enemy["pool"] = e["pool"].clone()
        }
        let aw = warband(&own["board"])?;
        let bw = warband(&enemy["board"])?;
        let r = call(e, "combat", json!({"state":own,"other":enemy}))?;
        e["seats"][a]["game"] = r["state"].clone();
        if let Some(b) = b {
            e["seats"][b]["game"] = r["other"].clone()
        }
        e["pool"] = r["state"]["pool"].clone();
        let battle = &r["battle"];
        let enemy_name = b
            .map(|b| e["seats"][b]["name"].as_str().unwrap().to_string())
            .unwrap_or("幽灵阵容".into());
        record(&mut e["seats"][a]["game"], turn, &aw, battle, &enemy_name);
        if let Some(b) = b {
            let mut mirror = battle.clone();
            mirror["result"] = json!(match battle["result"].as_str() {
                Some("win") => "loss",
                Some("loss") => "win",
                _ => "tie",
            });
            mirror["frames"] = json!(
                arr(&battle["frames"])
                    .iter()
                    .map(|f| {
                        let mut f = f.clone();
                        let allies = f["allies"].clone();
                        f["allies"] = f["enemies"].clone();
                        f["enemies"] = allies;
                        f
                    })
                    .collect::<Vec<_>>()
            );
            let name = e["seats"][a]["name"].as_str().unwrap().to_string();
            record(&mut e["seats"][b]["game"], turn, &bw, &mirror, &name)
        }
        let loser = if battle["result"] == "loss" {
            Some(a)
        } else if battle["result"] == "win" {
            b
        } else {
            None
        };
        if let Some(loser) = loser {
            damage(&mut e["seats"][loser]["game"], num(&battle["damage"]));
            if num(&e["seats"][loser]["game"]["health"]) <= 0. {
                dead.push(loser);
                if let Some(winner) = if loser == a { b } else { Some(a) } {
                    killers[e["seats"][loser]["id"].as_str().unwrap()] =
                        e["seats"][winner]["id"].clone()
                }
            }
        }
    }
    e["lastPairings"] = json!({"turn":turn,"pairs":pairs});
    dead.sort_by(|a, b| {
        num(&e["seats"][*a]["game"]["health"]).total_cmp(&num(&e["seats"][*b]["game"]["health"]))
    });
    let mut place = alive(e).len() + dead.len();
    for i in dead {
        eliminate(e, i)?;
        e["seats"][i]["place"] = json!(place);
        place -= 1
    }
    let living = alive(e);
    e["lastEliminations"] = json!({"turn":turn,"victims":before.iter().filter(|i|!living.contains(i)).map(|i|e["seats"][*i]["id"].clone()).collect::<Vec<_>>(),"killers":killers});
    e["stage"] = json!("combat");
    opponents(e);
    if truth(&e["options"]["recordFrames"]) {
        let replay = json!({"turn":turn,"battles":arr(&e["seats"]).iter().enumerate().map(|(i,p)|json!({"seat":i,"battle":p["game"]["battle"]})).collect::<Vec<_>>()});
        e["replays"].as_array_mut().unwrap().push(replay)
    }
    advance(e)
}
fn advance(e: &mut Value) -> Result<()> {
    if finish(e) {
        return Ok(());
    }
    let turn = num(&e["turn"]) + 1.;
    e["turn"] = json!(turn);
    if turn > 50. {
        let mut living = alive(e);
        living.sort_by(|a, b| {
            let score = |i: usize| {
                num(&e["seats"][i]["game"]["health"])
                    + num(&e["seats"][i]["game"]["season"]["armor"])
            };
            score(*b).total_cmp(&score(*a))
        });
        for (i, p) in living.iter().enumerate() {
            e["seats"][*p]["place"] = json!(i + 1)
        }
        for p in e["seats"].as_array_mut().unwrap() {
            p["game"]["phase"] = json!("over")
        }
        e["stage"] = json!("finished");
        return Ok(());
    }
    opponents(e);
    for i in alive(e) {
        let mut g = e["seats"][i]["game"].clone();
        g["pool"] = e["pool"].clone();
        let r = call(e, "advanceRecruit", json!({"state":g}))?;
        e["pool"] = r["state"]["pool"].clone();
        e["seats"][i]["game"] = r["state"].clone();
        e["seats"][i]["ended"] = json!(false)
    }
    e["stage"] = json!("recruit");
    plan(e)
}
fn legal(e: &Value) -> Result<Vec<Value>> {
    if e["stage"] == "finished" || truth(&e["truncated"]) {
        return Ok(vec![]);
    }
    let actor = num(&e["actor"]) as usize;
    let mut g = e["seats"][actor]["game"].clone();
    g["pool"] = e["pool"].clone();
    let candidates = action_space::candidates(
        &g,
        num(&e["actionsInTurn"][actor]) >= num(&e["options"]["maxActionsPerTurn"]),
    )?;
    let enemy = enemy_board(e, actor);
    let mut out = vec![];
    for c in arr(&candidates) {
        if ["end", "move", "freeze"].contains(&c[1]["type"].as_str().unwrap_or("")) {
            out.push(c.clone());
            continue;
        }
        let check = crate::dispatch(
            json!({"command":"actSeason","state":g,"action":c[1],"seed":e["rng"],"uidCounter":e["uidCounter"],"recordLogs":false,"recordFrames":false,"privateContext":{"opponentBoard":enemy}}),
        )?;
        if !truth(&check["error"]) {
            out.push(c.clone())
        }
    }
    if out.is_empty() {
        return Err(format!(
            "No legal actions for seat {actor}, turn {}",
            e["turn"]
        ));
    }
    Ok(out)
}
fn enemy_board(e: &Value, actor: usize) -> Value {
    let id = &e["seats"][actor]["id"];
    arr(&e["pairings"])
        .iter()
        .find(|p| arr(p).contains(id))
        .and_then(|p| arr(p).iter().find(|x| *x != id))
        .and_then(|enemy| arr(&e["seats"]).iter().find(|p| &p["id"] == enemy))
        .map(|p| p["game"]["board"].clone())
        .unwrap_or_else(|| json!(arr(&e["grave"]["board"])))
}
pub fn view(e: &Value) -> Result<Value> {
    let actor = num(&e["actor"]) as usize;
    let done = e["stage"] == "finished" || truth(&e["truncated"]);
    let g = &e["seats"][actor]["game"];
    let steps = num(&e["actionsInTurn"][actor]);
    let limit = num(&e["options"]["maxActionsPerTurn"]);
    Ok(
        json!({"actor":if done{Value::Null}else{json!(actor)},"observation":observation::observe(g,steps,limit)?,"entities":observation::entities(g,steps,limit)?,"legalActions":legal(e)?.iter().map(|a|a[0].clone()).collect::<Vec<_>>(),"terminated":e["stage"]=="finished","truncated":truth(&e["truncated"]),"info":{"turn":e["turn"],"steps":e["steps"],"placements":arr(&e["seats"]).iter().map(|p|p["place"].clone()).collect::<Vec<_>>(),"rewards":arr(&e["seats"]).iter().map(|p|if truth(&p["place"]){(4.5-num(&p["place"]))/3.5}else{0.}).collect::<Vec<_>>(),"actionLimitReached":!done&&steps>=limit,"heroes":arr(&e["seats"]).iter().map(|p|p["hero"].clone()).collect::<Vec<_>>(),"tribes":g["season"]["tribes"]}}),
    )
}
pub fn reset(seed: u64, options: &Value) -> Result<Value> {
    if seed > u32::MAX as u64 {
        return Err("Seed must be uint32".into());
    }
    let mut opts =
        json!({"maxActionsPerTurn":64,"maxSteps":30000,"recordFrames":false,"aiActionLimits":true});
    if let Some(obj) = options.as_object() {
        for (k, v) in obj {
            opts[k] = v.clone()
        }
    }
    if !opts["aiActionLimits"].is_boolean() {
        return Err("Invalid AI action limits option".into());
    }
    for k in ["maxActionsPerTurn", "maxSteps"] {
        if opts[k].as_u64().unwrap_or(0) < 1 {
            return Err("Invalid decision limits".into());
        }
    }
    let mut rng = Random::new(seed as u32);
    let mut heroes: Vec<Value> = vec![];
    let mut required = vec![json!("畸变怪")];
    for i in 0..8 {
        let available: Vec<_> = arr(&catalog().data["heroPool"])
            .iter()
            .filter(|h| {
                !heroes.contains(h) && {
                    let t = &catalog().data["heroTribes"][h.as_str().unwrap()];
                    t.is_null() || required.contains(t) || required.len() < 5
                }
            })
            .cloned()
            .collect();
        let h = if truth(&opts["heroes"][i]) {
            opts["heroes"][i].clone()
        } else {
            available[((rng.next_u32() as f64 / 4294967296.) * available.len() as f64) as usize]
                .clone()
        };
        if !available.contains(&h) {
            return Err(
                "Heroes must be distinct, implemented and compatible with five tribes".into(),
            );
        }
        let t = &catalog().data["heroTribes"][h.as_str().unwrap()];
        if !t.is_null() && !required.contains(t) {
            required.push(t.clone())
        }
        heroes.push(h)
    }
    if opts["heroes"].is_array() && arr(&opts["heroes"]).len() != 8 {
        return Err("Exactly eight heroes required".into());
    }
    let mut rest: Vec<_> = arr(&catalog().data["tribes"])
        .iter()
        .filter(|t| !required.contains(t))
        .cloned()
        .collect();
    for i in (1..rest.len()).rev() {
        let j = ((rng.next_u32() as f64 / 4294967296.) * (i + 1) as f64) as usize;
        rest.swap(i, j)
    }
    required.extend(rest.into_iter().take(5 - required.len()));
    let special = heroes.iter().any(|h| {
        ["s14_curator", "s14_lich", "s14_teron", "s14_nzoth"].contains(&h.as_str().unwrap())
    });
    let deity = if special || rng.next_u32() < 2147483648 {
        "BGFYM_000"
    } else {
        "BGFYM_011"
    };
    let mut e = json!({"schema":"tavern-native-environment-v1","sourceHash":meta()["sourceHash"],"seed":seed,"rng":rng.state,"uidCounter":0,"options":opts,"turn":1,"steps":0,"actor":seed%8,"actionsInTurn":[0,0,0,0,0,0,0,0],"truncated":false,"stage":"recruit","seats":[],"pool":{},"tribes":required,"tape":[],"replays":[]});
    for (i, h) in heroes.iter().enumerate() {
        let mut options = json!({"tribes":required,"deity":deity});
        if i > 0 {
            options["pool"] = e["pool"].clone()
        }
        let r = call(&mut e, "createSeason", json!({"hero":h,"options":options}))?;
        let mut g = r["state"].clone();
        g["seatIndex"] = json!(i);
        if truth(&opts["aiActionLimits"]) {
            g["aiActionUsage"] = json!({"turn":g["turn"],"freezes":0,"moves":0})
        }
        e["pool"] = g["pool"].clone();
        e["seats"].as_array_mut().unwrap().push(json!({"id":format!("seat-{i}"),"name":format!("策略 {}",i+1),"hero":h,"game":g,"ended":false}));
    }
    opponents(&mut e);
    plan(&mut e)?;
    Ok(e)
}
pub fn step(e: &mut Value, id: u64) -> Result<Value> {
    if e["stage"] == "finished" || truth(&e["truncated"]) {
        return Err("Episode ended; reset required".into());
    }
    let actor = num(&e["actor"]) as usize;
    let actions = legal(e)?;
    let action = actions
        .iter()
        .find(|a| a[0] == id)
        .map(|a| a[1].clone())
        .ok_or_else(|| format!("Illegal action {id} for seat {actor}"))?;
    let turn = num(&e["turn"]);
    if action["type"] == "end" {
        e["seats"][actor]["ended"] = json!(true)
    } else {
        let mut g = e["seats"][actor]["game"].clone();
        g["pool"] = e["pool"].clone();
        let enemy = enemy_board(e, actor);
        let r = call(
            e,
            "actSeason",
            json!({"state":g,"action":action,"privateContext":{"opponentBoard":enemy}}),
        )?;
        if let Some(error) = r["error"].as_str() {
            return Err(error.into());
        }
        e["pool"] = r["state"]["pool"].clone();
        e["seats"][actor]["game"] = r["state"].clone();
        if num(&e["seats"][actor]["game"]["health"]) <= 0. {
            eliminate(e, actor)?;
            opponents(e);
            if !finish(e) {
                plan(e)?
            }
        }
    }
    e["actionsInTurn"][actor] = json!(num(&e["actionsInTurn"][actor]) + 1.);
    e["steps"] = json!(num(&e["steps"]) + 1.);
    e["tape"].as_array_mut().unwrap().push(json!(id));
    if e["stage"] == "recruit" && alive(e).iter().all(|i| truth(&e["seats"][*i]["ended"])) {
        fight(e)?
    }
    if num(&e["turn"]) != turn {
        e["actionsInTurn"] = json!([0, 0, 0, 0, 0, 0, 0, 0])
    }
    if e["stage"] != "finished" {
        let start = if num(&e["turn"]) != turn {
            (num(&e["seed"]) + num(&e["turn"]) - 1.) as usize % 8
        } else {
            (actor + 1) % 8
        };
        for offset in 0..8 {
            let i = (start + offset) % 8;
            if num(&e["seats"][i]["game"]["health"]) > 0. && !truth(&e["seats"][i]["ended"]) {
                e["actor"] = json!(i);
                break;
            }
        }
    }
    e["truncated"] =
        json!(e["stage"] != "finished" && num(&e["steps"]) >= num(&e["options"]["maxSteps"]));
    view(e)
}
pub fn meta() -> Value {
    let m: Value = serde_json::from_str(include_str!("../../data/migration.json")).unwrap();
    json!({"schema":"tavern-selfplay-v3","observationVersion":4,"actionVersion":2,"sourceHash":format!("rust-v1-{}",m["catalogSha256"].as_str().unwrap_or("")),"rulesHash":m["catalogSha256"],"legacyV2SourceHash":null,"entitySchema":observation::entity_schema(),"actionCount":action_space::actions().len(),"actions":action_space::actions(),"cardIds":observation::card_ids(),"heroIds":observation::hero_ids(),"patch":catalog().data["patch"],"coverage":{"minions":m["counts"]["minions"],"heroes":m["counts"]["heroes"],"spells":m["counts"]["spells"],"trinkets":m["counts"]["trinkets"]},"opponents":"neural self-play only","reward":"(4.5 - placement) / 3.5","seats":8,"aiActionLimits":{"version":2,"freezes":1,"moves":6,"freezePolicy":"unaffordable-at-end"}})
}
pub fn dispatch(r: &Value) -> Result<Value> {
    let command = r["command"].as_str().unwrap_or("");
    if command == "envMeta" {
        return Ok(meta());
    }
    if command == "envCreate" {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        sessions()
            .lock()
            .map_err(|_| "Native sessions poisoned")?
            .insert(id, Value::Null);
        return Ok(json!(id));
    }
    let id = r["session"]
        .as_u64()
        .ok_or("Missing native environment session")?;
    let mut all = sessions().lock().map_err(|_| "Native sessions poisoned")?;
    if command == "envClose" {
        all.remove(&id);
        return Ok(Value::Null);
    }
    let e = all
        .get_mut(&id)
        .ok_or("Unknown native environment session")?;
    match command {
        "envReset" => {
            let next = reset(
                r["seed"].as_u64().ok_or("Seed must be uint32")?,
                &r["options"],
            )?;
            let v = view(&next)?;
            *e = next;
            Ok(v)
        }
        "envStep" => {
            if e.is_null() {
                return Err("Reset required".into());
            }
            let mut next = e.clone();
            let v = step(
                &mut next,
                r["action"].as_u64().ok_or("Action must be uint")?,
            )?;
            *e = next;
            Ok(v)
        }
        "envView" => view(e),
        "envSnapshot" => Ok(e.clone()),
        "envRestore" => {
            let next = &r["snapshot"];
            if next["schema"] != "tavern-native-environment-v1"
                || next["sourceHash"] != meta()["sourceHash"]
            {
                return Err("Incompatible environment snapshot".into());
            }
            let v = view(next)?;
            *e = next.clone();
            Ok(v)
        }
        "envReplay" => Ok(
            json!({"schema":meta()["schema"],"sourceHash":meta()["sourceHash"],"seed":e["seed"],"options":e["options"],"actions":e["tape"],"replays":e["replays"]}),
        ),
        _ => Err(format!("Unknown environment command: {command}")),
    }
}
