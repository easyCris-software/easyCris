#!/usr/bin/env python3
"""Provision the reproducible Darwin Nuitka builder and runtime dependency set."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path
from typing import Callable, Iterable


ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = ROOT / "python_embedded"
REQUIREMENTS = RUNTIME_DIR / "requirements-macos.txt"
RNA_REQUIREMENTS = RUNTIME_DIR / "requirements-rnaseq.txt"
DEPENDENCIES_DIR = RUNTIME_DIR / "python_dependencies"
WHEELHOUSE_ROOT = ROOT / "_tmp" / "python-wheelhouse"
BUILD_VENV = ROOT / ".venv-nuitka-build"
BUILDER_TOOLS = (
    "pip==26.2",
    "setuptools==83.0.0",
    "wheel==0.47.0",
    "nuitka==2.8.10",
    "setuptools-rust==1.13.0",
    "toml==0.10.2",
)
GSEAPY_PIN = "gseapy==1.1.11"
# The locked GSEApy source metadata declares this runtime dependency. It is
# intentionally fetched as a binary wheel on Intel; only GSEApy itself uses a
# source-build exception.
GSEAPY_RUNTIME_BINARY_REQUIREMENTS = ("requests",)


def parse_pinned_requirements(path: Path) -> dict[str, str]:
    """Return normalized exact pins, rejecting loose requirements."""
    requirements: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "==" not in line or any(token in line for token in ("/", "\\\\", ";", "@")):
            raise RuntimeError(f"Requirement must be a portable exact pin: {line}")
        name, version = (part.strip() for part in line.split("==", 1))
        if not name or not version:
            raise RuntimeError(f"Requirement must be a portable exact pin: {line}")
        normalized = name.lower().replace("_", "-").replace(".", "-")
        if normalized in requirements:
            raise RuntimeError(f"Duplicate requirement pin: {name}")
        requirements[normalized] = version
    return requirements


def validate_host(
    system_name: str | None = None,
    version_info: tuple[int, int] | None = None,
    machine_name: str | None = None,
) -> str:
    """Ensure this command provisions only a native, supported macOS runtime."""
    system_name = system_name or platform.system()
    version_info = version_info or sys.version_info[:2]
    machine_name = machine_name or platform.machine()
    if system_name != "Darwin":
        raise RuntimeError(f"Darwin is required; detected {system_name}")
    if tuple(version_info[:2]) != (3, 12):
        raise RuntimeError(f"Python 3.12 is required; detected {version_info[0]}.{version_info[1]}")
    if machine_name not in {"x86_64", "arm64"}:
        raise RuntimeError(f"Only native x86_64 or arm64 is supported; detected {machine_name}")
    return machine_name


def run_checked(command: list[str], **kwargs) -> str:
    """Run a checked command without ever silently continuing on failed provisioning."""
    completed = subprocess.run(command, check=True, text=True, capture_output=True, **kwargs)
    return completed.stdout


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def archive_hashes(wheelhouse: Path) -> dict[str, str]:
    return {
        archive.name: sha256(archive)
        for archive in sorted(wheelhouse.iterdir())
        if archive.is_file() and archive.name.endswith((".whl", ".tar.gz", ".zip"))
    }


def builder_python(root: Path) -> Path:
    return root / ".venv-nuitka-build" / "bin" / "python"


def _run(runner: Callable[..., str], command: Iterable[str], root: Path, **kwargs) -> str:
    return runner(list(command), cwd=str(root), **kwargs)


def write_binary_requirements(requirements: Path, destination: Path) -> None:
    """Write the Intel binary-only input, excluding only the locked gseapy pin."""
    lines = requirements.read_text(encoding="utf-8").splitlines()
    kept = [line for line in lines if line.strip() != GSEAPY_PIN]
    if len(lines) - len(kept) != 1:
        raise RuntimeError(f"Expected exactly one {GSEAPY_PIN} line in {requirements}")
    destination.write_text("\n".join(kept) + "\n", encoding="utf-8")


def validate_x86_gseapy_wheel(wheel: Path, runner: Callable[..., str] = run_checked) -> None:
    """Reject an Intel source build whose tag, Mach-O architecture, or floor drifts."""
    expected_name = "gseapy-1.1.11-cp312-cp312-macosx_13_0_x86_64.whl"
    if wheel.name != expected_name:
        raise RuntimeError(f"Unexpected Intel gseapy wheel tag: {wheel.name}")
    with tempfile.TemporaryDirectory(prefix="easycris-gseapy-wheel-") as temporary:
        unpacked = Path(temporary)
        with zipfile.ZipFile(wheel) as archive:
            archive.extractall(unpacked)
        extensions = sorted(unpacked.rglob("*.so"))
        if not extensions:
            raise RuntimeError("Intel gseapy wheel does not contain a native extension")
        for extension in extensions:
            file_output = _run(runner, ["file", str(extension)], ROOT)
            if "x86_64" not in file_output or "arm64" in file_output:
                raise RuntimeError(f"Intel gseapy extension is not x86_64: {file_output.strip()}")
            otool_output = _run(runner, ["otool", "-l", str(extension)], ROOT)
            match = re.search(r"(?:minos|version)\s+(\d+)(?:\.(\d+))?", otool_output)
            if not match:
                raise RuntimeError(f"Unable to determine Intel gseapy minimum macOS version: {otool_output.strip()}")
            version = (int(match.group(1)), int(match.group(2) or 0))
            if version > (13, 0):
                raise RuntimeError(f"Intel gseapy minimum macOS version is newer than 13.0: {version[0]}.{version[1]}")


def kaleido_macho_files(dependencies_root: Path, runner: Callable[..., str] = run_checked) -> list[str]:
    """Return only native Kaleido payloads that later signing must process inside-out."""
    executable_root = dependencies_root / "kaleido" / "executable"
    if not executable_root.is_dir():
        return []
    native_files = []
    for candidate in executable_root.rglob("*"):
        if not candidate.is_file() or not candidate.stat().st_mode & 0o111:
            continue
        inspected = _run(runner, ["file", str(candidate)], ROOT)
        if "Mach-O" in inspected:
            native_files.append(str(candidate.relative_to(dependencies_root)))
    return native_files


def write_runtime_manifest(
    *, root: Path, arch: str, builder: Path, wheelhouse: Path, runner: Callable[..., str]
) -> None:
    dependencies_root = root / "python_embedded" / "python_dependencies"
    manifest = {
        "schema_version": 1,
        "python": _run(runner, [str(builder), "--version"], root).strip(),
        "pip": _run(runner, [str(builder), "-m", "pip", "--version"], root).strip(),
        "architecture": arch,
        "pip_freeze": _run(runner, [str(builder), "-m", "pip", "freeze", "--path", str(dependencies_root)], root).splitlines(),
        "wheel_archive_sha256": archive_hashes(wheelhouse),
        "kaleido_executables": kaleido_macho_files(dependencies_root, runner),
    }
    (dependencies_root / "easycris_runtime_manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def bootstrap(
    *,
    root: Path = ROOT,
    runner: Callable[..., str] = run_checked,
    system_name: str | None = None,
    version_info: tuple[int, int] | None = None,
    machine_name: str | None = None,
    create_venv: Callable[[Path], None] | None = None,
    write_manifest: bool = True,
    hash_archives: Callable[[Path], dict[str, str]] = archive_hashes,
) -> Path:
    """Create an isolated builder plus the wheel-only target runtime."""
    arch = validate_host(system_name, version_info, machine_name)
    runtime_dir = root / "python_embedded"
    requirements = runtime_dir / "requirements-macos.txt"
    rnaseq_requirements = runtime_dir / "requirements-rnaseq.txt"
    dependencies = runtime_dir / "python_dependencies"
    wheelhouse = root / "_tmp" / "python-wheelhouse" / arch
    build_venv = root / ".venv-nuitka-build"
    builder = build_venv / "bin" / "python"
    for required in (requirements, rnaseq_requirements):
        if not required.is_file():
            raise RuntimeError(f"Missing requirements file: {required}")
    parse_pinned_requirements(requirements)
    parse_pinned_requirements(rnaseq_requirements)
    if not builder.exists():
        (create_venv or (lambda path: venv.EnvBuilder(with_pip=True).create(path)))(build_venv)
    if not builder.exists():
        raise RuntimeError(f"Nuitka builder Python not found: {builder}")
    if wheelhouse.exists():
        shutil.rmtree(wheelhouse)
    if dependencies.exists():
        shutil.rmtree(dependencies)
    wheelhouse.mkdir(parents=True)
    dependencies.mkdir(parents=True)
    _run(runner, [str(builder), "-m", "pip", "install", "--upgrade", *BUILDER_TOOLS], root)
    if arch == "arm64":
        _run(runner, [str(builder), "-m", "pip", "download", "--only-binary=:all:", "--dest", str(wheelhouse), "-r", str(requirements)], root)
        hash_archives(wheelhouse)
    else:
        binary_requirements = wheelhouse / "requirements-without-gseapy.txt"
        write_binary_requirements(requirements, binary_requirements)
        _run(runner, [str(builder), "-m", "pip", "download", "--only-binary=:all:", "--dest", str(wheelhouse), "-r", str(binary_requirements)], root)
        _run(runner, [str(builder), "-m", "pip", "download", "--no-binary=:all:", "--no-deps", "--no-build-isolation", "--dest", str(wheelhouse), GSEAPY_PIN], root)
        source_archives = hash_archives(wheelhouse)
        source_archive = wheelhouse / "gseapy-1.1.11.tar.gz"
        if source_archive.name not in source_archives:
            raise RuntimeError(f"Missing hashed Intel gseapy source archive: {source_archive}")
        build_env = {
            **os.environ,
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "_PYTHON_HOST_PLATFORM": "macosx-13.0-x86_64",
            "ARCHFLAGS": "-arch x86_64",
        }
        _run(runner, [str(builder), "-m", "pip", "wheel", "--no-deps", "--no-build-isolation", "--wheel-dir", str(wheelhouse), str(source_archive)], root, env=build_env)
        intel_wheel = wheelhouse / "gseapy-1.1.11-cp312-cp312-macosx_13_0_x86_64.whl"
        validate_x86_gseapy_wheel(intel_wheel, runner)
        _run(runner, [str(builder), "-m", "pip", "download", "--only-binary=:all:", "--dest", str(wheelhouse), *GSEAPY_RUNTIME_BINARY_REQUIREMENTS], root)
        hash_archives(wheelhouse)
    _run(runner, [str(builder), "-m", "pip", "install", "--no-index", "--find-links", str(wheelhouse), "--target", str(dependencies), "-r", str(requirements)], root)
    _run(runner, [str(builder), "-m", "pip", "download", "--only-binary=:all:", "--no-deps", "--dest", str(wheelhouse), "-r", str(rnaseq_requirements)], root)
    hashes = hash_archives(wheelhouse)
    if not hashes:
        raise RuntimeError(f"No wheel archives were downloaded to {wheelhouse}")
    clear_script = root / "scripts" / "clear_rnaseq_overlay_packages.py"
    patch_script = root / "scripts" / "apply_rnaseq_pydeseq2_patch.py"
    validate_script = root / "scripts" / "validate_rnaseq_runtime.py"
    _run(runner, [str(builder), str(clear_script), "--dependencies-root", str(dependencies), "--requirements", str(rnaseq_requirements)], root)
    _run(runner, [str(builder), "-m", "pip", "install", "--no-index", "--find-links", str(wheelhouse), "--no-deps", "--target", str(dependencies), "-r", str(rnaseq_requirements)], root)
    _run(runner, [str(builder), str(patch_script), "--dependencies-root", str(dependencies)], root)
    _run(runner, [str(builder), str(validate_script), "--dependencies-root", str(dependencies)], root)
    _run(runner, [str(builder), "-c", f"import sys; sys.path.insert(0, {str(dependencies)!r}); import numpy, pandas, scipy, statsmodels, plotly, kaleido, truststore; print('darwin-runtime-ok')"], root)
    if write_manifest:
        write_runtime_manifest(root=root, arch=arch, builder=builder, wheelhouse=wheelhouse, runner=runner)
    return dependencies


def main() -> int:
    dependencies = bootstrap()
    print(f"macos-python-runtime-ok root={dependencies}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
