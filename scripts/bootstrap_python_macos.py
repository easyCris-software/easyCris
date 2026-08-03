#!/usr/bin/env python3
"""Provision the pinned relocatable CPython runtime used by packaged macOS builds."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import traceback
import venv
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable


ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = ROOT / "python_embedded"
REQUIREMENTS = RUNTIME_DIR / "requirements-macos.txt"
RNA_REQUIREMENTS = RUNTIME_DIR / "requirements-rnaseq.txt"
INSTALLED_RUNTIME = RUNTIME_DIR / "runtime"
BUILD_VENV = ROOT / ".venv-macos-build"
BUILDER_TOOLS = (
    "pip==26.2",
    "setuptools==83.0.0",
    "wheel==0.47.0",
    "setuptools-rust==1.13.0",
    "toml==0.10.2",
)

ARCHIVE_PINS = {
    "x86_64": {
        "release": "20260718",
        "filename": "cpython-3.12.13+20260718-x86_64-apple-darwin-install_only_stripped.tar.gz",
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-x86_64-apple-darwin-install_only_stripped.tar.gz",
        "sha256": "8e6b7e6533bdf746287008edf91102e7bee0a6ca1d24f16c4514237cafd706c5",
        "python_version": "3.12.13",
    },
    "arm64": {
        "release": "20260718",
        "filename": "cpython-3.12.13+20260718-aarch64-apple-darwin-install_only_stripped.tar.gz",
        "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20260718/cpython-3.12.13%2B20260718-aarch64-apple-darwin-install_only_stripped.tar.gz",
        "sha256": "9a1e9e06175c10efd8378b904b07fa21bd791ab3345d7cdffeb4a76c9ff55903",
        "python_version": "3.12.13",
    },
}

BACKEND_SOURCE_FILES = (
    "stats.py",
    "rnaseq.py",
    "plot.py",
    "platform_trust.py",
    "plot_exporter.py",
)
BACKEND_SOURCE_DIRECTORIES = (
    "statistics_module",
    "rnaseq_module",
    "plots_module",
)
BACKEND_SOURCE_SUFFIXES = {".py", ".json"}
BOOTSTRAP_SCHEMA_VERSION = 1
RUNTIME_BIN_ALLOWLIST = {"python", "python3", "python3.12"}


@dataclass(frozen=True)
class LockEntry:
    name: str
    version: str
    group: str
    archives: tuple[str, ...]
    hashes: tuple[str, ...]


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


def parse_hashed_lock(path: Path) -> tuple[LockEntry, ...]:
    """Parse the EasyCris pip lock, requiring exact pins, filenames, and hashes."""
    entries: list[LockEntry] = []
    pending_group: str | None = None
    pending_archives: list[str] = []
    seen_names: set[str] = set()
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8-sig").splitlines(), start=1
    ):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("# group:"):
            pending_group = line.split(":", 1)[1].strip()
            pending_archives = []
            continue
        if line.startswith("# archive:"):
            pending_archives.append(line.split(":", 1)[1].strip())
            continue
        if line.startswith("#"):
            continue
        match = re.fullmatch(
            r"([A-Za-z0-9_.-]+)==([^\s;#]+)(?:\s+--hash=sha256:([0-9a-f]{64}))+",
            line,
        )
        if not match:
            raise RuntimeError(f"Invalid hashed lock entry at {path}:{line_number}: {line}")
        requirement_match = re.match(r"([A-Za-z0-9_.-]+)==([^\s;#]+)", line)
        assert requirement_match is not None
        name = requirement_match.group(1).lower().replace("_", "-").replace(".", "-")
        version = requirement_match.group(2)
        hashes = tuple(re.findall(r"--hash=sha256:([0-9a-f]{64})", line))
        if name in seen_names:
            raise RuntimeError(f"Duplicate package in hashed lock: {name}")
        if pending_group not in {"runtime", "rnaseq-overlay", "intel-source"}:
            raise RuntimeError(f"Missing lock group before {name} at {path}:{line_number}")
        if not pending_archives or len(pending_archives) != len(hashes):
            raise RuntimeError(f"Lock entry must name every hashed archive: {name}=={version}")
        if len(set(pending_archives)) != len(pending_archives) or len(set(hashes)) != len(hashes):
            raise RuntimeError(f"Duplicate archive or hash in lock entry: {name}=={version}")
        entries.append(
            LockEntry(name, version, pending_group, tuple(pending_archives), hashes)
        )
        seen_names.add(name)
        pending_group = None
        pending_archives = []
    if not entries:
        raise RuntimeError(f"Hashed lock is empty: {path}")
    return tuple(entries)


def validate_lock_matches_requirements(
    entries: Iterable[LockEntry], runtime_requirements: Path, rnaseq_requirements: Path
) -> None:
    """Require the selected architecture lock to equal both normative inputs."""
    expected = parse_pinned_requirements(runtime_requirements)
    for name, version in parse_pinned_requirements(rnaseq_requirements).items():
        current = expected.get(name)
        if current is not None and current != version:
            raise RuntimeError(
                f"Conflicting normative requirement pin: {name}=={current} and {name}=={version}"
            )
        expected[name] = version
    actual = {entry.name: entry.version for entry in entries}
    missing = sorted(f"{name}=={version}" for name, version in expected.items() if name not in actual)
    drifted = sorted(
        f"{name}: requirements={expected[name]}, lock={actual[name]}"
        for name in expected.keys() & actual.keys()
        if expected[name] != actual[name]
    )
    if missing or drifted:
        raise RuntimeError(
            "Architecture lock does not match normative requirements: "
            f"missing={missing}, drifted={drifted}"
        )


def validate_download_set(
    entries: Iterable[LockEntry],
    directory: Path,
    *,
    groups: set[str] | None = None,
) -> dict[str, str]:
    """Reject every filename or digest that is not admitted by the selected lock."""
    selected = tuple(entry for entry in entries if groups is None or entry.group in groups)
    by_archive: dict[str, tuple[LockEntry, str]] = {}
    for entry in selected:
        if len(entry.archives) != len(entry.hashes):
            raise RuntimeError(
                f"Lock archive/hash pairing is invalid: {entry.name}=={entry.version}"
            )
        for archive, expected_hash in zip(entry.archives, entry.hashes, strict=True):
            if archive in by_archive:
                raise RuntimeError(f"Duplicate locked archive filename: {archive}")
            by_archive[archive] = (entry, expected_hash)

    actual_hashes: dict[str, str] = {}
    for path in sorted(directory.iterdir()):
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"Downloaded set contains a non-file entry: {path.name}")
        locked = by_archive.get(path.name)
        if locked is None:
            raise RuntimeError(f"Downloaded unlocked archive: {path.name}")
        _, expected_hash = locked
        actual_hash = sha256(path)
        if actual_hash != expected_hash:
            raise RuntimeError(f"Downloaded archive hash mismatch: {path.name}")
        actual_hashes[path.name] = actual_hash

    actual_names = set(actual_hashes)
    for entry in selected:
        if not actual_names.intersection(entry.archives):
            raise RuntimeError(f"Missing locked archive for {entry.name}=={entry.version}")
    return actual_hashes


def _backend_source_files(source_root: Path) -> tuple[tuple[str, Path], ...]:
    resolved_root = source_root.resolve()
    selected: list[tuple[str, Path]] = []
    for name in BACKEND_SOURCE_FILES:
        path = source_root / name
        if path.is_symlink():
            raise RuntimeError(f"Backend source must not be a symlink: {path}")
        if not path.is_file():
            raise RuntimeError(f"Missing required backend source: {path}")
        try:
            path.resolve().relative_to(resolved_root)
        except ValueError as exc:
            raise RuntimeError(f"Backend source escapes its root: {path}") from exc
        selected.append((name, path))
    for directory_name in BACKEND_SOURCE_DIRECTORIES:
        directory = source_root / directory_name
        if directory.is_symlink():
            raise RuntimeError(f"Backend source must not be a symlink: {directory}")
        if not directory.is_dir():
            raise RuntimeError(f"Missing required backend source directory: {directory}")
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise RuntimeError(f"Backend source must not be a symlink: {path}")
            if not path.is_file() or path.suffix.lower() not in BACKEND_SOURCE_SUFFIXES:
                continue
            try:
                path.resolve().relative_to(resolved_root)
            except ValueError as exc:
                raise RuntimeError(f"Backend source escapes its root: {path}") from exc
            relative = path.relative_to(source_root)
            lowered_parts = {part.lower() for part in relative.parts}
            if lowered_parts.intersection({"__pycache__", "test", "tests", "fixtures", "logs", "output", "outputs"}):
                continue
            if path.name.lower() in {".env", "credentials.json", "secrets.json"}:
                continue
            selected.append((relative.as_posix(), path))
    return tuple(selected)


def backend_source_inventory(source_root: Path) -> dict:
    files = _backend_source_files(source_root)
    digest = hashlib.sha256()
    for relative, path in files:
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return {"files": [relative for relative, _path in files], "sha256": digest.hexdigest()}


def stage_backend_sources(source_root: Path, site_packages: Path) -> dict:
    """Copy only runtime backend files into the bundled interpreter site-packages."""
    inventory = backend_source_inventory(source_root)
    site_packages.mkdir(parents=True, exist_ok=True)
    for relative, source in _backend_source_files(source_root):
        destination = site_packages / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    staged_files = {
        path.relative_to(site_packages).as_posix()
        for path in site_packages.rglob("*")
        if path.is_file() and any(
            path.relative_to(site_packages).as_posix() == name
            or path.relative_to(site_packages).parts[0] in BACKEND_SOURCE_DIRECTORIES
            for name in BACKEND_SOURCE_FILES
        )
    }
    if staged_files != set(inventory["files"]):
        raise RuntimeError("Staged backend source set does not match the explicit allowlist")
    return inventory


def _parse_version(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d+)(?:\.(\d+))?", value)
    if not match:
        raise RuntimeError(f"Invalid macOS version in Mach-O metadata: {value}")
    return int(match.group(1)), int(match.group(2) or 0)


def validate_macho_file(
    path: Path,
    arch: str,
    runner: Callable[..., str] | None = None,
) -> dict:
    """Require exactly the native architecture and a floor no newer than 14.0."""
    runner = runner or run_checked
    inspected = _run(runner, ["/usr/bin/file", "-b", str(path)], ROOT)
    if "Mach-O" not in inspected:
        raise RuntimeError(f"Mach-O does not contain native {arch}: {path}: {inspected.strip()}")
    architectures = _macho_architectures(path, runner, ROOT)
    if architectures != {arch}:
        raise RuntimeError(
            f"Mach-O must contain the exact native architecture {arch}: "
            f"{path}: {sorted(architectures)}"
        )
    load_commands = _run(runner, ["/usr/bin/otool", "-l", str(path)], ROOT)
    versions: list[str] = []
    active_command: str | None = None
    for line in load_commands.splitlines():
        command_match = re.match(r"\s*cmd\s+(LC_[A-Z0-9_]+)\s*$", line)
        if command_match:
            active_command = command_match.group(1)
            continue
        if active_command == "LC_BUILD_VERSION":
            value = re.match(r"\s*minos\s+(\d+(?:\.\d+)?)\s*$", line)
        elif active_command == "LC_VERSION_MIN_MACOSX":
            value = re.match(r"\s*version\s+(\d+(?:\.\d+)?)\s*$", line)
        else:
            value = None
        if value:
            versions.append(value.group(1))
            active_command = None
    if not versions:
        raise RuntimeError(f"Unable to determine minimum macOS version for {path}")
    if any(_parse_version(version) > (14, 0) for version in versions):
        raise RuntimeError(f"Mach-O minimum macOS version is newer than 14.0: {path}: {versions}")
    return {
        "path": str(path),
        "architectures": [arch],
        "minimum_macos_versions": versions,
    }


def _macho_architectures(
    path: Path,
    runner: Callable[..., str],
    root: Path,
) -> set[str]:
    output = _run(runner, ["/usr/bin/lipo", "-archs", str(path)], root).strip()
    architectures = set(output.split())
    if not architectures or not architectures <= {"x86_64", "arm64"}:
        raise RuntimeError(f"Unexpected Mach-O architecture output for {path}: {output}")
    return architectures


def atomic_write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def mark_checkpoint_passed(
    checkpoint_path: Path, manifest_sha256: str, results: dict[str, dict]
) -> None:
    for name in ("stats", "rnaseq", "plot", "pdf", "tiff"):
        if not results.get(name, {}).get("success"):
            raise RuntimeError(f"Cannot pass checkpoint: {name} probe failed")
    atomic_write_json(
        checkpoint_path,
        {
            "status": "passed",
            "manifest_sha256": manifest_sha256,
            "results": results,
        },
    )


def compute_content_fingerprint(root: Path, arch: str) -> str:
    source_root = root / "python_embedded"
    pin = select_archive_pin("Darwin", arch)
    inputs = {
        "schema_version": BOOTSTRAP_SCHEMA_VERSION,
        "architecture": arch,
        "archive_url": pin["url"],
        "archive_sha256": pin["sha256"],
        "requirements": {
            name: sha256(source_root / name)
            for name in (
                "requirements-macos.txt",
                "requirements-rnaseq.txt",
                "requirements-macos-x86_64.lock",
                "requirements-macos-arm64.lock",
            )
        },
        "backend_sources": backend_source_inventory(source_root)["sha256"],
        "build_recipe": {
            relative: sha256(root / relative)
            for relative in (
                "scripts/bootstrap_python_macos.py",
                "scripts/apply_rnaseq_pydeseq2_patch.py",
                "scripts/validate_rnaseq_runtime.py",
            )
        },
        "rnaseq_patch_payload": directory_content_sha256(
            root / "scripts" / "rnaseq_patches" / "pydeseq2_0_5_3"
        ),
    }
    return hashlib.sha256(
        json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def directory_content_sha256(directory: Path) -> str:
    if not directory.is_dir() or directory.is_symlink():
        raise RuntimeError(f"Required content directory is missing or unsafe: {directory}")
    digest = hashlib.sha256()
    for path in sorted(directory.rglob("*"), key=lambda item: item.relative_to(directory).as_posix()):
        if path.is_symlink():
            raise RuntimeError(f"Content directory must not contain symlinks: {path}")
        if not path.is_file():
            continue
        digest.update(path.relative_to(directory).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256(path).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def validate_dev_cache_request(requested: bool, environment: dict[str, str]) -> None:
    if not requested:
        return
    protected_keys = {
        "CI",
        "GITHUB_ACTIONS",
        "EASYCRIS_PROTECTED_VALIDATION",
        "EASYCRIS_PRIVATE_E2E",
        "EASYCRIS_SIGNING",
        "EASYCRIS_RELEASE",
        "EASYCRIS_MILESTONE_CLOSEOUT",
    }
    active = [key for key in protected_keys if environment.get(key, "").lower() not in {"", "0", "false", "no"}]
    if active:
        raise RuntimeError(
            "Development runtime-cache reuse is forbidden in protected modes: "
            + ", ".join(sorted(active))
        )


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


def validate_builder_python(version_output: str) -> None:
    """Fail before provisioning if a previously created builder is not Python 3.12."""
    if not re.match(r"^Python 3\.12(?:\.\d+)?\b", version_output.strip()):
        raise RuntimeError(
            "macOS build environment must use Python 3.12. Remove .venv-macos-build and rerun provisioning. "
            f"Detected: {version_output.strip()}"
        )


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


def select_archive_pin(system_name: str, machine_name: str) -> dict[str, str]:
    """Return a copy of the immutable archive pin for a native Darwin host."""
    if system_name != "Darwin":
        raise RuntimeError(f"Darwin is required; detected {system_name}")
    if machine_name not in ARCHIVE_PINS:
        raise RuntimeError(
            f"Only native x86_64 or arm64 is supported; detected {machine_name}"
        )
    return dict(ARCHIVE_PINS[machine_name])


def _resolved_tar_path(member: tarfile.TarInfo) -> PurePosixPath:
    member_path = PurePosixPath(member.name)
    if member_path.is_absolute() or ".." in member_path.parts:
        raise RuntimeError(f"Archive contains unsafe path: {member.name}")
    if not member_path.parts or member_path.parts[0] != "python":
        raise RuntimeError(f"Archive member is outside python/: {member.name}")
    if member.ischr() or member.isblk() or member.isfifo():
        raise RuntimeError(f"Archive contains unsafe special file: {member.name}")
    if member.issym() or member.islnk():
        target = PurePosixPath(member.linkname)
        if target.is_absolute():
            raise RuntimeError(f"Archive contains unsafe link: {member.name}")
        combined = (member_path.parent / target) if member.issym() else target
        normalized: list[str] = []
        for part in combined.parts:
            if part in {"", "."}:
                continue
            if part == "..":
                if not normalized:
                    raise RuntimeError(f"Archive contains unsafe link: {member.name}")
                normalized.pop()
            else:
                normalized.append(part)
        if not normalized or normalized[0] != "python":
            raise RuntimeError(f"Archive contains unsafe link: {member.name}")
    return member_path


def verify_and_extract_archive(
    archive_path: Path, destination: Path, *, expected_sha256: str
) -> None:
    """Verify first, validate every tar member, then atomically expose extraction."""
    actual_sha256 = sha256(archive_path)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"Runtime archive SHA-256 mismatch: expected {expected_sha256}, got {actual_sha256}"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.extract-", dir=destination.parent)
    )
    backup = destination.with_name(f".{destination.name}.previous")
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
            for member in members:
                _resolved_tar_path(member)
            archive.extractall(staging, members=members, filter="data")
        if not (staging / "python").is_dir():
            raise RuntimeError("Runtime archive did not contain python/")
        if backup.exists():
            shutil.rmtree(backup)
        if destination.exists():
            destination.replace(backup)
        staging.replace(destination)
        if backup.exists():
            shutil.rmtree(backup)
    except Exception:
        if not destination.exists() and backup.exists():
            backup.replace(destination)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def run_backend_protocol(
    interpreter: Path,
    module: str,
    request: dict,
    *,
    environment: dict[str, str] | None = None,
) -> dict:
    """Run one EasyCris module request at the packaged isolated launch boundary."""
    if module not in {"stats", "rnaseq", "plot"}:
        raise RuntimeError(f"Unsupported backend module: {module}")
    clean_env = {
        key: value
        for key, value in (environment or os.environ).items()
        if not key.upper().startswith("PYTHON")
    }
    completed = subprocess.run(
        [str(interpreter), "-I", "-B", "-m", module],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        check=True,
        env=clean_env,
    )
    output = completed.stdout.strip()
    if not output:
        raise RuntimeError(f"Empty {module} protocol output")
    result = json.loads(output)
    if not isinstance(result, dict):
        raise RuntimeError(f"Invalid {module} protocol result")
    return result


def atomic_materialize_runtime(source_python: Path, runtime_dir: Path) -> None:
    """Copy a complete candidate before atomically replacing the live runtime."""
    if not (source_python / "bin" / "python3.12").is_file():
        raise RuntimeError(f"Extracted runtime interpreter is missing: {source_python}")
    runtime_dir.parent.mkdir(parents=True, exist_ok=True)
    temporary_root = Path(
        tempfile.mkdtemp(prefix=f".{runtime_dir.name}.candidate-", dir=runtime_dir.parent)
    )
    candidate = temporary_root / "runtime"
    backup = runtime_dir.with_name(f".{runtime_dir.name}.previous")
    try:
        shutil.copytree(source_python, candidate, symlinks=True)
        if backup.exists():
            shutil.rmtree(backup)
        if runtime_dir.exists():
            runtime_dir.replace(backup)
        candidate.replace(runtime_dir)
        if backup.exists():
            shutil.rmtree(backup)
    except Exception:
        if not runtime_dir.exists() and backup.exists():
            backup.replace(runtime_dir)
        raise
    finally:
        if temporary_root.exists():
            shutil.rmtree(temporary_root)


def write_filtered_lock(
    entries: Iterable[LockEntry], destination: Path, groups: set[str]
) -> Path:
    selected = [entry for entry in entries if entry.group in groups]
    if not selected:
        raise RuntimeError(f"No lock entries selected for groups: {sorted(groups)}")
    lines = []
    for entry in selected:
        hashes = " ".join(f"--hash=sha256:{value}" for value in entry.hashes)
        lines.append(f"{entry.name}=={entry.version} {hashes}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return destination


def failure_log_tail(path: Path, limit: int = 80) -> str:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return ""
    if not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError(f"Provision log must be a regular non-symlink file: {path}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise RuntimeError(f"Provision log could not be opened safely: {path}") from exc
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise RuntimeError(f"Provision log changed to a non-regular file: {path}")
        with os.fdopen(descriptor, "r", encoding="utf-8", errors="replace") as handle:
            descriptor = -1
            lines = handle.read().splitlines()
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    return "\n".join(lines[-limit:])


def managed_failure_log_tail(
    root: Path, head: str, arch: str, limit: int = 80
) -> str:
    """Read only the validated regular log for one accepted provision output."""
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        raise RuntimeError(f"Unsafe provision log head: {head}")
    if arch not in {"x86_64", "arm64"}:
        raise RuntimeError(f"Unsafe provision log architecture: {arch}")
    output = root / "_tmp" / "python-runtime" / head / arch
    _validate_managed_path(root, output, "python-runtime")
    try:
        output_metadata = output.lstat()
    except FileNotFoundError:
        return ""
    if not stat.S_ISDIR(output_metadata.st_mode):
        raise RuntimeError(f"Provision output must be a regular directory: {output}")
    log = output / "provision.log"
    _validate_managed_path(root, log, "python-runtime")

    directory_flags = (
        os.O_RDONLY
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    file_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    directory_descriptors: list[int] = []
    log_descriptor = -1
    try:
        current_descriptor = os.open(root.absolute(), directory_flags)
        directory_descriptors.append(current_descriptor)
        if not stat.S_ISDIR(os.fstat(current_descriptor).st_mode):
            raise RuntimeError(f"Provision log root is not a directory: {root}")
        for component in ("_tmp", "python-runtime", head, arch):
            current_descriptor = os.open(
                component,
                directory_flags,
                dir_fd=current_descriptor,
            )
            directory_descriptors.append(current_descriptor)
            if not stat.S_ISDIR(os.fstat(current_descriptor).st_mode):
                raise RuntimeError(
                    f"Provision log path component is not a directory: {component}"
                )
        log_descriptor = os.open(
            "provision.log",
            file_flags,
            dir_fd=current_descriptor,
        )
        if not stat.S_ISREG(os.fstat(log_descriptor).st_mode):
            raise RuntimeError("Provision log changed to a non-regular file")
        with os.fdopen(
            log_descriptor, "r", encoding="utf-8", errors="replace"
        ) as handle:
            log_descriptor = -1
            lines = handle.read().splitlines()
        return "\n".join(lines[-limit:])
    except FileNotFoundError:
        return ""
    except OSError as exc:
        raise RuntimeError(f"Provision log could not be opened safely: {log}") from exc
    finally:
        if log_descriptor >= 0:
            os.close(log_descriptor)
        for descriptor in reversed(directory_descriptors):
            os.close(descriptor)


def _run(runner: Callable[..., str], command: Iterable[str], root: Path, **kwargs) -> str:
    return runner(list(command), cwd=str(root), **kwargs)


class ProvisionLogger:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("", encoding="utf-8")

    def write(self, message: str) -> None:
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(message.rstrip("\n") + "\n")

    def phase(self, name: str) -> None:
        message = f"[provision] phase={name}"
        self.write(message)
        print(message, flush=True)


def run_logged(
    command: list[str],
    *,
    root: Path,
    logger: ProvisionLogger,
    env: dict[str, str] | None = None,
) -> None:
    logger.write("$ " + " ".join(command))
    with logger.path.open("a", encoding="utf-8") as handle:
        subprocess.run(
            command,
            cwd=root,
            env=env,
            stdout=handle,
            stderr=subprocess.STDOUT,
            text=True,
            check=True,
        )


def run_captured(
    command: list[str], *, root: Path, logger: ProvisionLogger, env: dict[str, str] | None = None
) -> str:
    logger.write("$ " + " ".join(command))
    completed = subprocess.run(
        command,
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    if completed.stdout:
        logger.write(completed.stdout)
    if completed.stderr:
        logger.write(completed.stderr)
    return completed.stdout


def _ensure_ignored(root: Path, path: Path) -> None:
    result = subprocess.run(
        ["git", "check-ignore", "-q", str(path)], cwd=root, check=False
    )
    if result.returncode != 0:
        raise RuntimeError(f"Provisioning output is not ignored by git: {path}")


def _safe_recreate_output(root: Path, output: Path, arch: str) -> None:
    expected_root = root / "_tmp" / "python-runtime"
    try:
        relative = output.relative_to(expected_root)
    except ValueError as exc:
        raise RuntimeError(f"Unsafe provisioning output path: {output}") from exc
    if len(relative.parts) != 2 or relative.parts[-1] != arch:
        raise RuntimeError(f"Unsafe provisioning output shape: {output}")
    _validate_managed_path(root, output, "python-runtime")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)


def _validate_managed_path(root: Path, path: Path, managed_name: str) -> None:
    """Reject symlink escapes before reading or removing managed temporary trees."""
    root = root.absolute()
    base = root / "_tmp" / managed_name
    try:
        relative = path.absolute().relative_to(base)
    except ValueError as exc:
        raise RuntimeError(f"Unsafe managed path: {path}") from exc
    for candidate in (root / "_tmp", base):
        if candidate.is_symlink():
            raise RuntimeError(f"Managed path ancestor must not be a symlink: {candidate}")
    cursor = base
    for part in relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise RuntimeError(f"Managed path must not be a symlink: {cursor}")
    try:
        base.resolve(strict=False).relative_to(root.resolve())
        path.resolve(strict=False).relative_to(base.resolve(strict=False))
    except ValueError as exc:
        raise RuntimeError(f"Managed path escapes repository: {path}") from exc


def _git_state(root: Path) -> tuple[str, bool, int]:
    state = capture_git_state(root)
    return state["head"], state["clean_tree"], state["dirty_entry_count"]


def capture_git_state(root: Path) -> dict[str, object]:
    """Capture HEAD plus exact tracked and untracked worktree content state."""
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    dirty_lines = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    tracked_diff = subprocess.run(
        ["git", "diff", "--binary", "HEAD", "--"],
        cwd=root,
        capture_output=True,
        check=True,
    ).stdout
    untracked_output = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        cwd=root,
        capture_output=True,
        check=True,
    ).stdout
    digest = hashlib.sha256()
    digest.update("\n".join(dirty_lines).encode("utf-8", errors="surrogateescape"))
    digest.update(b"\0tracked-diff\0")
    digest.update(tracked_diff)
    for encoded in sorted(value for value in untracked_output.split(b"\0") if value):
        relative = Path(os.fsdecode(encoded))
        path = root / relative
        metadata = path.lstat()
        digest.update(b"\0untracked\0")
        digest.update(encoded)
        digest.update(b"\0")
        digest.update(f"{stat.S_IMODE(metadata.st_mode):04o}".encode("ascii"))
        digest.update(b"\0")
        if path.is_symlink():
            digest.update(b"symlink\0")
            digest.update(os.fsencode(os.readlink(path)))
        elif path.is_file():
            digest.update(b"file\0")
            digest.update(sha256(path).encode("ascii"))
        else:
            raise RuntimeError(f"Unsupported untracked git entry: {path}")
    return {
        "head": head,
        "clean_tree": not dirty_lines,
        "dirty_entry_count": len(dirty_lines),
        "state_sha256": digest.hexdigest(),
    }


def _download_archive(
    pin: dict[str, str],
    destination: Path,
    logger: ProvisionLogger,
    *,
    runner: Callable[..., None] | None = None,
) -> None:
    partial = destination.with_suffix(destination.suffix + ".partial")
    destination.parent.mkdir(parents=True, exist_ok=True)
    logger.write(f"download url={pin['url']} destination={destination}")
    command = [
        "/usr/bin/curl",
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--output",
        str(partial),
        pin["url"],
    ]
    selected_runner = runner or (
        lambda command, **_kwargs: run_logged(command, root=ROOT, logger=logger)
    )
    try:
        selected_runner(command)
        if not partial.is_file() or partial.stat().st_size == 0:
            raise RuntimeError("Runtime archive download produced no bytes")
        os.replace(partial, destination)
    finally:
        if partial.exists():
            partial.unlink()


def _ensure_builder(root: Path, logger: ProvisionLogger) -> Path:
    build_venv = root / ".venv-macos-build"
    builder = build_venv / "bin" / "python"
    if not builder.exists():
        venv.EnvBuilder(with_pip=True).create(build_venv)
    version = run_captured(
        [str(builder), "-I", "-B", "--version"],
        root=root,
        logger=logger,
        env=_clean_python_environment(),
    ).strip()
    validate_builder_python(version)
    _run_pip(
        builder,
        ["install", "--upgrade", *BUILDER_TOOLS],
        root=root,
        logger=logger,
    )
    return builder


def _verify_relocated_interpreter(
    interpreter: Path, arch: str, root: Path, logger: ProvisionLogger
) -> dict:
    version = run_captured([str(interpreter), "--version"], root=root, logger=logger).strip()
    if version != "Python 3.12.13":
        raise RuntimeError(f"Bundled interpreter version mismatch: {version}")
    runner = lambda command, **_kwargs: run_captured(command, root=root, logger=logger)
    macho = validate_macho_file(interpreter, arch, runner)
    macho["path"] = "bin/python3.12"
    return {"version": version.removeprefix("Python "), **macho}


def _download_locked_groups(
    *,
    root: Path,
    output: Path,
    builder: Path,
    entries: tuple[LockEntry, ...],
    arch: str,
    logger: ProvisionLogger,
) -> tuple[Path, dict[str, str]]:
    lock_inputs = output / "lock-inputs"
    wheelhouse = output / "wheelhouse"
    wheelhouse.mkdir(parents=True)
    groups = ["runtime", "rnaseq-overlay"] + (["intel-source"] if arch == "x86_64" else [])
    all_hashes: dict[str, str] = {}
    for group in groups:
        filtered = write_filtered_lock(entries, lock_inputs / f"{group}.txt", {group})
        quarantine = output / "downloads" / group
        quarantine.mkdir(parents=True)
        command = ["download", "--require-hashes", "--dest", str(quarantine)]
        if group == "intel-source":
            command.extend(["--no-deps", "--no-binary=:all:", "--no-build-isolation"])
        else:
            command.append("--only-binary=:all:")
            if group == "rnaseq-overlay":
                command.append("--no-deps")
        command.extend(["-r", str(filtered)])
        _run_pip(builder, command, root=root, logger=logger)
        admitted = validate_download_set(entries, quarantine, groups={group})
        for name, value in admitted.items():
            destination = wheelhouse / name
            if destination.exists() and sha256(destination) != value:
                raise RuntimeError(f"Conflicting locked archive: {name}")
            if not destination.exists():
                shutil.copy2(quarantine / name, destination)
            all_hashes[name] = value
    return wheelhouse, dict(sorted(all_hashes.items()))


def _write_locked_group_inputs(
    entries: tuple[LockEntry, ...], output: Path, arch: str
) -> None:
    groups = ["runtime", "rnaseq-overlay"] + (["intel-source"] if arch == "x86_64" else [])
    for group in groups:
        write_filtered_lock(entries, output / "lock-inputs" / f"{group}.txt", {group})


def _copy_hash_verified_file(
    source: Path, destination: Path, expected_sha256: str
) -> bool:
    """Copy one immutable cached artifact only when its bytes match the pin."""
    if source.is_symlink() or not source.is_file():
        return False
    try:
        if sha256(source) != expected_sha256:
            return False
    except OSError:
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.cache-candidate")
    if temporary.exists() or temporary.is_symlink():
        if temporary.is_dir() and not temporary.is_symlink():
            shutil.rmtree(temporary)
        else:
            temporary.unlink()
    try:
        shutil.copy2(source, temporary, follow_symlinks=False)
        if sha256(temporary) != expected_sha256:
            return False
        os.replace(temporary, destination)
        return True
    finally:
        if temporary.exists() or temporary.is_symlink():
            temporary.unlink()


def _reuse_cached_wheelhouse(
    cache_wheelhouse: Path,
    destination: Path,
    entries: tuple[LockEntry, ...],
) -> dict[str, str] | None:
    """Materialize only an exact, fully re-hashed lock archive set."""
    if cache_wheelhouse.is_symlink() or not cache_wheelhouse.is_dir():
        return None
    if any(path.is_symlink() or not path.is_file() for path in cache_wheelhouse.iterdir()):
        return None
    try:
        admitted = validate_download_set(entries, cache_wheelhouse)
    except (OSError, RuntimeError):
        return None
    destination.parent.mkdir(parents=True, exist_ok=True)
    candidate = destination.with_name(f".{destination.name}.cache-candidate")
    if candidate.exists() or candidate.is_symlink():
        if candidate.is_dir() and not candidate.is_symlink():
            shutil.rmtree(candidate)
        else:
            candidate.unlink()
    try:
        shutil.copytree(cache_wheelhouse, candidate, symlinks=False)
        if validate_download_set(entries, candidate) != admitted:
            return None
        os.replace(candidate, destination)
        return dict(sorted(admitted.items()))
    except (OSError, RuntimeError):
        return None
    finally:
        if candidate.exists() or candidate.is_symlink():
            if candidate.is_dir() and not candidate.is_symlink():
                shutil.rmtree(candidate)
            else:
                candidate.unlink()


def _validate_built_gseapy_wheel(
    wheel: Path, root: Path, logger: ProvisionLogger
) -> dict:
    if not re.fullmatch(r"gseapy-1\.1\.11-cp312-cp312-macosx_14_0_x86_64\.whl", wheel.name):
        raise RuntimeError(f"Unexpected Intel GSEApy wheel tag: {wheel.name}")
    with tempfile.TemporaryDirectory(prefix="easycris-gseapy-wheel-") as temporary:
        unpacked = Path(temporary)
        with zipfile.ZipFile(wheel) as archive:
            archive.extractall(unpacked)
        extensions = sorted(unpacked.rglob("*.so"))
        if not extensions:
            raise RuntimeError("Intel GSEApy wheel has no native extension")
        runner = lambda command, **_kwargs: run_captured(command, root=root, logger=logger)
        for extension in extensions:
            validate_macho_file(extension, "x86_64", runner)
    return {"filename": wheel.name, "sha256": sha256(wheel)}


def local_build_roots(root: Path) -> tuple[Path, ...]:
    """Return machine-local roots that must not leak into shipped payloads."""
    candidates = (root, Path.home(), Path(tempfile.gettempdir()))
    roots = {form for path in candidates for form in (path.absolute(), path.resolve())}
    return tuple(sorted(roots, key=lambda path: (-len(os.fsencode(path)), os.fspath(path))))


def runtime_leak_roots(root: Path) -> tuple[Path, ...]:
    """Return paths that identify this checkout's runtime build.

    Generic hosted-runner homes and temporary roots are intentionally excluded:
    upstream binary wheels can retain those shared builder paths. Our source
    build still remaps the broader ``local_build_roots`` set, while the exact
    checkout root covers every EasyCris builder, cache, and output directory.
    """
    roots = {root.absolute(), root.resolve()}
    return tuple(sorted(roots, key=lambda path: (-len(os.fsencode(path)), os.fspath(path))))


def gseapy_build_environment(root: Path) -> dict[str, str]:
    """Create a deterministic Intel Rust build environment without local paths."""
    flags = [
        f"--remap-path-prefix={path}=easycris-build/{index}"
        for index, path in enumerate(local_build_roots(root))
    ]
    return {
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "_PYTHON_HOST_PLATFORM": "macosx-14.0-x86_64",
        "ARCHFLAGS": "-arch x86_64",
        "CARGO_INCREMENTAL": "0",
        "RUSTFLAGS": " ".join(flags),
    }


def _install_locked_dependencies(
    *,
    root: Path,
    output: Path,
    runtime: Path,
    builder: Path,
    entries: tuple[LockEntry, ...],
    wheelhouse: Path,
    arch: str,
    logger: ProvisionLogger,
) -> dict | None:
    interpreter = runtime / "bin" / "python3.12"
    lock_inputs = output / "lock-inputs"
    runtime_lock = lock_inputs / "runtime.txt"
    overlay_lock = lock_inputs / "rnaseq-overlay.txt"
    _run_pip(
        interpreter,
        ["install", "--no-index", "--find-links", str(wheelhouse), "--require-hashes", "--only-binary=:all:", "-r", str(runtime_lock)],
        root=root,
        logger=logger,
    )
    source_provenance = None
    if arch == "x86_64":
        source_archive = wheelhouse / "gseapy-1.1.11.tar.gz"
        if sha256(source_archive) != "d36a164ee466f7ea6deadfe82ea041f3328ee937ff4c9de862b3e6e2825df0dd":
            raise RuntimeError("Intel GSEApy source hash mismatch before build")
        built = output / "built-wheels"
        built.mkdir()
        build_env = gseapy_build_environment(root)
        _run_pip(
            builder,
            ["wheel", "--no-deps", "--no-build-isolation", "--wheel-dir", str(built), str(source_archive)],
            root=root,
            logger=logger,
            env_extra=build_env,
        )
        wheels = sorted(built.glob("gseapy-1.1.11-*.whl"))
        if len(wheels) != 1:
            raise RuntimeError(f"Expected one built Intel GSEApy wheel, found {len(wheels)}")
        source_provenance = {
            "source_filename": source_archive.name,
            "source_sha256": sha256(source_archive),
            "wheel": _validate_built_gseapy_wheel(wheels[0], root, logger),
        }
        _run_pip(
            interpreter,
            ["install", "--no-deps", "--no-index", str(wheels[0])],
            root=root,
            logger=logger,
        )
    _run_pip(
        interpreter,
        ["install", "--no-index", "--find-links", str(wheelhouse), "--require-hashes", "--only-binary=:all:", "--no-deps", "-r", str(overlay_lock)],
        root=root,
        logger=logger,
    )
    return source_provenance


def _clean_python_environment(extra: dict[str, str] | None = None) -> dict[str, str]:
    environment = {
        key: value for key, value in os.environ.items() if not key.upper().startswith("PYTHON")
    }
    environment.update(extra or {})
    return environment


def _run_pip(
    interpreter: Path,
    arguments: list[str],
    *,
    root: Path,
    logger: ProvisionLogger,
    env_extra: dict[str, str] | None = None,
    capture: bool = False,
) -> str | None:
    """Run pip through an isolated interpreter with Python env inputs removed."""
    command = [str(interpreter), "-I", "-B", "-m", "pip", *arguments]
    environment = _clean_python_environment(env_extra)
    if capture:
        return run_captured(command, root=root, logger=logger, env=environment)
    run_logged(command, root=root, logger=logger, env=environment)
    return None


def _apply_and_validate_overlay(
    *, root: Path, runtime: Path, logger: ProvisionLogger
) -> None:
    interpreter = runtime / "bin" / "python3.12"
    site_packages = runtime / "lib" / "python3.12" / "site-packages"
    patch_script = root / "scripts" / "apply_rnaseq_pydeseq2_patch.py"
    validate_script = root / "scripts" / "validate_rnaseq_runtime.py"
    env = _clean_python_environment()
    run_logged(
        [str(interpreter), "-I", "-B", str(patch_script), "--dependencies-root", str(site_packages)],
        root=root,
        logger=logger,
        env=env,
    )
    run_logged(
        [str(interpreter), "-I", "-B", str(validate_script), "--dependencies-root", str(site_packages)],
        root=root,
        logger=logger,
        env=env,
    )


def prune_provisioning_artifacts(runtime: Path) -> None:
    """Remove installer metadata, build payloads, launchers, and bytecode."""
    python_lib = runtime / "lib" / "python3.12"
    site_packages = python_lib / "site-packages"
    targets = [site_packages / "pip", python_lib / "ensurepip"]
    targets.extend(site_packages.glob("pip-*.dist-info"))
    targets.extend(site_packages.glob("pip-*.egg-info"))
    for target in targets:
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(target)
    targets = list(runtime.rglob("direct_url.json"))
    for target in targets:
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    for launcher in (runtime / "bin").iterdir():
        if launcher.name in RUNTIME_BIN_ALLOWLIST:
            continue
        if launcher.is_dir() and not launcher.is_symlink():
            shutil.rmtree(launcher)
        else:
            launcher.unlink()
    for cache in sorted(runtime.rglob("__pycache__"), reverse=True):
        if cache.is_dir() and not cache.is_symlink():
            shutil.rmtree(cache)
        elif cache.exists() or cache.is_symlink():
            cache.unlink()
    for bytecode in runtime.rglob("*.pyc"):
        bytecode.unlink()
    development_directories = {
        path
        for pattern in ("include", "pkgconfig", "config-*-darwin")
        for path in runtime.rglob(pattern)
    }
    for target in sorted(
        development_directories, key=lambda path: len(path.parts), reverse=True
    ):
        if target.is_symlink() or target.is_file():
            target.unlink()
        elif target.is_dir():
            shutil.rmtree(target)
    for pattern in ("*.a", "*.o"):
        for target in runtime.rglob(pattern):
            if target.is_dir() and not target.is_symlink():
                shutil.rmtree(target)
            else:
                target.unlink()


def _file_contains_any(path: Path, needles: tuple[bytes, ...]) -> bool:
    """Scan a file without loading large native payloads into memory."""
    overlap = max((len(needle) for needle in needles), default=1) - 1
    previous = b""
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            data = previous + chunk
            if any(needle in data for needle in needles):
                return True
            previous = data[-overlap:] if overlap else b""
    return False


def validate_no_local_build_paths(runtime: Path, roots: Iterable[Path]) -> None:
    """Reject machine-local paths in files or symlink targets under runtime."""
    expanded_roots = {
        form
        for path in roots
        for form in (path.absolute(), path.resolve())
    }
    needles = tuple(
        sorted(
            {os.fsencode(path) for path in expanded_roots if os.fspath(path)},
            key=lambda value: (-len(value), value),
        )
    )
    if not needles:
        return
    leaked: list[str] = []
    for path in runtime.rglob("*"):
        if path.is_symlink():
            target = os.fsencode(os.readlink(path))
            if any(needle in target for needle in needles):
                leaked.append(path.relative_to(runtime).as_posix())
        elif path.is_file() and _file_contains_any(path, needles):
            leaked.append(path.relative_to(runtime).as_posix())
        if len(leaked) >= 20:
            break
    if leaked:
        raise RuntimeError(f"Final runtime contains local build path data: {leaked}")


def validate_pruned_runtime(
    runtime: Path, root: Path, logger: ProvisionLogger
) -> None:
    python_lib = runtime / "lib" / "python3.12"
    site_packages = python_lib / "site-packages"
    forbidden: list[Path] = []
    for path in site_packages.iterdir():
        normalized = path.name.lower().replace("-", "_")
        if (
            normalized == "pip"
            or normalized.startswith("pip_")
            or normalized.startswith("nuitka")
            or normalized.startswith("pip_licenses")
        ):
            forbidden.append(path)
    forbidden.extend((runtime / "bin").glob("pip*"))
    forbidden.extend(
        path
        for path in (runtime / "bin").iterdir()
        if path.name not in RUNTIME_BIN_ALLOWLIST
    )
    if (python_lib / "ensurepip").exists():
        forbidden.append(python_lib / "ensurepip")
    for pattern in ("include", "pkgconfig", "config-*-darwin"):
        forbidden.extend(runtime.rglob(pattern))
    forbidden.extend(runtime.rglob("*.a"))
    forbidden.extend(runtime.rglob("*.o"))
    forbidden.extend(runtime.rglob("*.whl"))
    forbidden.extend(runtime.rglob("__pycache__"))
    forbidden.extend(runtime.rglob("*.pyc"))
    forbidden.extend(runtime.rglob("direct_url.json"))
    for name in ("wheelhouse", ".venv-macos-build", "provision.log"):
        forbidden.extend(runtime.rglob(name))
    if forbidden:
        relative = sorted({path.relative_to(runtime).as_posix() for path in forbidden})
        raise RuntimeError(f"Final runtime contains provisioning-only artifacts: {relative}")
    validate_no_local_build_paths(runtime, runtime_leak_roots(root))
    interpreter = runtime / "bin" / "python3.12"
    completed = subprocess.run(
        [str(interpreter), "-I", "-B", "-m", "pip", "--version"],
        cwd=root,
        env=_clean_python_environment(),
        capture_output=True,
        text=True,
        check=False,
    )
    logger.write(f"pip-prune-check returncode={completed.returncode}")
    if completed.returncode == 0:
        raise RuntimeError("Final runtime still imports provisioning-only pip")


def _verify_required_imports(
    *, root: Path, runtime: Path, logger: ProvisionLogger
) -> None:
    interpreter = runtime / "bin" / "python3.12"
    env = _clean_python_environment()
    modules = "numpy,pandas,scipy,statsmodels,sklearn,scikit_posthocs,lmfit,lifelines,matplotlib,seaborn,plotly,kaleido,truststore,certifi,gseapy,polars,duckdb,anndata,pydeseq2,stats,rnaseq,plot"
    script = ";".join(f"import {name}" for name in modules.split(",")) + ";print('darwin-runtime-imports-ok')"
    run_logged(
        [str(interpreter), "-I", "-B", "-c", script],
        root=root,
        logger=logger,
        env=env,
    )


def _run_real_probes(runtime: Path, output: Path) -> dict[str, dict]:
    interpreter = runtime / "bin" / "python3.12"
    env = _clean_python_environment({"EASYCRIS_OFFLINE": "1"})
    results: dict[str, dict] = {}
    stats = run_backend_protocol(
        interpreter,
        "stats",
        {"test": "independent_ttest", "data": {"group1": [1, 2, 3, 4], "group2": [5, 6, 7, 8]}, "parameters": {"equal_var": True}},
        environment=env,
    )
    if not stats.get("success"):
        raise RuntimeError(f"Stats protocol probe failed: {stats}")
    results["stats"] = {"success": True}
    rnaseq = run_backend_protocol(
        interpreter,
        "rnaseq",
        {"test": "rnaseq_validate", "data": {"counts": {"GeneA": {"S1": 20, "S2": 25}, "GeneB": {"S1": 12, "S2": 14}}, "metadata": {"S1": {"condition": "A"}, "S2": {"condition": "B"}}}, "parameters": {}},
        environment=env,
    )
    if not rnaseq.get("success"):
        raise RuntimeError(f"RNA-seq protocol probe failed: {rnaseq}")
    results["rnaseq"] = {"success": True}
    plot = run_backend_protocol(
        interpreter,
        "plot",
        {"action": "trendline", "x": [1, 2, 3, 4], "y": [2, 4, 6, 8], "type": "linear"},
        environment=env,
    )
    if not plot.get("success"):
        raise RuntimeError(f"Plot protocol probe failed: {plot}")
    results["plot"] = {"success": True}
    export_dir = output / "exports"
    export_dir.mkdir()
    figure = {"data": [{"type": "scatter", "x": [1, 2, 3], "y": [2, 1, 3]}], "layout": {"title": {"text": "EasyCris runtime probe"}}}
    for name, fmt in (("pdf", "pdf"), ("tiff", "tiff")):
        path = export_dir / f"probe.{fmt}"
        result = run_backend_protocol(
            interpreter,
            "plot",
            {"action": "export_plot", "plotly_json": figure, "output_path": str(path), "options": {"format": fmt, "width": 400, "height": 300, "dpi": 96}},
            environment=env,
        )
        if not result.get("success") or not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError(f"{name.upper()} export probe failed: {result}")
        header = path.read_bytes()[:4]
        if name == "pdf" and not header.startswith(b"%PDF"):
            raise RuntimeError("PDF export probe produced an invalid header")
        if name == "tiff" and header not in {b"II*\x00", b"MM\x00*"}:
            raise RuntimeError("TIFF export probe produced an invalid header")
        results[name] = {"success": True, "sha256": sha256(path), "bytes": path.stat().st_size}
    return results


MACHO_MAGICS = {
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
}


def _macho_candidates(runtime: Path) -> list[Path]:
    candidates = []
    for path in runtime.rglob("*"):
        if not path.is_file():
            continue
        try:
            with path.open("rb") as handle:
                magic = handle.read(4)
        except OSError:
            continue
        if magic in MACHO_MAGICS:
            candidates.append(path)
    return sorted(candidates)


def thin_universal_machos(
    runtime: Path,
    arch: str,
    root: Path,
    logger: ProvisionLogger,
) -> list[dict[str, object]]:
    """Atomically reduce every universal Mach-O to the one native slice."""
    capture = lambda command, **_kwargs: run_captured(command, root=root, logger=logger)
    records: list[dict[str, object]] = []
    for path in _macho_candidates(runtime):
        source_architectures = _macho_architectures(path, capture, root)
        if len(source_architectures) == 1:
            continue
        if arch not in source_architectures:
            raise RuntimeError(
                f"Universal Mach-O does not contain native {arch}: "
                f"{path}: {sorted(source_architectures)}"
            )
        source_hash = sha256(path)
        source_mode = stat.S_IMODE(path.stat().st_mode)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=f".{arch}.thin", dir=path.parent
        )
        os.close(descriptor)
        temporary = Path(temporary_name)
        temporary.unlink()
        try:
            run_logged(
                [
                    "/usr/bin/lipo",
                    "-thin",
                    arch,
                    str(path),
                    "-output",
                    str(temporary),
                ],
                root=root,
                logger=logger,
            )
            result_architectures = _macho_architectures(temporary, capture, root)
            if result_architectures != {arch}:
                raise RuntimeError(
                    f"Thinned Mach-O is not exact native {arch}: "
                    f"{path}: {sorted(result_architectures)}"
                )
            os.chmod(temporary, source_mode)
            result_hash = sha256(temporary)
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()
        records.append(
            {
                "path": path.relative_to(runtime).as_posix(),
                "source_architectures": [
                    candidate
                    for candidate in ("x86_64", "arm64")
                    if candidate in source_architectures
                ],
                "source_sha256": source_hash,
                "result_architectures": [arch],
                "result_sha256": result_hash,
            }
        )
    return records


def _verify_macho_inventory(
    runtime: Path, arch: str, root: Path, logger: ProvisionLogger
) -> dict:
    runner = lambda command, **_kwargs: run_captured(command, root=root, logger=logger)
    records = []
    for path in _macho_candidates(runtime):
        record = validate_macho_file(path, arch, runner)
        record["path"] = path.relative_to(runtime).as_posix()
        record["sha256"] = sha256(path)
        records.append(record)
    if not records:
        raise RuntimeError("Bundled runtime contains no Mach-O files")
    encoded = json.dumps(records, sort_keys=True, separators=(",", ":")).encode("utf-8")
    kaleido = [record["path"] for record in records if "/kaleido/executable/" in f"/{record['path']}"]
    if not kaleido:
        raise RuntimeError("Bundled Kaleido payload contains no Mach-O helper")
    return {
        "count": len(records),
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "kaleido_helpers": kaleido,
        "files": records,
    }


def validate_macho_thinning_provenance(
    thinning: list[dict[str, object]], inventory: dict
) -> None:
    """Bind each thinning result to the independently inventoried final file."""
    inventory_records = inventory.get("files")
    if not isinstance(inventory_records, list):
        raise RuntimeError("Final Mach-O inventory has no file records")
    by_path: dict[str, dict] = {}
    for record in inventory_records:
        if not isinstance(record, dict) or not isinstance(record.get("path"), str):
            raise RuntimeError("Final Mach-O inventory contains an invalid file record")
        path = record["path"]
        if path in by_path:
            raise RuntimeError(f"Final Mach-O inventory repeats a path: {path}")
        by_path[path] = record
    for record in thinning:
        path = record.get("path")
        final_record = by_path.get(path) if isinstance(path, str) else None
        if (
            final_record is None
            or final_record.get("sha256") != record.get("result_sha256")
            or final_record.get("architectures") != record.get("result_architectures")
        ):
            raise RuntimeError(
                f"Thinning result does not match final Mach-O inventory: {path}"
            )


def _requirements_hashes(source_root: Path) -> dict[str, str]:
    return {
        name: sha256(source_root / name)
        for name in (
            "requirements-macos.txt",
            "requirements-rnaseq.txt",
            "requirements-macos-x86_64.lock",
            "requirements-macos-arm64.lock",
        )
    }


def capture_provision_input_state(root: Path, arch: str) -> dict[str, object]:
    """Capture every checkout input that must remain stable until publication."""
    return {
        "git": capture_git_state(root),
        "content_fingerprint": compute_content_fingerprint(root, arch),
        "requirements_sha256": _requirements_hashes(root / "python_embedded"),
        "backend_sources": backend_source_inventory(root / "python_embedded"),
    }


def require_provision_input_state_unchanged(
    root: Path, arch: str, expected: dict[str, object]
) -> None:
    """Fail closed when any checkout input changes during provisioning."""
    current = capture_provision_input_state(root, arch)
    changed = sorted(
        name for name in expected.keys() | current.keys() if expected.get(name) != current.get(name)
    )
    if changed:
        raise RuntimeError(
            "Provision inputs changed during provisioning: " + ", ".join(changed)
        )


def runtime_relative_path(runtime: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(runtime.resolve()).as_posix()
    except ValueError as exc:
        raise RuntimeError(f"Runtime manifest path escapes runtime: {path}") from exc


def runtime_tree_sha256(runtime: Path) -> str:
    """Hash the package-stable logical file tree except its head-bound manifest."""
    digest = hashlib.sha256()
    if not runtime.is_dir():
        raise RuntimeError(f"Runtime tree is missing: {runtime}")
    resolved_runtime = runtime.resolve(strict=True)
    for path in sorted(
        runtime.rglob("*"),
        key=lambda candidate: candidate.relative_to(runtime).as_posix().encode("utf-8"),
    ):
        relative = path.relative_to(runtime).as_posix()
        if relative == "easycris_runtime_manifest.json":
            continue
        link_metadata = path.lstat()
        # Tauri dereferences file symlinks and omits empty directories while
        # copying macOS resources. Match the JavaScript validator's logical-file
        # digest without ever following a link outside the runtime.
        if stat.S_ISDIR(link_metadata.st_mode):
            continue
        metadata = link_metadata
        if path.is_symlink():
            resolved_target = path.resolve(strict=True)
            try:
                resolved_target.relative_to(resolved_runtime)
            except ValueError as exc:
                raise RuntimeError(
                    f"Runtime tree symlink escapes runtime: {path}"
                ) from exc
            metadata = resolved_target.stat()
        if not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError(f"Unsupported runtime tree entry: {path}")
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(f"{stat.S_IMODE(metadata.st_mode):04o}".encode("ascii"))
        digest.update(b"\0")
        digest.update(b"file\0")
        digest.update(sha256(path).encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest()


def _installed_distribution_rows(
    interpreter: Path, root: Path, logger: ProvisionLogger
) -> list[dict[str, str]]:
    script = (
        "import importlib.metadata,json;"
        "print(json.dumps([{'name':d.metadata['Name'],'version':d.version} "
        "for d in importlib.metadata.distributions() if d.metadata.get('Name')],sort_keys=True))"
    )
    output = run_captured(
        [str(interpreter), "-I", "-B", "-c", script],
        root=root,
        logger=logger,
        env=_clean_python_environment(),
    )
    parsed = json.loads(output)
    if not isinstance(parsed, list) or not parsed:
        raise RuntimeError("Bundled interpreter distribution inventory is empty")
    rows: list[dict[str, str]] = []
    for row in parsed:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("name"), str)
            or not isinstance(row.get("version"), str)
        ):
            raise RuntimeError("Bundled interpreter distribution inventory is malformed")
        rows.append({"name": row["name"], "version": row["version"]})
    return rows


def validate_final_distribution_inventory(
    installed_distributions: Iterable[dict[str, str]] | dict[str, str],
    entries: Iterable[LockEntry],
) -> list[dict[str, str]]:
    if isinstance(installed_distributions, dict):
        rows = [
            {"name": str(name), "version": str(version)}
            for name, version in installed_distributions.items()
        ]
    else:
        rows = list(installed_distributions)
    installed: dict[str, str] = {}
    duplicates: list[str] = []
    for row in rows:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("name"), str)
            or not isinstance(row.get("version"), str)
        ):
            raise RuntimeError("Malformed final runtime distribution metadata")
        name = row["name"].lower().replace("_", "-").replace(".", "-")
        if name in installed:
            duplicates.append(name)
        else:
            installed[name] = row["version"]
    if duplicates:
        raise RuntimeError(
            "duplicate final runtime distribution metadata: "
            + ", ".join(sorted(set(duplicates)))
        )
    expected = {entry.name: entry.version for entry in entries}
    if len(rows) != len(expected) or installed != expected:
        missing = sorted(f"{name}=={version}" for name, version in expected.items() if name not in installed)
        extra = sorted(f"{name}=={version}" for name, version in installed.items() if name not in expected)
        drifted = sorted(
            f"{name}: lock={expected[name]}, runtime={installed[name]}"
            for name in expected.keys() & installed.keys()
            if expected[name] != installed[name]
        )
        raise RuntimeError(
            "Unexpected final runtime distribution inventory: "
            f"missing={missing}, extra={extra}, drifted={drifted}"
        )
    return [{"name": name, "version": installed[name]} for name in sorted(installed)]


def final_runtime_distribution_inventory(
    runtime: Path, entries: Iterable[LockEntry], root: Path, logger: ProvisionLogger
) -> list[dict[str, str]]:
    installed = _installed_distribution_rows(
        runtime / "bin" / "python3.12", root, logger
    )
    return validate_final_distribution_inventory(installed, entries)


def _assert_manifest_privacy(value: object) -> None:
    if isinstance(value, dict):
        for nested in value.values():
            _assert_manifest_privacy(nested)
    elif isinstance(value, list):
        for nested in value:
            _assert_manifest_privacy(nested)
    elif isinstance(value, str):
        lowered = value.lower()
        if (
            "file://" in lowered
            or "/users/" in lowered
            or "/private/var/folders/" in lowered
            or re.search(r"[a-z]:\\\\users\\\\", lowered)
        ):
            raise RuntimeError("Runtime manifest contains a private absolute build path")


def _write_runtime_manifest(
    *,
    root: Path,
    runtime: Path,
    output: Path,
    arch: str,
    head: str,
    clean_tree: bool,
    dirty_count: int,
    pin: dict[str, str],
    interpreter: dict,
    wheel_hashes: dict[str, str],
    source_provenance: dict | None,
    source_inventory: dict,
    runtime_distributions: list[dict[str, str]],
    requirements_hashes: dict[str, str],
    macho_thinning: list[dict[str, object]],
    macho_inventory: dict,
    probe_results: dict[str, dict],
    development_reuse: bool,
    fingerprint: str,
    logger: ProvisionLogger,
) -> Path:
    validate_macho_thinning_provenance(macho_thinning, macho_inventory)
    manifest = {
        "schema_version": BOOTSTRAP_SCHEMA_VERSION,
        "head_sha": head,
        "clean_tree": clean_tree,
        "dirty_entry_count": dirty_count,
        "development_reuse": development_reuse,
        "content_fingerprint": fingerprint,
        "architecture": arch,
        "support_floor": "14.0",
        "archive": pin,
        "interpreter": interpreter,
        "requirements_sha256": requirements_hashes,
        "wheel_archive_sha256": wheel_hashes,
        "intel_gseapy_source_build": source_provenance,
        "backend_sources": source_inventory,
        "runtime_distributions": runtime_distributions,
        "universal_macho_thinning": macho_thinning,
        "macho_inventory": macho_inventory,
        "probe_results": probe_results,
        "runtime_tree_sha256": runtime_tree_sha256(runtime),
    }
    _assert_manifest_privacy(manifest)
    path = runtime / "easycris_runtime_manifest.json"
    atomic_write_json(path, manifest)
    shutil.copy2(path, output / "easycris_runtime_manifest.json")
    return path


def _populate_artifact_cache(
    *,
    root: Path,
    cache_artifacts: Path,
    archive_path: Path,
    wheelhouse: Path,
    pin: dict[str, str],
    entries: tuple[LockEntry, ...],
) -> None:
    """Atomically cache only immutable CPython and exact lock artifacts."""
    _validate_managed_path(root, cache_artifacts, "python-runtime-cache")
    if sha256(archive_path) != pin["sha256"]:
        raise RuntimeError("Cannot cache CPython archive with a mismatched pin hash")
    admitted = validate_download_set(entries, wheelhouse)
    cache_artifacts.parent.mkdir(parents=True, exist_ok=True)
    candidate = cache_artifacts.with_name("artifacts.candidate")
    _validate_managed_path(root, candidate, "python-runtime-cache")
    if candidate.exists() or candidate.is_symlink():
        if candidate.is_dir() and not candidate.is_symlink():
            shutil.rmtree(candidate)
        else:
            candidate.unlink()
    try:
        cached_archive = candidate / "cpython" / pin["filename"]
        cached_archive.parent.mkdir(parents=True)
        shutil.copy2(archive_path, cached_archive, follow_symlinks=False)
        shutil.copytree(wheelhouse, candidate / "wheelhouse", symlinks=False)
        if sha256(cached_archive) != pin["sha256"]:
            raise RuntimeError("Cached CPython archive changed during population")
        if validate_download_set(entries, candidate / "wheelhouse") != admitted:
            raise RuntimeError("Cached wheelhouse changed during population")
        if cache_artifacts.exists():
            shutil.rmtree(cache_artifacts)
        os.replace(candidate, cache_artifacts)
    finally:
        if candidate.exists() or candidate.is_symlink():
            if candidate.is_dir() and not candidate.is_symlink():
                shutil.rmtree(candidate)
            else:
                candidate.unlink()


def provision(
    *, root: Path = ROOT, reuse_dev_cache: bool = False, environment: dict[str, str] | None = None
) -> Path:
    environment = dict(os.environ if environment is None else environment)
    validate_dev_cache_request(reuse_dev_cache, environment)
    arch = validate_host()
    pin = select_archive_pin("Darwin", arch)
    input_state = capture_provision_input_state(root, arch)
    git_state = input_state["git"]
    assert isinstance(git_state, dict)
    head = str(git_state["head"])
    clean_tree = bool(git_state["clean_tree"])
    dirty_count = int(git_state["dirty_entry_count"])
    output = root / "_tmp" / "python-runtime" / head / arch
    _ensure_ignored(root, output / "provision.log")
    _safe_recreate_output(root, output, arch)
    logger = ProvisionLogger(output / "provision.log")
    checkpoint = output / "checkpoint.json"
    atomic_write_json(checkpoint, {"status": "running", "head_sha": head, "architecture": arch})
    runtime = root / "python_embedded" / "runtime"
    fingerprint = str(input_state["content_fingerprint"])
    requirements_hashes = input_state["requirements_sha256"]
    assert isinstance(requirements_hashes, dict)
    cache_artifacts = (
        root / "_tmp" / "python-runtime-cache" / fingerprint / arch / "artifacts"
    )
    _validate_managed_path(root, cache_artifacts, "python-runtime-cache")
    source_inventory = input_state["backend_sources"]
    assert isinstance(source_inventory, dict)
    lock_path = root / "python_embedded" / f"requirements-macos-{arch}.lock"
    entries = parse_hashed_lock(lock_path)
    validate_lock_matches_requirements(
        entries,
        root / "python_embedded" / "requirements-macos.txt",
        root / "python_embedded" / "requirements-rnaseq.txt",
    )
    development_reuse = False
    try:
        source_provenance = None
        wheel_hashes: dict[str, str] = {}
        archive_path = output / "archive" / pin["filename"]
        cached_archive = cache_artifacts / "cpython" / pin["filename"]
        if reuse_dev_cache and _copy_hash_verified_file(
            cached_archive, archive_path, pin["sha256"]
        ):
            logger.phase("reuse-hash-verified-cpython-archive")
            development_reuse = True
        else:
            logger.phase("download-pinned-cpython")
            _download_archive(pin, archive_path, logger)
        logger.phase("verify-and-extract-cpython")
        extracted = output / "extracted"
        verify_and_extract_archive(archive_path, extracted, expected_sha256=pin["sha256"])
        atomic_materialize_runtime(extracted / "python", runtime)
        logger.phase("verify-relocated-interpreter")
        interpreter = _verify_relocated_interpreter(runtime / "bin" / "python3.12", arch, root, logger)
        logger.phase("prepare-build-environment")
        builder = _ensure_builder(root, logger)
        wheelhouse = output / "wheelhouse"
        cached_wheel_hashes = None
        if reuse_dev_cache:
            cached_wheel_hashes = _reuse_cached_wheelhouse(
                cache_artifacts / "wheelhouse", wheelhouse, entries
            )
        if cached_wheel_hashes is not None:
            logger.phase("reuse-hash-verified-lock-artifacts")
            _write_locked_group_inputs(entries, output, arch)
            wheel_hashes = cached_wheel_hashes
            development_reuse = True
        else:
            logger.phase("download-hash-locked-dependencies")
            wheelhouse, wheel_hashes = _download_locked_groups(
                root=root, output=output, builder=builder, entries=entries, arch=arch, logger=logger
            )
        logger.phase("install-hash-locked-dependencies")
        source_provenance = _install_locked_dependencies(
            root=root, output=output, runtime=runtime, builder=builder, entries=entries,
            wheelhouse=wheelhouse, arch=arch, logger=logger,
        )
        logger.phase("apply-and-validate-rnaseq-overlay")
        _apply_and_validate_overlay(root=root, runtime=runtime, logger=logger)
        logger.phase("prune-provisioning-artifacts")
        prune_provisioning_artifacts(runtime)
        logger.phase("stage-backend-sources")
        site_packages = runtime / "lib" / "python3.12" / "site-packages"
        source_inventory = stage_backend_sources(root / "python_embedded", site_packages)
        logger.phase("validate-final-runtime-inventory")
        validate_pruned_runtime(runtime, root, logger)
        runtime_distributions = final_runtime_distribution_inventory(
            runtime, entries, root, logger
        )
        logger.phase("thin-universal-macho-files")
        macho_thinning = thin_universal_machos(runtime, arch, root, logger)
        logger.phase("validate-final-runtime-imports")
        _verify_required_imports(root=root, runtime=runtime, logger=logger)
        logger.phase("run-protocol-and-export-probes")
        probe_results = _run_real_probes(runtime, output)
        logger.phase("validate-macho-inventory")
        macho_inventory = _verify_macho_inventory(runtime, arch, root, logger)
        logger.phase("revalidate-provision-inputs")
        require_provision_input_state_unchanged(root, arch, input_state)
        logger.phase("write-manifest-and-checkpoint")
        manifest_path = _write_runtime_manifest(
            root=root, runtime=runtime, output=output, arch=arch, head=head,
            clean_tree=clean_tree, dirty_count=dirty_count, pin=pin, interpreter=interpreter,
            wheel_hashes=wheel_hashes, source_provenance=source_provenance,
            source_inventory=source_inventory, runtime_distributions=runtime_distributions,
            requirements_hashes=requirements_hashes,
            macho_thinning=macho_thinning,
            macho_inventory=macho_inventory,
            probe_results=probe_results, development_reuse=development_reuse,
            fingerprint=fingerprint, logger=logger,
        )
        manifest_hash = sha256(manifest_path)
        require_provision_input_state_unchanged(root, arch, input_state)
        mark_checkpoint_passed(checkpoint, manifest_hash, probe_results)
        _populate_artifact_cache(
            root=root,
            cache_artifacts=cache_artifacts,
            archive_path=archive_path,
            wheelhouse=wheelhouse,
            pin=pin,
            entries=entries,
        )
        logger.phase("complete")
        return runtime
    except Exception as exc:
        logger.write(traceback.format_exc())
        atomic_write_json(
            checkpoint,
            {"status": "failed", "head_sha": head, "architecture": arch, "error": str(exc)},
        )
        raise


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reuse-dev-cache", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        runtime = provision(reuse_dev_cache=args.reuse_dev_cache)
    except Exception as exc:
        try:
            head = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
            ).stdout.strip()
            arch = platform.machine()
            tail = managed_failure_log_tail(ROOT, head, arch)
            if tail:
                print(tail, file=sys.stderr)
        except Exception as log_error:
            print(f"provision-log-rejected: {log_error}", file=sys.stderr)
        finally:
            print(f"macos-python-runtime-failed: {exc}", file=sys.stderr)
        return 1
    print(f"macos-python-runtime-ok root={runtime}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
