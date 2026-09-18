//! Experimental keyword-only combat. Not a production rules engine.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Keyword {
    #[serde(rename = "嘲讽")]
    Taunt,
    #[serde(rename = "圣盾")]
    Shield,
    #[serde(rename = "复生")]
    Reborn,
    #[serde(rename = "剧毒")]
    Poison,
    #[serde(rename = "风怒")]
    Windfury,
    #[serde(rename = "烈毒")]
    Venom,
    #[serde(rename = "潜行")]
    Stealth,
}
impl Keyword {
    fn bit(self) -> u8 {
        1 << self as u8
    }
}
const KEYWORDS: [Keyword; 7] = [
    Keyword::Taunt,
    Keyword::Shield,
    Keyword::Reborn,
    Keyword::Poison,
    Keyword::Windfury,
    Keyword::Venom,
    Keyword::Stealth,
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Minion {
    pub uid: u32,
    pub card: String,
    pub attack: i64,
    pub health: i64,
    pub golden: bool,
    pub keywords: Vec<Keyword>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub name: String,
    pub seed: u32,
    pub turn: u32,
    pub living: u8,
    pub tiers: [u8; 2],
    pub boards: [Vec<Minion>; 2],
}
// Only these six cards have been audited for this prototype's keyword-only subset.
const CARDS: [(&str, i64, u8, u8); 6] = [
    ("s14_BG25_001", 2, 1, 1 | 4),
    ("s14_BG_BOT_911", 2, 3, 1 | 2),
    ("s14_BG_DEEP_015", 3, 3, 4),
    ("s14_BGS_034", 2, 2, 2 | 4),
    ("s14_BGS_119", 2, 1, 2 | 16),
    ("s14_BGS_131", 1, 3, 32),
];
#[derive(Clone, Copy, Debug)]
struct Unit {
    uid: u32,
    card: usize,
    attack: i64,
    health: i64,
    golden: bool,
    keywords: u8,
}
impl Unit {
    fn has(&self, k: Keyword) -> bool {
        self.keywords & k.bit() != 0
    }
    fn export(self) -> Minion {
        Minion {
            uid: self.uid,
            card: CARDS[self.card].0.into(),
            attack: self.attack,
            health: self.health,
            golden: self.golden,
            keywords: KEYWORDS.into_iter().filter(|k| self.has(*k)).collect(),
        }
    }
}
#[derive(Clone)]
pub struct Prepared {
    boards: [Vec<Unit>; 2],
    next_uid: u32,
    seed: u32,
    turn: u32,
    living: u8,
    tiers: [u8; 2],
}
pub fn prepare(case: &Case) -> Result<Prepared, String> {
    if case.turn == 0
        || !(1..=8).contains(&case.living)
        || case.tiers.iter().any(|t| !(1..=6).contains(t))
    {
        return Err("invalid turn, living player count or tavern tier".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut boards: [Vec<Unit>; 2] = Default::default();
    let mut next_uid = 1;
    for (side, team) in case.boards.iter().enumerate() {
        if team.len() > 7 {
            return Err("board exceeds seven minions".into());
        }
        for m in team {
            let card = CARDS
                .iter()
                .position(|c| c.0 == m.card)
                .ok_or_else(|| format!("unsupported card: {}", m.card))?;
            if m.uid == 0
                || m.uid > 1_000_000
                || !ids.insert(m.uid)
                || !(0..=1_000_000_000).contains(&m.attack)
                || !(1..=1_000_000_000).contains(&m.health)
            {
                return Err("invalid or duplicate uid, attack or health".into());
            }
            let mut keywords = 0;
            for k in &m.keywords {
                if keywords & k.bit() != 0 {
                    return Err("duplicate keyword".into());
                }
                keywords |= k.bit();
            }
            next_uid = next_uid.max(m.uid + 1);
            boards[side].push(Unit {
                uid: m.uid,
                card,
                attack: m.attack,
                health: m.health,
                golden: m.golden,
                keywords,
            });
        }
    }
    Ok(Prepared {
        boards,
        next_uid,
        seed: case.seed,
        turn: case.turn,
        living: case.living,
        tiers: case.tiers,
    })
}
#[derive(Clone, Copy)]
pub struct Random {
    pub state: u32,
    pub draws: u32,
}
impl Random {
    pub fn new(seed: u32) -> Self {
        Self {
            state: seed,
            draws: 0,
        }
    }
    pub fn next_u32(&mut self) -> u32 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        self.draws += 1;
        let mut t = (self.state ^ (self.state >> 15)).wrapping_mul(self.state | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        t ^ (t >> 14)
    }
    fn pick(&mut self, len: usize) -> usize {
        ((self.next_u32() as u64 * len as u64) >> 32) as usize
    }
}
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Trace {
    attacker: u32,
    target: u32,
    before_deaths: [Vec<Minion>; 2],
    after_deaths: [Vec<Minion>; 2],
}
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub result: &'static str,
    pub damage: u32,
    pub boards: [Vec<Minion>; 2],
    pub rng_state: u32,
    pub rng_draws: u32,
    pub trace: Vec<Trace>,
}
fn export(boards: &[Vec<Unit>; 2]) -> [Vec<Minion>; 2] {
    boards
        .each_ref()
        .map(|b| b.iter().map(|m| m.export()).collect())
}
fn damage(target: &mut Unit, amount: i64, source: &mut Unit) {
    if amount <= 0 {
        return;
    }
    if target.has(Keyword::Shield) {
        target.keywords &= !Keyword::Shield.bit();
        return;
    }
    target.health -= amount;
    if source.has(Keyword::Poison) || source.has(Keyword::Venom) {
        target.health = 0;
        source.keywords &= !Keyword::Venom.bit();
    }
}
fn resolve(boards: &mut [Vec<Unit>; 2], next_uid: &mut u32) {
    let mut dead = Vec::new();
    for (side, board) in boards.iter_mut().enumerate() {
        let mut pos = 0;
        for m in board.iter() {
            if m.health <= 0 {
                dead.push((side, pos, *m));
            } else {
                pos += 1;
            }
        }
        board.retain(|m| m.health > 0);
    }
    for i in 0..dead.len() {
        let (side, pos, m) = dead[i];
        if !m.has(Keyword::Reborn) {
            continue;
        }
        // TS allocates the reborn identity before checking whether the board is full.
        let revived = Unit {
            uid: *next_uid,
            card: m.card,
            attack: CARDS[m.card].1 * if m.golden { 2 } else { 1 },
            health: 1,
            golden: m.golden,
            keywords: CARDS[m.card].3 & !Keyword::Reborn.bit(),
        };
        *next_uid += 1;
        if boards[side].len() >= 7 {
            continue;
        }
        let insertion = pos.min(boards[side].len());
        boards[side].insert(insertion, revived);
        for slot in &mut dead {
            if slot.0 == side && slot.1 >= insertion {
                slot.1 += 1;
            }
        }
    }
}
pub fn combat(input: &Prepared, record_trace: bool) -> Outcome {
    let mut boards = input.boards.clone();
    let mut next_uid = input.next_uid;
    let mut rng = Random::new(input.seed);
    let mut side = if boards[0].len() == boards[1].len() {
        if rng.next_u32() < 0x80000000 { 0 } else { 1 }
    } else if boards[0].len() > boards[1].len() {
        0
    } else {
        1
    };
    let mut last = [0; 2];
    let mut index = [0; 2];
    let mut trace = Vec::new();
    for _ in 0..180 {
        if boards[0].is_empty() || boards[1].is_empty() {
            break;
        }
        let board = &boards[side];
        let start = board
            .iter()
            .position(|m| m.uid == last[side])
            .map(|p| (p + 1) % board.len())
            .unwrap_or(index[side] % board.len());
        let Some(ai) = (0..board.len())
            .map(|i| (start + i) % board.len())
            .find(|i| board[*i].attack > 0)
        else {
            if !boards[1 - side].iter().any(|m| m.attack > 0) {
                break;
            }
            side = 1 - side;
            continue;
        };
        let attacker_uid = board[ai].uid;
        last[side] = attacker_uid;
        index[side] = ai;
        let swings = if board[ai].has(Keyword::Windfury) {
            2
        } else {
            1
        };
        for _ in 0..swings {
            let Some(ai) = boards[side]
                .iter()
                .position(|m| m.uid == attacker_uid && m.health > 0)
            else {
                break;
            };
            if boards[1 - side].is_empty() {
                break;
            }
            let enemy = &boards[1 - side];
            let visible = enemy.iter().any(|m| !m.has(Keyword::Stealth));
            let has_taunt = enemy
                .iter()
                .any(|m| (!visible || !m.has(Keyword::Stealth)) && m.has(Keyword::Taunt));
            let eligible: Vec<usize> = enemy
                .iter()
                .enumerate()
                .filter(|(_, m)| {
                    (!visible || !m.has(Keyword::Stealth)) && (!has_taunt || m.has(Keyword::Taunt))
                })
                .map(|(i, _)| i)
                .collect();
            let ti = eligible[rng.pick(eligible.len())];
            let target_uid = enemy[ti].uid;
            let mut attacker = boards[side][ai];
            let mut target = boards[1 - side][ti];
            let a = attacker.attack;
            let t = target.attack;
            damage(&mut target, a, &mut attacker);
            damage(&mut attacker, t, &mut target);
            attacker.keywords &= !Keyword::Stealth.bit();
            boards[side][ai] = attacker;
            boards[1 - side][ti] = target;
            let before_deaths = if record_trace {
                export(&boards)
            } else {
                Default::default()
            };
            resolve(&mut boards, &mut next_uid);
            if record_trace {
                trace.push(Trace {
                    attacker: attacker_uid,
                    target: target_uid,
                    before_deaths,
                    after_deaths: export(&boards),
                });
            }
        }
        side = 1 - side;
    }
    let winner = match (boards[0].is_empty(), boards[1].is_empty()) {
        (false, true) => Some(0),
        (true, false) => Some(1),
        _ => None,
    };
    let raw = winner
        .map(|w| {
            input.tiers[w] as u32
                + boards[w]
                    .iter()
                    .map(|m| CARDS[m.card].2 as u32)
                    .sum::<u32>()
        })
        .unwrap_or(0);
    let cap = if input.living <= 4 {
        u32::MAX
    } else if input.turn < 4 {
        5
    } else if input.turn < 8 {
        10
    } else {
        15
    };
    Outcome {
        result: match winner {
            Some(0) => "win",
            Some(1) => "loss",
            _ => "tie",
        },
        damage: raw.min(cap),
        boards: export(&boards),
        rng_state: rng.state,
        rng_draws: rng.draws,
        trace,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn minion(uid: u32, attack: i64, health: i64, keywords: Vec<Keyword>) -> Minion {
        Minion {
            uid,
            card: "s14_BGS_034".into(),
            attack,
            health,
            golden: false,
            keywords,
        }
    }
    fn case(a: Vec<Minion>, b: Vec<Minion>) -> Case {
        Case {
            name: "test".into(),
            seed: 1,
            turn: 1,
            living: 8,
            tiers: [6, 6],
            boards: [a, b],
        }
    }
    #[test]
    fn damage_caps_change_at_turn_four_eight_and_top_four() {
        let mut c = case((1..=7).map(|i| minion(i, 2, 3, vec![])).collect(), vec![]);
        for (turn, living, expected) in [(3, 8, 5), (4, 8, 10), (7, 5, 10), (8, 5, 15), (1, 4, 20)]
        {
            c.turn = turn;
            c.living = living;
            assert_eq!(combat(&prepare(&c).unwrap(), false).damage, expected);
        }
    }
    #[test]
    fn shield_does_not_consume_venom_and_zero_damage_does_not_break_shield() {
        let p = prepare(&case(
            vec![minion(1, 1, 4, vec![Keyword::Venom])],
            vec![minion(2, 0, 4, vec![Keyword::Shield])],
        ))
        .unwrap();
        let mut a = p.boards[0][0];
        let mut b = p.boards[1][0];
        damage(&mut b, 0, &mut a);
        assert!(b.has(Keyword::Shield));
        damage(&mut b, 1, &mut a);
        assert!(!b.has(Keyword::Shield));
        assert!(a.has(Keyword::Venom));
        damage(&mut b, 1, &mut a);
        assert_eq!(b.health, 0);
        assert!(!a.has(Keyword::Venom));
    }
    #[test]
    fn golden_reborn_restores_base_attack_shield_and_one_health() {
        let mut m = minion(1, 100, 1, vec![Keyword::Reborn]);
        m.golden = true;
        let out = combat(
            &prepare(&case(vec![m], vec![minion(2, 1, 1, vec![])])).unwrap(),
            true,
        );
        let revived = &out.boards[0][0];
        assert_eq!((revived.uid, revived.attack, revived.health), (3, 4, 1));
        assert_eq!(revived.keywords, vec![Keyword::Shield]);
    }
    #[test]
    fn unsupported_state_is_rejected_instead_of_silently_ignored() {
        let mut c = case(vec![minion(1, 1, 1, vec![])], vec![]);
        c.boards[0][0].card = "s14_BG36_109".into();
        assert!(prepare(&c).is_err());
        let mut value = serde_json::to_value(case(vec![], vec![])).unwrap();
        value["trinkets"] = serde_json::json!(["something"]);
        assert!(serde_json::from_value::<Case>(value).is_err());
        let mut value = serde_json::to_value(minion(1, 1, 1, vec![])).unwrap();
        value["gift"] = serde_json::json!("some gift");
        assert!(serde_json::from_value::<Minion>(value.clone()).is_err());
        value.as_object_mut().unwrap().remove("gift");
        value["keywords"] = serde_json::json!(["unknown"]);
        assert!(serde_json::from_value::<Minion>(value.clone()).is_err());
    }
    #[test]
    fn rejects_invalid_stats_and_duplicate_ids() {
        for m in [
            minion(1, -1, 1, vec![]),
            minion(1, 1, 0, vec![]),
            minion(1, 1, 1, vec![Keyword::Shield, Keyword::Shield]),
        ] {
            assert!(prepare(&case(vec![m], vec![])).is_err());
        }
        assert!(
            prepare(&case(
                vec![minion(1, 1, 1, vec![])],
                vec![minion(1, 1, 1, vec![])]
            ))
            .is_err()
        );
        assert!(
            prepare(&case(
                (1..=8).map(|i| minion(i, 1, 1, vec![])).collect(),
                vec![]
            ))
            .is_err()
        );
    }
    #[test]
    fn no_attack_stalemate_and_180_turn_guard_terminate() {
        let zero = combat(
            &prepare(&case(
                vec![minion(1, 0, 10, vec![])],
                vec![minion(2, 0, 10, vec![])],
            ))
            .unwrap(),
            true,
        );
        assert_eq!(zero.result, "tie");
        assert_eq!(zero.trace.len(), 0);
        let long = combat(
            &prepare(&case(
                vec![minion(1, 1, 1000000, vec![])],
                vec![minion(2, 1, 1000000, vec![])],
            ))
            .unwrap(),
            true,
        );
        assert_eq!(long.result, "tie");
        assert_eq!(long.trace.len(), 180);
    }
}
