"""Package the standalone simulator and Python trainer; no game assets or live data."""
import hashlib
import json
from pathlib import Path
import tarfile
import io

ROOT = Path(__file__).resolve().parents[1]
files = [ROOT / path for path in ["rl-dist/bridge.cjs", "rl-dist/build.json", "rl/README.md",
    "rl/requirements.txt", "rl/run.sh", "rl/deep256.sh", "docs/rules-coverage.json", "docs/rl-roadmap.md", "docs/rl-server.md", "docs/rl-v3.md", "docs/rl-campaign.md", "docs/rl-public-scouting.md", "docs/rl-deep64.md", "docs/rl-deep256.md"]]
files += sorted((ROOT / "rl/python").rglob("*.py"))
files += [ROOT / "rl/deep1024.sh", ROOT / "docs/rl-deep1024.md"]
files += sorted((ROOT / "rl/tests").rglob("*.py"))
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
