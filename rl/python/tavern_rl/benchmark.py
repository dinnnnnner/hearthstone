import argparse
import json
import resource
import time
from .bridge import Simulator
from .environment_probe import random_episode

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--games", type=int, default=4)
    p.add_argument("--max-actions", type=int, default=16)
    args = p.parse_args()
    start = time.monotonic(); summaries = []
    with Simulator() as simulator:
        for seed in range(args.games):
            summaries.append(random_episode(simulator, seed, args.max_actions))
    elapsed = time.monotonic() - start
    count = sum(s["steps"] for s in summaries)
    print(json.dumps({"games": args.games, "seconds": elapsed, "actions": count, "actions_per_second": count/elapsed,
                      "max_child_rss_kib": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
                      "scope": "Uniform random legal actions, simulator throughput only; not policy quality", "matches": summaries}, indent=2))

if __name__ == "__main__": main()
