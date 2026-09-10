from __future__ import annotations
import argparse
import fcntl
import json
import os
from pathlib import Path
import random
import numpy as np
import torch
from .model import ActorCritic, ppo_update
from .rollout import SimulationPool


def cpu_weights(model):
    return {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}


def atomic_checkpoint(path, payload):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".next")
    with temporary.open("wb") as file:
        torch.save(payload, file)
        file.flush(); os.fsync(file.fileno())
    os.replace(temporary, path)


def load_checkpoint(path, meta, device="cpu"):
    # Checkpoints include optimizer and RNG state. Load only your own trusted files.
    saved = torch.load(path, map_location="cpu", weights_only=False)
    for key in ["schema", "sourceHash", "observationVersion", "actionVersion", "actionCount", "cardIds", "heroIds"]:
        if saved["meta"][key] != meta[key]:
            raise ValueError(f"Checkpoint incompatible with simulator: {key}")
    model = ActorCritic(**saved["model_spec"]).to(device)
    model.load_state_dict(saved["model"])
    return saved, model


def frozen_models(saved_states, specification, device):
    result = []
    for entry in saved_states:
        model = ActorCritic(**specification).to(device)
        model.load_state_dict(entry["weights"])
        model.eval()
        for parameter in model.parameters(): parameter.requires_grad_(False)
        result.append(model)
    return result


def parser():
    p = argparse.ArgumentParser(description="Eight-seat neural self-play PPO; no online game server or scripted bots")
    p.add_argument("--output", default="rl/runs/selfplay")
    p.add_argument("--resume", type=Path)
    p.add_argument("--iterations", type=int, default=100, help="Additional PPO iterations, including when resuming")
    p.add_argument("--games-per-iteration", type=int, default=8)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--learner-seats", type=int, default=4)
    p.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--hidden", type=int, default=128)
    p.add_argument("--max-actions", type=int, default=64)
    p.add_argument("--max-steps", type=int, default=30000)
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--learning-rate", type=float, default=3e-4)
    p.add_argument("--league-size", type=int, default=8)
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--replays", action="store_true", help="Save action tapes for deterministic offline replay")
    return p


def main():
    args = parser().parse_args()
    if min(args.iterations, args.games_per_iteration, args.workers, args.threads, args.epochs, args.batch_size) < 1 or args.league_size < 2 or not 1 <= args.learner_seats <= 8:
        raise ValueError("Invalid training sizes")
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed); np.random.seed(args.seed); random.seed(args.seed)
    if args.device == "cuda" and not torch.cuda.is_available(): raise RuntimeError("CUDA is not available")
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    lock = (output / ".train.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise RuntimeError(f"Another trainer is using {output}") from None
    if (output / "latest.pt").exists() and not args.resume:
        lock.close()
        raise ValueError("Output already contains a checkpoint; use --resume or choose a new --output")
    pool = SimulationPool(min(args.workers, args.games_per_iteration))
    try:
        state = pool.simulators[0].reset(args.seed & 0xffffffff)
        config = {"gamma": 1.0, "gae_lambda": .95, "clip": .2, "value_coef": .5, "entropy_coef": .01,
                  "target_kl": .03, "max_grad_norm": .5, "epochs": args.epochs, "batch_size": args.batch_size,
                  "learning_rate": args.learning_rate, "seed": args.seed, "learner_seats": args.learner_seats,
                  "games_per_iteration": args.games_per_iteration, "league_size": args.league_size,
                  "options": {"maxActionsPerTurn": args.max_actions, "maxSteps": args.max_steps, "recordFrames": False}}
        iteration = 0; episodes = 0; league = []
        saved = None
        if args.resume:
            saved, model = load_checkpoint(args.resume, pool.meta, args.device)
            config = saved["config"]  # Resume the actual reward/action budget, not accidental CLI defaults.
            iteration, episodes, league = saved["iteration"], saved["episodes"], saved["league"]
        else:
            model = ActorCritic(len(state["observation"]), pool.meta["actionCount"], args.hidden).to(args.device)
            league = [{"generation": 0, "weights": cpu_weights(model)}]
        optimizer = torch.optim.Adam(model.parameters(), lr=config["learning_rate"], eps=1e-5)
        if saved:
            optimizer.load_state_dict(saved["optimizer"])
        opponents = frozen_models(league, model.specification(), args.device)
        if saved:
            torch.set_rng_state(saved["torch_rng"])
            np.random.set_state(saved["numpy_rng"]); random.setstate(saved["python_rng"])
            if args.device == "cuda" and saved.get("cuda_rng") is not None:
                torch.cuda.set_rng_state_all(saved["cuda_rng"])

        def checkpoint():
            payload = {"format": 1, "meta": pool.meta, "model_spec": model.specification(), "model": cpu_weights(model),
                       "optimizer": optimizer.state_dict(), "iteration": iteration, "episodes": episodes,
                       "league": league, "config": config, "torch_rng": torch.get_rng_state(),
                       "numpy_rng": np.random.get_state(), "python_rng": random.getstate(),
                       "cuda_rng": torch.cuda.get_rng_state_all() if args.device == "cuda" else None}
            atomic_checkpoint(output / "latest.pt", payload)
            (output / "manifest.json").write_text(json.dumps({"format": 1, "meta": {k:v for k,v in pool.meta.items() if k not in ["actions", "cardIds", "heroIds"]},
                "config": config, "iteration": iteration, "episodes": episodes, "model_spec": model.specification(),
                "league_generations": [entry["generation"] for entry in league], "torch": torch.__version__, "numpy": np.__version__,
                "device": args.device, "workers": len(pool.simulators)}, indent=2))
        checkpoint()
        for _ in range(args.iterations):
            seeds = [(config["seed"] + episodes + i) & 0xffffffff for i in range(config["games_per_iteration"])]
            tracks, games, performance = pool.collect(model, opponents, seeds, config["options"], args.device,
                learner_seats=8 if iteration == 0 else config["learner_seats"],
                replay_dir=output / "replays" if args.replays else None, error_dir=output / "debug")
            if any(game["truncated"] for game in games):
                raise RuntimeError("A self-play game was truncated. Inspect replay/debug files and increase maxSteps; no PPO update was applied")
            metrics = ppo_update(model, optimizer, tracks, config, args.device)
            episodes += len(games); iteration += 1
            league.append({"generation": iteration, "weights": cpu_weights(model)})
            league = league[:1] + league[-(config["league_size"]-1):] if len(league) > config["league_size"] else league
            opponents = frozen_models(league, model.specification(), args.device)
            row = {"iteration": iteration, "episodes": episodes, **performance, **metrics,
                   "completed_games": len(games), "league_generations": [entry["generation"] for entry in league]}
            with (output / "metrics.jsonl").open("a") as file: file.write(json.dumps(row) + "\n")
            checkpoint()
            print(json.dumps(row), flush=True)
        print(f"Checkpoint: {output / 'latest.pt'}", flush=True)
    finally:
        pool.close()
        lock.close()

if __name__ == "__main__":
    main()
