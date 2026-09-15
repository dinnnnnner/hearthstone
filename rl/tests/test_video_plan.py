import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tavern_rl.video_extract import normalize_actions, prepare_frames, run, select_events
from test_video_extract import fixture
from tavern_rl.video_plan import SIGNATURE_SIZE, choose_windows, plan_frames, score_changes


class VideoPlanTests(unittest.TestCase):
    def test_actions_mode_preserves_unknown_state_and_rejects_unstable_before(self):
        data, frames = fixture()
        actions = {"events": [{**data["events"][0], "before_stable": True}], "notes": []}
        normalized = normalize_actions(actions)
        good, bad = select_events(normalized, frames, .9)
        self.assertEqual(len(good), 1)
        self.assertFalse(bad)
        self.assertIsNone(good[0]["observation"]["gold"])
        self.assertEqual(good[0]["observation"]["unknown_fields"],
                         ["all_state_fields_unobserved_actions_only"])
        actions["events"][0]["before_stable"] = False
        self.assertFalse(select_events(normalize_actions(actions), frames, .9)[0])

    def test_quiet_windows_are_skipped_and_can_be_audited(self):
        scores = [{"frame": 0.} for _ in range(10)]
        self.assertEqual(choose_windows(scores, 4, .06), [])
        self.assertEqual(choose_windows(scores, 4, .06, 2),
                         [{"first": 3, "last": 6, "reason": "quiet_audit"}])

    def test_changed_edges_keep_before_after_and_continuous_context(self):
        scores = [{"frame": 0.} for _ in range(16)]
        scores[7] = {"frame": .2}
        windows = choose_windows(scores, 16, .06)
        self.assertEqual(windows, [{"first": 5, "last": 8, "reason": "motion_candidate"}])
        scores[11] = {"frame": .2}
        self.assertEqual(choose_windows(scores, 16, .06)[0]["last"], 12)

    def test_actions_at_chunk_boundaries_are_not_lost_or_counted_twice(self):
        scores = [{"frame": 0.} for _ in range(10)]
        for edge in [3, 4, 6, 7]:
            scores[edge] = {"frame": .2}
        windows = choose_windows(scores, 4, .06)
        for edge in [3, 4, 6, 7]:
            self.assertEqual(sum(w["first"] < edge <= w["last"] for w in windows), 1)

    def test_small_pixel_noise_is_ignored_but_roi_change_is_retained(self):
        w, h = SIGNATURE_SIZE
        dark = bytes([0]) * (w * h)
        noise = bytes([10]) * (w * h)
        bright = bytes([255]) * (w * h)
        scores = score_changes([dark, noise, bright], "kimmy")
        self.assertTrue(all(v == 0 for v in scores[1].values()))
        self.assertTrue(all(v == 1 for v in scores[2].values()))

    def test_animation_outside_watched_regions_does_not_trigger_kimmy(self):
        w, h = SIGNATURE_SIZE
        before = bytes(w * h)
        after = bytearray(before)
        # Top-left background outside the shop/board/hand/gold/control regions.
        after[0:10] = bytes([255]) * 10
        self.assertTrue(all(v == 0 for v in score_changes([before, after], "kimmy")[1].values()))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_static_video_never_starts_model_and_motion_cache_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "static.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
                            "color=c=red:s=320x180:r=10:d=2", "-c:v", "mpeg4", str(video)], check=True)
            args = SimpleNamespace(video=str(video), out=str(root / "out"), source_url="test",
                source_offset=0, start=0, duration=2, fps=2, width=320, patch="unknown",
                layout="full", selection="changes", change_threshold=.06, audit_every=0,
                frames_per_chunk=3, prepare_only=False, model="gpt-5.6-luna", action_meta=None)
            with patch("tavern_rl.video_extract.find_codex") as binary:
                run(args)
                binary.assert_not_called()
            out = root / "out"
            manifest = json.loads((out / "frames.json").read_text())
            with patch("tavern_rl.video_plan.signatures", side_effect=AssertionError("Decoded cache again")):
                chunks, _ = plan_frames(manifest["frames"], 3, out, selection="changes")
                self.assertFalse(chunks)
            self.assertEqual(json.loads((out / "report.json").read_text())["attempted_new_chunks"], 0)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_crop_preserves_source_timestamp_and_records_partial_view(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / "clip.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
                            "color=c=red:s=1920x1080:r=2:d=1", "-c:v", "mpeg4", str(video)], check=True)
            out = root / "out"
            out.mkdir()
            args = SimpleNamespace(video=str(video), source_url="test", source_offset=600,
                start=0, duration=1, fps=2, width=1200, patch="unknown", layout="kimmy")
            manifest = prepare_frames(args, out)
            self.assertEqual(manifest["frames"][1]["source_time"], 600.5)
            self.assertTrue(manifest["frames"][0]["view"]["partial_view"])
            probe = subprocess.check_output(["ffprobe", "-v", "error", "-show_entries",
                "stream=width,height", "-of", "json", manifest["frames"][0]["path"]], text=True)
            self.assertEqual(json.loads(probe)["streams"][0], {"width": 1200, "height": 980})


if __name__ == "__main__":
    unittest.main()
