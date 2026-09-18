//! Mutable recruitment settlement. No JS callbacks or host-side rule execution.
use crate::{
    Result, abilities, arr, catalog, def, gifts, has, num, powers, primitives, stats, str_field,
    tribe, truth, validate_minion,
};
use serde_json::{Value, json};
use tavern_combat_prototype::Random;

pub struct Recruit {
    pub state: Value,
    pub rng: Random,
    pub serial: u64,
    pub logs: bool,
}
impl Recruit {
    pub fn new(request: &Value) -> Result<Self> {
        let mut s = request["state"].clone();
        for k in ["board", "hand", "shop", "discovery", "rewards", "logs"] {
            if !s[k].is_array() {
                return Err(format!("Recruit state requires {k} array"));
            }
        }
        if !s["pool"].is_object()
            || !s["season"].is_object()
            || !s["season"]["pendingDiscoveries"].is_array()
        {
            return Err("Recruit state requires pool and discovery queue".into());
        }
        for k in ["board", "hand", "shop", "discovery"] {
            for m in arr(&s[k]) {
                validate_minion(m)?;
            }
        }
        let seed = request["seed"]
            .as_u64()
            .filter(|v| *v <= u32::MAX as u64)
            .ok_or("Seed must be uint32")?;
        let serial = request
            .get("uidCounter")
            .map(|v| v.as_u64().ok_or("uidCounter must be uint64"))
            .transpose()?
            .unwrap_or(0);
        s["__detached"] = json!([]);
        Ok(Self {
            state: s,
            rng: Random::new(seed as u32),
            serial,
            logs: request["recordLogs"].as_bool().unwrap_or(true),
        })
    }
    pub fn make(&mut self, id: &str, golden: bool, pool: bool) -> Result<Value> {
        self.serial = self.serial.checked_add(1).ok_or("UID counter overflow")?;
        primitives::make(id, &format!("native-{}", self.serial), golden, pool)
    }
    pub fn result(mut self, results: Vec<Value>) -> Value {
        self.state.as_object_mut().unwrap().remove("__detached");
        json!({"state":self.state,"rng":self.rng.state,"draws":self.rng.draws,"uidCounter":self.serial,"results":results})
    }
    pub fn log(&mut self, text: String) {
        if self.logs {
            let logs = self.state["logs"].as_array_mut().expect("validated logs");
            logs.insert(0, json!(text));
            logs.truncate(80);
        }
    }
    pub fn room(&self) -> bool {
        arr(&self.state["hand"]).len() + arr(&self.state["rewards"]).len() < 10
    }
    pub fn item(&self, id: &str) -> usize {
        arr(&self.state["season"]["trinkets"])
            .iter()
            .filter(|v| *v == id)
            .count()
    }
    pub fn count(&self, key: &str) -> f64 {
        num(&self.state["season"]["counters"][key])
    }
    pub fn index(&mut self, len: usize) -> usize {
        (self.rng.next_u32() as f64 / 4294967296. * len as f64).floor() as usize
    }
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.index(i + 1);
            items.swap(i, j);
        }
    }
    pub fn release(&mut self, m: &mut Value) -> Result<()> {
        for (id, n) in m["copies"].as_object().ok_or("Invalid pool copies")? {
            self.state["pool"][id] = json!(num(&self.state["pool"][id]) + num(n));
        }
        m["copies"] = json!({});
        Ok(())
    }
    pub fn deity_gain(&mut self, a: f64, h: f64) {
        if !truth(&self.state["season"]["deity"]) {
            return;
        }
        for (k, n) in [("attack", a), ("health", h)] {
            self.state["season"]["deity"][k] = json!(num(&self.state["season"]["deity"][k]) + n);
        }
        for m in self.state["board"].as_array_mut().expect("validated board") {
            if truth(&m["counters"]["awakenedDeity"]) {
                stats::add(m, a, h);
            }
        }
    }
    pub fn put_hand(&mut self, mut m: Value, mark: bool) -> Result<Value> {
        validate_minion(&m)?;
        if mark && !truth(&m["counters"]["enteredTurn"]) {
            if !m["counters"].is_object() {
                m["counters"] = json!({});
            }
            m["counters"]["enteredTurn"] = self.state["turn"].clone();
        }
        if !self.room() {
            self.release(&mut m)?;
            self.log(format!(
                "手牌已满，{}未加入手牌。",
                str_field(def(str_field(&m, "id")?)?, "name")?
            ));
            return Ok(m);
        }
        self.state["hand"]
            .as_array_mut()
            .expect("validated hand")
            .push(m.clone());
        for source in arr(&self.state["board"])
            .to_vec()
            .iter()
            .filter(|x| x["id"] == "s14_BG36_109")
        {
            let f = if truth(&source["golden"]) { 2. } else { 1. };
            self.deity_gain(3. * f, 4. * f);
        }
        let sources = arr(&self.state["board"]).to_vec();
        for source in sources.iter().filter(|x| x["id"] == "s14_BG34_Giant_327") {
            let f = if truth(&source["golden"]) { 2. } else { 1. };
            for pirate in self.state["board"].as_array_mut().expect("validated board") {
                if tribe(pirate, "海盗")? {
                    stats::add(pirate, f, f);
                }
            }
        }
        if def(str_field(&m, "id")?)?["kind"] != "spell" && tribe(&m, "海盗")? {
            let bonus = 16. * self.item("BG35_MagicItem_713") as f64;
            if bonus != 0.
                && let Some(first) = self.state["board"]
                    .as_array_mut()
                    .expect("validated board")
                    .first_mut()
            {
                stats::add(first, bonus, bonus);
            }
        }
        Ok(m)
    }
    pub fn flush(&mut self) -> Result<()> {
        while self.room() && !arr(&self.state["season"]["pendingTrinketCards"]).is_empty() {
            let card = self.state["season"]["pendingTrinketCards"]
                .as_array_mut()
                .expect("pending cards")
                .remove(0);
            self.put_hand(card, true)?;
        }
        Ok(())
    }
    pub fn trinket_card(&mut self, m: Value) -> Result<()> {
        if !self.state["season"]["pendingTrinketCards"].is_array() {
            self.state["season"]["pendingTrinketCards"] = json!([]);
        }
        self.state["season"]["pendingTrinketCards"]
            .as_array_mut()
            .unwrap()
            .push(m);
        self.flush()
    }
    pub fn gold(&mut self, n: f64, unlimited: bool) {
        let prior = num(&self.state["gold"]);
        let cap = num(&self.state["season"]["temporaryGoldCap"]);
        if unlimited {
            self.state["gold"] = json!(prior + n);
            self.state["season"]["temporaryGoldCap"] = json!(cap.max(prior + n));
        } else {
            self.state["gold"] = json!(
                num(&self.state["season"]["maxGold"])
                    .max(cap)
                    .max(prior)
                    .min(prior + n)
            );
        }
    }
    pub fn pool_cards(&self) -> Result<Vec<Value>> {
        arr(&catalog().data["minionPool"])
            .iter()
            .filter(|id| self.state["pool"].get(id.as_str().unwrap_or("")).is_some())
            .map(|id| def(id.as_str().ok_or("Invalid catalog id")?).cloned())
            .collect()
    }
    pub fn draw(&mut self, mut filter: impl FnMut(&Value) -> bool) -> Result<Option<Value>> {
        let ds: Vec<Value> = self
            .pool_cards()?
            .into_iter()
            .filter(|d| num(&self.state["pool"][d["id"].as_str().unwrap()]) > 0. && filter(d))
            .collect();
        let total: f64 = ds
            .iter()
            .map(|d| num(&self.state["pool"][d["id"].as_str().unwrap()]))
            .sum();
        let mut n = self.rng.next_u32() as f64 / 4294967296. * total;
        for d in ds {
            let id = str_field(&d, "id")?;
            n -= num(&self.state["pool"][id]);
            if n < 0. {
                self.state["pool"][id] = json!(num(&self.state["pool"][id]) - 1.);
                let m = self.make(id, false, true)?;
                return Ok(Some(stats::global(&self.state, m)?));
            }
        }
        Ok(None)
    }
    pub fn draw_spell(&mut self, mut filter: impl FnMut(&Value) -> bool) -> Result<Option<Value>> {
        let mut ds = vec![];
        let weights = [0., 5., 7., 9., 11., 7., 5.];
        for id in arr(&catalog().data["spellPool"]) {
            let id = id.as_str().ok_or("Invalid spell id")?;
            let d = def(id)?;
            if !filter(d) {
                continue;
            }
            if id == "s14_BG31_819"
                && !arr(&self.state["season"]["tribes"])
                    .iter()
                    .any(|x| x == "元素")
            {
                continue;
            }
            if id == "s14_BG28_606"
                && !arr(&self.state["season"]["tribes"])
                    .iter()
                    .any(|x| x == "纳迦")
            {
                continue;
            }
            ds.push(d);
        }
        let mut n = self.rng.next_u32() as f64 / 4294967296.
            * ds.iter()
                .map(|d| weights[num(&d["tier"]) as usize])
                .sum::<f64>();
        for d in ds {
            n -= weights[num(&d["tier"]) as usize];
            if n < 0. {
                return self.make(str_field(d, "id")?, false, false).map(Some);
            }
        }
        Ok(None)
    }
    pub fn triples(&mut self) -> Result<()> {
        for _ in 0..50 {
            let mut all = vec![];
            for m in arr(&self.state["board"])
                .iter()
                .chain(arr(&self.state["hand"]))
            {
                if def(str_field(m, "id")?)?["kind"] != "spell"
                    && !truth(&m["golden"])
                    && !truth(&m["learnedSpell"])
                {
                    all.push(m.clone());
                }
            }
            let mut wild = vec![];
            for m in &all {
                if has(m, "elementalWildcard")? {
                    wild.push(m.clone());
                }
            }
            let needed = |m: &Value| -> Result<usize> {
                Ok(
                    if powers::has(&self.state, "clockwork")
                        || (self.item("BG30_MagicItem_439") > 0 && tribe(m, "海盗")?)
                    {
                        2
                    } else {
                        3
                    },
                )
            };
            let mut group = None;
            for m in &all {
                if all.iter().filter(|x| x["id"] == m["id"]).count() >= needed(m)? {
                    group = Some(m);
                    break;
                }
            }
            if group.is_none() {
                for m in &all {
                    if !has(m, "elementalWildcard")?
                        && tribe(m, "元素")?
                        && all.iter().filter(|x| x["id"] == m["id"]).count() + wild.len()
                            >= needed(m)?
                    {
                        group = Some(m);
                        break;
                    }
                }
            }
            let Some(group) = group else {
                break;
            };
            let mut parts: Vec<Value> = all
                .iter()
                .filter(|m| m["id"] == group["id"])
                .cloned()
                .collect();
            if tribe(group, "元素")? {
                parts.extend(wild.iter().filter(|m| m["id"] != group["id"]).cloned());
            }
            parts.truncate(needed(group)?);
            for key in ["board", "hand"] {
                self.state[key]
                    .as_array_mut()
                    .unwrap()
                    .retain(|m| !parts.iter().any(|p| p["uid"] == m["uid"]));
            }
            let id = str_field(group, "id")?;
            let base = self.make(id, true, false)?;
            let g = primitives::merge(
                &parts,
                str_field(&base, "uid")?,
                !powers::has(&self.state, "clockwork"),
            )?;
            self.put_hand(g, true)?;
            self.state["triples"] = json!(num(&self.state["triples"]) + 1.);
            self.log(format!(
                "{}三连！金色随从保留已有增益。",
                str_field(def(id)?, "name")?
            ));
        }
        Ok(())
    }
    pub fn reward(&mut self, tier: Option<f64>) -> Result<()> {
        if self.item("BG35_MagicItem_812") > 0 {
            let m = self.make("s14_BG35_MagicItem_812t", false, false)?;
            return self.trinket_card(m);
        }
        if self.room() {
            let t = tier.unwrap_or((num(&self.state["tier"]) + 1.).min(6.));
            self.state["rewards"].as_array_mut().unwrap().push(json!(t));
        } else {
            self.log("手牌已满，无法获得三连奖励。".into());
        }
        Ok(())
    }
    pub fn release_player(&mut self) -> Result<()> {
        let mut held = vec![];
        for k in ["board", "hand", "shop", "discovery"] {
            held.extend(arr(&self.state[k]).iter().cloned());
        }
        held.extend(
            arr(&self.state["season"]["pendingTrinketCards"])
                .iter()
                .cloned(),
        );
        if self.state["season"]["activeDiscovery"]["creationPart"].is_object() {
            held.push(self.state["season"]["activeDiscovery"]["creationPart"].clone());
        }
        for req in arr(&self.state["season"]["pendingDiscoveries"]) {
            if req["creationPart"].is_object() {
                held.push(req["creationPart"].clone());
            }
        }
        for mut m in held {
            self.release(&mut m)?;
        }
        for k in ["board", "hand", "shop", "discovery", "rewards"] {
            self.state[k] = json!([]);
        }
        for k in ["spellShop", "pendingTrinketCards", "pendingDiscoveries"] {
            self.state["season"][k] = json!([]);
        }
        self.state["season"]
            .as_object_mut()
            .unwrap()
            .remove("activeDiscovery");
        Ok(())
    }
    pub fn queue(&mut self, kind: &str, opts: &Value) -> Result<()> {
        let mut request = json!({"kind":kind});
        if let Some(opts) = opts.as_object() {
            for (k, v) in opts {
                request[k] = v.clone();
            }
        }
        self.state["season"]["pendingDiscoveries"]
            .as_array_mut()
            .ok_or("Invalid discovery queue")?
            .push(request);
        Ok(())
    }
    pub fn copy_discovery(&mut self, ids: &[Value]) -> Result<()> {
        let mut options = vec![];
        for id in ids {
            if !options.contains(id) {
                options.push(id.clone());
            }
        }
        self.shuffle(&mut options);
        options.truncate(3);
        if !options.is_empty() {
            self.queue("copy", &json!({"options":options}))?;
        }
        Ok(())
    }
    pub fn next_discovery(&mut self) -> Result<()> {
        while arr(&self.state["discovery"]).is_empty()
            && !arr(&self.state["season"]["pendingDiscoveries"]).is_empty()
        {
            let req = self.state["season"]["pendingDiscoveries"]
                .as_array_mut()
                .unwrap()
                .remove(0);
            self.state["season"]["discoveryKind"] = req["kind"].clone();
            self.state["season"]["activeDiscovery"] = req.clone();
            if truth(&req["darkGift"]) {
                let ids = if req["options"].is_array() {
                    arr(&req["options"]).to_vec()
                } else if arr(&req["tiers"]).iter().any(|t| num(t) == 7.) {
                    arr(&catalog().data["tierSevenPool"])
                        .iter()
                        .map(|id| json!(format!("s14_{}", id.as_str().unwrap())))
                        .collect()
                } else {
                    self.pool_cards()?
                        .into_iter()
                        .filter(|d| {
                            (!req["tiers"].is_array() || arr(&req["tiers"]).contains(&d["tier"]))
                                && (!truth(&req["tribe"])
                                    || arr(&d["races"]).contains(&req["tribe"])
                                    || d["tribe"] == "全部")
                                && num(&self.state["pool"][d["id"].as_str().unwrap()]) > 0.
                        })
                        .map(|d| d["id"].clone())
                        .collect()
                };
                let mut unique = vec![];
                for id in ids {
                    if !unique.contains(&id) {
                        unique.push(id);
                    }
                }
                self.shuffle(&mut unique);
                for id in unique {
                    let id = id.as_str().ok_or("Invalid discovery card")?;
                    let preview = self.make(id, false, false)?;
                    let gifts = gifts::eligible(&self.state, &preview)?;
                    let index = self.index(arr(&gifts).len());
                    let Some(gift) = arr(&gifts).get(index) else {
                        continue;
                    };
                    let card = if req["options"].is_array() || num(&def(id)?["tier"]) == 7. {
                        Some(preview)
                    } else {
                        self.draw(|d| d["id"] == id)?
                    };
                    let Some(card) = card else {
                        continue;
                    };
                    let card = gifts::attach(&self.state, card, str_field(gift, "id")?)?;
                    self.state["discovery"].as_array_mut().unwrap().push(card);
                    if arr(&self.state["discovery"]).len() == 3 {
                        break;
                    }
                }
                if !arr(&self.state["discovery"]).is_empty() {
                    return Ok(());
                }
                self.state["season"]
                    .as_object_mut()
                    .unwrap()
                    .remove("activeDiscovery");
                continue;
            }
            if req["kind"] == "chooseCard" {
                let mut choices: Vec<Value> = self
                    .pool_cards()?
                    .into_iter()
                    .filter(|d| num(&self.state["pool"][d["id"].as_str().unwrap()]) > 0.)
                    .collect();
                for id in arr(&catalog().data["spellPool"]) {
                    choices.push(def(id.as_str().unwrap())?.clone());
                }
                choices.retain(|d| {
                    num(&d["tier"]) <= num(&self.state["tier"])
                        && arr(&d["abilities"]).iter().any(|a| a["op"] == "choose")
                });
                self.shuffle(&mut choices);
                choices.truncate(3);
                for d in choices {
                    let id = str_field(&d, "id")?;
                    let m = if d["kind"] == "spell" {
                        Some(self.make(id, false, false)?)
                    } else {
                        self.draw(|d| d["id"] == id)?
                    };
                    if let Some(m) = m {
                        self.state["discovery"].as_array_mut().unwrap().push(m);
                    }
                }
                if !arr(&self.state["discovery"]).is_empty() {
                    return Ok(());
                }
                self.state["season"]
                    .as_object_mut()
                    .unwrap()
                    .remove("activeDiscovery");
                continue;
            }
            if req["options"].is_array() {
                // Filtering occurs before any pool debits, preserving duplicate option behavior.
                let ids: Vec<Value> = arr(&req["options"])
                    .iter()
                    .filter(|id| {
                        id.as_str().is_some_and(|id| def(id).is_ok())
                            && (req["kind"] != "cookie"
                                || num(&self.state["pool"][id.as_str().unwrap_or("")]) > 0.)
                    })
                    .cloned()
                    .collect();
                for id in ids {
                    let id = id.as_str().ok_or("Invalid discovery card")?;
                    def(id)?;
                    let mut card = self.make(
                        id,
                        truth(&req["golden"]) || truth(&req["source"]["golden"]),
                        req["kind"] == "cookie",
                    )?;
                    if req["kind"] == "cookie" {
                        self.state["pool"][id] = json!(num(&self.state["pool"][id]) - 1.);
                    }
                    if truth(&req["both"]) {
                        let mut extra = vec![];
                        for other in arr(&req["options"]) {
                            if other != id {
                                let m = self.make(
                                    other.as_str().ok_or("Invalid choice option")?,
                                    false,
                                    false,
                                )?;
                                extra.extend(
                                    abilities(&m)?.into_iter().filter(|a| a["event"] == "cast"),
                                );
                            }
                        }
                        card["extraAbilities"] = json!(extra);
                    }
                    self.state["discovery"].as_array_mut().unwrap().push(card);
                }
                return Ok(());
            }
            for _ in 0..3 {
                let tier = num(&self.state["tier"]);
                let prior = arr(&self.state["discovery"]).to_vec();
                let basic = |d: &Value| {
                    (if req["tiers"].is_array() {
                        arr(&req["tiers"]).contains(&d["tier"])
                    } else {
                        num(&d["tier"]) <= tier
                    }) && !prior.iter().any(|m| m["id"] == d["id"])
                };
                let card = if req["kind"] == "spell" {
                    self.draw_spell(basic)?
                } else {
                    self.draw(|d| {
                        basic(d)
                            && (!truth(&req["tribe"])
                                || arr(&d["races"]).contains(&req["tribe"])
                                || d["tribe"] == "全部")
                            && (!truth(&req["typed"]) || !arr(&d["races"]).is_empty())
                            && (!truth(&req["magnetic"]) || truth(&d["magnetic"]))
                            && (!truth(&req["mechanic"])
                                || arr(&d["mechanics"]).contains(&req["mechanic"]))
                    })?
                };
                if let Some(m) = card {
                    self.state["discovery"].as_array_mut().unwrap().push(m);
                }
            }
            if arr(&self.state["discovery"]).is_empty() {
                self.state["season"]
                    .as_object_mut()
                    .unwrap()
                    .remove("activeDiscovery");
                self.log("可用候选不足，跳过本次发现。".into());
            }
        }
        Ok(())
    }
    pub fn apply_shop(&self, mut m: Value) -> Result<Value> {
        validate_minion(&m)?;
        if powers::has(&self.state, "saurfang") {
            let n = 1. + (self.count("power:saurfang:boughtMinions") / 3.).floor();
            stats::add(&mut m, n, n);
        }
        let mut keys = vec!["shop".to_owned()];
        if tribe(&m, "元素")? {
            keys.push("elementalShop".into());
        }
        if num(&def(str_field(&m, "id")?)?["tier"]) <= 3. {
            keys.push("lowShop".into());
        }
        for t in arr(&catalog().data["tribes"]) {
            let t = t.as_str().ok_or("Invalid tribe")?;
            if tribe(&m, t)? {
                keys.push(format!("shopType:{t}"));
            }
        }
        for key in keys {
            let b = &self.state["season"]["buffs"][key];
            stats::add(&mut m, num(&b["attack"]), num(&b["health"]));
        }
        Ok(m)
    }
    pub fn scale(&mut self, key: &str, a: f64, h: f64) -> Result<()> {
        if !self.state["season"]["buffs"].is_object() {
            self.state["season"]["buffs"] = json!({});
        }
        self.state["season"]["buffs"][key] = json!({"attack":num(&self.state["season"]["buffs"][key]["attack"])+a,"health":num(&self.state["season"]["buffs"][key]["health"])+h});
        for zone in ["board", "hand", "shop"] {
            for m in self.state[zone].as_array_mut().unwrap() {
                let matches = match key {
                    "undead" => tribe(m, "亡灵")?,
                    "beast" => tribe(m, "野兽")?,
                    "beastCombat" => zone == "board" && tribe(m, "野兽")?,
                    "shop" => zone == "shop",
                    "elementalShop" => zone == "shop" && tribe(m, "元素")?,
                    "lowShop" => zone == "shop" && num(&def(str_field(m, "id")?)?["tier"]) <= 3.,
                    _ => false,
                };
                if matches {
                    stats::add(m, a, h);
                }
            }
        }
        Ok(())
    }
    pub(crate) fn zone(&self, zone:&str)->&Value {if zone=="spellShop" {&self.state["season"]["spellShop"]}else{&self.state[zone]}}
    pub(crate) fn zone_mut(&mut self, zone:&str)->&mut Value {if zone=="spellShop" {&mut self.state["season"]["spellShop"]}else{&mut self.state[zone]}}
    pub(crate) fn locate(&self, uid: &str) -> Result<(&'static str, usize)> {
        for zone in ["board", "hand", "shop", "discovery", "spellShop", "__detached"] {
            if let Some(index) = arr(self.zone(zone)).iter().position(|m| m["uid"] == uid) {
                return Ok((zone, index));
            }
        }
        Err(format!("Unknown owned minion: {uid}"))
    }
    pub fn gain(
        &mut self,
        uid: &str,
        mut a: f64,
        mut h: f64,
        source: Option<&Value>,
        depth: u32,
    ) -> Result<()> {
        if depth > 20 {
            return Ok(());
        }
        let (zone, index) = self.locate(uid)?;
        if let Some(source) = source
            && def(str_field(source, "id")?)?["kind"] != "spell"
            && tribe(source, "元素")?
            && (a > 0. || h > 0.)
        {
            let mut bonus = self.item("BG36_MagicItem_380") as f64
                * (1. + (self.count("trinketElementals") / 5.).floor());
            for x in arr(&self.state["board"]) {
                if has(x, "elementalGrantAura")? {
                    bonus += 3. * if truth(&x["golden"]) { 2. } else { 1. };
                }
            }
            a += bonus;
            h += bonus;
        }
        let mut m = self.zone(zone)[index].clone();
        if tribe(&m, "元素")? {
            a += num(&self.state["season"]["buffs"]["elementalGrant"]["attack"]);
            h += num(&self.state["season"]["buffs"]["elementalGrant"]["health"]);
        }
        stats::add(&mut m, a, h);
        self.zone_mut(zone)[index] = m.clone();
        if num(&m["counters"]["deityMirrorTurn"]) == num(&self.state["turn"]) {
            let f = num(&m["counters"]["deityMirrorCopies"]);
            self.deity_gain(a * f, h * f);
        }
        if zone == "board" && a > 0. {
            let mut bonus = 0.;
            for x in arr(&self.state["board"]) {
                if has(x, "healthOnAttackGain")? {
                    bonus += 3. * if truth(&x["golden"]) { 2. } else { 1. };
                }
            }
            if bonus != 0. {
                stats::add(&mut self.zone_mut(zone)[index], 0., bonus);
            }
        }
        if zone == "board" && has(&m, "handEchoStats")? {
            let mut targets = vec![];
            for card in arr(&self.state["hand"]) {
                if def(str_field(card, "id")?)?["kind"] != "spell" {
                    targets.push(str_field(card, "uid")?.to_owned());
                    if targets.len() == 2 {
                        break;
                    }
                }
            }
            let f = if truth(&m["golden"]) { 2. } else { 1. };
            for id in targets {
                self.gain(&id, a * f, h * f, None, depth + 1)?;
            }
        }
        self.zone_mut(zone)[index] = stats::sync(
            &self.state,
            self.zone(zone)[index].clone(),
            zone == "board",
        )?;
        let self_source = source.is_some_and(|source| source["uid"] == uid);
        if self_source && self.item("BG35_MagicItem_156") > 0 && m["id"] == "s14_BG34_500" {
            let position = arr(&self.state["board"])
                .iter()
                .position(|x| x["uid"] == uid)
                .map(|i| i as isize)
                .unwrap_or(-1);
            let board = arr(&self.state["board"]);
            let ids: Vec<String> = [position - 1, position + 1]
                .into_iter()
                .filter(|i| *i >= 0)
                .filter_map(|i| board.get(i as usize))
                .map(|m| str_field(m, "uid").map(str::to_owned))
                .collect::<Result<_>>()?;
            for id in ids {
                self.gain(&id, a, h, None, depth + 1)?;
            }
        }
        if self_source
            && self.item("BG35_MagicItem_924") > 0
            && m["id"] == "s14_BG31_035"
            && let Some(pos) = arr(&self.state["board"])
                .iter()
                .position(|x| x["uid"] == uid)
            && pos > 0
        {
            let id = str_field(&self.state["board"][pos - 1], "uid")?.to_owned();
            self.gain(&id, a, h, None, depth + 1)?;
        }
        if m["id"] == "s14_TB_BaconShop_HP_033t" {
            let buddies: Vec<Value> = arr(&self.state["board"])
                .iter()
                .filter(|x| x["id"] == "s14_TB_BaconShop_HERO_33_Buddy")
                .cloned()
                .collect();
            for buddy in buddies {
                let f = if truth(&buddy["golden"]) { 2. } else { 1. };
                self.gain(str_field(&buddy, "uid")?, a * f, h * f, None, depth + 1)?;
            }
        }
        Ok(())
    }
    pub fn dark_discover(&mut self) -> Result<()> {
        let tiers = gifts::tiers(num(&self.state["turn"]));
        let mut offered = vec![];
        for i in 0..3 {
            let mut majority = None;
            let mut max = 0;
            for t in arr(&catalog().data["tribes"]) {
                let t = t.as_str().ok_or("Invalid tribe")?;
                let mut count = 0;
                for m in arr(&self.state["board"])
                    .iter()
                    .chain(arr(&self.state["hand"]))
                {
                    if tribe(m, t)? {
                        count += 1;
                    }
                }
                if count > max {
                    max = count;
                    majority = Some(t.to_owned());
                }
            }
            let mut eligible = vec![];
            for d in self.pool_cards()? {
                let id = str_field(&d, "id")?;
                if num(&self.state["pool"][id]) <= 0.
                    || !tiers.contains(&(num(&d["tier"]) as u8))
                    || truth(&d["magnetic"])
                    || arr(&self.state["discovery"]).iter().any(|m| m["id"] == id)
                    || arr(&d["abilities"]).iter().any(|a| a["event"] == "sell")
                {
                    continue;
                }
                if num(&self.state["turn"]) < 5.
                    && arr(&d["mechanics"])
                        .iter()
                        .any(|k| k == "BATTLECRY" || k == "CHOOSE_ONE")
                {
                    continue;
                }
                if d["sourceId"] == "BGS_131" {
                    continue;
                }
                if i == 0
                    && num(&self.state["turn"]) >= 6.
                    && let Some(t) = &majority
                    && !arr(&d["races"]).iter().any(|x| x == t)
                {
                    continue;
                }
                // Reference filtering constructs a preview for each remaining candidate.
                let preview = self.make(id, false, false)?;
                if arr(&gifts::eligible(&self.state, &preview)?)
                    .iter()
                    .any(|g| !offered.contains(&g["id"]))
                {
                    eligible.push(d["id"].clone());
                }
            }
            let Some(mut card) = self.draw(|d| eligible.contains(&d["id"]))? else {
                continue;
            };
            let gift_list = gifts::eligible(&self.state, &card)?;
            let available: Vec<Value> = arr(&gift_list)
                .iter()
                .filter(|g| !offered.contains(&g["id"]))
                .cloned()
                .collect();
            let index = self.index(available.len());
            let Some(gift) = available.get(index) else {
                self.release(&mut card)?;
                continue;
            };
            offered.push(gift["id"].clone());
            let card = gifts::attach(&self.state, card, str_field(gift, "id")?)?;
            self.state["discovery"].as_array_mut().unwrap().push(card);
        }
        self.state["season"]["discoveryKind"] = json!("darkGift");
        Ok(())
    }
}

pub fn batch(request: &Value) -> Result<Value> {
    let mut game = Recruit::new(request)?;
    let mut results = vec![];
    for op in request["operations"]
        .as_array()
        .ok_or("Missing recruit operations")?
    {
        if truth(&op["combat"]) {
            return Err("RUST_EFFECT_INCOMPLETE: combat context".into());
        }
        let result = match str_field(op, "op")? {
            "heroStart" | "heroEnd" | "heroAction" | "heroWheel" | "trinketStart" | "settleTrinkets" | "offerPowers" | "startPowerEffects" => {
                let ctx=crate::recruit_effects::Context::from_request(op);
                match str_field(op,"op")? {
                    "heroStart"=>game.hero_start(&ctx)?,
                    "heroEnd"=>game.hero_end(&ctx)?,
                    "heroAction"=>{results.push(json!(game.hero_action(&ctx,str_field(op,"key")?,op["target"].as_str())?));continue;},
                    "heroWheel"=>game.hero_wheel(&ctx)?,
                    "trinketStart"=>game.trinket_start(&ctx,str_field(op,"id")?,truth(&op["purchased"]),num(&op["slot"]) as usize)?,
                    "settleTrinkets"=>game.settle_trinkets()?,
                    "offerPowers"=>game.offer_powers(str_field(op,"mode")?,arr(&op["selected"]))?,
                    "startPowerEffects"=>game.start_power_effects()?,
                    _=>unreachable!(),
                }
                Value::Null
            }

            "castSpell" => {
                let ctx = crate::recruit_effects::Context::from_request(op);
                let m = if let Some(uid) = op["uid"].as_str() {
                    game.owned(uid)?
                } else {
                    op["minion"].clone()
                };
                game.cast_spell(&ctx, &m)?;
                Value::Null
            }
            "giftEvent" => {
                let ctx = crate::recruit_effects::Context::from_request(op);
                game.gift_event(&ctx, str_field(op, "uid")?, str_field(op, "event")?)?;
                Value::Null
            }
            "discard" => {
                let ctx = crate::recruit_effects::Context::from_request(op);
                json!(game.discard(&ctx, str_field(op, "uid")?)?)
            }
            "heroDamage" => {
                let ctx = crate::recruit_effects::Context::from_request(op);
                game.hero_damage(&ctx, num(&op["amount"]))?;
                Value::Null
            }
            "trinketEvent" => {
                let ctx = crate::recruit_effects::Context::from_request(op);
                game.trinket_event(
                    &ctx,
                    str_field(op, "event")?,
                    op["slot"].as_u64().map(|n| n as usize),
                )?;
                Value::Null
            }
            "effect" => {
                let ctx = crate::recruit_effects::Context::from_request(op);
                let m = if let Some(uid) = op["uid"].as_str() {
                    game.owned(uid)?
                } else {
                    op["minion"].clone()
                };
                validate_minion(&m)?;
                game.effect(&ctx, &m, &op["ability"])?;
                Value::Null
            }
            "triggerBattlecry" => {
                let ctx = crate::recruit_effects::Context::from_request(op);
                game.battlecry(&ctx, str_field(op, "uid")?)?;
                Value::Null
            }
            "runEvent" => {
                let ctx = crate::recruit_effects::Context::from_request(op);
                game.run_event(&ctx, str_field(op, "uid")?, str_field(op, "event")?)?;
                Value::Null
            }
            "applyShop" => game.apply_shop(op["minion"].clone())?,
            "darkDiscover" => {
                game.dark_discover()?;
                Value::Null
            }
            "scale" => {
                game.scale(
                    str_field(op, "key")?,
                    num(&op["attack"]),
                    num(&op["health"]),
                )?;
                Value::Null
            }
            "gain" => {
                game.gain(
                    str_field(op, "uid")?,
                    num(&op["attack"]),
                    num(&op["health"]),
                    op.get("source"),
                    0,
                )?;
                Value::Null
            }
            "putHand" => game.put_hand(
                op["minion"].clone(),
                op["markEntered"].as_bool().unwrap_or(true),
            )?,
            "trinketCard" => {
                validate_minion(&op["minion"])?;
                game.trinket_card(op["minion"].clone())?;
                Value::Null
            }
            "flushTrinketCards" => {
                game.flush()?;
                Value::Null
            }
            "triples" => {
                game.triples()?;
                Value::Null
            }
            "reward" => {
                game.reward(op["tier"].as_f64())?;
                Value::Null
            }
            "releasePlayerCards" => {
                game.release_player()?;
                Value::Null
            }
            "queueDiscovery" => {
                game.queue(str_field(op, "kind")?, &op["options"])?;
                Value::Null
            }
            "copyDiscovery" => {
                game.copy_discovery(arr(&op["ids"]))?;
                Value::Null
            }
            "nextDiscovery" => {
                game.next_discovery()?;
                Value::Null
            }
            "drawSpell" => {
                let tier = num(&game.state["tier"]);
                game.draw_spell(|d| {
                    if op["cost"].is_number() {
                        d["cost"] == op["cost"]
                    } else {
                        num(&d["tier"]) <= tier
                    }
                })?
                .unwrap_or(Value::Null)
            }
            "gold" | "trinketGold" => {
                game.gold(num(&op["amount"]), op["op"] == "trinketGold");
                Value::Null
            }
            "deityGain" => {
                game.deity_gain(num(&op["attack"]), num(&op["health"]));
                Value::Null
            }
            other => return Err(format!("Unsupported native recruitment operation: {other}")),
        };
        results.push(result);
    }
    Ok(game.result(results))
}
