from __future__ import annotations
import argparse
import json
from pathlib import Path
import numpy as np
import torch
from .rollout import SimulationPool
from .train import load_checkpoint, frozen_models

def main():
    parser = argparse.ArgumentParser(description="Evaluate one candidate seat against frozen neural historical opponents")
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("--opponent-checkpoints", nargs="*", type=Path)
    parser.add_argument("--games", type=int, default=64)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--seed", type=int, default=1000000)
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--output", type=Path, default=Path("rl/runs/evaluation.json"))
    parser.add_argument("--replays", action="store_true")
    args = parser.parse_args()
    if args.games < 1 or args.workers < 1: raise ValueError("Positive games/workers required")
    torch.set_num_threads(1); torch.manual_seed(args.seed)
    pool = SimulationPool(min(args.workers, args.games))
    try:
        saved, model = load_checkpoint(args.checkpoint, pool.meta, args.device)
        if args.opponent_checkpoints:
            opponents = [load_checkpoint(path, pool.meta, args.device, allow_legacy=True)[1] for path in args.opponent_checkpoints]
            opponent_ids = [str(path) for path in args.opponent_checkpoints]
        else:
            history = [entry for entry in saved["league"] if entry["generation"] != saved["iteration"]]
            if not history: raise ValueError("No older policies available for evaluation")
            opponents = frozen_models(history, saved["model_spec"], args.device)
            opponent_ids = [entry["generation"] for entry in history]
        seeds = [(args.seed + i) & 0xffffffff for i in range(args.games)]
        training_start = saved["config"]["seed"] & 0xffffffff
        if any(((seed - training_start) & 0xffffffff) < saved["episodes"] for seed in seeds):
            raise ValueError("Evaluation seeds overlap the candidate's training games; select a held-out --seed")
        _, games, performance = pool.collect(model, opponents, seeds, saved["config"]["options"], args.device,
            learner_seats=1, collect=False, replay_dir=args.output.parent / "evaluation-replays" if args.replays else None)
        ranks = [game["placements"][game["controllers"].index(-1)] for game in games if game["terminated"]]
        if len(ranks) != args.games: raise RuntimeError("Evaluation truncated; report not valid")
        report = {"schema": "tavern-evaluation-v1", "sourceHash": pool.meta["sourceHash"], "checkpoint": str(args.checkpoint),
                  "iteration": saved["iteration"], "seed_start": args.seed, "games": args.games, "opponents": opponent_ids,
                  "mean_placement": float(np.mean(ranks)), "first_rate": float(np.mean(np.array(ranks) == 1)),
                  "top_four_rate": float(np.mean(np.array(ranks) <= 4)),
                  "placement_standard_error": float(np.std(ranks, ddof=1) / np.sqrt(len(ranks))) if len(ranks) > 1 else None,
                  "scope": "One candidate seat rotates through eight positions against frozen policies; finite sample, not proof of general or human-level strength",
                  "performance": performance, "matches": games}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2))
        print(json.dumps({k: v for k, v in report.items() if k != "matches"}, indent=2))
    finally:
        pool.close()

if __name__ == "__main__": main()
