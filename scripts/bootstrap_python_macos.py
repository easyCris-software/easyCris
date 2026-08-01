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
    by_archive = {
        archive: entry for entry in selected for archive in entry.archives
    }
    actual = tuple(
        path
        for path in sorted(directory.iterdir())
        if path.is_file() and path.name.endswith((".whl", ".tar.gz", ".zip"))
    )
    for path in actual:
        entry = by_archive.get(path.name)
        if entry is None:
            raise RuntimeError(f"Downloaded unlocked archive: {path.name}")
        actual_hash = sha256(path)
        if actual_hash not in entry.hashes:
            raise RuntimeError(f"Downloaded archive hash mismatch: {path.name}")
    actual_names = {path.name for path in actual}
    for entry in selected:
        if not actual_names.intersection(entry.archives):
            raise RuntimeError(f"Missing locked archive for {entry.name}=={entry.version}")
    return {path.name: sha256(path) for path in actual}


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
    """Require the target architecture and a deployment floor no newer than 14.0."""
    runner = runner or run_checked
    inspected = _run(runner, ["/usr/bin/file", "-b", str(path)], ROOT)
    architectures = set(re.findall(r"(?<![A-Za-z0-9_])(x86_64|arm64)(?![A-Za-z0-9_])", inspected))
    if "Mach-O" not in inspected or arch not in architectures:
        raise RuntimeError(f"Mach-O does not contain native {arch}: {path}: {inspected.strip()}")
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
        "architectures": [candidate for candidate in ("x86_64", "arm64") if candidate in architectures],
        "minimum_macos_versions": versions,
    }


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
    if not path.is_file():
        return ""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(lines[-limit:])


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
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True
    ).stdout.strip()
    dirty_lines = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    return head, not dirty_lines, len(dirty_lines)


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
    """Remove installer metadata, launchers, pip/ensurepip, and bytecode."""
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
    forbidden.extend(runtime.rglob("*.whl"))
    forbidden.extend(runtime.rglob("__pycache__"))
    forbidden.extend(runtime.rglob("*.pyc"))
    forbidden.extend(runtime.rglob("direct_url.json"))
    for name in ("wheelhouse", ".venv-macos-build", "provision.log"):
        forbidden.extend(runtime.rglob(name))
    if forbidden:
        relative = sorted({path.relative_to(runtime).as_posix() for path in forbidden})
        raise RuntimeError(f"Final runtime contains provisioning-only artifacts: {relative}")
    validate_no_local_build_paths(runtime, local_build_roots(root))
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
    return {"count": len(records), "sha256": hashlib.sha256(encoded).hexdigest(), "kaleido_helpers": kaleido}


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


def runtime_relative_path(runtime: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(runtime.resolve()).as_posix()
    except ValueError as exc:
        raise RuntimeError(f"Runtime manifest path escapes runtime: {path}") from exc


def runtime_tree_sha256(runtime: Path) -> str:
    """Hash every runtime entry except the head-bound manifest itself."""
    digest = hashlib.sha256()
    if not runtime.is_dir():
        raise RuntimeError(f"Runtime tree is missing: {runtime}")
    for path in sorted(runtime.rglob("*"), key=lambda candidate: candidate.relative_to(runtime).as_posix()):
        relative = path.relative_to(runtime).as_posix()
        if relative == "easycris_runtime_manifest.json":
            continue
        metadata = path.lstat()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(f"{stat.S_IMODE(metadata.st_mode):04o}".encode("ascii"))
        digest.update(b"\0")
        if path.is_symlink():
            digest.update(b"symlink\0")
            digest.update(os.readlink(path).encode("utf-8"))
        elif path.is_dir():
            digest.update(b"directory")
        elif path.is_file():
            digest.update(b"file\0")
            digest.update(sha256(path).encode("ascii"))
        else:
            raise RuntimeError(f"Unsupported runtime tree entry: {path}")
        digest.update(b"\0")
    return digest.hexdigest()


def _installed_distribution_versions(
    interpreter: Path, root: Path, logger: ProvisionLogger
) -> dict[str, str]:
    script = (
        "import importlib.metadata,json;"
        "print(json.dumps({d.metadata['Name']:d.version for d in importlib.metadata.distributions() "
        "if d.metadata.get('Name')},sort_keys=True))"
    )
    output = run_captured(
        [str(interpreter), "-I", "-B", "-c", script],
        root=root,
        logger=logger,
        env=_clean_python_environment(),
    )
    parsed = json.loads(output)
    if not isinstance(parsed, dict) or not parsed:
        raise RuntimeError("Bundled interpreter distribution inventory is empty")
    return {str(name): str(version) for name, version in parsed.items()}


def validate_final_distribution_inventory(
    installed_versions: dict[str, str], entries: Iterable[LockEntry]
) -> list[dict[str, str]]:
    installed = {
        name.lower().replace("_", "-").replace(".", "-"): str(version)
        for name, version in installed_versions.items()
    }
    expected = {entry.name: entry.version for entry in entries}
    if installed != expected:
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
    installed = _installed_distribution_versions(
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
    macho_inventory: dict,
    probe_results: dict[str, dict],
    development_reuse: bool,
    fingerprint: str,
    logger: ProvisionLogger,
) -> Path:
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
        "requirements_sha256": _requirements_hashes(root / "python_embedded"),
        "wheel_archive_sha256": wheel_hashes,
        "intel_gseapy_source_build": source_provenance,
        "backend_sources": source_inventory,
        "runtime_distributions": runtime_distributions,
        "macho_inventory": macho_inventory,
        "probe_results": probe_results,
        "runtime_tree_sha256": runtime_tree_sha256(runtime),
    }
    _assert_manifest_privacy(manifest)
    path = runtime / "easycris_runtime_manifest.json"
    atomic_write_json(path, manifest)
    shutil.copy2(path, output / "easycris_runtime_manifest.json")
    return path


def _valid_cache_snapshot(cache_runtime: Path, arch: str, fingerprint: str) -> bool:
    manifest_path = cache_runtime / "easycris_runtime_manifest.json"
    if not (cache_runtime / "bin" / "python3.12").is_file() or not manifest_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    expected_tree = manifest.get("runtime_tree_sha256")
    if not isinstance(expected_tree, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_tree):
        return False
    try:
        actual_tree = runtime_tree_sha256(cache_runtime)
    except (OSError, RuntimeError):
        return False
    return (
        manifest.get("architecture") == arch
        and manifest.get("content_fingerprint") == fingerprint
        and actual_tree == expected_tree
    )


def _populate_dev_cache(root: Path, runtime: Path, cache_runtime: Path) -> None:
    _validate_managed_path(root, cache_runtime, "python-runtime-cache")
    cache_runtime.parent.mkdir(parents=True, exist_ok=True)
    temporary = cache_runtime.with_name("runtime-snapshot.candidate")
    if temporary.exists():
        shutil.rmtree(temporary)
    shutil.copytree(runtime, temporary, symlinks=True)
    if cache_runtime.exists():
        shutil.rmtree(cache_runtime)
    os.replace(temporary, cache_runtime)


def provision(
    *, root: Path = ROOT, reuse_dev_cache: bool = False, environment: dict[str, str] | None = None
) -> Path:
    environment = dict(os.environ if environment is None else environment)
    validate_dev_cache_request(reuse_dev_cache, environment)
    arch = validate_host()
    pin = select_archive_pin("Darwin", arch)
    head, clean_tree, dirty_count = _git_state(root)
    output = root / "_tmp" / "python-runtime" / head / arch
    _ensure_ignored(root, output / "provision.log")
    _safe_recreate_output(root, output, arch)
    logger = ProvisionLogger(output / "provision.log")
    checkpoint = output / "checkpoint.json"
    atomic_write_json(checkpoint, {"status": "running", "head_sha": head, "architecture": arch})
    runtime = root / "python_embedded" / "runtime"
    fingerprint = compute_content_fingerprint(root, arch)
    cache_runtime = root / "_tmp" / "python-runtime-cache" / fingerprint / arch / "runtime-snapshot"
    _validate_managed_path(root, cache_runtime, "python-runtime-cache")
    source_inventory = backend_source_inventory(root / "python_embedded")
    lock_path = root / "python_embedded" / f"requirements-macos-{arch}.lock"
    entries = parse_hashed_lock(lock_path)
    validate_lock_matches_requirements(
        entries,
        root / "python_embedded" / "requirements-macos.txt",
        root / "python_embedded" / "requirements-rnaseq.txt",
    )
    development_reuse = reuse_dev_cache and _valid_cache_snapshot(cache_runtime, arch, fingerprint)
    try:
        source_provenance = None
        wheel_hashes: dict[str, str] = {}
        if development_reuse:
            logger.phase("reuse-validated-development-cache")
            atomic_materialize_runtime(cache_runtime, runtime)
        else:
            logger.phase("download-pinned-cpython")
            archive_path = output / "archive" / pin["filename"]
            _download_archive(pin, archive_path, logger)
            logger.phase("verify-and-extract-cpython")
            extracted = output / "extracted"
            verify_and_extract_archive(archive_path, extracted, expected_sha256=pin["sha256"])
            atomic_materialize_runtime(extracted / "python", runtime)
        logger.phase("verify-relocated-interpreter")
        interpreter = _verify_relocated_interpreter(runtime / "bin" / "python3.12", arch, root, logger)
        if not development_reuse:
            logger.phase("prepare-build-environment")
            builder = _ensure_builder(root, logger)
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
        if not development_reuse:
            logger.phase("stage-backend-sources")
            site_packages = runtime / "lib" / "python3.12" / "site-packages"
            source_inventory = stage_backend_sources(root / "python_embedded", site_packages)
        logger.phase("validate-final-runtime-inventory")
        validate_pruned_runtime(runtime, root, logger)
        runtime_distributions = final_runtime_distribution_inventory(
            runtime, entries, root, logger
        )
        logger.phase("validate-final-runtime-imports")
        _verify_required_imports(root=root, runtime=runtime, logger=logger)
        logger.phase("run-protocol-and-export-probes")
        probe_results = _run_real_probes(runtime, output)
        logger.phase("validate-macho-inventory")
        macho_inventory = _verify_macho_inventory(runtime, arch, root, logger)
        if development_reuse:
            cached_manifest = json.loads((runtime / "easycris_runtime_manifest.json").read_text(encoding="utf-8"))
            wheel_hashes = cached_manifest.get("wheel_archive_sha256", {})
            source_provenance = cached_manifest.get("intel_gseapy_source_build")
        logger.phase("write-manifest-and-checkpoint")
        manifest_path = _write_runtime_manifest(
            root=root, runtime=runtime, output=output, arch=arch, head=head,
            clean_tree=clean_tree, dirty_count=dirty_count, pin=pin, interpreter=interpreter,
            wheel_hashes=wheel_hashes, source_provenance=source_provenance,
            source_inventory=source_inventory, runtime_distributions=runtime_distributions,
            macho_inventory=macho_inventory,
            probe_results=probe_results, development_reuse=development_reuse,
            fingerprint=fingerprint, logger=logger,
        )
        manifest_hash = sha256(manifest_path)
        mark_checkpoint_passed(checkpoint, manifest_hash, probe_results)
        if not development_reuse:
            _populate_dev_cache(root, runtime, cache_runtime)
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
            log = ROOT / "_tmp" / "python-runtime" / head / arch / "provision.log"
            tail = failure_log_tail(log)
            if tail:
                print(tail, file=sys.stderr)
        finally:
            print(f"macos-python-runtime-failed: {exc}", file=sys.stderr)
        return 1
    print(f"macos-python-runtime-ok root={runtime}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
