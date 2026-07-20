#!/usr/bin/env python3
"""Apply the validated EasyCris patch to a stock PyDESeq2 0.5.3 install."""

from __future__ import annotations

import argparse
import hashlib
import shutil
from pathlib import Path


OFFICIAL_SOURCE_HASHES = {
    "__init__.py": "4a41e78c6df04539a1e2d4bbce5834e8a4944d24872a9dc05442cd250ea309aa",
    "__version__.py": "4e96d38f0879c0f18c42eb07f474d2d4037143fe56164068bdae58e4bd236462",
    "dds.py": "1a929f1f01723f95c102958f4507d50ae8ab53ca41a1ad19d9af479881851767",
    "default_inference.py": "561b79964d6c7458d29c001942937a372dab95a994af5450a40b847f9d8dc14d",
    "ds.py": "be8ddcff9ec3cba155d1717741be3e10beb92e9e764e8d401176b0b192925d0f",
    "grid_search.py": "4c1b6e832be75c25030c5eacc1e01a5c00ff34cf35d048355e868d80a957d7b7",
    "inference.py": "922ea3fdfe2a90d1ffe1745083c51403b3089e31680c881acdc8db9eaf56ba1f",
    "preprocessing.py": "3a18297b94780ef1f4d7c8d5f44d1a01d06af6cc10f022a18b3bd6e59278530a",
    "utils.py": "09b33d55ae44d26eddb5cd582a2c1bc0d0294967dc30b479e1144b787a69f538",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dependencies-root", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dependencies_root = args.dependencies_root.resolve()
    package_root = dependencies_root / "pydeseq2"
    dist_info = dependencies_root / "pydeseq2-0.5.3.dist-info"
    patch_root = Path(__file__).resolve().parent / "rnaseq_patches" / "pydeseq2_0_5_3"

    if not package_root.is_dir() or not dist_info.is_dir():
        raise RuntimeError("Stock PyDESeq2 0.5.3 must be installed before applying the patch")

    for relative_path, official_hash in OFFICIAL_SOURCE_HASHES.items():
        source = patch_root / relative_path
        target = package_root / relative_path
        if not source.is_file() or not target.is_file():
            raise RuntimeError(f"Missing PyDESeq2 patch input: {relative_path}")

        source_hash = sha256(source)
        target_hash = sha256(target)
        if target_hash == source_hash:
            continue
        if target_hash != official_hash:
            raise RuntimeError(
                f"Refusing to patch unexpected PyDESeq2 source {relative_path}: {target_hash}"
            )
        shutil.copy2(source, target)

    cache_root = package_root / "__pycache__"
    if cache_root.exists():
        shutil.rmtree(cache_root)

    print(f"rnaseq-pydeseq2-patch-ok root={package_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
