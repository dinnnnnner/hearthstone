from __future__ import annotations
import argparse
import fcntl
import json
import os
from pathlib import Path
import random
import time
import hashlib
from collections import Counter
import numpy as np
import torch
from .model import make_model, ppo_update
from .rollout import SimulationPool
from .placement_rewards import validate_bonus, resolve_bonus


def trainer_hash():
    digest = hashlib.sha256()
    for path in sorted(Path(__file__).parent.glob('*.py')):
        digest.update(path.name.encode());digest.update(path.read_bytes())
    return digest.hexdigest()


def cpu_weights(model):
    return {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}


def atomic_checkpoint(path, payload):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".next")
    with temporary.open("wb") as file:
        torch.save(payload, file)
        file.flush(); os.fsync(file.fileno())
    os.replace(temporary, path)


def load_checkpoint(path, meta, device="cpu", allow_legacy=False):
    # Checkpoints include optimizer and RNG state. Load only your own trusted files.
    saved = torch.load(path, map_location="cpu", weights_only=False)
    legacy = (allow_legacy and meta.get('legacyV2SourceHash') is not None
              and saved['meta'].get('sourceHash') == meta['legacyV2SourceHash']
              and saved['meta'].get('schema') == 'tavern-selfplay-v2'
              and saved['meta'].get('observationVersion') == 2
              and saved['model_spec'].get('observation_size') == 2705
              and saved['model_spec'].get('architecture', 'mlp') == 'mlp')
    keys = ["actionVersion", "actionCount", "cardIds", "heroIds"]
    if not legacy: keys += ["schema", "sourceHash", "observationVersion"]
    for key in keys:
        if saved["meta"][key] != meta[key]:
            raise ValueError(f"Checkpoint incompatible with simulator: {key}")
    if saved['meta'].get('actions') != meta.get('actions'):
        raise ValueError('Checkpoint action definitions differ')
    model = make_model(saved["model_spec"]).to(device)
    model.load_state_dict(saved["model"])
    return saved, model


def frozen_models(saved_states, specification, device):
    result = []
    for entry in saved_states:
        model = make_model(entry.get("model_spec", specification)).to(device)
        model.load_state_dict(entry["weights"])
        model.eval()
        for parameter in model.parameters(): parameter.requires_grad_(False)
        result.append(model)
    return result


def league_entry(model, generation, anchor=False):
    return dict(generation=generation,anchor=anchor,model_spec=model.specification(),weights=cpu_weights(model),comparisons=0,learner_wins=0.)


def league_weights(league, external_fraction=.4):
    from .league import sampling_weights
    return sampling_weights(league, external_fraction)


def update_league_scores(league,games):
    for game in games:
        learners = [i for i,c in enumerate(game['controllers']) if c == -1]
        for seat,c in enumerate(game['controllers']):
            if c < 0: continue
            e = league[c]
            e['comparisons'] = e.get('comparisons',0)+len(learners)
            e['learner_wins'] = e.get('learner_wins',0)+sum(game['placements'][i] < game['placements'][seat] for i in learners)


def prune_league(league,size):
    anchors = [e for e in league if e.get('anchor',e['generation']==0)]
    history = [e for e in league if not e.get('anchor',e['generation']==0)]
    keep = size-len(anchors)
    if keep < 1: raise ValueError('No league history slots remain')
    if len(history) > keep:
        # Keep recent policies and spread remaining slots across older generations.
        recent = max(1,keep//2); older = history[:-recent]
        indices = np.linspace(0,len(older)-1,keep-recent,dtype=int).tolist() if keep > recent else []
        history = [older[i] for i in indices]+history[-recent:]
    return anchors+history


def parser():
    p = argparse.ArgumentParser(description="Eight-seat neural self-play PPO; no online game server or scripted bots")
    p.add_argument("--output", default="rl/runs/selfplay")
    p.add_argument("--resume", type=Path)
    p.add_argument("--first-place-bonus", type=validate_bonus,
                   help="Additional PPO reward for placement 1; omitted preserves saved value, legacy default 0")
    p.add_argument("--hero-pool", type=Path, help="JSON whitelist for all eight seats; saved in checkpoints and retained on resume")
    p.add_argument("--packed-host-transfer", action=argparse.BooleanOptionalAction, default=None,
                   help="Experimentally combine inference results into one host copy; resumes preserve saved setting")
    p.add_argument("--resume-games-per-iteration", type=int, help="Explicitly change the saved rollout batch for a new experiment")
    p.add_argument("--resume-learning-rate", type=float, help="Explicitly change Adam learning rate when resuming")
    p.add_argument("--rollout-device", choices=['cpu','cuda'], help="Inference device; defaults to the optimizer device")
    p.add_argument("--iterations", type=int, default=100, help="Additional PPO iterations, including when resuming")
    p.add_argument("--games-per-iteration", type=int, default=8)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--learner-seats", type=int, default=4)
    p.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--architecture", choices=['entity-gru','entity-gru-resnet','mlp'],
                   help='New runs default to entity-gru; resume restores the saved architecture')
    p.add_argument("--policy-depth", type=int, help='Dense layers in policy residual tower; default 64 for entity-gru-resnet')
    p.add_argument("--value-depth", type=int, help='Dense layers in value residual tower; default 64 for entity-gru-resnet')
    p.add_argument("--heads", type=int, default=4)
    p.add_argument("--layers", type=int, default=2)
    p.add_argument("--sequence-length", type=int, default=16)
    p.add_argument("--burn-in", type=int, default=8)
    p.add_argument("--sequence-batch-size", type=int, default=4)
    p.add_argument("--anchors", nargs='*', type=Path, default=[], help='Trusted frozen neural checkpoints; never resume legacy weights as the new model')
    p.add_argument("--hidden", type=int, default=128)
    p.add_argument("--max-actions", type=int, default=64)
    p.add_argument("--max-steps", type=int, default=30000)
    p.add_argument("--epochs", type=int, default=4)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--learning-rate", type=float, help='Default 3e-5 for entity-gru-resnet, 3e-4 for other new runs')
    p.add_argument("--league-size", type=int, default=12)
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--replays", action="store_true", help="Save action tapes for deterministic offline replay")
    from .training_performance import add_arguments
    add_arguments(p)
    return p


def validate_resume_architecture(args, specification):
    expected = dict(architecture=specification.get('architecture', 'mlp'),
                    policy_depth=specification.get('policy_depth'), value_depth=specification.get('value_depth'))
    for key, saved in expected.items():
        requested = getattr(args, key)
        if requested is not None and requested != saved:
            raise ValueError(f'Resume restores checkpoint {key}={saved}; requested {requested} requires a new run')


def main():
    args = parser().parse_args()
    if min(args.iterations, args.games_per_iteration, args.workers, args.threads, args.epochs, args.batch_size) < 1 or args.league_size < 2 or not 1 <= args.learner_seats <= 8:
        raise ValueError("Invalid training sizes")
    if min(args.sequence_length,args.sequence_batch_size,args.heads,args.layers) < 1 or args.burn_in < 0:
        raise ValueError("Invalid recurrent sizes")
    for depth in (args.policy_depth, args.value_depth):
        if depth is not None:
            from .deep_model import validate_depth
            validate_depth(depth)
    if not args.resume and args.architecture != 'entity-gru-resnet' and any(d is not None for d in (args.policy_depth, args.value_depth)):
        raise ValueError('Residual depths require --architecture entity-gru-resnet')
    if args.learning_rate is not None and (not np.isfinite(args.learning_rate) or not 0 < args.learning_rate < 1):
        raise ValueError('Invalid learning rate')
    if args.resume and args.anchors: raise ValueError("Resume restores its frozen league; do not add anchors during resume")
    if (args.resume_games_per_iteration is not None or args.resume_learning_rate is not None) and not args.resume:
        raise ValueError('Resume overrides require --resume')
    if args.resume_games_per_iteration is not None and args.resume_games_per_iteration < 1: raise ValueError('Invalid rollout batch')
    if args.resume_learning_rate is not None and not 0 < args.resume_learning_rate < 1: raise ValueError('Invalid learning rate')
    rollout_device = args.rollout_device or args.device
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed); np.random.seed(args.seed); random.seed(args.seed)
    if 'cuda' in [args.device,rollout_device] and not torch.cuda.is_available(): raise RuntimeError("CUDA is not available")
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
    code_hash = trainer_hash()
    from .training_performance import make_pool
    pool = make_pool(args, output)
    try:
        state = pool.simulators[0].reset(args.seed & 0xffffffff)
        config = {"gamma": 1.0, "gae_lambda": .95, "clip": .2, "value_coef": .5, "entropy_coef": .01,
                  "target_kl": .03, "max_grad_norm": .5, "epochs": args.epochs, "batch_size": args.batch_size,
                  "sequence_length": args.sequence_length, "burn_in": args.burn_in, "sequence_batch_size": args.sequence_batch_size,
                  "learning_rate": args.learning_rate if args.learning_rate is not None else (3e-5 if args.architecture == 'entity-gru-resnet' else 3e-4),
                  "seed": args.seed, "learner_seats": args.learner_seats,
                  "first_place_bonus": resolve_bonus({}, args.first_place_bonus),
                  "games_per_iteration": args.games_per_iteration, "league_size": args.league_size,
                  "options": {"maxActionsPerTurn": args.max_actions, "maxSteps": args.max_steps, "recordFrames": False}}
        iteration = 0; episodes = 0; league = []
        saved = None
        if args.resume:
            saved, model = load_checkpoint(args.resume, pool.meta, args.device)
            validate_resume_architecture(args, saved['model_spec'])
            config = dict(saved["config"])  # Preserve saved settings except the explicitly reset gold penalty.
            config['first_place_bonus'] = resolve_bonus(config, args.first_place_bonus)
            config.pop('unused_gold_penalty', None)
            if args.resume_games_per_iteration is not None: config['games_per_iteration'] = args.resume_games_per_iteration
            if args.resume_learning_rate is not None: config['learning_rate'] = args.resume_learning_rate
            iteration, episodes, league = saved["iteration"], saved["episodes"], saved["league"]
        else:
            architecture = args.architecture or 'entity-gru'
            spec = dict(observation_size=len(state['observation']),action_size=pool.meta['actionCount'],hidden=args.hidden) if architecture == 'mlp' else dict(
                architecture=architecture,entity_schema=pool.meta['entitySchema'],actions=pool.meta['actions'],hidden=args.hidden,heads=args.heads,layers=args.layers)
            if architecture == 'entity-gru-resnet':
                spec.update(policy_depth=args.policy_depth or 64, value_depth=args.value_depth or 64)
            model = make_model(spec).to(args.device)
            league = [league_entry(model,0,anchor=True)]
            for path in args.anchors:
                _, anchor = load_checkpoint(path,pool.meta,args.device,allow_legacy=True)
                league.append(league_entry(anchor,'anchor:'+str(path),anchor=True))
            if len(league) >= args.league_size: raise ValueError('League needs space for anchors plus history')
        from .hero_pool import load_hero_pool, validate_hero_pool, options_for_seed
        config['packed_host_transfer'] = config.get('packed_host_transfer', False) if args.packed_host_transfer is None else args.packed_host_transfer
        if args.hero_pool:
            config['hero_pool'] = load_hero_pool(args.hero_pool, pool.meta)
        if config.get('hero_pool') is not None:
            validate_hero_pool(config['hero_pool'], pool.meta)
            options_for_seed(config['options'], config['hero_pool'], config['seed'])
        from .training_performance import apply_overrides, make_optimizer
        apply_overrides(config, args)
        optimizer = make_optimizer(model, config, saved["optimizer"] if saved else None)
        def inference_model():
            if rollout_device == args.device: return model
            copy = make_model(model.specification()).to(rollout_device)
            copy.load_state_dict(cpu_weights(model));copy.eval()
            for parameter in copy.parameters(): parameter.requires_grad_(False)
            return copy
        actor = inference_model()
        opponents = [] if args.sampling_processes > 1 else frozen_models(league, model.specification(), rollout_device)
        if saved:
            torch.set_rng_state(saved["torch_rng"])
            np.random.set_state(saved["numpy_rng"]); random.setstate(saved["python_rng"])
            if args.device == "cuda" and saved.get("cuda_rng") is not None:
                torch.cuda.set_rng_state_all(saved["cuda_rng"])

        def checkpoint():
            from .league import members
            payload = {"format": 1, "trainerHash": code_hash, "meta": pool.meta, "model_spec": model.specification(), "model": cpu_weights(model),
                       "optimizer": optimizer.state_dict(), "iteration": iteration, "episodes": episodes,
                       "league": league, "config": config, "torch_rng": torch.get_rng_state(),
                       "numpy_rng": np.random.get_state(), "python_rng": random.getstate(),
                       "cuda_rng": torch.cuda.get_rng_state_all() if args.device == "cuda" else None}
            if saved and saved.get('league_imports'): payload['league_imports'] = saved['league_imports']
            atomic_checkpoint(output / "latest.pt", payload)
            (output / "manifest.json").write_text(json.dumps({"format": 1, "trainerHash": code_hash, "meta": {k:v for k,v in pool.meta.items() if k not in ["actions", "cardIds", "heroIds", "entitySchema"]},
                "config": config, "iteration": iteration, "episodes": episodes, "model_spec": {k:v for k,v in model.specification().items() if k not in ["entity_schema","actions"]},
                "league_generations": [entry["generation"] for entry in league], "torch": torch.__version__, "numpy": np.__version__,
                "league_members": members(league),
                "device": args.device, "rollout_device": rollout_device, "workers": getattr(pool, "worker_count", len(pool.simulators)),
                "rollout_host_transfer": "packed" if config['packed_host_transfer'] else "separate",
                "parameters": sum(p.numel() for p in model.parameters())}, indent=2))
        checkpoint()
        for _ in range(args.iterations):
            iteration_started = time.monotonic()
            if args.device == "cuda": torch.cuda.reset_peak_memory_stats()
            seeds = [(config["seed"] + episodes + i) & 0xffffffff for i in range(config["games_per_iteration"])]
            probabilities = league_weights(league,config.get('external_opponent_fraction',.4))
            tracks, games, performance = pool.collect(actor, opponents, seeds, config["options"], rollout_device,
                learner_seats=8 if iteration == 0 and len(league) == 1 else config["learner_seats"],
                first_place_bonus=config['first_place_bonus'],
                hero_pool=config.get('hero_pool'),
                packed_host_transfer=config['packed_host_transfer'],
                opponent_weights=probabilities, seat_offset=episodes, progress=lambda row: print(json.dumps(row),flush=True),
                replay_dir=output / "replays" if args.replays else None, error_dir=output / "debug")
            if any(game["truncated"] for game in games):
                raise RuntimeError("A self-play game was truncated. Inspect replay/debug files and increase maxSteps; no PPO update was applied")
            optimization_started = time.monotonic()
            from .training_performance import optimized_update
            metrics = optimized_update(ppo_update, model, optimizer, tracks, config, args.device)
            if args.device == "cuda": torch.cuda.synchronize()
            metrics["optimization_seconds"] = time.monotonic()-optimization_started
            counts = Counter(c for game in games for c in game['controllers'] if c >= 0)
            opponent_sampling = [dict(generation=e['generation'],external=e.get('external',False),
                depth=e.get('model_spec',{}).get('policy_depth'),probability=float(probabilities[i]),seats=counts[i]) for i,e in enumerate(league)]
            episodes += len(games); iteration += 1
            update_league_scores(league,games)
            league.append(league_entry(model,iteration))
            league = prune_league(league,config["league_size"])
            actor = inference_model()
            opponents = [] if args.sampling_processes > 1 else frozen_models(league, model.specification(), rollout_device)
            total_seconds = time.monotonic()-iteration_started
            row = {"iteration": iteration, "iteration_seconds": total_seconds,
                   "end_to_end_actions_per_second": performance["environment_actions"]/total_seconds,
                   "cuda_peak_allocated_mib": torch.cuda.max_memory_allocated()/2**20 if args.device == "cuda" else None, "episodes": episodes, **performance, **metrics,
                   "completed_games": len(games), "league_generations": [entry["generation"] for entry in league]}
            row['opponent_sampling'] = opponent_sampling
            if config.get('hero_pool') is not None:
                row['hero_counts'] = dict(Counter(h for game in games for h in game['heroes']))
            with (output / "metrics.jsonl").open("a") as file: file.write(json.dumps(row) + "\n")
            checkpoint()
            print(json.dumps(row), flush=True)
        print(f"Checkpoint: {output / 'latest.pt'}", flush=True)
    finally:
        pool.close()
        lock.close()

if __name__ == "__main__":
    main()
