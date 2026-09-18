use serde::Deserialize;
use std::{
    hint::black_box,
    io::{self, BufRead, Write},
    time::Instant,
};
use tavern_combat_prototype::{Case, combat, prepare};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    cases: Vec<Case>,
    #[serde(default)]
    repetitions: Option<usize>,
}
fn main() {
    let stdin = io::stdin();
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let response = (|| -> Result<serde_json::Value, String> {
            let line = line.map_err(|e| e.to_string())?;
            let request: Request = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if request.cases.is_empty() || request.cases.len() > 100_000 {
                return Err("expected 1..100000 cases".into());
            }
            let prepared = request
                .cases
                .iter()
                .map(prepare)
                .collect::<Result<Vec<_>, _>>()?;
            if let Some(repetitions) = request.repetitions {
                if repetitions == 0 || repetitions > 100_000 {
                    return Err("invalid repetition count".into());
                }
                for _ in 0..5 {
                    for case in &prepared {
                        black_box(combat(case, false));
                    }
                }
                let start = Instant::now();
                let mut checksum = 0u64;
                for _ in 0..repetitions {
                    for case in &prepared {
                        let result = black_box(combat(black_box(case), false));
                        checksum = checksum.wrapping_add(
                            result.damage as u64
                                + result.rng_draws as u64
                                + match result.result {
                                    "win" => 1,
                                    "loss" => 2,
                                    _ => 0,
                                },
                        );
                    }
                }
                let seconds = start.elapsed().as_secs_f64();
                // /proc resets VmHWM after exec; wait4 may include the spawning parent's high water mark.
                let status =
                    std::fs::read_to_string("/proc/self/status").map_err(|e| e.to_string())?;
                let rss_kib: f64 = status
                    .lines()
                    .find(|s| s.starts_with("VmHWM:"))
                    .and_then(|s| s.split_whitespace().nth(1))
                    .ok_or("missing VmHWM")?
                    .parse()
                    .map_err(|_| "invalid VmHWM")?;
                Ok(
                    serde_json::json!({"ok":true,"combats":repetitions*prepared.len(),"seconds":seconds,"checksum":checksum,"peak_rss_mib":rss_kib/1024.0}),
                )
            } else {
                let results: Vec<_> = prepared.iter().map(|c| combat(c, true)).collect();
                Ok(serde_json::json!({"ok":true,"results":results}))
            }
        })();
        let value = response.unwrap_or_else(|error| serde_json::json!({"ok":false,"error":error}));
        writeln!(out, "{value}").expect("write response");
        out.flush().expect("flush response");
    }
}
