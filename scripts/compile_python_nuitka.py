#!/usr/bin/env python3
"""Compile Python backends with Nuitka for hardened Windows releases.

Usage:
    python compile_python_nuitka.py              # compile all backends
    python compile_python_nuitka.py stats        # compile only stats
    python compile_python_nuitka.py rnaseq plot  # compile specific backends
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import os
import platform
import stat
import re
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PYTHON_DIR = ROOT / "python_embedded"
PYTHON_DEPENDENCIES_DIR = PYTHON_DIR / "python_dependencies"
DIST_DIR = PYTHON_DIR / "dist"
COMPILE_SOURCE_DIR = DIST_DIR / "_compile_source"
NUITKA_BOOTSTRAP_SCRIPT = ROOT / "scripts" / "run_nuitka_from_builder.py"
TARGET_PLATFORM = os.environ.get("EASYCRIS_TARGET_PLATFORM", sys.platform)
TARGET_ARCH = os.environ.get("EASYCRIS_TARGET_ARCH", platform.machine())
PYTHON_EXE = ROOT / "python_embedded" / "python.exe"
DEFAULT_NUITKA_BUILD_PYTHON = ROOT / ".venv-nuitka-build" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
NUITKA_BUILD_PYTHON = Path(
    os.environ.get("EASYCRIS_NUITKA_BUILD_PYTHON", str(DEFAULT_NUITKA_BUILD_PYTHON))
)
VC_RUNTIME_DLLS_REQUIRED = (
    "msvcp140.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "vcomp140.dll",
)
CRITICAL_EXCLUDED_DLL_NAMES = {"libffi-8.dll", "libcrypto-3.dll", "libssl-3.dll"}
CRITICAL_EXCLUDED_USED_BY = {"_ctypes.pyd", "_hashlib.pyd", "_ssl.pyd"}
SOURCE_EXCLUDED_DIR_NAMES = {
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "dist",
    "dist_debug",
    "dist_build",
    "python_dependencies",
    "Scripts",
    "DLLs",
    "libs",
    "tcl",
}
SOURCE_EXCLUDED_SUFFIXES = {
    ".pyd",
    ".dll",
    ".exe",
    ".lib",
    ".obj",
    ".pdb",
    ".zip",
    ".whl",
    ".msi",
}


def executable_name(backend: str, target_platform: str) -> str:
    return f"{backend}.exe" if target_platform == "win32" else backend


def platform_nuitka_args(target_platform: str, target_arch: str) -> list[str]:
    if target_platform == "win32":
        return ["--windows-console-mode=force", "--msvc=latest"]
    if target_platform == "darwin":
        if target_arch not in {"x86_64", "arm64"}:
            raise ValueError(f"Unsupported Darwin architecture: {target_arch}")
        return [f"--macos-target-arch={target_arch}"]
    raise ValueError(f"Unsupported target platform: {target_platform}")


def _version_key_from_path(path: Path) -> tuple[int, ...]:
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", str(path))
    if not match:
        return (0, 0, 0)
    return tuple(int(part) for part in match.groups())


def _candidate_score(path: Path) -> tuple[int, tuple[int, ...]]:
    lower = str(path).lower().replace("/", "\\")
    score = 0
    if "\\x64\\" in lower:
        score += 100
    if "onecore" in lower:
        score -= 10
    return score, _version_key_from_path(path)


def _find_vswhere_executable() -> Path | None:
    candidates: list[Path] = []
    for env_key in ("ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"):
        env_value = os.environ.get(env_key, "").strip()
        if env_value:
            candidates.append(Path(env_value) / "Microsoft Visual Studio" / "Installer" / "vswhere.exe")

    # Canonical fallback paths (env variables can be malformed on some systems).
    candidates.extend(
        [
            Path(r"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"),
            Path(r"C:\Program Files\Microsoft Visual Studio\Installer\vswhere.exe"),
        ]
    )

    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def _discover_redist_roots() -> list[Path]:
    roots: list[Path] = []
    seen: set[str] = set()

    override = os.environ.get("EASYCRIS_MSVC_REDIST_ROOT", "").strip()
    if override:
        override_path = Path(override)
        if override_path.exists():
            return [override_path]
        print(f"[compile-python] WARNING: EASYCRIS_MSVC_REDIST_ROOT does not exist: {override_path}")

    vswhere = _find_vswhere_executable()
    if vswhere:
        try:
            result = subprocess.run(
                [
                    str(vswhere),
                    "-all",
                    "-products",
                    "*",
                    "-prerelease",
                    "-property",
                    "installationPath",
                ],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    install_path = line.strip()
                    if not install_path:
                        continue
                    redist_root = Path(install_path) / "VC" / "Redist" / "MSVC"
                    key = str(redist_root).lower()
                    if redist_root.exists() and key not in seen:
                        roots.append(redist_root)
                        seen.add(key)
        except Exception as exc:
            print(f"[compile-python] WARNING: vswhere discovery failed: {exc}")

    # Additional filesystem fallback scan for common VS install trees.
    fallback_bases: list[Path] = []
    for env_key in ("ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"):
        env_value = os.environ.get(env_key, "").strip()
        if env_value:
            fallback_bases.append(Path(env_value) / "Microsoft Visual Studio")
    fallback_bases.extend(
        [
            Path(r"C:\Program Files (x86)\Microsoft Visual Studio"),
            Path(r"C:\Program Files\Microsoft Visual Studio"),
            Path(r"D:\Program Files\Microsoft Visual Studio"),
        ]
    )

    for base in fallback_bases:
        if not base.exists():
            continue
        for redist_root in base.glob("*/*/VC/Redist/MSVC"):
            key = str(redist_root).lower()
            if redist_root.exists() and key not in seen:
                roots.append(redist_root)
                seen.add(key)

    return roots


def _find_best_redist_dll(dll_name: str, redist_roots: list[Path]) -> Path | None:
    candidates: list[Path] = []
    for redist_root in redist_roots:
        candidates.extend(p for p in redist_root.rglob(dll_name) if p.is_file())

    if not candidates:
        return None

    # Enforce x64 payloads only for this 64-bit Windows build pipeline.
    x64_candidates = []
    for candidate in candidates:
        lower = str(candidate).lower().replace("/", "\\")
        if "\\x64\\" in lower or "\\amd64\\" in lower:
            x64_candidates.append(candidate)
    if not x64_candidates:
        return None

    return max(x64_candidates, key=_candidate_score)


def bundle_msvc_runtime_dlls(name: str) -> None:
    dist_path = DIST_DIR / f"{name}.dist"
    if not dist_path.exists():
        raise RuntimeError(f"Missing dist folder for VC runtime bundling: {dist_path}")

    redist_roots = _discover_redist_roots()
    if not redist_roots:
        raise RuntimeError(
            "Could not discover Visual Studio redist roots. "
            "Set EASYCRIS_MSVC_REDIST_ROOT to a valid ...\\VC\\Redist\\MSVC path."
        )

    copied: list[str] = []
    missing_required: list[str] = []
    for dll_name in VC_RUNTIME_DLLS_REQUIRED:
        source = _find_best_redist_dll(dll_name, redist_roots)
        if source is None:
            missing_required.append(dll_name)
            continue
        target = dist_path / dll_name
        shutil.copy2(source, target)
        copied.append(dll_name)

    if missing_required:
        raise RuntimeError(
            "Missing required VC runtime DLL(s) in official VS redist paths: "
            f"{', '.join(missing_required)}"
        )

    print(f"[compile-python] VC runtime bundled for {name}: {', '.join(copied)}")

def _get_compile_timeout_secs() -> int:
    raw = os.environ.get("EASYCRIS_NUITKA_TIMEOUT_SECS", "").strip()
    if not raw:
        return 3 * 60 * 60
    try:
        value = int(raw)
        if value <= 0:
            raise ValueError
        return value
    except ValueError:
        print(
            "[compile-python] WARNING: invalid EASYCRIS_NUITKA_TIMEOUT_SECS value; using default 10800s."
        )
        return 3 * 60 * 60


# Heavy standalone builds (stats stack) can exceed 30 minutes on Windows.
COMPILE_TIMEOUT_SECS = _get_compile_timeout_secs()

BACKENDS = (
    {
        "entrypoint": "stats.py",
        "name": "stats",
        "extra_args": (
            "--include-package=numpy",
            "--include-package=scipy",
            "--include-package=pandas",
            "--include-package=statsmodels",
            "--include-package=lifelines",
            "--include-package=lmfit",
        ),
        "allow_unittest": True,
    },
    {
        "entrypoint": "rnaseq.py",
        "name": "rnaseq",
        "extra_args": (),
        "allow_unittest": True,
    },
    {
        "entrypoint": "plot.py",
        "name": "plot",
        "extra_args": (
            "--include-package=plotly",
            "--include-package=kaleido",
            "--include-package=PIL",
        ),
        "allow_unittest": False,
    },
)

BACKEND_NAMES = {b["name"] for b in BACKENDS}
# Aliases for the old _backend names â€” accepted for one release window (v0.1.25).
# Pass e.g. "stats_backend" on the CLI and it compiles the "stats" backend.
BACKEND_ALIASES: dict[str, str] = {
    "stats_backend": "stats",
    "rnaseq_backend": "rnaseq",
    "plot_backend": "plot",
}


def kill_orphan_python_workers() -> None:
    """Kill stale compile-chain Python workers for this repo only."""
    if TARGET_PLATFORM != "win32":
        return
    try:
        repo_marker = f"\\{ROOT.parent.name}\\{ROOT.name}".replace("'", "''")
        current_pid = os.getpid()
        ps_script = f"""
$repoMarker = '{repo_marker}'
$selfPid = {current_pid}
$procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object {{
    $_.ProcessId -ne $selfPid -and
    $_.CommandLine -and
    $_.CommandLine.ToLower().Contains($repoMarker.ToLower()) -and
    (
        $_.CommandLine -like "*compile_python_nuitka.py*" -or
        $_.CommandLine -like "*run_nuitka_from_builder.py*" -or
        $_.CommandLine -like "*nuitka\\__main__.py*" -or
        $_.CommandLine -like "*scons.py*"
    )
}}
$count = @($procs).Count
if ($count -gt 0) {{
    Write-Output \"Killing $count compile-chain python.exe orphan process(es)\"
    $procs | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}
}}
"""
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=25,
        )
        if result.stdout.strip():
            print(f"[compile-python] {result.stdout.strip()}")
        if result.returncode != 0 and result.stderr.strip():
            print(f"[compile-python] WARNING: Orphan cleanup stderr: {result.stderr.strip()}")
    except Exception as exc:
        print(f"[compile-python] WARNING: Orphan cleanup failed: {exc}")


def run_checked(command: list[str], timeout: int = COMPILE_TIMEOUT_SECS, env: dict[str, str] | None = None) -> None:
    print(f"[compile-python] Running: {' '.join(command)}")
    try:
        completed = subprocess.run(
            command, cwd=str(ROOT), check=False, timeout=timeout, env=env,
        )
    except subprocess.TimeoutExpired:
        print(f"[compile-python] ERROR: Compilation timed out after {timeout}s, cleaning up...")
        kill_orphan_python_workers()
        raise RuntimeError(f"Compilation timed out after {timeout} seconds")

    if completed.returncode != 0:
        print(f"[compile-python] ERROR: Exit code {completed.returncode}, cleaning up...")
        kill_orphan_python_workers()
        raise RuntimeError(f"Command failed with exit code {completed.returncode}")


def remove_previous_outputs(name: str) -> None:
    exe_path = DIST_DIR / executable_name(name, TARGET_PLATFORM)
    dist_path = DIST_DIR / f"{name}.dist"
    build_path = DIST_DIR / f"{name}.build"

    if exe_path.exists():
        exe_path.unlink()
    for target in (dist_path, build_path):
        if not target.exists():
            continue

        def _onerror(func, path, exc_info):
            # Best effort for read-only files on Windows.
            try:
                os.chmod(path, stat.S_IWRITE)
                func(path)
            except Exception:
                pass

        try:
            shutil.rmtree(target, onerror=_onerror)
        except Exception:
            if TARGET_PLATFORM != "win32":
                raise
            # Fallback for stubborn Windows directory locks.
            subprocess.run(
                ["cmd", "/c", "rmdir", "/s", "/q", str(target)],
                cwd=str(ROOT),
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if target.exists():
                raise


def _is_source_file_allowed(path: Path) -> bool:
    if path.name in {"python.exe", "pythonw.exe"}:
        return False
    if path.suffix.lower() in SOURCE_EXCLUDED_SUFFIXES:
        return False
    return True


def _copy_tree_filtered(src: Path, dst: Path) -> None:
    for item in src.iterdir():
        if item.name in SOURCE_EXCLUDED_DIR_NAMES:
            continue
        target = dst / item.name
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            _copy_tree_filtered(item, target)
            continue
        if _is_source_file_allowed(item):
            shutil.copy2(item, target)


def prepare_compile_source_tree(name: str) -> Path:
    """Build a clean source-only staging tree to avoid binary contamination from python_embedded root."""
    staged_root = COMPILE_SOURCE_DIR / name
    if staged_root.exists():
        shutil.rmtree(staged_root, ignore_errors=True)
    staged_root.mkdir(parents=True, exist_ok=True)
    _copy_tree_filtered(PYTHON_DIR, staged_root)
    return staged_root


def prepare_kaleido_executable_payload(name: str) -> Path:
    """
    Stage Kaleido executable payload for deterministic packaging.

    Excludes mutable runtime logs (for example debug.log/chrome_debug.log)
    so local machine artifacts are never bundled into release distributions.
    """
    src = PYTHON_DEPENDENCIES_DIR / "kaleido" / "executable"
    if not src.exists():
        raise RuntimeError(f"Missing Kaleido executable payload directory: {src}")

    staged_payload_dir = COMPILE_SOURCE_DIR / name / "_kaleido_executable_payload"
    if staged_payload_dir.exists():
        shutil.rmtree(staged_payload_dir, ignore_errors=True)

    shutil.copytree(src, staged_payload_dir, ignore=shutil.ignore_patterns("*.log"))
    for log_file in staged_payload_dir.rglob("*.log"):
        log_file.unlink(missing_ok=True)

    native_files = [path for path in staged_payload_dir.rglob("*") if path.is_file() and path.stat().st_mode & stat.S_IXUSR]
    if TARGET_PLATFORM == "darwin":
        if not native_files:
            raise RuntimeError(f"No executable Kaleido payload files found: {staged_payload_dir}")
        for native_file in native_files:
            inspected = subprocess.run(["file", str(native_file)], check=True, capture_output=True, text=True).stdout
            if TARGET_ARCH not in inspected:
                raise RuntimeError(
                    f"Kaleido payload architecture mismatch for {native_file}: expected {TARGET_ARCH}, got {inspected.strip()}"
                )

    return staged_payload_dir


def sync_kaleido_runtime_payload(dist_dir: Path, staged_payload_dir: Path) -> None:
    """
    Ensure Kaleido runtime payload (including executables/DLLs) is present in final dist.

    Nuitka data-dir inclusion can omit executable-class artifacts. We copy the
    sanitized payload after compilation so runtime probing is deterministic.
    """
    target_dir = dist_dir / "kaleido" / "executable"
    if target_dir.exists():
        shutil.rmtree(target_dir, ignore_errors=True)
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(staged_payload_dir, target_dir)


def validate_no_critical_excluded_dlls(report_path: Path, name: str) -> None:
    if not report_path.exists():
        raise RuntimeError(f"Missing Nuitka report for {name}: {report_path}")
    tree = ET.parse(report_path)
    root = tree.getroot()
    critical_matches: list[str] = []
    for node in root.findall(".//excluded_dll"):
        dll_name = (node.attrib.get("name") or "").replace("/", "\\").split("\\")[-1].lower()
        used_by = (node.attrib.get("used_by") or "").lower()
        reason = (node.attrib.get("reason") or "").strip()
        if dll_name in {dll.lower() for dll in CRITICAL_EXCLUDED_DLL_NAMES} or used_by in {
            mod.lower() for mod in CRITICAL_EXCLUDED_USED_BY
        }:
            critical_matches.append(f"{dll_name} (used_by={used_by}, reason={reason})")
    if critical_matches:
        details = "; ".join(critical_matches[:8])
        raise RuntimeError(
            f"Critical excluded DLL(s) detected in {name} report: {details}. "
            "Fix compile input layout before packaging."
        )


def ensure_output(name: str) -> None:
    launcher = executable_name(name, TARGET_PLATFORM)
    exe_path = DIST_DIR / launcher
    dist_path = DIST_DIR / f"{name}.dist"
    dist_exe_path = dist_path / launcher
    exe_exists = exe_path.exists() or dist_exe_path.exists()
    if not exe_exists or not dist_path.exists():
        raise RuntimeError(
            f"Missing Nuitka output for {name}: "
            f"exe_exists={exe_exists} dist_exists={dist_path.exists()} "
            f"top_level_exe_exists={exe_path.exists()} dist_exe_exists={dist_exe_path.exists()}"
        )


def sync_top_level_exe(name: str) -> None:
    """Normalize output contract for the selected target platform."""
    launcher = executable_name(name, TARGET_PLATFORM)
    exe_path = DIST_DIR / launcher
    dist_path = DIST_DIR / f"{name}.dist"
    dist_exe_path = dist_path / launcher

    if not dist_exe_path.exists():
        raise RuntimeError(f"Missing compiled dist executable for {name}: {dist_exe_path}")

    shutil.copy2(dist_exe_path, exe_path)
    print(f"[compile-python] Synced top-level executable for {name}: {exe_path.name}")


def compile_backend(
    entrypoint: str,
    name: str,
    extra_args: tuple[str, ...],
    allow_unittest: bool,
) -> None:
    remove_previous_outputs(name)
    staged_source_root = prepare_compile_source_tree(name)
    kaleido_staged_payload_dir: Path | None = None
    staged_entrypoint = staged_source_root / entrypoint
    if not staged_entrypoint.exists():
        raise RuntimeError(f"Staged entrypoint missing for {name}: {staged_entrypoint}")

    compile_env = os.environ.copy()
    # Make vendored runtime deps visible to Nuitka plugin subprocess checks.
    existing_pythonpath = compile_env.get("PYTHONPATH")
    pythonpath_parts = [str(PYTHON_DEPENDENCIES_DIR)]
    if TARGET_PLATFORM == "win32":
        pythonpath_parts.extend(
            [
                str(PYTHON_DEPENDENCIES_DIR / "win32"),
                str(PYTHON_DEPENDENCIES_DIR / "win32" / "lib"),
                str(PYTHON_DEPENDENCIES_DIR / "pywin32_system32"),
            ]
        )
    if existing_pythonpath:
        pythonpath_parts.append(existing_pythonpath)
    compile_env["PYTHONPATH"] = os.pathsep.join(pythonpath_parts)
    compile_env.pop("PYTHONHOME", None)
    # Hardening for deterministic compile behavior.
    compile_env["SETUPTOOLS_USE_DISTUTILS"] = "stdlib"
    compile_env["NO_COLOR"] = "1"
    compile_env["PYTZ_SKIPEXISTSCHECK"] = "1"
    compile_env["MPLBACKEND"] = "Agg"
    report_path = DIST_DIR / f"{name}.report.xml"

    command = [
        str(NUITKA_BUILD_PYTHON),
        str(NUITKA_BOOTSTRAP_SCRIPT),
        "--standalone",
        "--follow-imports",
        "--nofollow-import-to=pytest",
        "--nofollow-import-to=_pytest",
        "--nofollow-import-to=test",
        "--nofollow-import-to=*.tests",
        "--nofollow-import-to=*.tests.*",
        "--nofollow-import-to=pkg_resources",
        "--nofollow-import-to=setuptools",
        "--nofollow-import-to=_distutils_hack",
        "--enable-plugin=no-qt",
        "--noinclude-pytest-mode=nofollow",
        "--assume-yes-for-downloads",
        f"--output-dir={DIST_DIR}",
        f"--report={report_path}",
        "--report-diffable",
        f"--report-user-provided=backend={name}",
        *platform_nuitka_args(TARGET_PLATFORM, TARGET_ARCH),
        *extra_args,
    ]
    if name == "rnaseq":
        gene_cache_src = staged_source_root / "rnaseq_module" / "gene_cache"
        if not gene_cache_src.exists():
            raise RuntimeError(f"Missing staged RNA-seq gene cache directory: {gene_cache_src}")
        command.append(f"--include-data-dir={gene_cache_src}=rnaseq_module/gene_cache")
    if name == "plot":
        # Kaleido ships a native executable payload (kaleido/executable/...) that is
        # required at runtime for PDF/TIFF export in compiled mode.
        kaleido_staged_payload_dir = prepare_kaleido_executable_payload(name)
        command.append(f"--include-data-dir={kaleido_staged_payload_dir}=kaleido/executable")
    if not allow_unittest:
        command.extend(
            [
                "--nofollow-import-to=unittest",
                "--noinclude-unittest-mode=nofollow",
            ]
        )
    command.append(str(staged_entrypoint))
    run_checked(command, env=compile_env)
    if TARGET_PLATFORM == "win32":
        validate_no_critical_excluded_dlls(report_path, name)
    ensure_output(name)
    if kaleido_staged_payload_dir is not None:
        sync_kaleido_runtime_payload(DIST_DIR / f"{name}.dist", kaleido_staged_payload_dir)
    sync_top_level_exe(name)
    if TARGET_PLATFORM == "win32":
        bundle_msvc_runtime_dlls(name)

    print(f"[compile-python] OK: {name}")


def main() -> int:
    if TARGET_PLATFORM not in {"win32", "darwin"}:
        print(f"[compile-python] ERROR: Unsupported target platform: {TARGET_PLATFORM}", file=sys.stderr)
        return 1
    if TARGET_PLATFORM == "win32" and not PYTHON_EXE.exists():
        print(
            f"[compile-python] ERROR: Embedded Python not found at: {PYTHON_EXE}",
            file=sys.stderr,
        )
        return 1
    if not NUITKA_BUILD_PYTHON.exists():
        print(
            "[compile-python] ERROR: Nuitka builder Python not found.\n"
            f"  Expected: {NUITKA_BUILD_PYTHON}\n"
            "  Set EASYCRIS_NUITKA_BUILD_PYTHON to override.",
            file=sys.stderr,
        )
        return 1
    if not PYTHON_DEPENDENCIES_DIR.exists():
        print(
            "[compile-python] ERROR: Runtime dependency folder not found.\n"
            f"  Expected: {PYTHON_DEPENDENCIES_DIR}",
            file=sys.stderr,
        )
        return 1
    if not NUITKA_BOOTSTRAP_SCRIPT.exists():
        print(
            "[compile-python] ERROR: Nuitka bootstrap script not found.\n"
            f"  Expected: {NUITKA_BOOTSTRAP_SCRIPT}",
            file=sys.stderr,
        )
        return 1

    nuitka_version = subprocess.run(
        [str(NUITKA_BUILD_PYTHON), str(NUITKA_BOOTSTRAP_SCRIPT), "--version"],
        cwd=str(ROOT),
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if nuitka_version.returncode != 0:
        print(
            "[compile-python] ERROR: Nuitka is not available in builder environment.\n"
            f"  Builder Python: {NUITKA_BUILD_PYTHON}\n"
            f"  Install with: {NUITKA_BUILD_PYTHON} -m pip install nuitka==2.8.10",
            file=sys.stderr,
        )
        return 1

    # Parse optional backend filter from CLI args
    requested_raw = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    # Resolve old _backend aliases to canonical names.
    requested = []
    for arg in requested_raw:
        if arg in BACKEND_ALIASES:
            resolved = BACKEND_ALIASES[arg]
            print(f"[compile-python] NOTE: '{arg}' is an alias for '{resolved}' (renamed in v0.1.25)")
            requested.append(resolved)
        else:
            requested.append(arg)
    if requested:
        unknown = set(requested) - BACKEND_NAMES
        if unknown:
            print(f"[compile-python] ERROR: Unknown backends: {unknown}", file=sys.stderr)
            print(f"[compile-python] Available: {sorted(BACKEND_NAMES)}", file=sys.stderr)
            return 1
        backends_to_build = [b for b in BACKENDS if b["name"] in requested]
    else:
        backends_to_build = list(BACKENDS)

    DIST_DIR.mkdir(parents=True, exist_ok=True)

    failed: list[str] = []
    try:
        # Clean up any orphans from previous failed runs.
        kill_orphan_python_workers()

        for backend in backends_to_build:
            try:
                compile_backend(
                    backend["entrypoint"],
                    backend["name"],
                    backend["extra_args"],
                    bool(backend.get("allow_unittest", False)),
                )
            except Exception as exc:
                print(
                    f"[compile-python] FAILED: {backend['name']} â€” {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                failed.append(backend["name"])
                # Clean up after failure, then continue to next backend.
                kill_orphan_python_workers()
    except KeyboardInterrupt:
        print("[compile-python] Aborted by user (KeyboardInterrupt)", file=sys.stderr)
        return 130
    finally:
        # Always perform one final cleanup so aborted runs do not leave workers.
        kill_orphan_python_workers()

    if failed:
        print(f"[compile-python] {len(failed)} backend(s) failed: {', '.join(failed)}", file=sys.stderr)
        return 1

    print(f"[compile-python] Completed successfully ({len(backends_to_build)} backends)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
