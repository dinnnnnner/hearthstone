//! Hero recruitment effects, using the same mutable game and RNG as all other rules.
use crate::recruit::Recruit;
use crate::recruit_effects::Context;
use crate::{Result, arr, catalog, def, num, powers, primitives, str_field, tribe, truth};
use serde_json::{Value, json};
impl Recruit {
    pub fn offer_powers(&mut self, mode: &str, selected: &[Value]) -> Result<()> {
        let equipped = powers::equipped(&self.state);
        let mut offers: Vec<Value> = arr(&catalog().data["heroPool"])
            .iter()
            .filter(|id| {
                let idstr = id.as_str().unwrap_or("");
                !equipped.contains(id)
                    && !selected.contains(id)
                    && !["s14_finley", "s14_nguyen", "s14_genn", "s14_patchwerk"].contains(&idstr)
                    && (mode != "nguyen" || powers::eligible(&self.state, idstr))
                    && (!truth(&catalog().data["heroTribes"][idstr])
                        || arr(&self.state["season"]["tribes"])
                            .contains(&catalog().data["heroTribes"][idstr]))
            })
            .cloned()
            .collect();
        self.shuffle(&mut offers);
        offers.truncate(if mode == "nguyen" { 2 } else { 3 });
        self.state["season"]["powerChoice"] =
            json!({"mode":mode,"offers":offers,"selected":selected});
        Ok(())
    }
    pub fn start_power_effects(&mut self) -> Result<()> {
        if powers::has(&self.state, "xavius")
            && num(&self.state["turn"]) % 4. == 0.
            && arr(&self.state["discovery"]).is_empty()
        {
            self.dark_discover()?;
        }
        Ok(())
    }
    pub fn hero_start(&mut self, ctx: &Context) -> Result<()> {
        let tier = num(&self.state["tier"]);
        self.state["season"]["boughtTurn"] = json!([]);
        if let Some(cs) = self.state["season"]["counters"].as_object_mut() {
            for (key, value) in cs {
                if key.ends_with(":boughtMinionsTurn") {
                    *value = json!(0);
                }
            }
        }
        for key in ["togwaggle", "nobundo"] {
            if powers::has(&self.state, key) {
                self.bump(&format!("{key}Discount"), 1.);
            }
        }
        let turn = num(&self.state["turn"]);
        if powers::has(&self.state, "afk") {
            if turn <= 2. {
                self.state["gold"] = json!(0);
            }
            if turn == 3. {
                self.queue("minion", &json!({"tiers":[3]}))?;
                self.queue("minion", &json!({"tiers":[4]}))?;
            }
        }
        if powers::has(&self.state, "vashj") {
            let m = self.make("s14_BG25_001", false, false)?;
            self.expanded(ctx, &m, &json!({"event":"start","op":"randomSpellcraft"}))?;
        }
        if powers::has(&self.state, "yogg") && turn >= 3. {
            if let Some(m) = self.draw_spell(|d| num(&d["tier"]) <= tier)? {
                let mut c = ctx.clone();
                c.from_hand = false;
                self.cast_spell(&c, &m)?;
            }
        }
        Ok(())
    }
    pub fn hero_end(&mut self, ctx: &Context) -> Result<()> {
        let turn = num(&self.state["turn"]);
        if powers::has(&self.state, "sindragosa") {
            self.state["frozen"] = json!(true);
        }
        if powers::has(&self.state, "voone") && turn % 3. == 0. {
            if let Some(source) = arr(&self.state["hand"]).first().cloned() {
                let id = str_field(&source, "id")?;
                let mut copy = if def(id)?["kind"] == "spell" {
                    source.clone()
                } else {
                    self.make(id, false, false)?
                };
                copy["uid"] = self.make(id, false, false)?["uid"].clone();
                copy["copies"] = json!({});
                if id == "s14_BG36_520t" {
                    copy["lockedUntil"] = json!(turn + 5.);
                }
                self.put_hand(copy, true)?;
            }
        }
        if powers::has(&self.state, "cthun") && self.count("cthunTurn") == turn {
            for _ in 0..turn as usize {
                let ids = self.board_ids();
                let i = self.index(ids.len());
                if let Some(uid) = ids.get(i) {
                    self.gain(uid, 1., 1., ctx.source.as_ref(), ctx.depth)?;
                }
            }
        }
        if powers::has(&self.state, "ragnaros") && self.count("power:ragnaros:boughtCards") >= 12. {
            let ids = self.board_ids();
            if let Some(uid) = ids.first() {
                self.gain(uid, 4., 4., ctx.source.as_ref(), ctx.depth)?;
            }
            if ids.len() > 1 {
                self.gain(ids.last().unwrap(), 4., 4., ctx.source.as_ref(), ctx.depth)?;
            }
        }
        Ok(())
    }
    pub fn hero_action(
        &mut self,
        ctx: &Context,
        key: &str,
        target: Option<&str>,
    ) -> Result<Option<String>> {
        let dummy = self.make("s14_BG25_001", false, false)?;
        let mut c = ctx.clone();
        c.target = target.map(str::to_owned);
        let tier = num(&self.state["tier"]);
        let turn = num(&self.state["turn"]);
        let target = target.map(|id| self.owned(id)).transpose()?;
        match key {
            "edwin" => {
                if let Some(m) = &target {
                    let n = 2. + 2. * (self.count("power:edwin:boughtCards") / 4.).floor();
                    self.gain(str_field(m, "uid")?, n, n, ctx.source.as_ref(), ctx.depth)?;
                }
            }
            "mutanus" => self.expanded(
                &c,
                &dummy,
                &json!({"event":"power","op":"sellTransfer","target":"selected"}),
            )?,
            "cookie" => {
                if let Some(m) = &target {
                    let mut types = arr(&self.state["season"]["cookieTribes"]).to_vec();
                    for t in arr(&catalog().data["tribes"]) {
                        if tribe(m, t.as_str().unwrap())? {
                            types.push(t.clone());
                        }
                    }
                    self.state["season"]["cookieTribes"] = json!(types);
                    let mut card = self.detach(str_field(m, "uid")?)?;
                    self.release(&mut card)?;
                    *self.owned_mut(str_field(m, "uid")?)? = card;
                    if self.bump("cookieCount", 1.) % 3. == 0. {
                        self.state["season"]["cookieTribes"] = json!([]);
                        let mut options: Vec<Value> = self
                            .pool_cards()?
                            .into_iter()
                            .filter(|d| {
                                num(&self.state["pool"][d["id"].as_str().unwrap()]) > 0.
                                    && num(&d["tier"]) <= tier
                                    && (d["tribe"] == "全部"
                                        || arr(&d["races"]).iter().any(|t| types.contains(t)))
                            })
                            .map(|d| d["id"].clone())
                            .collect();
                        self.shuffle(&mut options);
                        options.truncate(3);
                        self.queue("cookie", &json!({"options":options}))?;
                    }
                }
            }
            "scabbs" => {
                let index = num(&self.state["nextOpponent"]) as usize;
                let board = arr(&self.state["opponents"][index]["board"]);
                if board.is_empty() {
                    return Ok(Some("下一个对手没有可供发现的随从。".into()));
                }
                self.copy_discovery(&board.iter().map(|m| m["id"].clone()).collect::<Vec<_>>())?;
            }
            "sylvanas" => {
                let ids = arr(&self.state["season"]["lastDead"]).to_vec();
                if ids.is_empty() {
                    return Ok(Some("上一场战斗没有死亡随从。".into()));
                }
                self.copy_discovery(&ids)?;
            }
            "galakrond" => {
                if let Some(m) = &target {
                    self.queue("minion",&json!({"tiers":[(num(&def(str_field(m,"id")?)?["tier"])+1.).min(6.)],"replaceShop":m["uid"]}))?;
                }
            }
            "tavish" => {
                if let Some(m) = &target {
                    if !self.state["season"]["heroMarks"].is_object() {
                        self.state["season"]["heroMarks"] = json!({});
                    }
                    self.state["season"]["heroMarks"]["tavishId"] = m["id"].clone();
                    self.bump(
                        "tavishAttack",
                        num(&m["attack"]) - self.count("tavishAttack"),
                    );
                    let mut card = self.detach(str_field(m, "uid")?)?;
                    self.release(&mut card)?;
                    *self.owned_mut(str_field(m, "uid")?)? = card;
                }
            }
            "togwaggle" => {
                let cards: Vec<Value> = arr(&self.state["shop"])
                    .iter()
                    .chain(arr(&self.state["season"]["spellShop"]))
                    .cloned()
                    .collect();
                for m in cards {
                    self.put_hand(m, true)?;
                }
                self.state["shop"] = json!([]);
                self.state["season"]["spellShop"] = json!([]);
                self.bump("togwaggleDiscount", -self.count("togwaggleDiscount"));
            }
            "teron" => {
                if let Some(m) = &target {
                    if !self.state["season"]["heroMarks"].is_object() {
                        self.state["season"]["heroMarks"] = json!({});
                    }
                    self.state["season"]["heroMarks"]["teron"] = m["uid"].clone();
                }
            }
            "zerek" => {
                if let Some(m) = &target {
                    if arr(&self.state["board"]).len() >= 7 {
                        return Ok(Some("战场已满。".into()));
                    }
                    let mut copy = m.clone();
                    copy["uid"] = self.make(str_field(m, "id")?, false, false)?["uid"].clone();
                    copy["copies"] = json!({});
                    copy["reward"] = json!(false);
                    let uid = str_field(&copy, "uid")?.to_owned();
                    self.state["board"].as_array_mut().unwrap().push(copy);
                    self.notify_summon(ctx, &uid)?;
                }
            }
            "snakeEyes" => {
                let roll = (self.index(6) + 1).min(6);
                self.gold(roll as f64, false);
                self.bump(
                    "snakeUnlock",
                    turn + roll as f64 - self.count("snakeUnlock"),
                );
                self.log(format!("骰子点数：{roll}。"));
            }
            "nobundo" => {
                let Some(id) = self.state["season"]["lastSpell"]
                    .as_str()
                    .map(str::to_owned)
                else {
                    return Ok(Some("还没有施放过酒馆法术。".into()));
                };
                let m = self.make(&id, false, false)?;
                self.put_hand(m, true)?;
                self.bump("nobundoDiscount", -self.count("nobundoDiscount"));
            }
            "akazamzarakScholar" => {
                self.state["season"]["spellDiscount"] =
                    json!(num(&self.state["season"]["spellDiscount"]) + 1.)
            }
            "cenarius" => {
                self.state["season"]["maxGold"] = json!(num(&self.state["season"]["maxGold"]) + 1.)
            }
            "chromie" => self.expanded(ctx, &dummy, &json!({"event":"power","op":"spellShop"}))?,
            "ratKing" => {
                let ts = arr(&self.state["season"]["tribes"]);
                let t = ts
                    .get((turn as usize - 1) % ts.len())
                    .cloned()
                    .unwrap_or(Value::Null);
                self.queue("minion", &json!({"tribe":t}))?;
            }
            "patches" => {
                if let Some(m) = self.draw(|d| {
                    num(&d["tier"]) <= tier
                        && (arr(&d["races"]).iter().any(|t| t == "海盗") || d["tribe"] == "全部")
                })? {
                    self.put_hand(m, true)?;
                }
                self.bump("patchesDiscount", -self.count("patchesDiscount"));
            }
            "shudderwock" => {
                if let Some(m) = &target {
                    let mut c = ctx.clone();
                    c.target = None;
                    self.battlecry(&c, str_field(m, "uid")?)?;
                }
            }
            "bazhial" | "maiev" => {
                if let Some(m) = &target {
                    let mut card = self.detach(str_field(m, "uid")?)?;
                    if key == "maiev" {
                        card["lockedUntil"] = json!(turn + 2.);
                    }
                    self.put_hand(card, true)?;
                    if key == "bazhial" {
                        self.hero_damage(ctx, 2.)?;
                    }
                }
            }
            "toki" => {
                self.refill(false, false, true)?;
                for _ in 0..2 {
                    if let Some(m) = self.draw(|d| num(&d["tier"]) == (tier + 1.).min(6.))? {
                        if let Some(mut old) = self.state["shop"].as_array_mut().unwrap().pop() {
                            self.release(&mut old)?;
                        }
                        let m = self.apply_shop(m)?;
                        self.state["shop"].as_array_mut().unwrap().insert(0, m);
                    }
                }
            }
            "cthun" | "rafaam" | "yshaarj" => {
                let k = format!("{key}Turn");
                self.bump(&k, turn - self.count(&k));
            }
            "tess" => {
                let cards = arr(&self.state["season"]["lastEnemy"]).to_vec();
                if cards.is_empty() {
                    return Ok(Some("还没有上一场对手的战队记录。".into()));
                }
                for mut old in arr(&self.state["shop"]).to_vec() {
                    self.release(&mut old)?;
                }
                let mut shop = vec![];
                for m in cards {
                    shop.push(self.make(str_field(&m, "id")?, false, false)?);
                }
                self.state["shop"] = json!(shop);
                self.state["season"]["spellShop"] = json!([]);
                if let Some(m) = self.draw_spell(|d| num(&d["tier"]) <= tier)? {
                    self.state["season"]["spellShop"]
                        .as_array_mut()
                        .unwrap()
                        .push(m);
                }
                self.state["frozen"] = json!(false);
            }
            "malygos" => {
                if let Some(m) = &target {
                    let d = def(str_field(m, "id")?)?;
                    let t = num(&d["tier"]);
                    let replacement = if d["kind"] == "spell" {
                        self.draw_spell(|x| num(&x["tier"]) == t)?
                    } else {
                        self.draw(|x| num(&x["tier"]) == t)?
                    };
                    if let Some(card) = replacement {
                        let uid = str_field(m, "uid")?;
                        *self.owned_mut(uid)? = card;
                        let mut old = m.clone();
                        self.release(&mut old)?;
                    }
                }
            }
            "eudora" => {
                if self.bump("eudoraDigs", 1.) % 4. == 0. {
                    let cards: Vec<Value> = self
                        .pool_cards()?
                        .into_iter()
                        .filter(|d| num(&d["tier"]) <= tier)
                        .collect();
                    let i = self.index(cards.len());
                    if let Some(d) = cards.get(i) {
                        let mut m = self.make(str_field(d, "id")?, true, false)?;
                        m["reward"] = json!(true);
                        self.put_hand(m, true)?;
                    }
                }
            }
            "hooktusk" => {
                if let Some(m) = &target {
                    let mut old = self.detach(str_field(m, "uid")?)?;
                    self.release(&mut old)?;
                    *self.owned_mut(str_field(m, "uid")?)? = old;
                    self.queue(
                        "minion",
                        &json!({"tiers":[(num(&def(str_field(m,"id")?)?["tier"])-1.).max(1.)]}),
                    )?;
                }
            }
            "kragg" => self.gold(turn + 1., false),
            "jailer" => {
                if let Some(m) = &target {
                    if self.destroy_recruit(ctx, str_field(m, "uid")?)? {
                        if let Some(m) = self.draw(|d| {
                            num(&d["tier"]) <= tier
                                && (arr(&d["races"]).iter().any(|t| t == "亡灵")
                                    || d["tribe"] == "全部")
                        })? {
                            self.put_hand(m, true)?;
                        }
                    }
                }
            }
            "jandice" => {
                if let Some(m) = &target {
                    let shop = arr(&self.state["shop"]).to_vec();
                    let i = self.index(shop.len());
                    let Some(other) = shop.get(i) else {
                        return Ok(Some("酒馆没有可交换的随从。".into()));
                    };
                    *self.owned_mut(str_field(m, "uid")?)? = other.clone();
                    self.state["shop"][i] = m.clone();
                }
            }
            "zephrys" => {
                let mut cards = vec![];
                for m in arr(&self.state["board"])
                    .iter()
                    .chain(arr(&self.state["hand"]))
                {
                    if !truth(&m["golden"]) && def(str_field(m, "id")?)?["kind"] != "spell" {
                        cards.push(m.clone());
                    }
                }
                let matches: Vec<Value> = cards
                    .iter()
                    .filter(|m| {
                        cards.iter().filter(|x| x["id"] == m["id"]).count() >= 2
                            && num(&self.state["pool"][m["id"].as_str().unwrap()]) > 0.
                    })
                    .cloned()
                    .collect();
                let i = self.index(matches.len());
                let Some(m) = matches.get(i) else {
                    return Ok(Some("没有可补齐三连的随从对子。".into()));
                };
                if let Some(card) = self.draw(|d| d["id"] == m["id"])? {
                    self.put_hand(card, true)?;
                }
            }
            _ => {}
        }
        Ok(None)
    }
    pub fn open_lockboxes(&mut self, ctx: &Context) -> Result<()> {
        let turn = num(&self.state["turn"]);
        let tier = num(&self.state["tier"]);
        for m in arr(&self.state["hand"]).to_vec() {
            if m["id"] == "s14_BG36_520t"
                && m["lockedUntil"]
                    .as_f64()
                    .filter(|v| *v != 0.)
                    .unwrap_or(f64::INFINITY)
                    <= turn
            {
                self.detach(str_field(&m, "uid")?)?;
                let candidates: Vec<Value> = self
                    .pool_cards()?
                    .into_iter()
                    .filter(|d| num(&d["tier"]) <= tier && !arr(&d["races"]).is_empty())
                    .collect();
                let i = self.index(candidates.len());
                if let Some(d) = candidates.get(i) {
                    let m = self.make(str_field(d, "id")?, true, false)?;
                    self.put_hand(m, true)?;
                }
                self.log("上锁宝箱已打开，获得金色随从。".into());
            }
        }
        let _ = ctx;
        Ok(())
    }
    pub fn hero_wheel(&mut self, ctx: &Context) -> Result<()> {
        let tier = num(&self.state["tier"]);
        let roll = self.rng.next_u32() as f64 / 4294967296.;
        if roll < 0.19 {
            let ids: Vec<String> = arr(&self.state["shop"])
                .iter()
                .filter(|m| !truth(&m["golden"]))
                .map(|m| m["uid"].as_str().unwrap().into())
                .collect();
            let i = self.index(ids.len());
            if let Some(uid) = ids.get(i) {
                let mut m = primitives::golden(self.owned(uid)?)?;
                m["reward"] = json!(true);
                *self.owned_mut(uid)? = m;
            }
        } else if roll < 0.38 {
            for _ in 0..2 {
                let choices =
                    self.darkmoon_prizes(
                        (num(&self.state["turn"]) / 4.).floor().clamp(1., 4.) as usize
                    );
                let i = self.index(choices.len());
                if let Some(id) = choices.get(i) {
                    let m = self.make(id, false, false)?;
                    self.give(ctx, m)?;
                }
            }
        } else if roll < 0.57 {
            let mut ids = self.board_ids();
            self.shuffle(&mut ids);
            if ids.len() > 1 {
                let m = self.owned(&ids[1])?;
                self.gain(
                    &ids[0],
                    num(&m["attack"]),
                    num(&m["health"]),
                    None,
                    ctx.depth,
                )?;
            }
        } else if roll < 0.76 {
            for food in arr(&self.state["shop"]).to_vec() {
                let ids = self.board_ids();
                let i = self.index(ids.len());
                if let Some(uid) = ids.get(i) {
                    self.consume(ctx, uid, str_field(&food, "uid")?, 1., false)?;
                }
            }
            self.refill(false, false, true)?;
        } else if roll < 0.95 {
            for _ in 0..4 {
                if let Some(m) = self.draw_spell(|d| num(&d["tier"]) <= tier)? {
                    let mut c = ctx.clone();
                    c.from_hand = false;
                    self.cast_spell(&c, &m)?;
                }
            }
        } else {
            for _ in 0..100 {
                let targets: Vec<Value> = arr(&self.state["board"])
                    .iter()
                    .chain(arr(&self.state["shop"]))
                    .cloned()
                    .collect();
                let i = self.index(targets.len() + 2);
                let Some(m) = targets.get(i) else {
                    break;
                };
                self.gain(
                    str_field(m, "uid")?,
                    10.,
                    10.,
                    ctx.source.as_ref(),
                    ctx.depth,
                )?;
            }
        }
        Ok(())
    }
    pub fn darkmoon_prizes(&mut self, tier: usize) -> Vec<String> {
        let codes: &[&str] = match tier {
            1 => &["004", "013", "029", "033", "040", "100", "110"],
            2 => &[
                "006", "009", "010", "012", "014", "018", "026", "030", "101",
            ],
            3 => &["011", "015", "019", "020", "034", "037", "039", "104"],
            _ => &["016", "022", "023", "025", "028", "032", "106"],
        };
        let mut cards: Vec<String> = codes
            .iter()
            .map(|id| format!("s14_BGS_Treasures_{id}"))
            .collect();
        self.shuffle(&mut cards);
        cards.truncate(3);
        cards
    }
}
