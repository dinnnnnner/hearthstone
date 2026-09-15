import copy
import json
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tavern_rl.codex_video_client import CodexVideoClient
from tavern_rl.video_extract import SCHEMA, digest, make_chunks, prepare_frames, run, select_events, validate_schema
from tavern_rl.video_dataset import candidate_actions, name_index


def fixture():
    state = dict(frame=0, stable=True, hero_name=None, hero_power_name=None,
                 turn=2, tier=1, gold=4, board=[], shop=[], spellShop=[], hand=[],
                 unknown_fields=["hero_name", "hero_power_name", "board", "shop", "hand"])
    event = dict(before_frame=0, after_frame=1, type="upgrade", source_slot=None,
                 target_zone=None, target_slot=None, position=None, card_name=None,
                 confidence=.98, exactly_one_action=True, continuous=True,
                 evidence="Tier indicator changed from 1 to 2 and gold decreased")
    frames = [dict(path=f"{i}.jpg", source_time=float(i)) for i in range(4)]
    return dict(states=[state], events=[event], notes=[]), frames


class VideoExtractTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_durable_resume_keeps_prior_rows_and_obeys_new_call_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "test.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
                            "color=c=red:s=320x180:r=10:d=2", "-c:v", "mpeg4", str(video)], check=True)
            args = SimpleNamespace(video=str(video), out=str(root / "out"), source_url="test",
                source_offset=0, start=0, duration=2, fps=2, width=320, patch="unknown",
                prepare_only=False, frames_per_chunk=2, codex_bin=None, timeout=1,
                model="gpt-5.6-luna", max_chunks=1, retries=0, min_confidence=.9,
                action_meta=None, catalog=None)
            with patch("tavern_rl.video_extract.CodexVideoClient") as provider, \
                 patch("tavern_rl.video_extract.find_codex", return_value="unused"), \
                 patch("builtins.print"):
                client = provider.return_value.__enter__.return_value
                client.initialize.return_value = {"server": {"userAgent": "test/1"}}
                client.annotate.return_value = {"data": fixture()[0], "text": "synthetic fixture"}
                for expected in [1, 2, 3, 3]:
                    run(args)
                    report = json.loads((root / "out/report.json").read_text())
                    rows = (root / "out/demonstrations.jsonl").read_text().splitlines()
                    self.assertEqual(len(rows), expected)
                    self.assertEqual(report["completed_chunks"], expected)
                    self.assertEqual(client.annotate.call_count, expected)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_frame_pts_source_offset_and_cached_file_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "test.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
                            "color=c=red:s=320x180:r=10:d=2", "-c:v", "mpeg4", str(video)], check=True)
            out = root / "out"
            out.mkdir()
            args = SimpleNamespace(video=str(video), source_url="test", source_offset=600,
                start=.3, duration=1, fps=2, width=320, patch="unknown")
            manifest = prepare_frames(args, out)
            self.assertEqual([round(f["source_time"], 3) for f in manifest["frames"]], [600.3, 600.8])
            first = Path(manifest["frames"][0]["path"])
            first.write_bytes(b"corrupt")
            restored = prepare_frames(args, out)
            self.assertEqual(restored, manifest)
            args.fps = 4
            with self.assertRaisesRegex(ValueError, "different video/frame settings"):
                prepare_frames(args, out)

    def test_unknown_targets_remain_partial_and_known_shop_target_maps_correctly(self):
        data, _ = fixture()
        event = data["events"][0]
        event.update(type="cast", source_slot=2)
        actions = [dict(type="cast", source=2, target=i, position=0) for i in range(41)]
        self.assertEqual(len(candidate_actions(event, actions)), 41)
        event.update(target_zone="shop", target_slot=3)
        self.assertEqual(candidate_actions(event, actions), [11])
        event.update(target_slot=16)
        self.assertEqual(candidate_actions(event, actions), [])
        event.update(target_slot=None)
        self.assertEqual(candidate_actions(event, actions), [0, *range(8, 24)])

    def test_names_with_multiple_ids_are_not_arbitrarily_resolved(self):
        index = name_index([dict(id="a", name="牌"), dict(id="b", name="牌")])
        self.assertEqual(index["牌"], ["a", "b"])

    def test_pre_action_state_and_evidence_are_separate(self):
        data, frames = fixture()
        good, bad = select_events(data, frames, .9)
        self.assertEqual(len(good), 1)
        self.assertFalse(bad)
        self.assertEqual(good[0]["observation"]["gold"], 4)
        self.assertIsNone(good[0]["observation"]["hero_name"])
        self.assertEqual(good[0]["observation_frame"]["source_time"], 0)
        self.assertEqual(good[0]["evidence_after_frame"]["source_time"], 1)
        self.assertFalse(good[0]["ppo_ready"])

    def test_reject_cut_multi_action_uncertainty_and_future_state(self):
        for key, value in [("continuous", False), ("exactly_one_action", False),
                           ("confidence", .7), ("type", "unknown"), ("after_frame", 0),
                           ("before_frame", 2), ("after_frame", 999), ("source_slot", -1),
                           ("source_slot", 99), ("target_slot", 99), ("position", 8)]:
            data, frames = fixture()
            data["events"][0][key] = value
            good, bad = select_events(data, frames, .9)
            self.assertFalse(good, (key, value))
            self.assertEqual(len(bad), 1)

    def test_overlapping_actions_rejected_instead_of_hallucinated_states(self):
        data, frames = fixture()
        data["events"].append(copy.deepcopy(data["events"][0]))
        data["events"][1]["after_frame"] = 2
        good, bad = select_events(data, frames, .9)
        self.assertFalse(good)
        self.assertEqual(len(bad), 2)

    def test_chunks_share_frame_but_not_intervals(self):
        chunks = make_chunks(list(range(35)), 16)
        self.assertEqual(chunks, [list(range(16)), list(range(15, 31)), list(range(30, 35))])
        self.assertFalse(make_chunks([0], 16))

    def test_schema_fails_on_extra_fields_nan_and_boolean_index(self):
        for mutation in [lambda d: d.update(hidden_pool=[]),
                         lambda d: d["events"][0].update(confidence=float("nan")),
                         lambda d: d["states"][0].update(frame=True)]:
            data, _ = fixture()
            mutation(data)
            with self.assertRaises(ValueError):
                validate_schema(data, SCHEMA)

    def test_cache_identity_includes_model_prompt_and_frames(self):
        config = dict(model="gpt-5.6-luna", effort="max", prompt="v1", frames=["a"])
        for key, value in [("model", "other"), ("prompt", "v2"), ("frames", ["b"])]:
            self.assertNotEqual(digest(config), digest({**config, key: value}))

    def test_rpc_buffers_notifications_before_request_response(self):
        client = CodexVideoClient.__new__(CodexVideoClient)
        client.sequence, client.pending, client.timeout = 0, [], 1
        client.messages = queue.Queue()
        sent = []
        client.send = sent.append
        client.messages.put({"method": "turn/completed", "params": {}})
        client.messages.put({"id": 1, "result": {"ok": True}})
        self.assertEqual(client.request("turn/start", {}), {"ok": True})
        self.assertEqual(client.pending[0]["method"], "turn/completed")
        self.assertEqual(sent[0]["id"], 1)

    def test_rpc_timeout_and_unexpected_tool_requests(self):
        client = CodexVideoClient.__new__(CodexVideoClient)
        client.messages = queue.Queue()
        client.send = lambda _: None
        with self.assertRaises(TimeoutError):
            client.receive(time.monotonic() - 1)
        client.messages.put({"id": 7, "method": "item/tool/call"})
        with self.assertRaisesRegex(RuntimeError, "Unexpected server request"):
            client.receive(time.monotonic() + 1)


if __name__ == "__main__":
    unittest.main()
