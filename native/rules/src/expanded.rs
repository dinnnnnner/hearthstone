use crate::recruit::Recruit;
use crate::recruit_effects::{Context, keyword};
use crate::{Result, abilities, arr, catalog, def, has, num, stats, str_field, tribe, truth};
use serde_json::{Value, json};
pub const EFFECTS: &[&str] = &[
    "trinketCopy",
    "trinketEvolve",
    "ownStatsHand",
    "zarjiraCraft",
    "copyShop",
    "kodoStats",
    "stoneSlab",
    "discoverMagnetize",
    "growDragonBuff",
    "dragonCombatBuff",
    "bounty",
    "chromadrake",
    "learnSpell",
    "growingBeast",
    "choose",
    "combatEffect",
    "delayedBuff",
    "winnerBuff",
    "murlocPair",
    "nagaRepeatedBuff",
    "lockedDiscover",
    "doomedDiscover",
    "discoverDemonDamage",
    "discoverChoice",
    "tribeShop",
    "randomStatsSpell",
    "lossGold",
    "scoutDiscover",
    "stripDefenses",
    "goldHealth",
    "spellProgressBuff",
    "goldenNeighbors",
    "handAttack",
    "targetAttack",
    "undeadPlague",
    "lastSpell",
    "morglton",
    "morgltonParent",
    "armPurchase",
    "armMagnetic",
    "goldenFour",
    "pirateDiscover",
    "shieldReborn",
    "inheritReborn",
    "randomShopUpgrade",
    "parrotGold",
    "satelliteGrowing",
    "satellite",
    "magneticGrowth",
    "murlocDiscover",
    "castTavern",
    "adjacentSpell",
    "rightSpell",
    "castRandom",
    "consume",
    "weaver",
    "confiscateGems",
    "spellShop",
    "evolve",
    "tribeRefresh",
];
impl Recruit {
    pub fn expanded(&mut self, ctx: &Context, m: &Value, a: &Value) -> Result<()> {
        let f = if truth(&m["golden"]) && !truth(&a["noScale"]) {
            2.
        } else {
            1.
        };
        let n = a["amount"].as_f64().unwrap_or(1.) * f;
        let uid = str_field(m, "uid")?;
        let target = ctx
            .target
            .as_deref()
            .map(|uid| self.owned(uid))
            .transpose()?;
        let subject = ctx
            .event_minion
            .as_deref()
            .map(|uid| self.owned(uid))
            .transpose()?;
        match str_field(a, "op")? {
            "preview" => self.preview_effect(ctx,m,a)?,
            "trinketCopy" => {
                if let Some(t) = &target {
                    let c = self.make(str_field(t, "id")?, truth(&t["golden"]), false)?;
                    self.give(ctx, c)?;
                }
            }
            "trinketEvolve" => {
                if let Some(t) = &target {
                    let mut opts =
                        json!({"tiers":[(num(&def(str_field(t,"id")?)?["tier"])+1.).min(6.)]});
                    let on_board = self.locate(str_field(t, "uid")?)?.0 == "board";
                    opts[if on_board {
                        "replaceBoard"
                    } else {
                        "replaceShop"
                    }] = t["uid"].clone();
                    self.queue_effect(ctx, "minion", opts)?;
                }
            }
            "ownStatsHand" => {
                for x in arr(&self.state["hand"]).to_vec() {
                    if def(str_field(&x, "id")?)?["kind"] != "spell" {
                        self.gain(
                            str_field(&x, "uid")?,
                            num(&m["attack"]) * f,
                            num(&m["health"]) * f,
                            Some(m),
                            ctx.depth,
                        )?;
                        break;
                    }
                }
            }
            "zarjiraCraft" => {
                let mut c = self.make("s14_BG27_514t", truth(&m["golden"]), false)?;
                c["expires"] = json!(true);
                self.give(ctx, c)?;
            }
            "copyShop" => {
                if let Some(t) = &target {
                    let tid = str_field(t, "uid")?;
                    let turn = num(&self.state["turn"]);
                    self.mbump(
                        tid,
                        "zarjiraTurn",
                        turn - num(&t["counters"]["zarjiraTurn"]),
                    )?;
                    for _ in 0..f as usize {
                        let c = self.make(str_field(t, "id")?, truth(&t["golden"]), false)?;
                        self.give(ctx, c)?;
                    }
                }
            }
            "kodoStats" => {
                if let Some(t) = &subject
                    && self.mbump(uid, "kodoSummons", 1.)? <= 3.
                {
                    self.gain(
                        str_field(t, "uid")?,
                        num(&m["attack"]) * f,
                        m["counters"]["deathStatsHealth"]
                            .as_f64()
                            .unwrap_or(num(&m["health"]))
                            * f,
                        Some(m),
                        ctx.depth,
                    )?;
                }
            }
            "stoneSlab" => {
                if let Some(t) = &subject
                    && num(&m["counters"]["stoneSlabTurn"]) != num(&self.state["turn"])
                {
                    self.mbump(
                        uid,
                        "stoneSlabTurn",
                        num(&self.state["turn"]) - num(&m["counters"]["stoneSlabTurn"]),
                    )?;
                    let id = str_field(t, "uid")?;
                    self.gain(id, 20., 20., Some(m), ctx.depth)?;
                    let t = self.owned(id)?;
                    self.gain(
                        id,
                        num(&t["attack"]) * f,
                        num(&t["health"]) * f,
                        Some(m),
                        ctx.depth,
                    )?;
                }
            }
            "discoverMagnetize" => {
                if let Some(t) = &target {
                    for _ in 0..f as usize {
                        self.queue_effect(
                            ctx,
                            "minion",
                            json!({"tribe":"机械","magnetizeTarget":t["uid"]}),
                        )?;
                    }
                }
            }
            "growDragonBuff" => {
                self.mbump(uid, "dragonBuff", f)?;
            }
            "dragonCombatBuff" => {
                for id in self.board_ids() {
                    if tribe(&self.owned(&id)?, "龙")? {
                        let value = 2. * f + num(&self.owned(uid)?["counters"]["dragonBuff"]);
                        self.gain(&id, value, value, Some(m), ctx.depth)?;
                    }
                }
            }
            "bounty" | "chromadrake" => {
                let ids = if a["op"] == "bounty" {
                    ["BG33_811", "BG33_812", "BG33_813", "BG33_814", "BG33_815"]
                } else {
                    [
                        "BG34_634t",
                        "BG34_635t",
                        "BG34_636t",
                        "BG34_637t",
                        "BG34_638t",
                    ]
                };
                for _ in 0..n.ceil().max(0.) as usize {
                    let index = self.index(ids.len());
                    let card = self.make(&format!("s14_{}", ids[index]), false, false)?;
                    self.give(ctx, card)?;
                }
            }
            "learnSpell" => {
                if let Some(t) = &subject {
                    let key = format!("learn:{}", num(&self.state["turn"]));
                    if num(&m["counters"][&key]) < f {
                        self.mbump(uid, &key, 1.)?;
                        let mut c = self.make("s14_BG33_890t", false, false)?;
                        c["attack"] = json!(1);
                        c["health"] = json!(1);
                        c["learnedSpell"] = t["id"].clone();
                        c["extraAbilities"] = json!([{"event":"battlecry","op":"castTavern","id":str_field(t,"id")?.trim_start_matches("s14_")}]);
                        self.give(ctx, c)?;
                    }
                }
            }
            "growingBeast" => {
                if let Some(t) = &subject {
                    self.gain(
                        str_field(t, "uid")?,
                        3. * f + num(&m["counters"]["beastGrowth"]),
                        0.,
                        Some(m),
                        ctx.depth,
                    )?;
                    self.mbump(uid, "beastGrowth", f)?;
                }
            }
            "choose" => {
                let mut source = m.clone();
                source["copies"] = json!({});
                let mut provider = None;
                for id in self.board_ids() {
                    let x = self.owned(&id)?;
                    if has(&x, "bothChoices")?
                        && num(&x["counters"]["choiceTurn"]) != num(&self.state["turn"])
                    {
                        provider = Some(id);
                        break;
                    }
                }
                let both = truth(&m["bothChoices"])
                    || provider.is_some()
                    || self.item("BG36_MagicItem_308") > 0;
                if let Some(id) = provider {
                    let x = self.owned(&id)?;
                    self.mbump(
                        &id,
                        "choiceTurn",
                        num(&self.state["turn"]) - num(&x["counters"]["choiceTurn"]),
                    )?;
                }
                let id = str_field(a, "id")?;
                self.queue_effect(ctx,"choose",json!({"options":[format!("s14_{id}t"),format!("s14_{id}t2")],"source":source,"both":both}))?;
            }
            "combatEffect" => {
                if !self.state["season"]["combatEffects"].is_object() {
                    self.state["season"]["combatEffects"] = json!({});
                }
                let key = str_field(a, "key")?;
                self.state["season"]["combatEffects"][key] =
                    json!(num(&self.state["season"]["combatEffects"][key]) + n);
            }
            "delayedBuff" | "winnerBuff" => {
                if a["op"] == "delayedBuff" || target.is_some() {
                    if !self.state["season"]["delayed"].is_array() {
                        self.state["season"]["delayed"] = json!([]);
                    }
                    let mut d = json!({"turn":num(&self.state["turn"])+1.,"attack":num(&a["attack"])*f,"health":num(&a["health"])*f,"amount":a["amount"].as_f64().filter(|v|*v!=0.).unwrap_or(1.)});
                    if let Some(t) = &target
                        && a["op"] == "winnerBuff"
                    {
                        d = json!({"turn":num(&self.state["turn"])+1.,"uid":t["uid"],"win":true,"attack":4,"health":6,"amount":1});
                    }
                    self.state["season"]["delayed"]
                        .as_array_mut()
                        .unwrap()
                        .push(d);
                }
            }
            "murlocPair" => {
                let tier = num(&self.state["tier"]);
                if let Some(c) = self.draw(|d| {
                    num(&d["tier"]) <= tier
                        && (arr(&d["races"]).iter().any(|t| t == "鱼人") || d["tribe"] == "全部")
                })? {
                    let id = str_field(&c, "id")?.to_owned();
                    self.give(ctx, c)?;
                    let copy = self.make(&id, false, false)?;
                    self.give(ctx, copy)?;
                }
            }
            "nagaRepeatedBuff" => {
                let count = if let Some(t) = &target
                    && tribe(t, "纳迦")?
                {
                    4
                } else {
                    2
                };
                for _ in 0..count {
                    self.effect(ctx,m,&json!({"event":"cast","op":"buff","target":"selected","attack":1,"health":1}))?;
                }
            }
            "lockedDiscover" => self.queue_effect(
                ctx,
                "minion",
                json!({"tiers":[self.state["tier"]],"lockedUntil":num(&self.state["turn"])+1.}),
            )?,
            "doomedDiscover" => self.queue_effect(
                ctx,
                "minion",
                json!({"tribe":"亡灵","doomedTurn":self.state["turn"]}),
            )?,
            "discoverDemonDamage" => {
                for _ in 0..n.ceil().max(0.) as usize {
                    self.queue_effect(ctx, "minion", json!({"tribe":"恶魔","damage":true}))?;
                }
            }
            "discoverChoice" => {
                self.queue_effect(ctx, "chooseCard", json!({"bothChoices":true}))?
            }
            "tribeShop" => {
                if let Some(t) = &target {
                    for ty in arr(&catalog().data["tribes"]) {
                        let ty = ty.as_str().unwrap();
                        if tribe(t, ty)? {
                            self.scale(&format!("shopType:{ty}"), 3., 3.)?;
                            for x in arr(&self.state["shop"]).to_vec() {
                                if tribe(&x, ty)? {
                                    self.gain(str_field(&x, "uid")?, 3., 3., Some(m), ctx.depth)?;
                                }
                            }
                        }
                    }
                }
            }
            "randomStatsSpell" => {
                for _ in 0..n.ceil().max(0.) as usize {
                    let tier = num(&self.state["tier"]);
                    if let Some(c) = self.draw_spell(|d| {
                        num(&d["tier"]) <= tier
                            && arr(&d["abilities"]).iter().any(|a| {
                                ["buff", "buffType", "nagaRepeatedBuff"]
                                    .iter()
                                    .any(|op| a["op"] == *op)
                            })
                    })? {
                        self.give(ctx, c)?;
                    }
                }
            }
            "lossGold" => {
                if self.state["battles"][0]["result"] == "loss" {
                    self.gold(
                        a["amount"].as_f64().filter(|v| *v != 0.).unwrap_or(4.),
                        false,
                    );
                }
            }
            "scoutDiscover" => {
                for _ in 0..f as usize {
                    let turn = num(&self.state["turn"]);
                    self.queue_effect(ctx,"minion",json!({"tiers":[(1.+turn-m["counters"]["enteredTurn"].as_f64().filter(|v|*v!=0.).unwrap_or(turn)).min(6.)]}))?;
                }
            }
            "stripDefenses" => {
                if let Some(t) = &target {
                    self.owned_mut(str_field(t, "uid")?)?["keywords"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|k| k != "嘲讽" && k != "复生");
                }
            }
            "goldHealth" => {
                let h = (1. + num(&self.state["season"]["goldSpentTurn"])) * f;
                for id in self.buff_targets(ctx, m, a)? {
                    self.gain(&id, 0., h, Some(m), ctx.depth)?;
                }
            }
            "spellProgressBuff" => {
                let p = (self.count("allSpells") / 3.).floor();
                for id in self.buff_targets(ctx, m, a)? {
                    self.gain(
                        &id,
                        (num(&a["attack"]) + p) * f,
                        (num(&a["health"]) + p) * f,
                        Some(m),
                        ctx.depth,
                    )?;
                }
            }
            "goldenNeighbors" => {
                let mut a = a.clone();
                a["target"] = json!("adjacent");
                for id in self.buff_targets(ctx, m, &a)? {
                    let n = arr(&self.state["board"])
                        .iter()
                        .filter(|x| truth(&x["golden"]))
                        .count();
                    self.gain(&id, f * (1 + n) as f64, 0., Some(m), ctx.depth)?;
                }
            }
            "handAttack" => {
                let mut max: f64 = 0.;
                for x in arr(&self.state["hand"]) {
                    if def(str_field(x, "id")?)?["kind"] != "spell" {
                        max = max.max(num(&x["attack"]));
                    }
                }
                self.gain(uid, max * f, 0., Some(m), ctx.depth)?;
            }
            "targetAttack" => {
                if let Some(t) = &target {
                    self.gain(uid, num(&t["attack"]) * f, 0., Some(m), ctx.depth)?;
                }
            }
            "undeadPlague" => self.scale("undead", 4. * f, 0.)?,
            "lastSpell" => {
                if let Some(id) = self.state["season"]["lastSpell"]
                    .as_str()
                    .map(str::to_owned)
                {
                    for _ in 0..f as usize {
                        let c = self.make(&id, false, false)?;
                        self.give(ctx, c)?;
                    }
                }
            }
            "morglton" => {
                let n = (3. + self.count("morglton")) * f;
                for id in self.buff_targets(ctx, m, a)? {
                    self.gain(
                        &id,
                        if truth(&a["attack"]) { n } else { 0. },
                        if truth(&a["health"]) { n } else { 0. },
                        Some(m),
                        ctx.depth,
                    )?;
                }
            }
            "morgltonParent" => {
                for _ in 0..f as usize {
                    let i = self.index(2);
                    let c = self.make(
                        if i == 0 {
                            "s14_BG35_140"
                        } else {
                            "s14_BG35_141"
                        },
                        false,
                        false,
                    )?;
                    self.give(ctx, c)?;
                }
            }
            "armPurchase" => {
                self.mbump(
                    uid,
                    "purchaseArmed",
                    f - num(&m["counters"]["purchaseArmed"]),
                )?;
            }
            "armMagnetic" => {
                self.mbump(
                    uid,
                    "magneticArmed",
                    if truth(&m["golden"]) { 3. } else { 2. }
                        - num(&m["counters"]["magneticArmed"]),
                )?;
            }
            "goldenFour" => {
                for _ in 0..f as usize {
                    let choices: Vec<Value> = self
                        .pool_cards()?
                        .into_iter()
                        .filter(|d| num(&d["tier"]) == 4.)
                        .collect();
                    let i = self.index(choices.len());
                    if let Some(d) = choices.get(i) {
                        let c = self.make(str_field(d, "id")?, true, false)?;
                        self.give(ctx, c)?;
                    }
                }
            }
            "pirateDiscover" => {
                let n = (1. + num(&self.state["season"]["goldenPlayed"])) * f;
                for id in self.board_ids() {
                    if id != uid && tribe(&self.owned(&id)?, "海盗")? {
                        self.gain(&id, n, n, Some(m), ctx.depth)?;
                    }
                }
            }
            "shieldReborn" => {
                if let Some(t) = &subject {
                    keyword(self.owned_mut(str_field(t, "uid")?)?, "圣盾");
                    self.gain(uid, 7. * f, 7. * f, Some(m), ctx.depth)?;
                }
            }
            "inheritReborn" => {
                if let Some(t) = &subject {
                    for id in self.board_ids().iter().rev() {
                        if tribe(&self.owned(id)?, "亡灵")? {
                            self.gain(
                                id,
                                num(&t["attack"]) * f,
                                num(&t["attack"]) * f,
                                Some(m),
                                ctx.depth,
                            )?;
                            break;
                        }
                    }
                }
            }
            "randomShopUpgrade" => {
                for x in arr(&self.state["shop"]).to_vec() {
                    let i = self.index(4);
                    let id = str_field(&x, "uid")?;
                    if i == 0 {
                        self.gain(id, 8. * f, 8. * f, Some(m), ctx.depth)?;
                    } else {
                        keyword(self.owned_mut(id)?, ["嘲讽", "圣盾", "风怒"][i - 1]);
                    }
                }
            }
            "parrotGold" => {
                if num(&m["counters"]["parrotDamage"]) < 35. && ctx.amount > 0. {
                    let total = self.mbump(uid, "parrotDamage", ctx.amount)?;
                    if total >= 35. {
                        for _ in 0..f as usize {
                            let c = self.make("s14_BG28_830", false, false)?;
                            self.give(ctx, c)?;
                        }
                    }
                }
            }
            "satelliteGrowing" => {
                let value = (2. + num(&m["counters"]["satelliteSize"])) * f;
                if let Some(t) = &subject {
                    let id = str_field(t, "uid")?;
                    self.gain(id, value, value, Some(m), ctx.depth)?;
                    let target = self.owned_mut(id)?;
                    target["magneticCount"] = json!(num(&target["magneticCount"]) + 1.);
                }
                self.mbump(uid, "satelliteSize", 1.)?;
            }
            "satellite" => {
                for id in self.buff_targets(ctx, m, a)? {
                    self.gain(
                        &id,
                        num(&a["attack"]) * f,
                        num(&a["health"]) * f,
                        Some(m),
                        ctx.depth,
                    )?;
                    let t = self.owned_mut(&id)?;
                    t["magneticCount"] = json!(num(&t["magneticCount"]) + 1.);
                }
            }
            "magneticGrowth" => {
                for id in self.board_ids() {
                    let repeats = num(&self.owned(&id)?["magneticCount"]);
                    for _ in 0..repeats.ceil().max(0.) as usize {
                        self.gain(
                            &id,
                            num(&a["attack"]) * f,
                            num(&a["health"]) * f,
                            Some(m),
                            ctx.depth,
                        )?;
                    }
                }
            }
            "murlocDiscover" => {
                let mut found = false;
                for id in self.board_ids() {
                    if id != uid && tribe(&self.owned(&id)?, "鱼人")? {
                        found = true;
                        break;
                    }
                }
                if found {
                    for _ in 0..f as usize {
                        self.queue_effect(ctx, "minion", json!({"tribe":"鱼人"}))?;
                    }
                }
            }
            "castTavern" => {
                for _ in 0..n.ceil().max(0.) as usize {
                    let spell = self.make(&format!("s14_{}", str_field(a, "id")?), false, false)?;
                    let mut next = ctx.clone();
                    next.target = None;
                    next.from_hand = false;
                    self.cast_spell(&next, &spell)?;
                }
            }
            "adjacentSpell" | "rightSpell" => {
                let ids = if a["op"] == "rightSpell" {
                    let b = self.board_ids();
                    let index = b
                        .iter()
                        .position(|id| id == uid)
                        .map(|i| i as isize)
                        .unwrap_or(-1)
                        + 1;
                    b.get(index as usize).cloned().into_iter().collect()
                } else {
                    let mut a = a.clone();
                    a["target"] = json!("adjacent");
                    self.buff_targets(ctx, m, &a)?
                };
                for id in ids {
                    for _ in 0..f as usize {
                        let spell =
                            self.make(&format!("s14_{}", str_field(a, "id")?), false, false)?;
                        let mut next = ctx.clone();
                        next.target = Some(id.clone());
                        next.from_hand = false;
                        self.cast_spell(&next, &spell)?;
                    }
                }
            }
            "castRandom" => {
                for _ in 0..n.ceil().max(0.) as usize {
                    let tier = num(&self.state["tier"]);
                    if let Some(card) = self.draw_spell(|d| num(&d["tier"]) <= tier)? {
                        let ts = crate::targets::targets(&self.state, &card, "cast")?;
                        let chosen = if arr(&ts).iter().any(|x| x["uid"] == uid) {
                            Some(uid.to_owned())
                        } else {
                            let i = self.index(arr(&ts).len());
                            arr(&ts)
                                .get(i)
                                .and_then(|x| x["uid"].as_str())
                                .map(str::to_owned)
                        };
                        if chosen.is_none()
                            && abilities(&card)?
                                .iter()
                                .any(|a| a["event"] == "cast" && a["target"] == "selected")
                        {
                            continue;
                        }
                        let mut next = ctx.clone();
                        next.target = chosen;
                        next.from_hand = false;
                        self.cast_spell(&next, &card)?;
                    }
                }
            }
            "consume" => {
                for id in self.buff_targets(ctx, m, a)? {
                    for _ in 0..((a["amount"].as_f64().filter(|n| *n != 0.).unwrap_or(1.)) * f)
                        .ceil()
                        .max(0.) as usize
                    {
                        let mut shop = arr(&self.state["shop"]).to_vec();
                        let i = if truth(&a["highest"]) {
                            shop.sort_by(|x, y| num(&y["health"]).total_cmp(&num(&x["health"])));
                            0
                        } else {
                            self.index(shop.len())
                        };
                        if let Some(t) = shop.get(i) {
                            self.consume(
                                ctx,
                                &id,
                                str_field(t, "uid")?,
                                1.,
                                truth(&a["keywords"]),
                            )?;
                        }
                    }
                }
            }
            "weaver" => {
                self.hero_damage(ctx, 1.)?;
                stats::add(
                    self.owned_mut(uid)?,
                    num(&a["attack"]) * f,
                    num(&a["health"]) * f,
                );
            }
            "confiscateGems" => {
                if let Some(t) = &target {
                    let id = str_field(t, "uid")?;
                    let (zone, index) = self.locate(id)?;
                    if zone == "board" || zone == "shop" {
                        self.effect(
                            ctx,
                            m,
                            &json!({"event":"cast","op":"gem","target":"selected","amount":2}),
                        )?;
                        let neighbors = [index.checked_sub(1), Some(index + 1)]
                            .into_iter()
                            .flatten()
                            .filter_map(|i| arr(&self.state[zone]).get(i))
                            .cloned()
                            .collect::<Vec<_>>();
                        for other in neighbors {
                            if other["gems"].is_object() {
                                let other_id = str_field(&other, "uid")?;
                                let a = num(&other["gems"]["attack"]);
                                let h = num(&other["gems"]["health"]);
                                stats::add(self.owned_mut(other_id)?, -a, -h);
                                self.gain(id, a, h, Some(m), ctx.depth)?;
                                let target = self.owned_mut(id)?;
                                target["gems"] = json!({"attack":num(&target["gems"]["attack"])+a,"health":num(&target["gems"]["health"])+h});
                                self.owned_mut(other_id)?
                                    .as_object_mut()
                                    .unwrap()
                                    .remove("gems");
                            }
                        }
                    }
                }
            }
            "spellShop" => {
                for mut x in arr(&self.state["shop"]).to_vec() {
                    self.release(&mut x)?;
                }
                self.state["shop"] = json!([]);
                self.state["season"]["spellShop"] = json!([]);
                let tier = num(&self.state["tier"]);
                let size = num(&catalog().data["shopSize"][tier as usize]);
                for _ in 0..(size + 1.) as usize {
                    if let Some(c) = self.draw_spell(|d| num(&d["tier"]) <= tier)? {
                        self.state["season"]["spellShop"]
                            .as_array_mut()
                            .unwrap()
                            .push(c);
                    }
                }
                self.state["frozen"] = json!(false);
            }
            "evolve" => {
                if let Some(t) = &target {
                    let id = str_field(t, "uid")?;
                    let (zone, index) = self.locate(id)?;
                    let d = def(str_field(t, "id")?)?;
                    let tier = num(&d["tier"]) + 1.;
                    if let Some(mut card) = self.draw(|d| num(&d["tier"]) == tier)? {
                        if zone == "board" || zone == "shop" {
                            let ga = if truth(&t["golden"]) {
                                num(&d["goldenAttack"])
                            } else {
                                num(&d["attack"])
                            };
                            let gh = if truth(&t["golden"]) {
                                num(&d["goldenHealth"])
                            } else {
                                num(&d["health"])
                            };
                            stats::add(&mut card, num(&t["attack"]) - ga, num(&t["health"]) - gh);
                            for k in ["temporary", "gems"] {
                                if let Some(v) = t.get(k) {
                                    card[k] = v.clone();
                                }
                            }
                            card["uid"] = t["uid"].clone();
                            let mut old = t.clone();
                            self.release(&mut old)?;
                            self.state[zone][index] = card;
                        }
                    }
                }
            }
            "tribeRefresh" => {
                if let Some(t) = &target {
                    let mut types = vec![];
                    for ty in arr(&catalog().data["tribes"]) {
                        if tribe(t, ty.as_str().unwrap())? {
                            types.push(ty.clone());
                        }
                    }
                    for mut x in arr(&self.state["shop"]).to_vec() {
                        self.release(&mut x)?;
                    }
                    self.state["shop"] = json!([]);
                    self.state["season"]["spellShop"] = json!([]);
                    let tier = num(&self.state["tier"]);
                    for _ in 0..num(&catalog().data["shopSize"][tier as usize]) as usize {
                        if let Some(c) = self.draw(|d| {
                            num(&d["tier"]) <= tier
                                && (d["tribe"] == "全部"
                                    || arr(&d["races"]).iter().any(|t| types.contains(t)))
                        })? {
                            let c = self.apply_shop(c)?;
                            self.state["shop"].as_array_mut().unwrap().push(c);
                        }
                    }
                    if let Some(c) = self.draw_spell(|d| num(&d["tier"]) <= tier)? {
                        self.state["season"]["spellShop"]
                            .as_array_mut()
                            .unwrap()
                            .push(c);
                    }
                    self.state["frozen"] = json!(false);
                }
            }
            other => return Err(format!("RUST_EFFECT_INCOMPLETE: {other}")),
        }
        Ok(())
    }
}
