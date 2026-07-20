#!/usr/bin/env python3
"""Validate the reproducible EasyCris RNA-seq runtime contract."""

from __future__ import annotations

import argparse
import inspect
import re
import sys
from importlib import metadata
from pathlib import Path


EXPECTED_BASE_VERSIONS = {
    "numpy": "1.26.4",
}


def normalize_package_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def requirement_versions(requirements_path: Path) -> dict[str, str]:
    versions = {}
    for raw_line in requirements_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)\s*==\s*([^\s]+)", line)
        if match is None:
            raise RuntimeError(f"RNA overlay requirement must use an exact pin: {line}")
        versions[normalize_package_name(match.group(1))] = match.group(2)
    return versions


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dependencies-root",
        type=Path,
        default=repo_root / "python_embedded" / "python_dependencies",
    )
    return parser.parse_args()


def distribution_versions(dependencies_root: Path) -> dict[str, set[str]]:
    versions: dict[str, set[str]] = {}
    for distribution in metadata.distributions(path=[str(dependencies_root)]):
        package_name = distribution.metadata.get("Name")
        if package_name:
            versions.setdefault(normalize_package_name(package_name), set()).add(
                distribution.version
            )
    return versions


def main() -> int:
    args = parse_args()
    dependencies_root = args.dependencies_root.resolve()
    if not dependencies_root.is_dir():
        raise RuntimeError(f"RNA dependency directory is missing: {dependencies_root}")

    requirements_path = Path(__file__).resolve().parent.parent / "python_embedded" / "requirements-rnaseq.txt"
    expected_versions = requirement_versions(requirements_path)
    expected_versions.update(EXPECTED_BASE_VERSIONS)
    versions = distribution_versions(dependencies_root)
    mismatches = []
    for package_name, expected in expected_versions.items():
        actual = versions.get(package_name, set())
        if actual != {expected}:
            found = ", ".join(sorted(actual)) if actual else "missing"
            mismatches.append(f"{package_name}: expected only {expected}, found {found}")
    if mismatches:
        raise RuntimeError("RNA dependency contract mismatch: " + "; ".join(mismatches))

    sys.path.insert(0, str(dependencies_root))
    from formulaic_contrasts import FormulaicContrasts  # noqa: F401
    from pydeseq2.dds import DeseqDataSet
    from pydeseq2.utils import locfit_predict, locfit_weighted, lowess_weighted  # noqa: F401

    parameters = inspect.signature(DeseqDataSet.__init__).parameters
    required_parameters = {"design", "size_factors_fit_type"}
    missing_parameters = sorted(required_parameters.difference(parameters))
    if missing_parameters:
        raise RuntimeError(
            "PyDESeq2 constructor is missing required parameters: "
            + ", ".join(missing_parameters)
        )
    if not hasattr(DeseqDataSet, "_fit_local_dispersion_trend"):
        raise RuntimeError("PyDESeq2 local dispersion patch is missing")

    print(
        "rnaseq-runtime-ok "
        + " ".join(f"{name}={version}" for name, version in sorted(expected_versions.items()))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
