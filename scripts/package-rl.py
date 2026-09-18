"""Package the standalone simulator and Python trainer; no game assets or live data."""
import hashlib
import json
from pathlib import Path
import tarfile
import io

ROOT = Path(__file__).resolve().parents[1]
files = [ROOT / path for path in ["rl-dist/bridge.cjs", "rl-dist/build.json", "rl/README.md",
    "rl/requirements.txt", "rl/run.sh", "rl/deep256.sh", "docs/rules-coverage.json", "docs/rl-roadmap.md", "docs/rl-server.md", "docs/rl-v3.md", "docs/rl-campaign.md", "docs/rl-public-scouting.md", "docs/rl-deep64.md", "docs/rl-deep256.md"]]
files += [ROOT / "rl-dist/scene-evaluation.cjs", ROOT / "rl-dist/scene-evaluation.json", ROOT / "scripts/build-scene-evaluation.mjs"]
files += [ROOT / "rl-dist/basic-evaluation.cjs", ROOT / "scripts/build-basic-evaluation.mjs",
          ROOT / "rl/fixtures/basic-opening-cases.json", ROOT / "docs/rl-basic-feedback.md"]
files += sorted((ROOT / "rl/python").rglob("*.py"))
files += [ROOT / "rl/deep1024.sh", ROOT / "docs/rl-deep1024.md"]
files += [ROOT / "docs/rl-opponent-diversity.md"]
files += [ROOT / "docs/rl-population.md"]
files += [ROOT / "docs/rl-independent.md"]
files += [ROOT / "docs/rl-rollout-optimization.md"]
files += [ROOT / "docs/rl-maintenance.md"]
files += [ROOT / "docs/rl-recruit-search.md"]
if (ROOT / "rl-dist/recruit-search.cjs").exists():
    files += [ROOT / "rl-dist/recruit-search.cjs"]
if (ROOT / "rl-dist/stage-evaluation.cjs").exists():
    files += [ROOT / "rl-dist/stage-evaluation.cjs"]
files += [ROOT / "src/season/ai-hero-pool.json"]
files += [ROOT / "docs/rl-video-extraction.md"]
files += [ROOT / "docs/rl-video-extraction-validation-20260911.json"]
files += [ROOT / "docs/rl-video-speed-validation-20260912.json"]
for name in ["rl-deep64-diversity-20260911.json", "rl-diversity-gpu-validation-20260911.json", "rl-population-launch-20260911.json"]:
    record = ROOT / "docs" / name
    if record.exists(): files.append(record)
files += sorted((ROOT / "rl/tests").rglob("*.py"))
files += [ROOT / "scripts/enable-sampling-graphs.py", ROOT / "scripts/watch-fresh-imitation.py", ROOT / "scripts/control-imitation-stopping.py", ROOT / "scripts/benchmark-selective-precision.py"]
validation = ROOT / "docs/rl-validation.json"
if validation.exists(): files.append(validation)
server_validation = ROOT / "docs/rl-server-validation.json"
if server_validation.exists(): files.append(server_validation)
v3_validation = ROOT / "docs/rl-v3-validation.json"
if v3_validation.exists(): files.append(v3_validation)
deep_validation = ROOT / "docs/rl-deep64-validation.json"
if deep_validation.exists(): files.append(deep_validation)
deep256_validation = ROOT / "docs/rl-deep256-validation.json"
if deep256_validation.exists(): files.append(deep256_validation)
deep1024_validation = ROOT / "docs/rl-deep1024-validation.json"
if deep1024_validation.exists(): files.append(deep1024_validation)
# Include documentation linked from the package entry point. Keep dated records
# already selected above; the full deployment archive stays in the source repo.
files += [ROOT / "docs" / name for name in [
    "rl-fresh-selfplay.md", "rl-fresh-selfplay-validation-20260915.json", "rl-gold-planning.md", "rl-gold-planning-validation-20260915.json", "rl-gold-planning-12-validation-20260915.json", "ai-freeze-close-deployment-20260915.md", "ai-freeze-close-deployment-20260915.json", "ai-action-limits.md", "ai-action-limits-validation-20260915.json", "ai-action-limits-deployment-20260915.md", "ai-action-limits-deployment-20260915.json", "rl-network.md", "rl-training.md", "rl-card-value.md", "rl-action-value.md", "rl-scene-value.md", "rl-multi-horizon.md", "rl-first-place-bonus.md", "rl-unused-gold-penalty.md",
    "rl-blackwell-20260915.md", "tavern-operations.md", "rl-human-demonstrations.md", "rl-fresh-imitation-20260915.json",
    "neural-serving.md",
]]
files += [ROOT / "rl-dist/ledger-evaluation.cjs", ROOT / "scripts/build-ledger-evaluation.mjs", ROOT / "docs/rl-ledger-model.md"]
files += [ROOT / "docs/rl-moe-model.md", ROOT / "docs/rl-moe-validation-20260917.json"]
files = sorted(set(files))
manifest = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
archive = ROOT / "rl-dist/tavern-selfplay-v3.tar.gz"
with tarfile.open(archive, "w:gz") as package:
    for path in files:
        package.add(path, arcname=f"tavern-selfplay-v3/{path.relative_to(ROOT)}", recursive=False)
    data = json.dumps(manifest, indent=2).encode()
    entry = tarfile.TarInfo("tavern-selfplay-v3/checksums.json"); entry.size = len(data)
    package.addfile(entry, io.BytesIO(data))
print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size,
                  "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}, indent=2))
