//! Recruitment effect dispatch; unsupported families fail the whole native request.
use crate::recruit::Recruit;
use crate::{
    Result, abilities, arr, catalog, def, has, num, powers, primitives, stats, str_field, tribe,
    truth,
};
use serde_json::{Value, json};

pub const SUPPORTED_EFFECTS: &[&str] = &[
    "buff",
    "gem",
    "deathStats",
    "setStats",
    "doubleAttack",
    "scale",
    "gold",
    "goldNext",
    "goldCap",
    "freeRefresh",
    "discountSpell",
    "fodder",
    "armor",
    "spell",
    "generate",
    "randomSpell",
    "draw",
    "drawType",
    "drawId",
    "discoverMinion",
    "discoverSpell",
    "handStats",
    "golden",
    "steal",
    "stealHighest",
    "rally",
    "damageAll",
    "majorityDraw",
    "majorityDiscover",
    "buffType",
    "roogug",
    "rewind",
    "baller",
    "lobster",
    "craft",
    "craftScale",
    "battlecry",
];

#[derive(Clone, Default)]
pub struct Context {
    pub target: Option<String>,
    pub event_minion: Option<String>,
    pub depth: u32,
    pub from_hand: bool,
    pub permanent_spell: bool,
    pub trinket: bool,
    pub trinket_set: bool,
    pub amount: f64,
    pub trinket_cast: bool,
    pub source: Option<Value>,
    pub source_pos: usize,
    pub summon_cursor: Option<std::rc::Rc<std::cell::Cell<usize>>>,
}
impl Context {
    pub fn from_request(v: &Value) -> Self {
        Self {
            target: v["target"].as_str().map(str::to_owned),
            event_minion: v["eventMinion"].as_str().map(str::to_owned),
            depth: 0,
            from_hand: truth(&v["fromHand"]),
            permanent_spell: truth(&v["permanentSpell"]),
            trinket: truth(&v["trinket"]),
            trinket_set: v.get("trinket").is_some(),
            amount: num(&v["amount"]),
            trinket_cast: truth(&v["trinketCast"]),
            source: v.get("source").cloned(),
            source_pos: num(&v["sourcePos"]) as usize,
            summon_cursor: None,
        }
    }
}
pub(crate) fn keyword(m: &mut Value, k: &str) {
    let ks = m["keywords"].as_array_mut().expect("validated minion");
    if !ks.iter().any(|x| x == k) {
        ks.push(json!(k));
    }
}
impl Recruit {
    pub fn owned(&self, uid: &str) -> Result<Value> {
        let (zone, index) = self.locate(uid)?;
        Ok(self.zone(zone)[index].clone())
    }
    pub(crate) fn owned_mut(&mut self, uid: &str) -> Result<&mut Value> {
        let (zone, index) = self.locate(uid)?;
        Ok(&mut self.zone_mut(zone)[index])
    }
    pub(crate) fn board_types(&self) -> Result<usize> {
        let mut n = 0;
        for t in arr(&catalog().data["tribes"]) {
            for m in arr(&self.state["board"]) {
                if tribe(m, t.as_str().unwrap())? {
                    n += 1;
                    break;
                }
            }
        }
        Ok(n)
    }
    pub(crate) fn give(&mut self, ctx: &Context, m: Value) -> Result<()> {
        if ctx.trinket {
            self.trinket_card(m)
        } else {
            self.put_hand(m, true).map(|_| ())
        }
    }
    pub fn buff_targets(&mut self, ctx: &Context, m: &Value, a: &Value) -> Result<Vec<String>> {
        let board = arr(&self.state["board"]).to_vec();
        let hand = arr(&self.state["hand"]).to_vec();
        let nonspells = |cards: &[Value]| -> Result<Vec<Value>> {
            let mut out = vec![];
            for x in cards {
                if def(str_field(x, "id")?)?["kind"] != "spell" {
                    out.push(x.clone());
                }
            }
            Ok(out)
        };
        let mut targets = match a["target"].as_str().unwrap_or("self") {
            "self" => vec![m.clone()],
            "event" => ctx
                .event_minion
                .as_deref()
                .map(|id| self.owned(id))
                .transpose()?
                .into_iter()
                .collect(),
            "selected" => ctx
                .target
                .as_deref()
                .map(|id| self.owned(id))
                .transpose()?
                .into_iter()
                .collect(),
            "all" | "left" => board.clone(),
            "others" | "random" | "randomFour" => board
                .iter()
                .filter(|x| x["uid"] != m["uid"])
                .cloned()
                .collect(),
            "boardAndHand" => board.iter().cloned().chain(nonspells(&hand)?).collect(),
            "shop" => arr(&self.state["shop"]).to_vec(),
            "handLeft" => nonspells(&hand)?.into_iter().take(1).collect(),
            "randomHand" => {
                let mut hs = nonspells(&hand)?;
                self.shuffle(&mut hs);
                hs.truncate(1);
                hs
            }
            "adjacent" => {
                let mut out = vec![];
                if let Some(i) = board.iter().position(|x| x["uid"] == m["uid"]) {
                    if i > 0 {
                        out.push(board[i - 1].clone());
                    }
                    if let Some(x) = board.get(i + 1) {
                        out.push(x.clone());
                    }
                }
                out
            }
            "golden" => board
                .iter()
                .filter(|x| truth(&x["golden"]))
                .cloned()
                .collect(),
            "shielded" => board
                .iter()
                .filter(|x| arr(&x["keywords"]).iter().any(|k| k == "圣盾"))
                .cloned()
                .collect(),
            "menagerie" => {
                let mut out: Vec<Value> = vec![];
                for t in arr(&catalog().data["tribes"]) {
                    let mut choices = vec![];
                    for x in &board {
                        if tribe(x, t.as_str().unwrap())?
                            && !out.iter().any(|m| m["uid"] == x["uid"])
                        {
                            choices.push(x.clone());
                        }
                    }
                    let i = self.index(choices.len());
                    if let Some(x) = choices.get(i) {
                        out.push(x.clone());
                    }
                }
                out
            }
            _ => vec![],
        };
        if let Some(t) = a["tribe"].as_str() {
            let mut filtered = vec![];
            for x in targets {
                if tribe(&x, t)? {
                    filtered.push(x);
                }
            }
            targets = filtered;
        }
        if a["target"] == "random" || a["target"] == "randomFour" {
            self.shuffle(&mut targets);
            targets.truncate(if a["target"] == "random" { 1 } else { 4 });
        }
        if a["target"] == "left" {
            targets.truncate(1);
        }
        targets
            .iter()
            .map(|m| str_field(m, "uid").map(str::to_owned))
            .collect()
    }
    pub fn run_event(&mut self, ctx: &Context, uid: &str, event: &str) -> Result<()> {
        if ctx.depth > 12 {
            return Ok(());
        }
        let mut repeats = 1;
        if event == "rally" {
            for x in arr(&self.state["board"]) {
                if has(x, "repeatAllTriggers")? {
                    repeats = repeats.max(if truth(&x["golden"]) { 3 } else { 2 });
                }
            }
        }
        for _ in 0..repeats {
            let list = abilities(&self.owned(uid)?)?;
            for a in list.iter().filter(|a| a["event"] == event) {
                let mut next = ctx.clone();
                next.depth += 1;
                let source = self.owned(uid)?;
                self.effect(&next, &source, a)?;
            }
        }
        Ok(())
    }
    pub fn battlecry(&mut self, ctx: &Context, uid: &str) -> Result<()> {
        let m = self.owned(uid)?;
        let mut ctx = ctx.clone();
        let list = abilities(&m)?;
        if let Some(selected) = list
            .iter()
            .find(|a| a["event"] == "battlecry" && a["target"] == "selected")
            && ctx.target.is_none()
        {
            let mut candidates = vec![];
            for x in arr(&self.state["board"]) {
                if x["uid"] != uid
                    && (!truth(&selected["tribe"]) || tribe(x, str_field(selected, "tribe")?)?)
                {
                    candidates.push(str_field(x, "uid")?.to_owned());
                }
            }
            let i = self.index(candidates.len());
            ctx.target = candidates.get(i).cloned();
        }
        let mut repeats = 1.;
        for x in arr(&self.state["board"]) {
            if x["uid"] != uid && (has(x, "brann")? || has(x, "repeatAllTriggers")?) {
                repeats = f64::max(repeats, if truth(&x["golden"]) { 3. } else { 2. });
            }
        }
        if tribe(&m, "龙")? {
            repeats += self.item("BG36_MagicItem_215") as f64;
        }
        if list.iter().any(|a| a["event"] == "battlecry") {
            let key = format!("warDrum:{}", num(&self.state["turn"]));
            let count = self.count(&key) + 1.;
            if !self.state["season"]["counters"].is_object() {
                self.state["season"]["counters"] = json!({});
            }
            self.state["season"]["counters"][key] = json!(count);
            if count == 1. {
                repeats += 2. * self.item("BG32_MagicItem_416") as f64;
            }
        }
        repeats += self.count(&format!("prizeBattlecry:{}", num(&self.state["turn"])));
        for _ in 0..(repeats.ceil().max(0.) as usize) {
            self.run_event(&ctx, uid, "battlecry")?;
            if abilities(&self.owned(uid)?)?
                .iter()
                .any(|a| a["event"] == "battlecry")
            {
                self.state["season"]["battlecries"] =
                    json!(num(&self.state["season"]["battlecries"]) + 1.);
                let board = arr(&self.state["board"]).to_vec();
                for other in &board {
                    let mut next = ctx.clone();
                    next.event_minion = Some(uid.into());
                    self.run_event(&next, str_field(other, "uid")?, "battlecryTriggered")?;
                }
                let bonus = 5. * self.item("BG36_MagicItem_203") as f64;
                if bonus > 0. {
                    let b = self.state["board"].as_array_mut().unwrap();
                    let len = b.len();
                    if len > 0 {
                        stats::add(&mut b[0], bonus, bonus);
                    }
                    if len > 1 {
                        stats::add(&mut b[len - 1], bonus, bonus);
                    }
                }
            }
        }
        Ok(())
    }
    pub fn effect(&mut self, ctx: &Context, m: &Value, a: &Value) -> Result<()> {
        let mut ctx = ctx.clone();
        ctx.source = Some(m.clone());
        if truth(&a["trinket"]) {
            ctx.trinket = true;
            ctx.trinket_set = true;
        }
        let f = if truth(&m["golden"]) && !truth(&a["noScale"]) {
            2.
        } else {
            1.
        };
        let n = a["amount"].as_f64().unwrap_or(1.) * f;
        let op = str_field(a, "op")?;
        match op {
            "buff" => {
                let mut attack = num(&a["attack"]) * f;
                let mut health = num(&a["health"]) * f;
                if a["event"] == "cast"
                    && arr(&catalog().data["tavernSpellIds"]).contains(&m["id"])
                    && !truth(&m["tempSpell"])
                {
                    for source in arr(&self.state["board"]) {
                        for aura in abilities(source)?.iter().filter(|a| a["op"] == "spellAura") {
                            let f = if truth(&source["golden"]) && !truth(&aura["noScale"]) {
                                2.
                            } else {
                                1.
                            };
                            attack += num(&aura["attack"]) * f;
                            health += num(&aura["health"]) * f;
                        }
                    }
                    attack += num(&self.state["season"]["buffs"]["spell"]["attack"]);
                    health += num(&self.state["season"]["buffs"]["spell"]["health"]);
                    if powers::has(&self.state, "rakanishu") {
                        let bonus = 1. + ((num(&self.state["turn"]) - 1.) / 3.).floor();
                        attack += bonus;
                        health += bonus;
                    }
                    let copies = self.item("BG36_MagicItem_373");
                    if copies > 0 {
                        let bonus = (1 + self.board_types()?) as f64 * copies as f64;
                        attack += bonus;
                        health += bonus * 2.;
                    }
                    let honey = self.item("BG36_MagicItem_371") as f64
                        * (1. + self.count(&format!("honeycomb:{}", num(&self.state["turn"]))));
                    let forest = self.item("BG32_MagicItem_801t") as f64
                        * (1. + (self.count("forestSpells") / 6.).floor());
                    attack += honey + forest;
                    health += honey + forest;
                }
                if m["id"] == "s14_BG28_741" && self.item("BG32_MagicItem_283") > 0 {
                    health += attack;
                }
                for uid in self.buff_targets(&ctx, m, a)? {
                    let prior = self.owned(&uid)?;
                    let had_keyword = arr(&prior["keywords"]).contains(&a["keyword"]);
                    let had_wind = arr(&prior["keywords"]).iter().any(|k| k == "风怒");
                    self.gain(&uid, attack, health, Some(m), ctx.depth)?;
                    let target = self.owned_mut(&uid)?;
                    if let Some(k) = a["keyword"].as_str() {
                        if truth(&a["toggle"]) && arr(&target["keywords"]).iter().any(|v| v == k) {
                            target["keywords"]
                                .as_array_mut()
                                .unwrap()
                                .retain(|v| v != k);
                        } else {
                            keyword(target, k);
                        }
                    }
                    let naga = a["key"] == "nagaWindfury" && tribe(target, "纳迦")?;
                    if naga {
                        keyword(target, "风怒");
                    }
                    if !ctx.permanent_spell
                        && (truth(&m["tempSpell"]) || a["key"] == "nagaWindfury")
                    {
                        if !target["temporary"].is_object() {
                            target["temporary"] = json!({"attack":0,"health":0,"keywords":[]});
                        }
                        if truth(&m["tempSpell"]) {
                            target["temporary"]["attack"] =
                                json!(num(&target["temporary"]["attack"]) + attack);
                            target["temporary"]["health"] =
                                json!(num(&target["temporary"]["health"]) + health);
                        }
                        if let Some(k) = a["keyword"].as_str()
                            && !had_keyword
                        {
                            keyword(&mut target["temporary"], k);
                        }
                        if naga && !had_wind {
                            keyword(&mut target["temporary"], "风怒");
                        }
                    }
                }
            }
            "gem" => {
                let mut surveyor = 0.;
                if ctx.from_hand {
                    surveyor = 6. * self.item("BG30_MagicItem_943") as f64;
                    for x in arr(&self.state["board"]) {
                        if x["id"] == "s14_BG30_121" {
                            surveyor += if truth(&x["golden"]) { 2. } else { 1. };
                        }
                    }
                }
                let attack =
                    (1. + num(&self.state["season"]["buffs"]["gem"]["attack"]) + surveyor) * n;
                let health =
                    (1. + num(&self.state["season"]["buffs"]["gem"]["health"]) + surveyor) * n;
                for uid in self.buff_targets(&ctx, m, a)? {
                    self.gain(&uid, attack, health, Some(m), ctx.depth)?;
                    let target = self.owned_mut(&uid)?;
                    target["gems"] = json!({"attack":num(&target["gems"]["attack"])+attack,"health":num(&target["gems"]["health"])+health});
                    for _ in 0..(n.ceil().max(0.) as usize) {
                        let mut next = ctx.clone();
                        next.event_minion = Some(str_field(m, "uid")?.into());
                        self.run_event(&next, &uid, "gemPlayed")?;
                    }
                }
            }
            "deathStats" => {
                for uid in self.buff_targets(&ctx, m, a)? {
                    self.gain(
                        &uid,
                        num(&self
                            .owned(str_field(m, "uid")?)
                            .unwrap_or_else(|_| m.clone())["attack"]),
                        num(&self
                            .owned(str_field(m, "uid")?)
                            .unwrap_or_else(|_| m.clone())["counters"]["deathStatsHealth"]),
                        Some(m),
                        ctx.depth,
                    )?;
                }
            }
            "setStats" => {
                for uid in self.buff_targets(&ctx, m, a)? {
                    let t = self.owned_mut(&uid)?;
                    t["attack"] = json!(num(&a["attack"]));
                    t["health"] = json!(a["health"].as_f64().filter(|x| *x != 0.).unwrap_or(1.));
                }
            }
            "doubleAttack" => {
                for uid in self.buff_targets(&ctx, m, a)? {
                    let t = self.owned_mut(&uid)?;
                    let attack = num(&t["attack"]) * f;
                    stats::add(t, attack, 0.);
                }
            }
            "scale" => {
                if m["id"] == "s14_BG28_707" && self.item("BG30_MagicItem_431") > 0 {
                    for x in arr(&self.state["board"]).to_vec() {
                        if tribe(&x, "元素")? {
                            self.gain(str_field(&x, "uid")?, 3. * f, 2. * f, Some(m), ctx.depth)?;
                        }
                    }
                }
                self.scale(
                    str_field(a, "key")?,
                    num(&a["attack"]) * f,
                    num(&a["health"]) * f,
                )?;
            }
            "gold" => self.gold(n, ctx.trinket),
            "goldNext" | "goldCap" | "freeRefresh" | "discountSpell" | "fodder" => {
                let key = match op {
                    "goldNext" => "nextGold",
                    "goldCap" => "maxGold",
                    "discountSpell" => "spellDiscount",
                    _ => op,
                };
                self.state["season"][key] = json!(num(&self.state["season"][key]) + n);
            }
            "armor" => {
                self.state["season"]["spellArmor"] = json!(
                    (n - (num(&self.state["season"]["armor"])
                        - num(&self.state["season"]["spellArmor"])))
                    .max(0.)
                );
                self.state["season"]["armor"] = json!(n);
            }
            "spell" | "generate" | "randomSpell" | "draw" | "drawType" => {
                for _ in 0..(n.ceil().max(0.) as usize) {
                    let tier = num(&self.state["tier"]);
                    let card = match op {
                        "spell" | "generate" => {
                            let id = format!("s14_{}", a["id"].as_str().unwrap_or("undefined"));
                            if def(&id).is_ok() {
                                Some(self.make(&id, false, false)?)
                            } else {
                                None
                            }
                        }
                        "randomSpell" => self.draw_spell(|d| {
                            if a["cost"].is_number() {
                                num(&d["cost"]) == num(&a["cost"])
                            } else {
                                num(&d["tier"]) <= tier
                            }
                        })?,
                        _ => {
                            let t = if op == "drawType" {
                                let target = ctx
                                    .target
                                    .as_deref()
                                    .map(|id| self.owned(id))
                                    .transpose()?
                                    .unwrap_or(m.clone());
                                def(str_field(&target, "id")?)?["tribe"].clone()
                            } else {
                                a["tribe"].clone()
                            };
                            self.draw(|d| {
                                (if truth(&a["tier"]) {
                                    num(&d["tier"]) == num(&a["tier"])
                                } else {
                                    num(&d["tier"]) <= tier
                                }) && (!truth(&t)
                                    || arr(&d["races"]).contains(&t)
                                    || d["tribe"] == "全部")
                                    && (!truth(&a["magnetic"]) || truth(&d["magnetic"]))
                            })?
                        }
                    };
                    if let Some(card) = card {
                        self.give(&ctx, card)?;
                    }
                }
            }
            "drawId" => {
                let id = format!("s14_{}", str_field(a, "id")?);
                if let Some(card) = self.draw(|d| d["id"] == id)? {
                    self.give(&ctx, card)?;
                }
            }
            "discoverMinion" | "discoverSpell" => {
                for _ in 0..(n.ceil().max(0.) as usize) {
                    let mut opts = json!({});
                    if ctx.trinket_set {
                        opts["trinket"] = json!(ctx.trinket);
                    }
                    if a["key"] == "currentTier" {
                        opts["tiers"] = json!([if op == "discoverMinion" && truth(&a["tier"]) {
                            a["tier"].clone()
                        } else {
                            self.state["tier"].clone()
                        }]);
                    }
                    if op == "discoverMinion" {
                        if truth(&a["tier"]) {
                            opts["tiers"] = json!([a["tier"]]);
                        }
                        if a["key"] != "currentTier" && !a["key"].is_null() {
                            opts["mechanic"] = a["key"].clone();
                        }
                        if !a["tribe"].is_null() {
                            opts["tribe"] = a["tribe"].clone();
                        }
                    }
                    self.queue(
                        if op == "discoverSpell" {
                            "spell"
                        } else {
                            "minion"
                        },
                        &opts,
                    )?;
                }
            }
            "handStats" => {
                let ids: Vec<String> = arr(&self.state["hand"])
                    .iter()
                    .map(|x| str_field(x, "uid").map(str::to_owned))
                    .collect::<Result<_>>()?;
                for uid in ids {
                    let x = self.owned(&uid)?;
                    if def(str_field(&x, "id")?)?["kind"] != "spell" {
                        stats::add(
                            self.owned_mut(str_field(m, "uid")?)?,
                            num(&x["attack"]) * f,
                            num(&x["health"]) * f,
                        );
                    }
                }
            }
            "golden" => {
                let target = if a["target"] == "selected" {
                    ctx.target.clone()
                } else {
                    let choices: Vec<Value> = arr(&self.state["shop"])
                        .iter()
                        .filter(|x| !truth(&x["golden"]))
                        .cloned()
                        .collect();
                    let i = self.index(choices.len());
                    choices
                        .get(i)
                        .map(|x| str_field(x, "uid").map(str::to_owned))
                        .transpose()?
                };
                if let Some(uid) = target
                    && !truth(&self.owned(&uid)?["golden"])
                {
                    let (zone, i) = self.locate(&uid)?;
                    self.zone_mut(zone)[i] = primitives::golden(self.zone(zone)[i].clone())?;
                    if zone == "shop" {
                        self.zone_mut(zone)[i]["reward"] = json!(true);
                    }
                    if m["id"] == "s14_BG25_034" && truth(&m["golden"]) {
                        let mut choices = vec![];
                        for x in arr(&self.state["board"]) {
                            if x["uid"] != uid
                                && !truth(&x["golden"])
                                && num(&def(str_field(x, "id")?)?["tier"]) <= 6.
                            {
                                choices.push(x.clone());
                            }
                        }
                        let i = self.index(choices.len());
                        if let Some(other) = choices.get(i) {
                            let id = str_field(other, "uid")?;
                            *self.owned_mut(id)? = primitives::golden(other.clone())?;
                        }
                    }
                }
            }
            "steal" | "stealHighest" => {
                let mut choices = arr(&self.state["shop"]).to_vec();
                let index = if op == "stealHighest" {
                    choices.sort_by(|a, b| num(&b["attack"]).total_cmp(&num(&a["attack"])));
                    0
                } else {
                    self.index(choices.len())
                };
                if let Some(card) = choices.get(index) {
                    self.state["shop"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|x| x["uid"] != card["uid"]);
                    self.give(&ctx, card.clone())?;
                }
            }
            "rally" => {
                if let Some(id) = &ctx.target {
                    for _ in 0..(n.ceil().max(0.) as usize) {
                        self.run_event(&ctx, id, "rally")?;
                    }
                }
            }
            "damageAll" => {
                for x in self.state["board"].as_array_mut().unwrap() {
                    if x["uid"] != m["uid"] {
                        if arr(&x["keywords"]).iter().any(|k| k == "圣盾") {
                            x["keywords"]
                                .as_array_mut()
                                .unwrap()
                                .retain(|k| k != "圣盾");
                        } else {
                            x["health"] = json!(num(&x["health"]) - n);
                        }
                    }
                }
            }
            "majorityDraw" | "majorityDiscover" => {
                let mut counts = vec![];
                for t in arr(&catalog().data["tribes"]) {
                    let mut n = 0;
                    for x in arr(&self.state["board"]) {
                        if tribe(x, t.as_str().unwrap())? {
                            n += 1;
                        }
                    }
                    counts.push((t.clone(), n));
                }
                let max = counts.iter().map(|(_, n)| *n).max().unwrap_or(0);
                let t = if max > 0 {
                    let ts: Vec<Value> = counts
                        .into_iter()
                        .filter(|(_, n)| *n == max)
                        .map(|(t, _)| t)
                        .collect();
                    Some(ts[self.index(ts.len())].clone())
                } else {
                    None
                };
                if op == "majorityDiscover" {
                    let mut opts = json!({});
                    if let Some(t) = t {
                        opts["tribe"] = t;
                    }
                    if ctx.trinket_set {
                        opts["trinket"] = json!(ctx.trinket);
                    }
                    self.queue("minion", &opts)?;
                } else {
                    let tier = num(&self.state["tier"]);
                    if let Some(card) = self.draw(|d| {
                        num(&d["tier"]) <= tier
                            && t.as_ref().is_none_or(|t| {
                                arr(&d["races"]).contains(t) || d["tribe"] == "全部"
                            })
                    })? {
                        self.give(&ctx, card)?;
                    }
                }
            }
            "buffType" => {
                let target = ctx.target.as_deref().map(|id| self.owned(id)).transpose()?;
                let mut races = vec![];
                if let Some(target) = target {
                    for t in arr(&catalog().data["tribes"]) {
                        if tribe(&target, t.as_str().unwrap())? {
                            races.push(t.clone());
                        }
                    }
                }
                let mut targets = vec![];
                for x in arr(&self.state["board"])
                    .iter()
                    .chain(arr(&self.state["shop"]))
                {
                    let mut found = false;
                    for r in &races {
                        found |= tribe(x, r.as_str().unwrap())?;
                    }
                    if found {
                        targets.push(str_field(x, "uid")?.to_owned());
                    }
                }
                for uid in targets {
                    let mut next = ctx.clone();
                    next.target = Some(uid);
                    let mut a = a.clone();
                    a["op"] = json!("buff");
                    a["target"] = json!("selected");
                    self.effect(&next, m, &a)?;
                }
            }
            "roogug" => {
                let targets: Vec<Value> = arr(&self.state["board"])
                    .iter()
                    .filter(|x| x["id"] != m["id"])
                    .cloned()
                    .collect();
                let i = self.index(targets.len());
                if let Some(t) = targets.get(i)
                    && arr(&self.state["board"])
                        .iter()
                        .any(|x| x["uid"] == m["uid"])
                {
                    let mut next = ctx.clone();
                    next.target = Some(str_field(t, "uid")?.into());
                    self.effect(
                        &next,
                        m,
                        &json!({"event":"gemPlayed","op":"gem","target":"selected"}),
                    )?;
                }
            }
            "rewind" => {
                if a["target"] == "shop" {
                    for x in self.state["shop"].as_array_mut().unwrap() {
                        stats::add(x, num(&a["attack"]) * f, num(&a["health"]) * f);
                    }
                } else {
                    self.gain(
                        str_field(m, "uid")?,
                        if self.item("BG30_MagicItem_868") > 0 {
                            num(&a["health"]) * f
                        } else {
                            0.
                        },
                        num(&a["health"]) * f,
                        Some(m),
                        ctx.depth,
                    )?;
                }
            }
            "baller" => {
                let attack = (num(&a["attack"])
                    + num(&self.state["season"]["buffs"]["baller"]["attack"]))
                    * f;
                let health = (num(&a["health"])
                    + num(&self.state["season"]["buffs"]["baller"]["health"]))
                    * f;
                for x in self.state["board"].as_array_mut().unwrap() {
                    stats::add(x, attack, health);
                }
                self.scale("baller", 1., 1.)?;
            }
            "lobster" => {
                let attack = (2. + num(&self.state["season"]["buffs"]["lobster"]["attack"])) * f;
                let health = (1. + num(&self.state["season"]["buffs"]["lobster"]["health"])) * f;
                let mut targets = vec![];
                for x in arr(&self.state["board"]) {
                    if x["uid"] != m["uid"] && tribe(x, "野兽")? {
                        targets.push(str_field(x, "uid")?.to_owned());
                    }
                }
                let i = self.index(targets.len());
                if let Some(uid) = targets.get(i) {
                    stats::add(self.owned_mut(uid)?, attack, health);
                }
                self.scale("lobster", 2., 1.)?;
            }
            "craft" | "craftScale" => {
                let d = def(str_field(m, "id")?)?;
                let id = format!("s14_{}t", d["sourceId"].as_str().unwrap_or("undefined"));
                if def(&id).is_ok() {
                    let mut card = self.make(&id, false, false)?;
                    card["golden"] = m["golden"].clone();
                    card["expires"] = json!(true);
                    card["tempSpell"] = json!(op == "craft" && a["key"] != "nagaWindfury");
                    let mut extra = a.clone();
                    extra["event"] = json!("cast");
                    extra["op"] = json!(if op == "craft" { "buff" } else { "scale" });
                    if op == "craft" {
                        extra["target"] = json!("selected");
                    } else {
                        extra.as_object_mut().unwrap().remove("target");
                    }
                    card["extraAbilities"] = json!([extra]);
                    self.give(&ctx, card)?;
                }
            }
            "battlecry" => {
                for uid in self.buff_targets(&ctx, m, a)? {
                    let mut next = ctx.clone();
                    next.target = None;
                    self.battlecry(&next, &uid)?;
                }
            }
            _ => self.expanded(&ctx, m, a)?,
        }
        Ok(())
    }
}
