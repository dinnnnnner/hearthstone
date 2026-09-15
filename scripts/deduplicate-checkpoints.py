"""Reclaim byte-identical frozen checkpoint copies while preserving every file path.

Use only on stopped training directories. Trainers must publish checkpoints by
atomic replacement, as tavern_rl.train.atomic_checkpoint does, never in-place writes.
"""
import argparse
from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat


def signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    by_size = defaultdict(list)
    for path in root.rglob("*.pt"):
        if path.is_symlink() or not path.is_file():
            continue
        info = path.stat()
        if info.st_size >= 1024 * 1024:
            by_size[(info.st_dev, info.st_size, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))].append(path)
    groups = []
    for paths in by_size.values():
        if len({(p.stat().st_dev, p.stat().st_ino) for p in paths}) < 2:
            continue
        hashes, inode_hashes = defaultdict(list), {}
        for path in sorted(paths):
            info = path.stat()
            inode = (info.st_dev, info.st_ino)
            if inode not in inode_hashes:
                hasher = hashlib.sha256()
                with path.open("rb") as source:
                    for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
                        hasher.update(block)
                if signature(path.stat()) != signature(info):
                    raise RuntimeError(f"Checkpoint changed while hashing: {path}")
                inode_hashes[inode] = hasher.hexdigest()
            hashes[inode_hashes[inode]].append((path, info))
        for digest, matches in hashes.items():
            if len({(s.st_dev, s.st_ino) for _, s in matches}) > 1:
                groups.append((digest, matches))
    report = {"root": str(root), "apply": args.apply, "free_before": shutil.disk_usage(root).free, "groups": []}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    def save():
        tmp = args.report.with_suffix(".tmp")
        tmp.write_text(json.dumps(report, indent=2) + "\n")
        tmp.replace(args.report)
    save()
    for digest, matches in groups:
        canonical, original = matches[0]
        row = {"sha256": digest, "bytes": original.st_size, "canonical": str(canonical), "linked": []}
        report["groups"].append(row)
        for path, info in matches[1:]:
            if (info.st_dev, info.st_ino) == (original.st_dev, original.st_ino):
                continue
            if args.apply:
                if signature(path.stat()) != signature(info) or signature(canonical.stat()) != signature(original):
                    raise RuntimeError("Checkpoint changed after hashing; refusing replacement")
                temporary = path.with_name(path.name + f".dedup-{os.getpid()}")
                try:
                    os.link(canonical, temporary)
                    os.replace(temporary, path)
                finally:
                    temporary.unlink(missing_ok=True)
            row["linked"].append(str(path))
            save()
    report["free_after"] = shutil.disk_usage(root).free
    report["reclaimed_bytes"] = report["free_after"] - report["free_before"]
    save()
    print(json.dumps({k: v for k, v in report.items() if k != "groups"} |
                     {"duplicate_groups": len(groups), "paths_linked": sum(len(g["linked"]) for g in report["groups"])}))


if __name__ == "__main__":
    main()
