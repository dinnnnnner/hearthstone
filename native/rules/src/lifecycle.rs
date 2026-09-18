use crate::recruit::Recruit;
use crate::recruit_effects::{Context, keyword};
use crate::{
    Result, abilities, arr, catalog, def, has, num, stats, str_field, tribe, truth, validate_minion,
};
use serde_json::{Value, json};
impl Recruit {
    pub fn bump(&mut self, key: &str, n: f64) -> f64 {
        let value = self.count(key) + n;
        if !self.state["season"]["counters"].is_object() {
            self.state["season"]["counters"] = json!({});
        }
        self.state["season"]["counters"][key] = json!(value);
        value
    }
    pub fn mbump(&mut self, uid: &str, key: &str, n: f64) -> Result<f64> {
        let m = self.owned_mut(uid)?;
        let v = num(&m["counters"][key]) + n;
        if !m["counters"].is_object() {
            m["counters"] = json!({});
        }
        m["counters"][key] = json!(v);
        Ok(v)
    }
    pub fn remember_card(&mut self, m: Value) -> Result<String> {
        validate_minion(&m)?;
        let uid = str_field(&m, "uid")?.to_owned();
        if self.locate(&uid).is_err() {
            self.state["__detached"].as_array_mut().unwrap().push(m);
        }
        Ok(uid)
    }
    pub fn detach(&mut self, uid: &str) -> Result<Value> {
        let (zone, i) = self.locate(uid)?;
        let m = self.zone_mut(zone).as_array_mut().unwrap().remove(i);
        self.remember_card(m.clone())?;
        Ok(m)
    }
    pub fn board_ids(&self) -> Vec<String> {
        arr(&self.state["board"])
            .iter()
            .filter_map(|m| m["uid"].as_str().map(str::to_owned))
            .collect()
    }
    pub fn sync_all(&mut self) -> Result<()> {
        for zone in ["board", "hand", "shop"] {
            for i in 0..arr(&self.state[zone]).len() {
                self.state[zone][i] =
                    stats::sync(&self.state, self.state[zone][i].clone(), zone == "board")?;
            }
        }
        Ok(())
    }
    pub fn run_card(&mut self, ctx: &Context, m: &Value, event: &str) -> Result<()> {
        if ctx.depth > 12 {
            return Ok(());
        }
        self.remember_card(m.clone())?;
        let mut repeats = 1;
        if event == "rally" {
            for x in arr(&self.state["board"]) {
                if has(x, "repeatAllTriggers")? {
                    repeats = repeats.max(if truth(&x["golden"]) { 3 } else { 2 });
                }
            }
        }
        for _ in 0..repeats {
            for a in abilities(m)?.iter().filter(|a| a["event"] == event) {
                let mut next = ctx.clone();
                next.depth += 1;
                let mut source = self.owned(str_field(m, "uid")?)?;
                if let Some(temp) = m.get("tempSpell") {
                    source["tempSpell"] = temp.clone();
                }
                self.effect(&next, &source, a)?;
            }
        }
        Ok(())
    }
    pub fn majority(&self) -> Result<Option<String>> {
        let mut best = None;
        let mut max = 0;
        for t in arr(&catalog().data["tribes"]) {
            let t = t.as_str().unwrap();
            let mut n = 0;
            for m in arr(&self.state["board"])
                .iter()
                .chain(arr(&self.state["hand"]))
            {
                if tribe(m, t)? {
                    n += 1;
                }
            }
            if n > max {
                max = n;
                best = Some(t.into());
            }
        }
        Ok(best)
    }
    pub fn queue_effect(&mut self, ctx: &Context, kind: &str, mut opts: Value) -> Result<()> {
        if ctx.trinket_set {
            opts["trinket"] = json!(ctx.trinket);
        }
        self.queue(kind, &opts)
    }
    pub fn gift_event(&mut self, ctx: &Context, uid: &str, event: &str) -> Result<()> {
        let m = self.owned(uid)?;
        let Some(gift) = m["gift"].as_str() else {
            return Ok(());
        };
        let n = gift.trim_start_matches("BG36_MidGameEffect_000t");
        match event {
            "play" => {
                let target = self.owned_mut(uid)?;
                if n == "74" {
                    target["attack"] = json!(num(&target["attack"]) + 3.);
                }
                if n == "75" {
                    target["health"] = json!(num(&target["health"]) + 3.);
                }
            }
            "rally" if n == "80" => self.effect(
                ctx,
                &m,
                &json!({"event":"rally","op":"spell","id":"BG20_GEM","amount":2}),
            )?,
            "death" => {
                if n == "52" {
                    self.state["season"]["freeRefresh"] =
                        json!(num(&self.state["season"]["freeRefresh"]) + 2.);
                }
                if n == "5" {
                    let tier = num(&self.state["tier"]);
                    if let Some(card) = self.draw_spell(|d| num(&d["tier"]) <= tier)? {
                        self.put_hand(card, true)?;
                    }
                }
            }
            "end" => {
                if n == "51" {
                    let t = num(&m["giftTurn"]);
                    let t = if t == 0. { 3. } else { t };
                    stats::add(
                        self.owned_mut(uid)?,
                        if t == 3. { 1. } else { t - 2. },
                        if t == 3. { 2. } else { t - 2. },
                    );
                }
                if n == "4" && num(&self.state["turn"]) == num(&m["giftTurn"]) + 2. {
                    let target = self.owned_mut(uid)?;
                    target["attack"] = json!(num(&target["attack"]) * 2.);
                    target["health"] = json!(num(&target["health"]) * 2.);
                }
                if n == "10" {
                    let mut next = ctx.clone();
                    next.target = None;
                    self.battlecry(&next, uid)?;
                }
                let turn = num(&self.state["turn"]);
                let gift_turn = m["giftTurn"].as_f64().filter(|v| *v != 0.).unwrap_or(turn);
                if ["18", "82"].contains(&n) && (turn - gift_turn + 1.) % 2. == 0. {
                    let tier = num(&self.state["tier"]);
                    let mut types = vec![];
                    for t in arr(&catalog().data["tribes"]) {
                        if tribe(&m, t.as_str().unwrap())? {
                            types.push(t.clone());
                        }
                    }
                    let card = self.draw(|d| {
                        if n == "18" {
                            d["id"] == m["id"]
                        } else {
                            num(&d["tier"]) <= tier
                                && arr(&d["races"]).iter().any(|t| types.contains(t))
                        }
                    })?;
                    if let Some(card) = card {
                        self.put_hand(card, true)?;
                    }
                }
            }
            "combat" => return Err("RUST_EFFECT_INCOMPLETE: combat gift context".into()),
            _ => {}
        }
        Ok(())
    }
    pub fn discard(&mut self, ctx: &Context, uid: &str) -> Result<bool> {
        if !arr(&self.state["hand"]).iter().any(|m| m["uid"] == uid) {
            return Ok(false);
        }
        let mut card = self.detach(uid)?;
        self.release(&mut card)?;
        *self.owned_mut(uid)? = card.clone();
        self.bump("discarded", 1.);
        self.log(format!(
            "弃掉{}。",
            str_field(def(str_field(&card, "id")?)?, "name")?
        ));
        self.run_event(ctx, uid, "discarded")?;
        let mut next = ctx.clone();
        next.event_minion = Some(uid.into());
        for id in self.board_ids() {
            self.run_event(&next, &id, "discard")?;
        }
        self.trinket_event(&next, "discard", None)?;
        self.sync_all()?;
        Ok(true)
    }
    pub fn discard_partner(&mut self, ctx: &Context, m: &Value) -> Result<()> {
        if truth(&m["discardGroup"]) {
            let ids: Vec<String> = arr(&self.state["hand"])
                .iter()
                .filter(|x| x["discardGroup"] == m["discardGroup"])
                .map(|x| str_field(x, "uid").map(str::to_owned))
                .collect::<Result<_>>()?;
            for id in ids {
                self.discard(ctx, &id)?;
            }
        }
        Ok(())
    }
    pub fn hero_damage(&mut self, ctx: &Context, n: f64) -> Result<()> {
        let mut rewind = false;
        for m in arr(&self.state["board"]) {
            rewind |= has(m, "rewind")?;
        }
        if !rewind {
            let armor = num(&self.state["season"]["armor"]);
            if self.count("iceBlock") != 0. && n >= num(&self.state["health"]) + armor {
                self.state["season"]["counters"]["iceBlock"] = json!(0);
            } else {
                let absorbed = armor.min(n);
                self.state["season"]["armor"] = json!(armor - absorbed);
                self.state["season"]["spellArmor"] =
                    json!((num(&self.state["season"]["spellArmor"]) - absorbed).max(0.));
                self.state["health"] = json!(num(&self.state["health"]) - n + absorbed);
            }
        }
        let mut next = ctx.clone();
        next.amount = n;
        for id in self.board_ids() {
            self.run_event(&next, &id, "heroDamage")?;
        }
        self.trinket_event(&next, "heroDamage", None)?;
        self.sync_all()
    }
    pub fn consume(
        &mut self,
        ctx: &Context,
        eater: &str,
        food: &str,
        f: f64,
        keywords: bool,
    ) -> Result<()> {
        if !arr(&self.state["shop"]).iter().any(|m| m["uid"] == food) {
            return Ok(());
        }
        let card = self.owned(food)?;
        self.gain(
            eater,
            num(&card["attack"]) * f,
            num(&card["health"]) * f,
            None,
            ctx.depth,
        )?;
        for id in self.board_ids() {
            let watcher = self.owned(&id)?;
            if has(&watcher, "copyConsumedStats")? {
                let factor = if truth(&watcher["golden"]) { 2. } else { 1. };
                self.gain(
                    &id,
                    num(&card["attack"]) * factor,
                    num(&card["health"]) * factor,
                    Some(&watcher),
                    ctx.depth,
                )?;
            }
        }
        let claws = if tribe(&self.owned(eater)?, "恶魔")? {
            self.item("BG36_MagicItem_801")
        } else {
            0
        };
        if keywords || claws > 0 {
            for k in arr(&card["keywords"]) {
                keyword(self.owned_mut(eater)?, k.as_str().unwrap());
            }
        }
        if claws > 0 {
            self.gain(eater, 5. * claws as f64, 5. * claws as f64, None, ctx.depth)?;
        }
        let mut card = self.detach(food)?;
        self.release(&mut card)?;
        *self.owned_mut(food)? = card;
        Ok(())
    }
    pub fn cast_spell(&mut self, ctx: &Context, m: &Value) -> Result<()> {
        if ctx.depth > 12 {
            return Ok(());
        }
        self.remember_card(m.clone())?;
        let list = abilities(m)?;
        if list
            .iter()
            .any(|a| a["event"] == "cast" && a["op"] == "choose")
        {
            self.run_card(ctx, m, "cast")?;
            if ctx.from_hand {
                self.discard_partner(ctx, m)?;
            }
            return Ok(());
        }
        let targeted = list
            .iter()
            .any(|a| a["event"] == "cast" && a["target"] == "selected");
        let mut ctx = ctx.clone();
        if targeted && ctx.target.is_none() {
            let targets = crate::targets::targets(&self.state, m, "cast")?;
            let index = self.index(arr(&targets).len());
            ctx.target = arr(&targets)
                .get(index)
                .and_then(|x| x["uid"].as_str())
                .map(str::to_owned);
        }
        if targeted && ctx.target.is_none() {
            return Ok(());
        }
        let friendly = ctx
            .target
            .as_ref()
            .is_some_and(|uid| arr(&self.state["board"]).iter().any(|x| x["uid"] == *uid));
        let bounty = [
            "s14_BG33_811",
            "s14_BG33_812",
            "s14_BG33_813",
            "s14_BG33_814",
            "s14_BG33_815",
        ]
        .contains(&str_field(m, "id")?);
        let mut repeats = 1;
        for x in arr(&self.state["board"]) {
            if (friendly && has(x, "repeatFriendlySpell")?) || (bounty && has(x, "repeatBounty")?) {
                repeats = repeats.max(if truth(&x["golden"]) { 3 } else { 2 });
            }
        }
        let turn = num(&self.state["turn"]);
        if self.bump(&format!("trinketFirstSpell:{turn}"), 1.) == 1. {
            repeats += self.item("BG30_MagicItem_434");
        }
        if truth(&m["expires"]) && self.bump(&format!("trinketFirstCraft:{turn}"), 1.) <= 2. {
            repeats += self.item("BG30_MagicItem_920");
        }
        let craft = truth(&m["expires"]) && def(str_field(m, "id")?)?["kind"] == "spell";
        let mut permanent = truth(&m["counters"]["permanentCraft"]);
        if ctx.from_hand
            && craft
            && let Some(uid) = &ctx.target
        {
            let target = self.owned(uid)?;
            let key = format!("permanentCraft:{turn}");
            let f = if truth(&target["golden"]) { 2 } else { 1 };
            if has(&target, "permanentSpellcraft")? && num(&target["counters"][&key]) < f as f64 {
                self.mbump(uid, &key, 1.)?;
                permanent = true;
            }
            let key = format!("copyCraft:{turn}");
            if has(&target, "copySpellcraft")? && num(&target["counters"][&key]) < 1. {
                self.mbump(uid, &key, 1.)?;
                for _ in 0..f {
                    let mut copy = m.clone();
                    copy["uid"] = self.make(str_field(m, "id")?, false, false)?["uid"].clone();
                    copy["copies"] = json!({});
                    self.put_hand(copy, true)?;
                }
            }
        }
        for i in 0..repeats {
            let mut next = ctx.clone();
            next.target = ctx
                .target
                .as_ref()
                .filter(|uid| {
                    arr(&self.state["board"])
                        .iter()
                        .chain(arr(&self.state["shop"]))
                        .any(|x| x["uid"] == **uid && num(&x["health"]) > 0.)
                })
                .cloned();
            if targeted {
                let Some(uid) = &next.target else {
                    break;
                };
                if !arr(&crate::targets::targets(&self.state, m, "cast")?)
                    .iter()
                    .any(|x| x["uid"] == *uid)
                {
                    break;
                }
            }
            next.permanent_spell = permanent;
            next.from_hand = ctx.from_hand && i == 0;
            let mut spell = m.clone();
            if permanent {
                spell["tempSpell"] = json!(false);
            }
            self.cast_once(&next, &spell)?;
        }
        let mut event = ctx.clone();
        event.event_minion = Some(str_field(m, "uid")?.into());
        if craft {
            for id in self.board_ids() {
                self.run_event(&event, &id, "spellcraftCast")?;
            }
        }
        if ctx.from_hand {
            self.discard_partner(&ctx, m)?;
            for id in self.board_ids() {
                self.run_event(&event, &id, "cardPlayed")?;
            }
            self.trinket_event(&event, "cardPlayed", None)?;
        }
        Ok(())
    }
    pub fn cast_once(&mut self, ctx: &Context, m: &Value) -> Result<()> {
        self.run_card(ctx, m, "cast")?;
        self.bump("allSpells", 1.);
        let mut event = ctx.clone();
        event.event_minion = Some(str_field(m, "uid")?.into());
        self.trinket_event(&event, "spell", None)?;
        if !truth(&m["tempSpell"]) && arr(&catalog().data["tavernSpellIds"]).contains(&m["id"]) {
            self.state["season"]["spellsCast"] =
                json!(num(&self.state["season"]["spellsCast"]) + 1.);
            self.state["season"]["lastSpell"] = m["id"].clone();
            self.trinket_event(&event, "tavernSpell", None)?;
            if ctx.from_hand {
                self.bump(
                    &format!("handTavernSpells:{}", num(&self.state["turn"])),
                    1.,
                );
                if self.item("BG32_MagicItem_801t") > 0 {
                    self.bump("forestSpells", 1.);
                }
            }
            let mut next = ctx.clone();
            next.depth += 1;
            next.event_minion = ctx.target.clone();
            for id in self.board_ids() {
                self.run_event(&next, &id, "tavernSpell")?;
            }
            let count = self.item("BG36_MagicItem_800") as f64;
            if count > 0. {
                self.scale("shop", count, count)?;
            }
            self.state["season"]["fodder"] = json!(
                num(&self.state["season"]["fodder"]) + self.item("BG36_MagicItem_830") as f64
            );
        }
        let mut next = ctx.clone();
        next.depth += 1;
        for id in self.board_ids() {
            self.run_event(&next, &id, "anySpell")?;
        }
        if let Some(uid) = &ctx.target {
            self.trinket_event(&event, "targetSpell", None)?;
            self.run_event(&next, uid, "targetSpell")?;
            next.event_minion = Some(uid.clone());
            for id in self.board_ids() {
                for (t, e) in [
                    ("机械", "spellMech"),
                    ("鱼人", "spellMurloc"),
                    ("纳迦", "spellNaga"),
                ] {
                    if tribe(&self.owned(uid)?, t)? {
                        self.run_event(&next, &id, e)?;
                    }
                }
            }
            if self.item("BG36_MagicItem_307") > 0 {
                let n = num(&self.state["season"]["buffs"]["wand"]["attack"]) + 1.;
                self.state["season"]["buffs"]["wand"] = json!({"attack":n,"health":0});
                if n % 3. == 0. {
                    self.gold(self.item("BG36_MagicItem_307") as f64, true);
                }
            }
        }
        for id in self.board_ids() {
            self.gift_event(ctx, &id, "play")?;
        }
        self.trinket_spell(ctx, m)?;
        self.sync_all()
    }
    pub fn trinket_spell(&mut self, ctx: &Context, m: &Value) -> Result<()> {
        if !truth(&m["tempSpell"]) && arr(&catalog().data["tavernSpellIds"]).contains(&m["id"]) {
            self.bump(&format!("trinketSpells:{}", num(&self.state["turn"])), 1.);
            for _ in 0..self.item("BG36_MagicItem_820") {
                let ids: Vec<String> = arr(&self.state["board"])
                    .iter()
                    .chain(arr(&self.state["hand"]))
                    .filter(|x| x["id"] == "s14_BG32_330")
                    .map(|x| str_field(x, "uid").map(str::to_owned))
                    .collect::<Result<_>>()?;
                for id in ids {
                    self.gain(&id, 3., 3., None, ctx.depth)?;
                }
            }
        }
        if let Some(uid) = &ctx.target {
            if self.item("BG36_MagicItem_371") > 0 {
                self.bump(&format!("honeycomb:{}", num(&self.state["turn"])), 1.);
            }
            if arr(&self.state["board"]).iter().any(|x| x["uid"] == *uid) && !ctx.trinket_cast {
                for _ in 0..self.item("BG36_MagicItem_211") {
                    let candidates = crate::targets::targets(&self.state, m, "cast")?;
                    let candidates: Vec<Value> = arr(&candidates)
                        .iter()
                        .filter(|x| {
                            x["uid"] != *uid
                                && arr(&self.state["board"])
                                    .iter()
                                    .any(|b| b["uid"] == x["uid"])
                        })
                        .cloned()
                        .collect();
                    let i = self.index(candidates.len());
                    if let Some(target) = candidates.get(i) {
                        let mut next = ctx.clone();
                        next.target = Some(str_field(target, "uid")?.into());
                        next.from_hand = false;
                        next.trinket_cast = true;
                        next.depth += 1;
                        self.cast_spell(&next, m)?;
                    }
                }
            }
            if arr(&self.state["shop"]).iter().any(|x| x["uid"] == *uid)
                && self.item("BG36_MagicItem_831") > 0
            {
                let ids = self.board_ids();
                let i = self.index(ids.len());
                if let Some(id) = ids.get(i) {
                    self.consume(ctx, id, uid, 1., false)?;
                }
            }
        }
        for (slot, id) in arr(&self.state["season"]["trinkets"])
            .to_vec()
            .iter()
            .enumerate()
        {
            if id == "BG36_MagicItem_305" && self.bump(&format!("rune:{slot}"), 1.) >= 18. {
                self.replace_rune(ctx, slot)?;
            }
        }
        Ok(())
    }
    pub fn trinket_event(&mut self, ctx: &Context, event: &str, only: Option<usize>) -> Result<()> {
        if ctx.depth > 12 {
            return Ok(());
        }
        let equipped = arr(&self.state["season"]["trinkets"]).to_vec();
        for (slot, id) in equipped.iter().enumerate() {
            if only.is_some_and(|n| n != slot) {
                continue;
            }
            let id = id.as_str().ok_or("Invalid trinket id")?;
            let rules = &catalog().data["trinketRules"][id];
            if rules.is_null() {
                continue;
            }
            let key = format!("trinket:{slot}:{id}");
            if !self.state["season"]["trinketData"].is_object() {
                self.state["season"]["trinketData"] = json!({});
            }
            if self.state["season"]["trinketData"][&key].is_null() {
                let mut data = json!({"turn":self.state["turn"]});
                let ty = if let Some(t) = self.majority()? {
                    Some(json!(t))
                } else {
                    let ts = arr(&self.state["season"]["tribes"]).to_vec();
                    let i = self.index(ts.len());
                    ts.get(i).cloned()
                };
                if let Some(t) = ty {
                    data["type"] = t;
                }
                self.state["season"]["trinketData"][&key] = data;
            }
            for (index, rule) in arr(rules).iter().enumerate() {
                if rule["event"] != event || truth(&rule["combatOnly"]) {
                    continue;
                }
                if let Some(t) = rule["subjectTribe"].as_str() {
                    let Some(uid) = &ctx.event_minion else {
                        continue;
                    };
                    if !tribe(&self.owned(uid)?, t)? {
                        continue;
                    }
                }
                let progress = format!(
                    "{key}:{index}{}",
                    if truth(&rule["perTurn"]) {
                        format!(":{}", num(&self.state["turn"]))
                    } else {
                        String::new()
                    }
                );
                let before = self.count(&progress);
                let amount = if event == "spend" && truth(&rule["every"]) {
                    ctx.amount
                } else {
                    1.
                };
                let after = self.bump(&progress, amount);
                let every = rule["every"].as_f64().filter(|v| *v != 0.).unwrap_or(1.);
                let limit = rule["limit"].as_f64().unwrap_or(f64::INFINITY);
                let triggers =
                    (after.min(limit) / every).floor() - (before.min(limit) / every).floor();
                for _ in 0..(triggers.max(0.) as usize) {
                    let mut next = ctx.clone();
                    next.depth += 1;
                    next.trinket = true;
                    next.trinket_set = true;
                    if rule["op"] == "trinketCustom" {
                        self.trinket_custom(&next, id, event, slot, &key)?;
                        continue;
                    }
                    if rule["op"] == "trinketDraw" {
                        let tier = num(&self.state["tier"]);
                        if let Some(card) = self.draw(|d| {
                            num(&d["tier"]) <= tier
                                && (!truth(&rule["key"])
                                    || arr(&d["mechanics"]).contains(&rule["key"]))
                        })? {
                            self.trinket_card(card)?;
                        }
                    } else {
                        let m = self.make("s14_BG20_GEM", false, false)?;
                        self.remember_card(m.clone())?;
                        self.effect(&next, &m, rule)?;
                    }
                }
            }
        }
        Ok(())
    }
}
