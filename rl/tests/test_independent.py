import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tavern_rl.independent import isolate_checkpoint, supervise


def checkpoint():
    spec = {"architecture": "entity-gru-resnet", "policy_depth": 64, "value_depth": 64}
    return dict(model={"weight": [1., 2.]}, model_spec=spec, meta={}, optimizer={"step": 17},
        torch_rng=[1], numpy_rng=[2], python_rng=[3], iteration=4, episodes=16,
        config={"learning_rate": 3e-5, "unused_gold_penalty": .01, "external_opponent_fraction": .4},
        league=[dict(generation=0, anchor=True, model_spec=spec, weights={}),
                dict(generation="external:other", external=True, model_spec=spec, weights={}),
                dict(generation="anchor:foreign", anchor=True, model_spec=spec, weights={}),
                dict(generation=3, model_spec={**spec, "policy_depth": 256}, weights={}),
                dict(generation=4, model_spec=spec, weights={})])


class IndependentTests(unittest.TestCase):
    def test_only_native_history_kept_without_mutating_optimizer_weights_rng_or_source(self):
        saved = checkpoint()
        before = copy.deepcopy(saved)
        result, removed = isolate_checkpoint(saved)
        self.assertEqual([e["generation"] for e in result["league"]], [0, 4])
        self.assertEqual(removed, ["external:other", "anchor:foreign", 3])
        for key in ["model", "optimizer", "torch_rng", "numpy_rng", "python_rng"]:
            self.assertIs(result[key], saved[key])
        self.assertEqual(saved, before)
        self.assertEqual(result["config"]["opponent_mode"], "self_history_only")
        self.assertNotIn("external_opponent_fraction", result["config"])
        self.assertEqual(result["config"]["unused_gold_penalty"], .01)
        self.assertEqual(result["episodes"], 16)

    def test_no_native_history_seeds_frozen_current_self(self):
        saved = checkpoint()
        saved["league"] = [saved["league"][1]]
        result, _ = isolate_checkpoint(saved)
        self.assertEqual(len(result["league"]), 1)
        self.assertIs(result["league"][0]["weights"], saved["model"])
        self.assertTrue(result["league"][0]["anchor"])

    def test_inference_export_cannot_be_used_as_full_resume(self):
        saved = checkpoint()
        del saved["optimizer"]
        with self.assertRaisesRegex(ValueError, "full training checkpoint"):
            isolate_checkpoint(saved)

    def supervisor(self, fail=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            members, processes, commands = [], [], []
            for i, depth in enumerate([64, 256, 1024]):
                target = root / f"member-{i}"
                target.mkdir()
                members.append(dict(depth=depth, initial=str(target / "initial.pt")))
            class Process:
                def __init__(self, command, **kwargs):
                    self.pid = 90000 + len(processes)
                    self.returncode = 1 if fail else None
                    processes.append(self)
                    commands.append((command, kwargs))
                def poll(self):
                    return self.returncode
            ticks = [0.]
            def monotonic():
                ticks[0] += .25
                return ticks[0]
            with patch("tavern_rl.independent.subprocess.Popen", Process), \
                 patch("tavern_rl.independent.time.monotonic", monotonic), \
                 patch("tavern_rl.independent.time.sleep"), \
                 patch("tavern_rl.independent.stop_processes") as stop, patch("builtins.print"):
                if fail:
                    with self.assertRaisesRegex(RuntimeError, "exited"):
                        supervise(root, members, .001, 3, "cuda")
                else:
                    supervise(root, members, .001, 3, "cuda")
                stop.assert_called_once_with(processes)
            state = json.loads((root / "status.json").read_text())
            self.assertEqual(state["stage"], "failed" if fail else "time_limit")
            self.assertTrue(all(not m["running"] for m in state["members"]))
            self.assertEqual(len(commands), 3)
            for (command, kwargs), member in zip(commands, members):
                self.assertIn("tavern_rl.train", command)
                self.assertNotIn("mix_league", command)
                self.assertEqual(command[command.index("--resume") + 1], member["initial"])
                self.assertTrue(kwargs["start_new_session"])
                self.assertIn(str(Path(member["initial"]).parent / "training"), command)

    def test_three_isolated_processes_share_deadline_without_exchanges(self):
        self.supervisor()

    def test_child_failure_stops_remaining_process_groups(self):
        self.supervisor(fail=True)


if __name__ == "__main__":
    unittest.main()
