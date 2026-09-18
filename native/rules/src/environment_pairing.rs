use crate::{Result, arr, num};
use serde_json::{Value, json};
use tavern_combat_prototype::Random;
fn key(a: &Value, b: &Value) -> String {
    let mut p = vec![a.as_str().unwrap_or(""), b.as_str().unwrap_or("")];
    p.sort();
    serde_json::to_string(&p).unwrap()
}
fn matchings(ids: &[Value]) -> Vec<Vec<Value>> {
    if ids.is_empty() {
        return vec![vec![]];
    }
    let mut out = vec![];
    for i in 1..ids.len() {
        let rest: Vec<_> = ids
            .iter()
            .enumerate()
            .filter(|(j, _)| *j != 0 && *j != i)
            .map(|(_, x)| x.clone())
            .collect();
        for tail in matchings(&rest) {
            let mut v = vec![json!([ids[0], ids[i]])];
            v.extend(tail);
            out.push(v)
        }
    }
    out
}
fn robin(ids: &[Value], round: usize) -> Vec<Value> {
    if ids.len() < 2 {
        return vec![];
    }
    let mut order = ids.to_vec();
    if order.len() % 2 != 0 {
        order.push(Value::Null)
    }
    let mut tail = order.split_off(1);
    let n = tail.len();
    tail.rotate_left(round % n);
    order.extend(tail);
    let mut out = vec![];
    while !order.is_empty() {
        let a = order.remove(0);
        let b = order.pop().unwrap();
        out.push(if a.is_null() {
            json!([b, a])
        } else {
            json!([a, b])
        })
    }
    out
}
pub fn cycle(
    mut c: Value,
    turn: u64,
    ghosts: &[Value],
    rng: &mut Random,
    previous: &[Value],
) -> Result<Value> {
    if c["lastTurn"] == turn && c["pairs"].is_array() {
        return Ok(c);
    }
    let members = arr(&c["members"]);
    let keys: Vec<_> = previous
        .iter()
        .filter(|p| !p[1].is_null())
        .map(|p| key(&p[0], &p[1]))
        .collect();
    let repeats = |pairs: &[Value]| {
        members.len() > 2
            && pairs
                .iter()
                .any(|p| !p[1].is_null() && keys.contains(&key(&p[0], &p[1])))
    };
    let pairs = if members.len() % 2 == 0 {
        let order = if !c["order"].is_array() && c["startTurn"] == turn && !keys.is_empty() {
            let options: Vec<_> = matchings(members)
                .into_iter()
                .filter(|ps| !repeats(ps))
                .collect();
            let i = (rng.next_u32() as f64 / 4294967296. * options.len() as f64).floor() as usize;
            if let Some(first) = options.get(i) {
                let mut v: Vec<_> = first.iter().map(|p| p[0].clone()).collect();
                v.extend(first.iter().rev().map(|p| p[1].clone()));
                Some(v)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(order) = order {
            c["order"] = json!(order)
        }
        robin(
            if c["order"].is_array() {
                arr(&c["order"])
            } else {
                arr(&c["members"])
            },
            (turn - num(&c["startTurn"]) as u64) as usize,
        )
    } else {
        let mut best = f64::INFINITY;
        let mut ties = 0.;
        let mut pairs = vec![];
        for ghost in ghosts {
            let rest: Vec<_> = members.iter().filter(|id| *id != ghost).cloned().collect();
            for matches in matchings(&rest) {
                if repeats(&matches) {
                    continue;
                }
                let mut cost = num(&c["ghosts"][ghost.as_str().unwrap_or("")]);
                for p in &matches {
                    let prior = &c["meetings"][key(&p[0], &p[1])];
                    if prior.is_object() {
                        cost += num(&prior["count"]) * 10000.
                            + (100. - (turn as f64 - num(&prior["turn"]))).max(0.) * 10.
                    }
                }
                if cost < best {
                    best = cost;
                    ties = 0.
                }
                if cost == best {
                    ties += 1.;
                    if (rng.next_u32() as f64 / 4294967296.) < 1. / ties {
                        pairs = matches;
                        pairs.push(json!([ghost, null]))
                    }
                }
            }
        }
        pairs
    };
    for p in &pairs {
        if p[1].is_null() {
            let id = p[0].as_str().ok_or("Invalid seat id")?;
            c["ghosts"][id] = json!(num(&c["ghosts"][id]) + 1.)
        } else {
            let k = key(&p[0], &p[1]);
            c["meetings"][&k] = json!({"count":num(&c["meetings"][&k]["count"])+1.,"turn":turn})
        }
    }
    c["lastTurn"] = json!(turn);
    c["pairs"] = json!(pairs);
    Ok(c)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_opponents_before_repeat() {
        let ids: Vec<_> = (0..8).map(|i| json!(i.to_string())).collect();
        let mut faced = std::collections::HashSet::new();
        for r in 0..7 {
            for p in robin(&ids, r) {
                assert!(faced.insert(key(&p[0], &p[1])));
            }
        }
        assert_eq!(faced.len(), 28);
    }
}
