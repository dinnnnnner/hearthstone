"""Package the standalone simulator and Python trainer; no game assets or live data."""
import hashlib
import json
from pathlib import Path
import tarfile
import io

ROOT = Path(__file__).resolve().parents[1]
files = [ROOT / path for path in ["rl-dist/bridge.cjs", "rl-dist/build.json", "rl/README.md",
    "rl/requirements.txt", "rl/run.sh", "docs/rules-coverage.json", "docs/rl-roadmap.md"]]
files += sorted((ROOT / "rl/python").rglob("*.py"))
files += sorted((ROOT / "rl/tests").rglob("*.py"))
validation = ROOT / "docs/rl-validation.json"
if validation.exists(): files.append(validation)
manifest = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}
archive = ROOT / "rl-dist/tavern-selfplay-v1.tar.gz"
with tarfile.open(archive, "w:gz") as package:
    for path in files:
        package.add(path, arcname=f"tavern-selfplay/{path.relative_to(ROOT)}", recursive=False)
    data = json.dumps(manifest, indent=2).encode()
    entry = tarfile.TarInfo("tavern-selfplay/checksums.json"); entry.size = len(data)
    package.addfile(entry, io.BytesIO(data))
print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size,
                  "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}, indent=2))
