#!/usr/bin/env python3
"""Contract tests for the Darwin Python-runtime bootstrap."""

from __future__ import annotations

import importlib
import platform as host_platform
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import bootstrap_python_macos


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python_embedded"))


class MacRequirementsContractTests(unittest.TestCase):
    """Protect the validated scientific stack from accidental Darwin drift."""

    def test_macos_requirements_only_replace_kaleido_and_add_truststore(self):
        # Mutation caught: changing any validated scientific pin on Darwin.
        validated = bootstrap_python_macos.parse_pinned_requirements(
            ROOT / "python_embedded" / "requirements-validated.txt"
        )
        darwin = bootstrap_python_macos.parse_pinned_requirements(
            ROOT / "python_embedded" / "requirements-macos.txt"
        )
        expected = dict(validated)
        expected["kaleido"] = "0.2.1"
        expected["truststore"] = "0.10.4"
        self.assertEqual(darwin, expected)
        self.assertEqual(darwin["plotly"], "5.24.1")

    def test_macos_requirements_admit_no_windows_only_package_or_path(self):
        # Mutation caught: adding a Windows binary/path dependency to Darwin.
        requirements = bootstrap_python_macos.parse_pinned_requirements(
            ROOT / "python_embedded" / "requirements-macos.txt"
        )
        forbidden = ("pywin32", "win32", "python-exe")
        self.assertFalse(any(value in requirements for value in forbidden))
        self.assertNotIn("0.1.0.post1", requirements.values())


class BootstrapHostContractTests(unittest.TestCase):
    """The bootstrap must never produce a cross-platform runtime by accident."""

    def test_rejects_non_darwin_and_non_python_312_hosts(self):
        # Mutation caught: removing a host guard that permits unsupported payloads.
        with self.assertRaisesRegex(RuntimeError, "Darwin"):
            bootstrap_python_macos.validate_host("Linux", (3, 12), "arm64")
        with self.assertRaisesRegex(RuntimeError, "Python 3.12"):
            bootstrap_python_macos.validate_host("Darwin", (3, 11), "arm64")

    def test_reports_only_supported_native_architectures(self):
        # Mutation caught: silently accepting an unsupported architecture.
        self.assertEqual(
            bootstrap_python_macos.validate_host("Darwin", (3, 12), "x86_64"), "x86_64"
        )
        self.assertEqual(
            bootstrap_python_macos.validate_host("Darwin", (3, 12), "arm64"), "arm64"
        )
        with self.assertRaisesRegex(RuntimeError, "x86_64 or arm64"):
            bootstrap_python_macos.validate_host("Darwin", (3, 12), "i386")


class BootstrapCommandContractTests(unittest.TestCase):
    """The pip command sequence is the reproducible-runtime boundary."""

    def test_bootstrap_runs_wheelhouse_first_and_propagates_command_failures(self):
        # Mutation caught: installing from the network into the runtime or swallowing failure.
        calls: list[list[str]] = []

        def runner(command: list[str], **kwargs):
            calls.append(command)
            if "download" in command:
                destination = Path(command[command.index("--dest") + 1])
                destination.mkdir(parents=True, exist_ok=True)
                (destination / f"fixture-{len(calls)}.whl").write_bytes(b"wheel")
            if any(part.endswith("validate_rnaseq_runtime.py") for part in command):
                raise RuntimeError("intentional runner failure")
            return ""

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_runtime = ROOT / "python_embedded"
            runtime = root / "python_embedded"
            runtime.mkdir()
            for name in ("requirements-validated.txt", "requirements-rnaseq.txt", "requirements-macos.txt"):
                (runtime / name).write_text((source_runtime / name).read_text(encoding="utf-8"), encoding="utf-8")
            scripts = root / "scripts"
            scripts.mkdir()
            for name in (
                "clear_rnaseq_overlay_packages.py",
                "apply_rnaseq_pydeseq2_patch.py",
                "validate_rnaseq_runtime.py",
            ):
                (scripts / name).write_text("# fixture\n", encoding="utf-8")
            builder = root / ".venv-nuitka-build" / "bin"
            builder.mkdir(parents=True)
            (builder / "python").touch()
            with self.assertRaisesRegex(RuntimeError, "intentional runner failure"):
                bootstrap_python_macos.bootstrap(
                    root=root,
                    runner=runner,
                    system_name="Darwin",
                    version_info=(3, 12),
                    machine_name="arm64",
                    create_venv=lambda _path: None,
                    write_manifest=False,
                )

        flat = [" ".join(command) for command in calls]
        download_index = next(index for index, command in enumerate(flat) if "pip download --only-binary=:all:" in command)
        install_index = next(index for index, command in enumerate(flat) if "pip install --no-index" in command)
        overlay_download_index = next(index for index, command in enumerate(flat) if "requirements-rnaseq.txt" in command and "pip download" in command)
        overlay_install_index = next(index for index, command in enumerate(flat) if "requirements-rnaseq.txt" in command and "pip install" in command)
        self.assertLess(download_index, install_index)
        self.assertLess(overlay_download_index, overlay_install_index)
        self.assertTrue(all("powershell" not in command.lower() for command in flat))
        self.assertTrue(all("python.exe" not in command.lower() for command in flat))
        self.assertTrue(all("\\\\" not in command for command in flat))

    def test_arm64_keeps_every_runtime_requirement_binary_only(self):
        # Mutation caught: applying the Intel source-build exception to arm64.
        calls = self._run_bootstrap_with_arch("arm64")
        runtime_download = next(command for command in calls if "download" in command and "requirements-macos.txt" in command)
        self.assertIn("--only-binary=:all:", runtime_download)
        self.assertNotIn("--no-binary=:all:", runtime_download)
        self.assertFalse(any("gseapy==1.1.11" in command and "--no-binary=:all:" in command for command in calls))

    def test_x86_64_builds_only_locked_gseapy_source_before_any_install(self):
        # Mutation caught: source-building another package or installing before the source is hashed.
        calls, events = self._run_bootstrap_with_arch("x86_64", include_events=True)
        source_download = next(command for command in calls if command.endswith("gseapy==1.1.11") and "--no-binary=:all:" in command)
        self.assertEqual(source_download.split()[-1], "gseapy==1.1.11")
        self.assertIn("--no-deps", source_download)
        self.assertIn("--no-build-isolation", source_download)
        self.assertEqual(sum("--no-binary=:all:" in command for command in calls), 1)
        requests_download = next(command for command in calls if command.endswith("requests") and "pip download" in command)
        self.assertIn("--only-binary=:all:", requests_download)
        self.assertNotIn("--no-binary=:all:", requests_download)
        first_install = next(index for index, command in enumerate(events) if command.startswith("install ") and "--no-index" in command)
        source_hash = next(index for index, command in enumerate(events) if command == "hash")
        self.assertLess(source_hash, first_install)
        self.assertTrue(any(command.startswith("wheel ") and "MACOSX_DEPLOYMENT_TARGET=13.0" in command for command in events))

    def test_x86_gseapy_wheel_validation_rejects_bad_tag_architecture_and_minos(self):
        # Mutation caught: admitting a wheel that cannot run on the macOS 13 Intel floor.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wheel = root / "gseapy-1.1.11-cp312-cp312-macosx_13_0_x86_64.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("gseapy/gse.cpython-312-darwin.so", "fixture")

            def valid_runner(command: list[str], **_kwargs):
                if command[0] == "file":
                    return "Mach-O 64-bit dynamically linked shared library x86_64"
                if command[0] == "otool":
                    return "cmd LC_BUILD_VERSION\n  minos 13.0\n"
                raise AssertionError(command)

            bootstrap_python_macos.validate_x86_gseapy_wheel(wheel, valid_runner)
            with self.assertRaisesRegex(RuntimeError, "x86_64"):
                bootstrap_python_macos.validate_x86_gseapy_wheel(
                    wheel, lambda command, **_kwargs: "Mach-O 64-bit arm64" if command[0] == "file" else "minos 13.0"
                )
            with self.assertRaisesRegex(RuntimeError, "minimum macOS"):
                bootstrap_python_macos.validate_x86_gseapy_wheel(
                    wheel, lambda command, **_kwargs: "Mach-O x86_64" if command[0] == "file" else "minos 14.0"
                )
            with self.assertRaisesRegex(RuntimeError, "wheel tag"):
                bootstrap_python_macos.validate_x86_gseapy_wheel(root / "gseapy-1.1.11-py3-none-any.whl", valid_runner)

    def _run_bootstrap_with_arch(self, arch: str, include_events: bool = False):
        calls: list[list[str]] = []
        events: list[str] = []

        def runner(command: list[str], **kwargs):
            calls.append(command)
            if "download" in command:
                destination = Path(command[command.index("--dest") + 1])
                destination.mkdir(parents=True, exist_ok=True)
                if "gseapy==1.1.11" in command:
                    (destination / "gseapy-1.1.11.tar.gz").write_bytes(b"source")
                else:
                    (destination / f"fixture-{len(calls)}.whl").write_bytes(b"wheel")
            if "wheel" in command:
                destination = Path(command[command.index("--wheel-dir") + 1])
                wheel = destination / "gseapy-1.1.11-cp312-cp312-macosx_13_0_x86_64.whl"
                with zipfile.ZipFile(wheel, "w") as archive:
                    archive.writestr("gseapy/gse.cpython-312-darwin.so", "fixture")
            if command[0] == "file":
                return "Mach-O 64-bit x86_64"
            if command[0] == "otool":
                return "minos 13.0"
            event = ("install " if "install" in command else "wheel " if "wheel" in command else "run ") + " ".join(command)
            if "env" in kwargs:
                event += " " + " ".join(f"{key}={value}" for key, value in sorted(kwargs["env"].items()) if key in {"MACOSX_DEPLOYMENT_TARGET", "_PYTHON_HOST_PLATFORM", "ARCHFLAGS"})
            events.append(event)
            return ""

        def hash_archives(wheelhouse: Path):
            events.append("hash")
            return {path.name: "fixture-sha256" for path in wheelhouse.iterdir() if path.is_file()}

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "python_embedded"
            runtime.mkdir()
            for name in ("requirements-validated.txt", "requirements-rnaseq.txt", "requirements-macos.txt"):
                (runtime / name).write_text((ROOT / "python_embedded" / name).read_text(encoding="utf-8"), encoding="utf-8")
            scripts = root / "scripts"
            scripts.mkdir()
            for name in ("clear_rnaseq_overlay_packages.py", "apply_rnaseq_pydeseq2_patch.py", "validate_rnaseq_runtime.py"):
                (scripts / name).write_text("# fixture\n", encoding="utf-8")
            builder = root / ".venv-nuitka-build" / "bin"
            builder.mkdir(parents=True)
            (builder / "python").touch()
            bootstrap_python_macos.bootstrap(
                root=root, runner=runner, system_name="Darwin", version_info=(3, 12), machine_name=arch,
                create_venv=lambda _path: None, write_manifest=False, hash_archives=hash_archives,
            )
        flat = [" ".join(command) for command in calls]
        return (flat, events) if include_events else flat


class PlatformTrustContractTests(unittest.TestCase):
    def test_darwin_injects_truststore_once_and_windows_is_a_noop(self):
        # Mutation caught: failing to install macOS system trust or changing Windows behavior.
        module = importlib.import_module("platform_trust")
        with patch.object(module.sys, "platform", "darwin"), patch.dict(
            sys.modules, {"truststore": type("Truststore", (), {"inject_into_ssl": staticmethod(lambda: None)})()}
        ):
            with patch("truststore.inject_into_ssl") as inject:
                module.configure_platform_trust()
                inject.assert_called_once_with()
        with patch.object(module.sys, "platform", "win32"):
            module.configure_platform_trust()


class KaleidoManifestContractTests(unittest.TestCase):
    def test_manifest_records_only_native_kaleido_payload_files(self):
        # Mutation caught: treating an executable-bit asset such as an OGG file as a signable Mach-O payload.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "kaleido" / "executable"
            root.mkdir(parents=True)
            native = root / "bin" / "kaleido"
            native.parent.mkdir()
            native.write_bytes(b"binary")
            native.chmod(0o755)
            asset = root / "etc" / "mathjax.ogg"
            asset.parent.mkdir()
            asset.write_bytes(b"asset")
            asset.chmod(0o755)

            def runner(command: list[str], **_kwargs):
                return "Mach-O 64-bit executable x86_64" if command[-1].endswith("kaleido") else "Ogg data"

            self.assertEqual(
                bootstrap_python_macos.kaleido_macho_files(root.parent.parent, runner),
                ["kaleido/executable/bin/kaleido"],
            )


if __name__ == "__main__":
    unittest.main()
