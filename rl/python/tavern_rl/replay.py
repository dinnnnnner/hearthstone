import argparse
import json
from pathlib import Path
from .bridge import Simulator

def main():
    p = argparse.ArgumentParser(description="Re-simulate a saved action tape locally, optionally recording combat frames")
    p.add_argument("tape", type=Path)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--frames", action="store_true")
    args = p.parse_args()
    tape = json.loads(args.tape.read_text())
    with Simulator() as simulator:
        if tape["sourceHash"] != simulator.meta["sourceHash"]: raise ValueError("Replay rules/source version mismatch")
        state = simulator.reset(tape["seed"], {**tape["options"], "recordFrames": args.frames})
        for action in tape["actions"]:
            state = simulator.step(action)
        result = simulator.call("replay")
        result["final"] = state["info"]
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result))
        print(json.dumps(state["info"]))

if __name__ == "__main__": main()
