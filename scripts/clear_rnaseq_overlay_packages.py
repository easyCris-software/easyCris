#!/usr/bin/env python3
"""Remove existing RNA overlay distributions before installing pinned versions."""

from __future__ import annotations

import argparse
import re
from importlib import metadata
from pathlib import Path


def normalize_package_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def requirement_names(requirements_path: Path) -> set[str]:
    names = set()
    for raw_line in requirements_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"([A-Za-z0-9_.-]+)\s*==", line)
        if match is None:
            raise RuntimeError(f"RNA overlay requirement must use an exact pin: {line}")
        names.add(normalize_package_name(match.group(1)))
    return names


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dependencies-root", type=Path, required=True)
    parser.add_argument("--requirements", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dependencies_root = args.dependencies_root.resolve()
    requirements_path = args.requirements.resolve()
    selected_names = requirement_names(requirements_path)
    removed_names = set()
    removable_parents: set[Path] = set()

    for distribution in list(metadata.distributions(path=[str(dependencies_root)])):
        package_name = distribution.metadata.get("Name")
        if not package_name or normalize_package_name(package_name) not in selected_names:
            continue

        removed_names.add(f"{package_name}=={distribution.version}")
        for relative_path in distribution.files or ():
            target = (dependencies_root / relative_path).resolve()
            try:
                target.relative_to(dependencies_root)
            except ValueError:
                continue
            if target.is_file() or target.is_symlink():
                target.unlink()
                removable_parents.update(target.parents)

    for parent in sorted(removable_parents, key=lambda path: len(path.parts), reverse=True):
        if parent == dependencies_root:
            continue
        try:
            parent.rmdir()
        except OSError:
            pass

    print("rnaseq-overlay-clear-ok removed=" + ",".join(sorted(removed_names)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
