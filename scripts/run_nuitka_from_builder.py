#!/usr/bin/env python3
"""Run builder-installed Nuitka while exposing embedded runtime dependencies."""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PYTHON_DEPENDENCIES_DIR = ROOT / "python_embedded" / "python_dependencies"
SETUPTOOLS_VENDOR_DIR = PYTHON_DEPENDENCIES_DIR / "setuptools" / "_vendor"


def _canonical_path(path_value: str) -> str:
    try:
        return str(Path(path_value).resolve()).casefold()
    except Exception:
        return str(Path(path_value)).casefold()


def main() -> int:
    if not PYTHON_DEPENDENCIES_DIR.exists():
        print(
            "[run-nuitka-builder] ERROR: runtime dependency folder missing: "
            f"{PYTHON_DEPENDENCIES_DIR}",
            file=sys.stderr,
        )
        return 1

    deps_path = str(PYTHON_DEPENDENCIES_DIR.resolve())
    deps_path_key = _canonical_path(deps_path)
    vendor_path = str(SETUPTOOLS_VENDOR_DIR.resolve())
    vendor_path_key = _canonical_path(vendor_path)

    # If PYTHONPATH injected vendored deps, remove that entry first so builder Nuitka wins.
    sys.path = [path_value for path_value in sys.path if _canonical_path(path_value) != deps_path_key]
    # Also remove setuptools private vendor path to avoid namespace-package collisions.
    sys.path = [path_value for path_value in sys.path if _canonical_path(path_value) != vendor_path_key]

    # Import Nuitka first so we bind to the builder environment package.
    from nuitka import __main__ as nuitka_main

    # Keep builder-side support libs (e.g. colorama used by Nuitka/tqdm) ahead of
    # vendored runtime deps to avoid Windows stderr flush crashes in wrapped streams.
    try:
        import colorama  # noqa: F401
    except Exception:
        pass

    if deps_path not in sys.path:
        sys.path.append(deps_path)
    sys.path = [path_value for path_value in sys.path if _canonical_path(path_value) != vendor_path_key]

    # If jaraco namespace was preloaded from setuptools/_vendor, force reload from vendored deps.
    for module_name in tuple(sys.modules):
        if module_name == "jaraco" or module_name.startswith("jaraco."):
            del sys.modules[module_name]

    # Forward all Nuitka CLI args.
    sys.argv = ["nuitka", *sys.argv[1:]]
    nuitka_main.main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
