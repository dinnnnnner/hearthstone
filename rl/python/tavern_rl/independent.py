"""Resume separate self-play learners with only their own frozen history as opponents."""
from __future__ import annotations

import argparse
import datetime
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from .population import stop_processes


def isolate_checkpoint(saved):
    """Keep learned weights/Adam/RNG untouched; remove imported and foreign opponents."""
    required = {"model", "model_spec", "meta", "optimizer", "torch_rng", "numpy_rng",
                "python_rng", "iteration", "episodes", "config", "league"}
    if not required <= saved.keys():
        raise ValueError("Independent continuation requires a full training checkpoint")
    own_spec = saved["model_spec"]
    native = [entry for entry in saved["league"] if not entry.get("external", False)
              and type(entry["generation"]) is int
              and entry.get("model_spec", own_spec) == own_spec]
    removed = [entry["generation"] for entry in saved["league"]
               if not any(entry is kept for kept in native)]
    if not native:
        native = [dict(generation=saved["iteration"], anchor=True, model_spec=own_spec,
                       weights=saved["model"], comparisons=0, learner_wins=0.)]
    config = dict(saved["config"], opponent_mode="self_history_only")
    # sampling_weights ignores this fraction when there are no external opponents;
    # its existing range validation requires leaving it unset rather than setting 0.
    config.pop("external_opponent_fraction", None)
    return saved | {"league": native, "config": config,
                    "independent_start": {"episodes": saved["episodes"], "removed_generations": removed}}, removed


def write_status(path, state):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


def prepare(source, target, meta, hero_pool=None, packed_host_transfer=None):
    import torch
    from .train import atomic_checkpoint, load_checkpoint
    from .league import members, sampling_weights
    torch.set_num_threads(1)
    saved, model = load_checkpoint(source, meta)
    independent, removed = isolate_checkpoint(saved)
    if packed_host_transfer is not None:
        independent['config']['packed_host_transfer'] = packed_host_transfer
    if hero_pool is not None:
        from .hero_pool import validate_hero_pool, options_for_seed
        validate_hero_pool(hero_pool, meta)
        options_for_seed(independent['config']['options'], hero_pool, independent['config']['seed'])
        independent['config']['hero_pool'] = hero_pool
    target.mkdir(parents=True, exist_ok=False)
    atomic_checkpoint(target / "initial.pt", independent)
    report = {"source": str(source.resolve()), "initial": str(target / "initial.pt"),
              "episodes": saved["episodes"], "iteration": saved["iteration"],
              "depth": saved["model_spec"].get("policy_depth"),
              "removed_generations": removed, "league_members": members(independent["league"]),
              "probabilities": sampling_weights(independent["league"]).tolist(),
              "config": independent["config"], "source_hash": meta["sourceHash"],
              "rules_hash": meta.get("rulesHash"),
              "parameters": sum(p.numel() for p in model.parameters())}
    write_status(target / "isolation.json", report)
    return report


def supervise(root, members, hours, workers, device, deadline_utc=None):
    """Common wall-clock budget; no exchange stage, shared checkpoints, or mixed league."""
    started = time.time()
    if deadline_utc is not None:
        hours = (deadline_utc.timestamp() - started) / 3600
        if hours <= 0:
            raise ValueError("Training deadline has already passed")
    deadline = time.monotonic() + hours * 3600
    state = {"stage": "starting", "pid": os.getpid(), "opponent_mode": "self_history_only",
             "started_utc": datetime.datetime.fromtimestamp(started, datetime.timezone.utc).isoformat(),
             "deadline_utc": datetime.datetime.fromtimestamp(started + hours * 3600, datetime.timezone.utc).isoformat(),
             "hours": hours, "workers_per_learner": workers, "members": members}
    active = []
    def status():
        write_status(root / "status.json", state)
    def interrupt(signum, _frame):
        raise KeyboardInterrupt(f"Signal {signum}")
    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        for member in members:
            directory = Path(member["initial"]).parent
            command = [sys.executable, "-u", "-m", "tavern_rl.train", "--resume", member["initial"],
                       "--output", str(directory / "training"), "--iterations", "1000000000",
                       "--workers", str(workers), "--threads", "1", "--device", device,
                       "--rollout-device", device]
            with (directory / "training.log").open("a") as log:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log,
                    stderr=subprocess.STDOUT, start_new_session=True)
            active.append(process)
            member.update(pid=process.pid, command=command, checkpoint=str(directory / "training/latest.pt"))
            status()
        state["stage"] = "running"
        status()
        print(json.dumps(state, ensure_ascii=False), flush=True)
        while time.monotonic() < deadline:
            for member, process in zip(members, active):
                if process.poll() is not None:
                    raise RuntimeError(f"Independent depth {member['depth']} exited {process.returncode}; inspect training.log")
            time.sleep(min(1, max(0, deadline - time.monotonic())))
        state["stage"] = "time_limit"
    except BaseException as exc:
        state.update(stage="interrupted" if isinstance(exc, KeyboardInterrupt) else "failed", error=repr(exc))
        raise
    finally:
        stop_processes(active)
        state["stopped_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        for member in members:
            member["running"] = False
        status()
        signal.signal(signal.SIGTERM, previous)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resumes", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--hours", type=float, default=4)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    parser.add_argument("--hero-pool", type=Path, help="Whitelist for all eight seats, persisted in isolated checkpoints")
    parser.add_argument("--packed-host-transfer", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--deadline-utc", help="ISO timestamp with timezone; overrides hours to retain an existing run's deadline")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--prepared", action="store_true", help="Launch from this output's prepared isolation records")
    args = parser.parse_args()
    deadline = datetime.datetime.fromisoformat(args.deadline_utc) if args.deadline_utc else None
    if deadline is not None and deadline.tzinfo is None:
        parser.error("--deadline-utc requires a timezone")
    hero_pool = json.loads(args.hero_pool.read_text()) if args.hero_pool else None
    if not math.isfinite(args.hours) or args.hours <= 0 or args.workers < 1:
        parser.error("Positive finite hours and positive worker count required")
    if args.prepare_only and args.prepared:
        parser.error("--prepare-only and --prepared are mutually exclusive")
    if len({p.resolve() for p in args.resumes}) != len(args.resumes) or any(not p.is_file() for p in args.resumes):
        parser.error("Distinct existing training checkpoints required")
    root = args.output.resolve()
    import fcntl
    if not args.prepared:
        root.mkdir(parents=True, exist_ok=False)
    with (root / ".independent.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.prepared:
            if (root / "status.json").exists():
                raise ValueError("Output already launched; prepare a new run to continue")
            members = [json.loads((root / f"member-{i}/isolation.json").read_text()) for i in range(len(args.resumes))]
            if any(m["source"] != str(p.resolve()) for m, p in zip(members, args.resumes)):
                raise ValueError("Prepared sources do not match requested resumes")
            if hero_pool is not None and any(m['config'].get('hero_pool') != hero_pool for m in members):
                raise ValueError("Prepared hero pool differs from requested whitelist")
            if args.packed_host_transfer is not None and any(m['config'].get('packed_host_transfer', False) != args.packed_host_transfer for m in members):
                raise ValueError("Prepared host transfer differs from requested setting")
        else:
            from .bridge import Simulator
            with Simulator() as simulator:
                meta = simulator.meta
            members = [prepare(source, root / f"member-{i}", meta, hero_pool, args.packed_host_transfer) for i, source in enumerate(args.resumes)]
            write_status(root / "prepared.json", {"stage": "prepared", "members": members})
        if args.prepare_only:
            print(json.dumps({"stage": "prepared", "output": str(root)}), flush=True)
            return
        supervise(root, members, args.hours, args.workers, args.device, deadline)


if __name__ == "__main__":
    main()
