"""Stream local image motion screening. Motion is NOT an action or phase label."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import time

PLANNER_VERSION = 2
SIGNATURE_SIZE = (160, 128)
# Fractions of the original frame, for the downloaded Kimmy 1080p broadcast only.
LAYOUTS = {"full": None, "kimmy": (300 / 1920, 80 / 1080, 1200 / 1920, 980 / 1080)}
REGIONS = {
    "full": {"frame": (0, 0, 1, 1)},
    "kimmy": {"shop": (.10, .21, .88, .24), "board": (.08, .43, .89, .23),
              "hand": (.18, .78, .65, .22), "gold": (.75, .91, .12, .08),
              "upgrade": (.365, .05, .075, .16), "tier": (.46, .12, .04, .07),
              "refresh": (.64, .05, .07, .16), "freeze": (.74, .015, .075, .13)},
}


def crop_filter(layout):
    rect = LAYOUTS[layout]
    if rect is None:
        return ""
    x, y, w, h = rect
    return (f"crop=trunc(iw*{w}/2)*2:trunc(ih*{h}/2)*2:"
            f"trunc(iw*{x}/2)*2:trunc(ih*{y}/2)*2,")


def write_json(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


def signatures(frames):
    """Decode the numbered extraction sequence once, stream one tiny gray frame at a time."""
    if not frames:
        return
    first = Path(frames[0]["path"])
    pattern = first.parent / "frame-%06d.jpg"
    for i, frame in enumerate(frames, 1):
        if Path(frame["path"]) != first.parent / f"frame-{i:06d}.jpg":
            raise ValueError("Motion planner requires the complete numbered frame sequence")
    w, h = SIGNATURE_SIZE
    with subprocess.Popen(["ffmpeg", "-nostdin", "-loglevel", "error", "-threads", "1",
            "-i", str(pattern), "-vf", f"scale={w}:{h}", "-threads", "1",
            "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        try:
            for _ in frames:
                block = process.stdout.read(w * h)
                if len(block) != w * h:
                    raise ValueError("Incomplete grayscale frame stream")
                yield block
            if process.stdout.read(1) or process.wait() != 0:
                raise ValueError("Unexpected grayscale stream length or decoder failure")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)


def region_indices(layout):
    w, h = SIGNATURE_SIZE
    return {name: [y * w + x for y in range(int(ry * h), int((ry + rh) * h))
                   for x in range(int(rx * w), int((rx + rw) * w))]
            for name, (rx, ry, rw, rh) in REGIONS[layout].items()}


def score_changes(sequence, layout):
    regions = region_indices(layout)
    previous = None
    scores = []
    for current in sequence:
        scores.append({name: (sum(abs(current[j] - previous[j]) >= 24 for j in indices) / len(indices)
                              if previous is not None else 0.)
                       for name, indices in regions.items()})
        previous = current
    return scores


def choose_windows(scores, size, threshold, audit_every=0):
    """Prune uniform windows, retaining continuous samples around changed edges.

    Each changed edge i means frames i-1 -> i. Never merge distant windows or
    invent an intermediate state; one neighbor on each side is retained.
    """
    windows, skipped = [], 0
    for start in range(0, len(scores) - 1, size - 1):
        end = min(start + size - 1, len(scores) - 1)
        edges = [i for i in range(start + 1, end + 1) if max(scores[i].values()) >= threshold]
        if edges:
            windows.append({"first": max(start, min(edges) - 2),
                            "last": min(end, max(edges) + 1), "reason": "motion_candidate"})
        else:
            skipped += 1
            if audit_every and skipped % audit_every == 0:
                windows.append({"first": start, "last": end, "reason": "quiet_audit"})
    return windows


def plan_frames(frames, size, out, *, selection="uniform", layout="full", threshold=.06, audit_every=0):
    started = time.monotonic()
    config = {"version": PLANNER_VERSION, "selection": selection, "layout": layout,
              "threshold": threshold, "audit_every": audit_every, "frames_per_chunk": size,
              "frame_hashes": [f["sha256"] for f in frames]}
    cache_key = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
    cache = out / f"motion-{cache_key}.json"
    if selection == "changes":
        if cache.exists():
            scores = json.loads(cache.read_text())["scores"]
        else:
            scores = score_changes(signatures(frames), layout)
            write_json(cache, {"config": config, "scores": scores})
        windows = choose_windows(scores, size, threshold, audit_every)
    else:
        windows = [{"first": i, "last": min(i + size - 1, len(frames) - 1), "reason": "uniform"}
                   for i in range(0, len(frames) - 1, size - 1)]
    chunks = [frames[w["first"]:w["last"] + 1] for w in windows]
    baseline = [frames[i:i + size] for i in range(0, len(frames) - 1, size - 1)]
    baseline_inputs = sum(map(len, baseline))
    selected_inputs = sum(map(len, chunks))
    report = {"config": {k: v for k, v in config.items() if k != "frame_hashes"},
        "sampled_frames": len(frames), "baseline_requests": len(baseline),
        "planned_requests": len(chunks), "baseline_image_inputs": baseline_inputs,
        "planned_image_inputs": selected_inputs,
        "image_input_reduction": 1 - selected_inputs / baseline_inputs if baseline_inputs else 0,
        "planning_seconds": time.monotonic() - started,
        "windows": [{**w, "start_time": frames[w["first"]]["source_time"],
                      "end_time": frames[w["last"]]["source_time"]} for w in windows],
        "action_recall_measured": False, "phase_classification": False}
    write_json(out / "plan.json", report)
    return chunks, report
