//! Recruitment trinket lifecycle and custom effects.
use crate::recruit::Recruit;
use crate::recruit_effects::{Context, keyword};
use crate::{
    Result, abilities, arr, catalog, def, num, powers, primitives, stats, str_field, tribe,
    trinkets, truth,
};
use serde_json::{Value, json};
impl Recruit {
    fn trinket_grant(&mut self, id: &str, golden: bool) -> Result<String> {
        let card = self.make(&format!("s14_{id}"), golden, false)?;
        let uid = str_field(&card, "uid")?.to_owned();
        self.trinket_card(card)?;
        Ok(uid)
    }
    fn trinket_craft(&mut self, id: &str) -> Result<()> {
        let mut m = self.make(&format!("s14_{id}"), false, false)?;
        m["expires"] = json!(true);
        self.trinket_card(m)
    }
    fn trinket_plain(&mut self, m: &Value) -> Result<()> {
        self.trinket_grant(
            str_field(def(str_field(m, "id")?)?, "sourceId")?,
            truth(&m["golden"]),
        )?;
        Ok(())
    }
    fn trinket_discover(&mut self, kind: &str, mut opts: Value) -> Result<()> {
        opts["trinket"] = json!(true);
        self.queue(kind, &opts)
    }
    fn trinket_cast_card(&mut self, ctx: &Context, id: &str, target: Option<String>) -> Result<()> {
        let mut c = ctx.clone();
        c.target = target;
        c.from_hand = false;
        c.trinket_cast = true;
        let card = self.make(&format!("s14_{id}"), false, false)?;
        self.cast_spell(&c, &card)
    }
    fn trinket_ends(&self, ty: Option<&str>) -> Result<Vec<String>> {
        let mut ids = vec![];
        for m in arr(&self.state["board"]) {
            if ty.map(|t| tribe(m, t)).transpose()?.unwrap_or(true) {
                ids.push(str_field(m, "uid")?.to_owned());
            }
        }
        if ids.len() > 2 {
            ids = vec![ids[0].clone(), ids.last().unwrap().clone()];
        }
        Ok(ids)
    }
    fn trinket_types(&self, m: &Value) -> Result<Vec<Value>> {
        let mut ts = vec![];
        for t in arr(&catalog().data["tribes"]) {
            if tribe(m, t.as_str().unwrap())? {
                ts.push(t.clone());
            }
        }
        Ok(ts)
    }
    fn trinket_pending(&mut self, choice: Value) {
        if !self.state["season"]["pendingTrinketChoices"].is_array() {
            self.state["season"]["pendingTrinketChoices"] = json!([]);
        }
        self.state["season"]["pendingTrinketChoices"]
            .as_array_mut()
            .unwrap()
            .push(choice);
    }
    pub fn queue_undead_creation(&mut self, part: Option<Value>) -> Result<()> {
        let mut opts = json!({"tribe":"亡灵","trinket":true});
        let kind = if let Some(part) = part {
            opts["creationPart"] = part;
            "undeadCreationFinish"
        } else {
            "undeadCreation"
        };
        self.queue(kind, &opts)
    }
    pub fn queue_timewarp(&mut self, greater: bool) -> Result<()> {
        let mut cards = vec![];
        for id in arr(&catalog().data["trinketDependencies"]["timewarp"]) {
            let id = id.as_str().ok_or("Invalid timewarp card")?;
            let d = def(&format!("s14_{id}"))?;
            let races = arr(&d["races"]);
            if num(&d["tier"]) == if greater { 5. } else { 3. }
                && (races.is_empty()
                    || d["tribe"] == "全部"
                    || races
                        .iter()
                        .any(|t| arr(&self.state["season"]["tribes"]).contains(t)))
                && (d["sourceId"] != "BG34_Giant_602" || powers::has(&self.state, "curator"))
            {
                cards.push(d["id"].clone());
            }
        }
        self.shuffle(&mut cards);
        cards.truncate(3);
        self.trinket_discover("timewarp", json!({"options":cards}))
    }
    pub fn trinket_start(
        &mut self,
        ctx: &Context,
        id: &str,
        purchased: bool,
        slot: usize,
    ) -> Result<()> {
        let n = id.strip_prefix("BG36_MagicItem_").unwrap_or(id);
        let turn = num(&self.state["turn"]);
        if purchased {
            let ty = if truth(&self.state["season"]["trinketOfferTypes"][id]) {
                Some(self.state["season"]["trinketOfferTypes"][id].clone())
            } else if let Some(t) = self.majority()? {
                Some(json!(t))
            } else {
                let ts = arr(&self.state["season"]["tribes"]).to_vec();
                let i = self.index(ts.len());
                ts.get(i).cloned()
            };
            let mut data = json!({"turn":turn});
            if let Some(t) = ty {
                data["type"] = t;
            }
            if !self.state["season"]["trinketData"].is_object() {
                self.state["season"]["trinketData"] = json!({});
            }
            self.state["season"]["trinketData"][format!("trinket:{slot}:{id}")] = data;
            let portrait = match n {
                "201" => Some("BG36_201"),
                "204" => Some("BG34_690"),
                "216" => Some("BG25_008"),
                "362" => Some("BG31_925"),
                "363" => Some("BG36_523"),
                "820" => Some("BG32_330"),
                _ => None,
            };
            if let Some(card) = portrait {
                self.trinket_grant(card, ["216", "363"].contains(&n))?;
            }
            if n == "206" {
                let mut opts = json!({"tiers":[4],"darkGift":true});
                if let Some(t) = self.majority()? {
                    opts["tribe"] = json!(t);
                }
                self.trinket_discover("darkGift", opts)?;
            }
            if n == "309" {
                self.trinket_discover("darkGift", json!({"tiers":[7],"darkGift":true}))?;
            }
            if n == "363" {
                for m in self.state["hand"].as_array_mut().unwrap() {
                    if m["id"] == "s14_BG36_520t" {
                        m["lockedUntil"] = json!(
                            m["lockedUntil"]
                                .as_f64()
                                .filter(|x| *x != 0.)
                                .unwrap_or(turn + 5.)
                                - 1.
                        );
                    }
                }
                self.open_lockboxes(ctx)?;
            }
        }
        if n == "208" {
            self.trinket_craft("BG36_MagicItem_208t")?;
        }
        if n == "301" {
            let mut found = false;
            for zone in ["hand", "pendingTrinketCards"] {
                let cards = if zone == "hand" {
                    &mut self.state["hand"]
                } else {
                    &mut self.state["season"]["pendingTrinketCards"]
                };
                if let Some(ms) = cards.as_array_mut() {
                    if let Some(m) = ms.iter_mut().find(|m| m["id"] == "s14_BG36_520t") {
                        m["lockedUntil"] = json!(
                            m["lockedUntil"]
                                .as_f64()
                                .filter(|x| *x != 0.)
                                .unwrap_or(turn + 5.)
                                - 2.
                        );
                        found = true;
                        break;
                    }
                }
            }
            if found {
                self.open_lockboxes(ctx)?;
            } else {
                let mut m = self.make("s14_BG36_520t", false, false)?;
                m["lockedUntil"] = json!(turn + 5. - self.item("BG36_MagicItem_363") as f64);
                self.trinket_card(m)?;
            }
        }
        if n == "303" || n == "303t" {
            for _ in 0..if n == "303t" { 2 } else { 1 } {
                let mut cards: Vec<Value> = self
                    .pool_cards()?
                    .into_iter()
                    .filter(|d| num(&self.state["pool"][d["id"].as_str().unwrap()]) > 0.)
                    .collect();
                for id in arr(&catalog().data["spellPool"]) {
                    cards.push(def(id.as_str().unwrap())?.clone());
                }
                let tier = num(&self.state["tier"]);
                cards.retain(|d| {
                    num(&d["tier"]) <= tier
                        && arr(&d["abilities"]).iter().any(|a| a["op"] == "choose")
                });
                let i = self.index(cards.len());
                if let Some(d) = cards.get(i) {
                    let m = if d["kind"] == "spell" {
                        Some(self.make(str_field(d, "id")?, false, false)?)
                    } else {
                        self.draw(|x| x["id"] == d["id"])?
                    };
                    if let Some(m) = m {
                        self.trinket_card(m)?;
                    }
                }
            }
        }
        if n == "370" {
            self.trinket_discover("darkGift",json!({"options":arr(&self.state["board"]).iter().map(|m|m["id"].clone()).collect::<Vec<_>>(),"darkGift":true}))?;
        }
        if n == "390" {
            let id = if self.index(2) == 0 {
                "BG31_816"
            } else {
                "BG31_818"
            };
            self.trinket_grant(id, false)?;
        }
        if n == "220" && !purchased {
            let mut n = 0;
            for t in arr(&catalog().data["tribes"]) {
                let mut yes = false;
                for m in arr(&self.state["board"]) {
                    yes |= tribe(m, t.as_str().unwrap())?;
                }
                n += usize::from(yes);
            }
            self.gold(n as f64, true);
        }
        if purchased {
            self.trinket_event(ctx, "purchase", Some(slot))?;
        }
        Ok(())
    }
    pub fn settle_trinkets(&mut self) -> Result<()> {
        for _ in 0..60 {
            let signature = |s: &Value| {
                (
                    arr(&s["hand"]).len(),
                    num(&s["triples"]),
                    arr(&s["season"]["pendingTrinketCards"]).len(),
                )
            };
            let before = signature(&self.state);
            self.flush()?;
            self.triples()?;
            if before == signature(&self.state) {
                break;
            }
        }
        self.sync_all()?;
        self.trinket_event(&Context::default(), "sync", None)?;
        if self.state["phase"] != "recruit" {
            return Ok(());
        }
        self.next_discovery()?;
        if !arr(&self.state["discovery"]).is_empty()
            || !arr(&self.state["season"]["trinketOffers"]).is_empty()
        {
            return Ok(());
        }
        let choice = if let Some(q) = self.state["season"]["pendingTrinketChoices"].as_array_mut() {
            if q.is_empty() {
                None
            } else {
                Some(q.remove(0))
            }
        } else {
            None
        };
        let Some(choice) = choice else {
            return Ok(());
        };
        let school = str_field(&choice, "school")?;
        let result = trinkets::offer(self.state.clone(), school, self.rng.state)?;
        self.state = result["state"].clone();
        self.rng.state = result["rng"].as_u64().unwrap() as u32;
        self.rng.draws += result["draws"].as_u64().unwrap() as u32;
        self.state["season"]["replacingTrinket"] = choice["slot"].clone();
        if self.state["season"]["kiriSlot"] == choice["slot"] {
            let mut offers = vec![];
            for t in arr(&catalog().data["trinkets"]) {
                let id = str_field(t, "id")?;
                if t["school"] == school
                    && num(&t["cost"]) <= 4.
                    && !["BG36_MagicItem_412", "BG36_MagicItem_412t2"].contains(&id)
                    && trinkets::eligible(&self.state, id)?
                    && arr(&catalog().data["trinketTypes"][id]["types"])
                        .iter()
                        .all(|t| arr(&self.state["season"]["tribes"]).contains(t))
                {
                    offers.push(t.clone());
                }
            }
            self.shuffle(&mut offers);
            offers.truncate(4);
            self.state["season"]["trinketOffers"] =
                json!(offers.iter().map(|t| t["id"].clone()).collect::<Vec<_>>());
            self.state["season"]["trinketOfferCosts"] = json!({});
            for t in offers {
                self.state["season"]["trinketOfferCosts"][t["id"].as_str().unwrap()] =
                    t["cost"].clone();
            }
        }
        if truth(&choice["free"]) {
            self.state["season"]["trinketOffers"]
                .as_array_mut()
                .unwrap()
                .truncate(2);
            self.state["season"]["trinketOfferCosts"] = json!({});
            for id in arr(&self.state["season"]["trinketOffers"]).to_vec() {
                self.state["season"]["trinketOfferCosts"][id.as_str().unwrap()] = json!(0);
            }
        }
        Ok(())
    }
    pub fn trinket_custom(
        &mut self,
        ctx: &Context,
        id: &str,
        event: &str,
        slot: usize,
        key: &str,
    ) -> Result<()> {
        // Aura entries describe conditions queried by pricing, recruitment and combat.
        // The TS event dispatcher has no custom mutation for these registry markers.
        if event == "aura"
            && matches!(
                id,
                "BG30_MagicItem_434"
                    | "BG30_MagicItem_439"
                    | "BG30_MagicItem_700"
                    | "BG30_MagicItem_701"
                    | "BG30_MagicItem_804"
                    | "BG30_MagicItem_841"
                    | "BG30_MagicItem_868"
                    | "BG30_MagicItem_888"
                    | "BG30_MagicItem_998"
                    | "BG32_MagicItem_283"
                    | "BG32_MagicItem_366"
                    | "BG32_MagicItem_367"
                    | "BG32_MagicItem_416"
                    | "BG32_MagicItem_821"
                    | "BG32_MagicItem_822"
                    | "BG32_MagicItem_957"
                    | "BG35_MagicItem_151"
                    | "BG35_MagicItem_151t"
                    | "BG35_MagicItem_156"
                    | "BG35_MagicItem_801"
                    | "BG35_MagicItem_818"
            )
        {
            return Ok(());
        }
        let data = self.state["season"]["trinketData"][key].clone();
        let subject = ctx
            .event_minion
            .as_ref()
            .map(|uid| self.owned(uid))
            .transpose()?;
        let tier = num(&self.state["tier"]);
        let turn = num(&self.state["turn"]);
        match id {
            "BG32_MagicItem_892" => self.trinket_craft("BG32_MagicItem_892t")?,
            "BG32_MagicItem_925" => {
                for m in arr(&self.state["board"]).to_vec() {
                    if m["id"] == "s14_BG31_148" {
                        self.battlecry(ctx, str_field(&m, "uid")?)?;
                    }
                }
            }
            "BG36_MagicItem_404" | "BG36_MagicItem_404t" => {
                let n = if id.ends_with('t') { 10. } else { 4. };
                self.deity_gain(n, n);
            }
            "BG36_MagicItem_406" => {
                if let Some(m) = &subject {
                    if def(str_field(m, "id")?)?["kind"] == "spell" {
                        if let Some(m) = self.draw(|d| {
                            num(&d["tier"]) <= tier
                                && (arr(&d["races"]).iter().any(|t| t == "畸变怪")
                                    || d["tribe"] == "全部")
                        })? {
                            self.trinket_card(m)?;
                        }
                    }
                }
            }
            "BG36_MagicItem_407" | "BG36_MagicItem_408" | "BG36_MagicItem_409"
            | "BG36_MagicItem_410" => {
                if id.ends_with("409")
                    && (subject.as_ref().is_none_or(|m| m["id"] != "s14_BG20_GEM")
                        || self.bump(&format!("{key}:gems"), 1.) % 10. != 0.)
                {
                    return Ok(());
                }
                let ty = match id {
                    "BG36_MagicItem_407" => "龙",
                    "BG36_MagicItem_408" => "海盗",
                    "BG36_MagicItem_409" => "野猪人",
                    _ => "亡灵",
                };
                let mut choices = vec![];
                for t in arr(&catalog().data["trinkets"]) {
                    let id = str_field(t, "id")?;
                    if t["school"] == "GREATER_TRINKET"
                        && arr(&catalog().data["trinketTypes"][id]["types"])
                            .iter()
                            .any(|t| t == ty)
                        && trinkets::eligible(&self.state, id)?
                    {
                        choices.push(id.to_owned());
                    }
                }
                let i = self.index(choices.len());
                if let Some(id) = choices.get(i) {
                    self.state["season"]["trinkets"][slot] = json!(id);
                    self.trinket_start(ctx, id, true, slot)?;
                }
            }
            "BG36_MagicItem_411" => {
                self.gold(3., true);
                self.offer_powers("additional", &[])?;
            }
            "BG36_MagicItem_412" | "BG36_MagicItem_412t2" => {
                self.state["season"]["kiriSlot"] = json!(slot);
                self.trinket_pending(json!({"slot":slot,"school":if id.ends_with("t2"){"GREATER_TRINKET"}else{"LESSER_TRINKET"}}));
            }
            "BG36_MagicItem_414" => {
                let n = 2f64.powf((turn - num(&data["turn"])).max(0.));
                for uid in self.board_ids() {
                    self.gain(&uid, n, n, ctx.source.as_ref(), ctx.depth)?;
                }
            }
            "BG36_MagicItem_417" => self.trinket_craft("BG36_MagicItem_417t")?,
            "BG36_MagicItem_423" | "BG36_MagicItem_423t" => {
                for _ in 0..if id.ends_with('t') { 2 } else { 1 } {
                    let ids = ["BG34_170t", "BG34_170t2", "BG34_170t3"];
                    let i = self.index(3);
                    self.trinket_grant(ids[i], false)?;
                }
            }
            "BG36_MagicItem_424" => {
                let n = arr(&self.state["board"])
                    .iter()
                    .filter(|m| truth(&m["golden"]))
                    .count();
                self.gold(n as f64, true);
            }
            "BG36_MagicItem_450" => {
                if subject.as_ref().is_some_and(|m| m["id"] == "s14_BG36_205") {
                    let n = 4. * self.bump(&format!("{key}:bait"), 1.);
                    for uid in self.board_ids() {
                        if tribe(&self.owned(&uid)?, "野兽")? {
                            self.gain(&uid, n, n, ctx.source.as_ref(), ctx.depth)?;
                        }
                    }
                }
            }
            "BG36_MagicItem_600" => {
                for uid in self.board_ids() {
                    if self.owned(&uid)?["id"] == "s14_BG36_318" {
                        keyword(self.owned_mut(&uid)?, "复生");
                    }
                }
            }
            "BG36_MagicItem_602" => {
                if truth(&self.state["season"]["deity"])
                    && !truth(&self.state["season"]["deity"]["golden"])
                {
                    self.state["season"]["deity"]["golden"] = json!(true);
                    for k in ["attack", "health"] {
                        self.state["season"]["deity"][k] =
                            json!(num(&self.state["season"]["deity"][k]) + 1.);
                    }
                }
            }
            "BG36_MagicItem_606" => {
                if let Some(m) = &subject {
                    if def(str_field(m, "id")?)?["kind"] != "spell"
                        && self.bump(&format!("{key}:discard:{turn}"), 1.) == 1.
                    {
                        let mut copy = m.clone();
                        copy["uid"] = self.make(str_field(m, "id")?, false, false)?["uid"].clone();
                        copy["copies"] = json!({});
                        copy["reward"] = json!(false);
                        copy["attack"] = json!(num(&m["attack"]) * 2.);
                        copy["health"] = json!(num(&m["health"]) * 2.);
                        self.trinket_card(copy)?;
                    }
                }
            }
            "BG36_MagicItem_609" => {
                if (self.count(&format!("{key}:mode")) % 2. == 0.) == (event == "buy") {
                    self.bump(&format!("{key}:mode"), 1.);
                    self.gold(1., true);
                }
            }
            "BG36_MagicItem_610" => {
                let mut opts = json!({"golden":true,"darkGift":true});
                if let Some(t) = self.majority()? {
                    opts["tribe"] = json!(t);
                }
                self.trinket_discover("darkGift", opts)?;
            }
            "BG36_MagicItem_852" => {
                let mut c = ctx.clone();
                c.trinket = true;
                c.trinket_set = true;
                self.linked_cards(&c, true, false)?;
            }
            "BG30_MagicItem_301" => {
                for uid in self.board_ids() {
                    if self.owned(&uid)?["id"] == "s14_BG25_008" {
                        keyword(self.owned_mut(&uid)?, "嘲讽");
                        keyword(self.owned_mut(&uid)?, "复生");
                    }
                }
            }
            "BG30_MagicItem_303" => {
                let m = self.make("s14_BG_TTN_401", false, false)?;
                let _ = stats::global(&self.state, m)?;
            }
            "BG30_MagicItem_310" => {
                for uid in self.board_ids() {
                    let m = self.owned(&uid)?;
                    if m["id"] == "s14_BG25_354" {
                        self.gain(&uid, 0., num(&m["health"]), ctx.source.as_ref(), ctx.depth)?;
                    }
                }
            }
            "BG30_MagicItem_403" => {
                for uid in self.board_ids() {
                    let m = self.owned(&uid)?;
                    if self.trinket_types(&m)?.is_empty() {
                        self.gain(
                            &uid,
                            num(&m["attack"]) * 2.,
                            num(&m["health"]) * 2.,
                            None,
                            ctx.depth,
                        )?;
                    }
                }
            }
            "BG30_MagicItem_411" | "BG30_MagicItem_917" | "BG35_MagicItem_740" => {
                for uid in self.board_ids() {
                    let ty = match id {
                        "BG30_MagicItem_411" => Some("野猪人"),
                        "BG30_MagicItem_917" => Some("纳迦"),
                        _ => None,
                    };
                    if ty
                        .map(|t| tribe(&self.owned(&uid).unwrap(), t))
                        .transpose()?
                        .unwrap_or(true)
                    {
                        let a = match id {
                            "BG30_MagicItem_411" => {
                                json!({"event":"death","op":"generate","id":"BG20_GEM","amount":2,"trinket":true})
                            }
                            "BG30_MagicItem_917" => {
                                json!({"event":"death","op":"randomSpellcraft","trinket":true})
                            }
                            _ => {
                                json!({"event":"death","op":"buff","target":"all","attack":2,"health":2,"permanent":true,"noScale":true})
                            }
                        };
                        let m = self.owned_mut(&uid)?;
                        if !m["extraAbilities"].is_array() {
                            m["extraAbilities"] = json!([]);
                        }
                        m["extraAbilities"].as_array_mut().unwrap().push(a);
                    }
                }
            }
            "BG30_MagicItem_416" => self.trinket_craft("BG30_MagicItem_416t")?,
            "BG30_MagicItem_418" => {
                for zone in ["board", "hand", "shop"] {
                    for m in self.state[zone].as_array_mut().unwrap() {
                        if m["id"] == "s14_BG_LOE_077" {
                            m["extraTribes"] = json!(["鱼人", "龙"]);
                        }
                    }
                }
            }
            "BG30_MagicItem_423" => {
                if let Some(mut m) = self.draw(|d| num(&d["tier"]) == (tier + 1.).min(6.))? {
                    if arr(&self.state["shop"]).len() < 7 {
                        m = self.apply_shop(m)?;
                        self.state["shop"].as_array_mut().unwrap().push(m);
                    } else {
                        self.release(&mut m)?;
                    }
                }
            }
            "BG30_MagicItem_425" => {
                self.gold(2., true);
                self.trinket_discover("minion", json!({"tiers":[6]}))?;
            }
            "BG30_MagicItem_426" | "BG30_MagicItem_426t" => {
                for _ in 0..if id.ends_with('t') { 2 } else { 1 } {
                    if let Some(m) = self.draw(|d| {
                        num(&d["tier"]) <= tier
                            && (!truth(&data["type"])
                                || arr(&d["races"]).contains(&data["type"])
                                || d["tribe"] == "全部")
                    })? {
                        self.trinket_card(m)?;
                    }
                }
            }
            "BG30_MagicItem_442" => {
                if subject.as_ref().is_some_and(|m| truth(&m["gems"])) {
                    self.make("s14_BG30_MagicItem_442t", false, false)?;
                }
            }
            "BG30_MagicItem_703" => {
                if !self.state["season"]["mysteryCubeSlots"].is_array() {
                    self.state["season"]["mysteryCubeSlots"] = json!([]);
                }
                if !arr(&self.state["season"]["mysteryCubeSlots"]).contains(&json!(slot)) {
                    self.state["season"]["mysteryCubeSlots"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(slot));
                }
                self.trinket_pending(json!({"slot":slot,"school":"LESSER_TRINKET","free":true}));
            }
            "BG30_MagicItem_705" => {
                self.state["upgrade"] = json!((num(&self.state["upgrade"]) - 3.).max(0.))
            }
            "BG30_MagicItem_706" => {
                let board = arr(&self.state["board"]).to_vec();
                let i = self.index(board.len());
                if let Some(m) = board.get(i) {
                    self.trinket_plain(m)?;
                }
            }
            "BG30_MagicItem_707" => {
                if event == "purchase" || (turn - num(&data["turn"])) % 3. == 0. {
                    let opts = self.darkmoon_prizes(3);
                    self.trinket_discover("minion", json!({"options":opts}))?;
                }
            }
            "BG30_MagicItem_801" => {
                if let Some(m) = &subject {
                    if self.bump(&format!("{key}:discover:{turn}"), 1.) <= 2. {
                        self.trinket_plain(m)?;
                    }
                }
            }
            "BG30_MagicItem_891" => {
                if turn == num(&data["turn"]) + 2. {
                    self.trinket_pending(json!({"slot":slot,"school":"GREATER_TRINKET"}));
                }
            }
            "BG30_MagicItem_902" => {
                for uid in self.trinket_ends(None)? {
                    keyword(self.owned_mut(&uid)?, "圣盾");
                }
            }
            "BG30_MagicItem_924" | "BG30_MagicItem_924t" => {
                let mut ids = vec![];
                for uid in self.board_ids() {
                    if tribe(&self.owned(&uid)?, "海盗")? {
                        ids.push(uid);
                    }
                }
                self.shuffle(&mut ids);
                for uid in ids.iter().take(2) {
                    let n = if id.ends_with('t') { 6. } else { 3. };
                    self.gain(uid, n, n, ctx.source.as_ref(), ctx.depth)?;
                }
            }
            "BG30_MagicItem_942" => {
                let mut cards = vec![];
                for id in arr(&catalog().data["seasonRelated"]) {
                    let d = def(id.as_str().unwrap())?;
                    if truth(&d["magnetic"])
                        && arr(&d["races"]).iter().any(|t| t == "机械")
                        && arr(&d["races"]).iter().any(|t| t == "恶魔")
                    {
                        cards.push(d.clone());
                    }
                }
                for _ in 0..2 {
                    let i = self.index(cards.len());
                    if let Some(d) = cards.get(i) {
                        self.trinket_grant(str_field(d, "sourceId")?, false)?;
                    }
                }
            }
            "BG30_MagicItem_952" => {
                let mut ids = vec![];
                for uid in self.board_ids() {
                    if tribe(&self.owned(&uid)?, "元素")? {
                        ids.push(uid);
                    }
                }
                self.shuffle(&mut ids);
                for uid in ids.iter().take(2) {
                    let m = self.owned_mut(uid)?;
                    if !m["extraAbilities"].is_array() {
                        m["extraAbilities"] = json!([]);
                    }
                    m["extraAbilities"].as_array_mut().unwrap().push(
                        json!({"event":"death","op":"summon","id":"BG26_537","noScale":true}),
                    );
                }
            }
            "BG30_MagicItem_962" => {
                let mut board = arr(&self.state["board"]).to_vec();
                board.sort_by(|a, b| num(&a["attack"]).total_cmp(&num(&b["attack"])));
                for m in board.iter().take(2) {
                    self.gain(
                        str_field(m, "uid")?,
                        num(&m["attack"]),
                        num(&m["health"]),
                        None,
                        ctx.depth,
                    )?;
                }
            }
            "BG30_MagicItem_973" => {
                for _ in 0..2 {
                    if arr(&self.state["shop"]).len() >= 7 {
                        break;
                    }
                    if let Some(m) = self.draw(|d| {
                        num(&d["tier"]) <= tier
                            && truth(&data["type"])
                            && (arr(&d["races"]).contains(&data["type"]) || d["tribe"] == "全部")
                    })? {
                        let m = self.apply_shop(m)?;
                        self.state["shop"].as_array_mut().unwrap().push(m);
                    }
                }
            }
            "BG30_MagicItem_981" => {
                if let Some(m) = &subject {
                    if self.trinket_types(m)?.is_empty() {
                        if let Some(card) = self.draw_spell(|d| num(&d["tier"]) <= tier)? {
                            self.trinket_card(card)?;
                        }
                    }
                }
            }
            "BG30_MagicItem_993" => {
                let ids = arr(&catalog().data["tierSevenPool"]).to_vec();
                let i = self.index(ids.len());
                if let Some(id) = ids.get(i) {
                    self.trinket_grant(
                        id.as_str()
                            .unwrap()
                            .strip_prefix("s14_")
                            .unwrap_or(id.as_str().unwrap()),
                        false,
                    )?;
                }
            }
            "BG30_MagicItem_994" => self.hero_wheel(ctx)?,
            "BG30_MagicItem_995" => {
                for uid in self.board_ids() {
                    let n = (num(&self.owned(&uid)?["attack"]) / 2.).ceil();
                    self.gain(&uid, 0., n, ctx.source.as_ref(), ctx.depth)?;
                }
            }
            "BG32_MagicItem_170" => {
                if let Some(m) = &subject {
                    if truth(&def(str_field(m, "id")?)?["magnetic"]) {
                        let mut ids = vec![];
                        for uid in self.board_ids() {
                            if tribe(&self.owned(&uid)?, "机械")? {
                                ids.push(uid);
                            }
                        }
                        let i = self.index(ids.len());
                        if let Some(uid) = ids.get(i) {
                            self.trinket_cast_card(ctx, "BG36_624", Some(uid.clone()))?;
                        }
                    }
                }
            }
            "BG32_MagicItem_200" => {
                if let Some(m) = &subject {
                    if tribe(m, "野兽")? {
                        let n = 2. + self.bump(&format!("{key}:growth"), 1.);
                        self.gain(str_field(m, "uid")?, n, 0., ctx.source.as_ref(), ctx.depth)?;
                    }
                }
            }
            "BG32_MagicItem_232" => {
                let n = self.bump(&format!("{key}:growth"), 1.);
                for uid in self.board_ids() {
                    if tribe(&self.owned(&uid)?, "海盗")? {
                        self.gain(&uid, n, n, ctx.source.as_ref(), ctx.depth)?;
                    }
                }
            }
            "BG32_MagicItem_271" => {
                if event == "purchase" {
                    self.bump("earlyGreater", turn + 1. - self.count("earlyGreater"));
                }
            }
            "BG32_MagicItem_278" => {
                if let Some(m) = &subject {
                    let mut card = self.make("s14_BG31_171t", false, false)?;
                    card["attack"] = m["attack"].clone();
                    card["health"] = m["health"].clone();
                    self.trinket_card(card)?;
                }
            }
            "BG32_MagicItem_300" => {
                if event == "purchase" || (turn - num(&data["turn"])) % 2. == 0. {
                    self.queue_undead_creation(None)?;
                }
            }
            "BG32_MagicItem_306" => {
                for uid in self.board_ids() {
                    if abilities(&self.owned(&uid)?)?
                        .iter()
                        .any(|a| a["event"] == "death")
                    {
                        self.death(ctx, &uid)?;
                    }
                }
            }
            "BG32_MagicItem_350" => {
                if num(&self.state["gold"]) >= 15. && self.count(&format!("{key}:done")) == 0. {
                    self.bump(&format!("{key}:done"), 1.);
                    let ds: Vec<Value> = self
                        .pool_cards()?
                        .into_iter()
                        .filter(|d| num(&d["tier"]) == 5.)
                        .collect();
                    let i = self.index(ds.len());
                    if let Some(d) = ds.get(i) {
                        let uid = self.trinket_grant(str_field(d, "sourceId")?, true)?;
                        self.trinket_mutate_granted(&uid, |m| m["reward"] = json!(true))?;
                    }
                }
            }
            "BG32_MagicItem_360" => {
                for uid in self.trinket_ends(Some("亡灵"))? {
                    keyword(self.owned_mut(&uid)?, "复生");
                }
            }
            "BG32_MagicItem_361" | "BG32_MagicItem_361t" => {
                if event == "purchase" {
                    self.trinket_discover("minion",json!({"tiers":[if id.ends_with('t'){5}else{4}],"typed":true,"trinketKey":key}))?;
                } else if let Some(card) = data["card"].as_str() {
                    self.trinket_grant(card, false)?;
                }
            }
            "BG32_MagicItem_362t" => {
                for _ in 0..2 {
                    self.trinket_discover(
                        "minion",
                        json!({"tiers":[6],"stats":{"attack":30,"health":30}}),
                    )?;
                }
            }
            "BG32_MagicItem_400" => {
                for uid in self.board_ids() {
                    if let Some(card) = self.draw(|d| num(&d["tier"]) == 4.)? {
                        let mut old = self.owned(&uid)?;
                        self.release(&mut old)?;
                        *self.owned_mut(&uid)? = card;
                    }
                }
            }
            "BG32_MagicItem_428" => {
                if turn == num(&data["turn"]) + 2. {
                    self.gold(10., true);
                }
            }
            "BG32_MagicItem_807" => {
                self.trinket_grant("TB_BaconShop_HERO_33_Buddy", true)?;
                let uid = self.trinket_grant("TB_BaconShop_HP_033t", false)?;
                self.trinket_mutate_granted(&uid, |m| {
                    m["attack"] = json!(10);
                    m["health"] = json!(10);
                    keyword(m, "烈毒");
                })?;
            }
            "BG32_MagicItem_817" => {
                let mut cards: Vec<Value> = arr(&self.state["shop"])
                    .iter()
                    .chain(arr(&self.state["season"]["spellShop"]))
                    .cloned()
                    .collect();
                cards.sort_by(|a, b| {
                    num(&def(b["id"].as_str().unwrap()).unwrap()["tier"])
                        .total_cmp(&num(&def(a["id"].as_str().unwrap()).unwrap()["tier"]))
                });
                if let Some(m) = cards.first() {
                    let card = self.detach(str_field(m, "uid")?)?;
                    self.trinket_card(card)?;
                }
            }
            "BG32_MagicItem_860" | "BG32_MagicItem_860t" => {
                for _ in 0..if id.ends_with('t') { 2 } else { 1 } {
                    let m = self.make("s14_BG28_603t", false, false)?;
                    let _ = stats::global(&self.state, m)?;
                }
            }
            "BG32_MagicItem_901" => {
                if let Some(m) = &subject {
                    if let Some(ty) = data["type"].as_str() {
                        if tribe(m, ty)? && self.count(&format!("{key}:done")) == 0. {
                            self.bump(&format!("{key}:done"), 1.);
                            let mut card = primitives::golden(self.owned(str_field(m, "uid")?)?)?;
                            card["reward"] = json!(true);
                            *self.owned_mut(str_field(m, "uid")?)? = card;
                        }
                    }
                }
            }
            "BG32_MagicItem_922" => {
                if event == "spell" {
                    self.bump(&format!("{key}:growth"), 1.);
                } else if let Some(uid) = self.board_ids().first() {
                    let n = 3. + self.count(&format!("{key}:growth"));
                    self.gain(uid, n, n, ctx.source.as_ref(), ctx.depth)?;
                }
            }
            "BG32_MagicItem_951" => {
                let mut ids = vec![];
                for uid in self.board_ids() {
                    let m = self.owned(&uid)?;
                    if num(&def(str_field(&m, "id")?)?["tier"]) <= 4. && !truth(&m["golden"]) {
                        ids.push(uid);
                    }
                }
                let i = self.index(ids.len());
                if let Some(uid) = ids.get(i) {
                    *self.owned_mut(uid)? = primitives::golden(self.owned(uid)?)?;
                }
            }
            "BG35_MagicItem_150" => {
                for m in arr(&self.state["shop"]).to_vec() {
                    let uid = str_field(&m, "uid")?;
                    self.gain(uid, 3., 3., ctx.source.as_ref(), ctx.depth)?;
                    let m = self.owned_mut(uid)?;
                    if !m["temporary"].is_object() {
                        m["temporary"] = json!({"attack":0,"health":0,"keywords":[]});
                    }
                    for k in ["attack", "health"] {
                        m["temporary"][k] = json!(num(&m["temporary"][k]) + 3.);
                    }
                }
            }
            "BG35_MagicItem_152" => {
                let mut cards = arr(&self.state["shop"]).to_vec();
                cards.sort_by(|a, b| {
                    num(&def(b["id"].as_str().unwrap()).unwrap()["tier"])
                        .total_cmp(&num(&def(a["id"].as_str().unwrap()).unwrap()["tier"]))
                });
                if let Some(m) = cards.first() {
                    self.mbump(
                        str_field(m, "uid")?,
                        "healthPurchase",
                        1. - num(&m["counters"]["healthPurchase"]),
                    )?;
                }
            }
            "BG35_MagicItem_154" => {
                if let Some(m) = &subject {
                    if tribe(m, "恶魔")? {
                        let mut ids = vec![];
                        for uid in self.board_ids() {
                            if uid != str_field(m, "uid")? && tribe(&self.owned(&uid)?, "恶魔")? {
                                ids.push(uid);
                            }
                        }
                        let i = self.index(ids.len());
                        let shop = arr(&self.state["shop"]).to_vec();
                        let j = self.index(shop.len());
                        if let (Some(uid), Some(food)) = (ids.get(i), shop.get(j)) {
                            self.consume(ctx, uid, str_field(food, "uid")?, 1., false)?;
                        }
                    }
                }
            }
            "BG35_MagicItem_309" => {
                let id = if self.index(2) == 0 {
                    "BG35_140"
                } else {
                    "BG35_141"
                };
                self.trinket_grant(id, false)?;
            }
            "BG35_MagicItem_306" | "BG35_MagicItem_733" => self.trinket_craft(&format!("{id}t"))?,
            "BG35_MagicItem_434" => {
                let mut m = self.make("s14_BG20_GEM", false, false)?;
                let k = ["嘲讽", "圣盾", "复生"][self.index(3)];
                m["extraAbilities"] = json!([{"event":"cast","op":"buff","target":"selected","tribe":"野猪人","keyword":k}]);
                self.trinket_card(m)?;
            }
            "BG35_MagicItem_701" => {
                if let Some(m) = &subject {
                    if tribe(m, "野兽")? {
                        self.bump(&format!("{key}:growth"), 1.);
                    }
                }
            }
            "BG35_MagicItem_732" => {
                if self.board_ids().is_empty() && !arr(&data["stored"]).is_empty() {
                    self.state["season"]["trinketData"][key]["stored"] = json!([]);
                }
            }
            "BG35_MagicItem_742" => {
                for uid in self.trinket_ends(Some("机械"))? {
                    let card = self.make("s14_BG26_147", false, false)?;
                    self.magnetize(ctx, &uid, card)?;
                }
            }
            "BG35_MagicItem_743" => {
                if event == "refresh" && arr(&self.state["shop"]).len() < 7 {
                    if let Some(card) =
                        self.draw(|d| num(&d["tier"]) <= tier && d["magnetic"] == true)?
                    {
                        let card = self.apply_shop(card)?;
                        self.state["shop"].as_array_mut().unwrap().push(card);
                    }
                }
            }
            "BG35_MagicItem_752" => {
                let mut c = ctx.clone();
                c.target = None;
                for uid in self.trinket_ends(None)? {
                    self.battlecry(&c, &uid)?;
                }
            }
            "BG35_MagicItem_754" => {
                let mut n: f64 = 0.;
                for m in arr(&self.state["hand"]) {
                    if def(str_field(m, "id")?)?["kind"] != "spell" {
                        n = n.max(num(&m["attack"]));
                    }
                }
                for uid in self.board_ids() {
                    if tribe(&self.owned(&uid)?, "鱼人")? {
                        self.gain(&uid, n, 0., ctx.source.as_ref(), ctx.depth)?;
                    }
                }
            }
            "BG35_MagicItem_755" => self.trinket_craft("BG35_MagicItem_755t")?,
            "BG35_MagicItem_812" => {
                if event == "purchase" {
                    self.trinket_grant("BG35_MagicItem_812t", false)?;
                }
            }
            "BG35_MagicItem_814" => {
                if tier == 6. {
                    self.gold(12., true);
                }
            }
            "BG35_MagicItem_816" | "BG35_MagicItem_816t" => {
                let choices: Vec<Value> = arr(&catalog().data["trinkets"])
                    .iter()
                    .filter(|t| {
                        t["school"]
                            == if id.ends_with('t') {
                                "GREATER_TRINKET"
                            } else {
                                "LESSER_TRINKET"
                            }
                            && !arr(&self.state["season"]["trinkets"]).contains(&t["id"])
                            && !t["id"].as_str().unwrap().starts_with("BG35_MagicItem_816")
                    })
                    .cloned()
                    .collect();
                let i = self.index(choices.len());
                if let Some(t) = choices.get(i) {
                    let id = str_field(t, "id")?;
                    self.state["season"]["trinkets"][slot] = json!(id);
                    let last = arr(&self.state["season"]["trinkets"])
                        .iter()
                        .rposition(|x| x == id)
                        .unwrap();
                    self.trinket_start(ctx, id, true, last)?;
                }
                if id.ends_with('t') {
                    self.gold(4., true);
                }
            }
            "BG35_MagicItem_820" => {
                self.bump("iceBlock", 1. - self.count("iceBlock"));
            }
            "BG35_MagicItem_821" | "BG35_MagicItem_821t" => {
                let mut ids = arr(&catalog().data["tierSevenPool"]).to_vec();
                self.shuffle(&mut ids);
                ids.truncate(3);
                let opts: Vec<String> = ids
                    .iter()
                    .map(|id| {
                        let id = id.as_str().unwrap();
                        if id.starts_with("s14_") {
                            id.into()
                        } else {
                            format!("s14_{id}")
                        }
                    })
                    .collect();
                self.trinket_discover(
                    "minion",
                    json!({"options":opts,"golden":id.ends_with('t'),"lockedUntil":turn+2.}),
                )?;
            }
            "BG35_MagicItem_823" | "BG35_MagicItem_823t" => {
                self.queue_timewarp(id.ends_with('t'))?
            }
            "BG35_MagicItem_862" => {
                let mut shop = arr(&self.state["shop"]).to_vec();
                shop.sort_by(|a, b| num(&b["health"]).total_cmp(&num(&a["health"])));
                if let Some(m) = shop.first() {
                    self.gain(
                        str_field(m, "uid")?,
                        num(&m["attack"]),
                        num(&m["health"]),
                        None,
                        ctx.depth,
                    )?;
                }
            }
            "BG35_MagicItem_872" => self.trinket_craft("BG35_MagicItem_872t")?,
            "BG35_MagicItem_923" => {
                for uid in self.board_ids() {
                    self.gain(&uid, 1., 1., ctx.source.as_ref(), ctx.depth)?;
                }
            }
            "BG35_MagicItem_930" => {
                self.bump("warbandRefresh", 1. - self.count("warbandRefresh"));
            }
            "BG35_MagicItem_931" | "BG35_MagicItem_931t" => {
                if let Some(m) = &subject {
                    self.trinket_plain(m)?;
                }
            }
            _ => return Err(format!("Unknown custom trinket: {id}")),
        }
        Ok(())
    }
    fn trinket_mutate_granted(&mut self, uid: &str, f: impl FnOnce(&mut Value)) -> Result<()> {
        if let Some(i) = arr(&self.state["season"]["pendingTrinketCards"])
            .iter()
            .position(|m| m["uid"] == uid)
        {
            f(&mut self.state["season"]["pendingTrinketCards"][i]);
        } else {
            f(self.owned_mut(uid)?);
        }
        Ok(())
    }
    pub fn replace_rune(&mut self, ctx: &Context, index: usize) -> Result<()> {
        let choices: Vec<Value> = arr(&catalog().data["trinkets"])
            .iter()
            .filter(|t| {
                t["school"] == "GREATER_TRINKET"
                    && arr(&catalog().data["trinketTypes"][t["id"].as_str().unwrap()]["types"])
                        .iter()
                        .any(|x| x == "纳迦")
                    && !arr(&self.state["season"]["trinkets"]).contains(&t["id"])
            })
            .cloned()
            .collect();
        let i = self.index(choices.len());
        if let Some(t) = choices.get(i) {
            let id = str_field(t, "id")?;
            self.state["season"]["trinkets"][index] = json!(id);
            let last = arr(&self.state["season"]["trinkets"])
                .iter()
                .rposition(|x| x == id)
                .unwrap();
            self.trinket_start(ctx, id, true, last)?;
        }
        Ok(())
    }
}
