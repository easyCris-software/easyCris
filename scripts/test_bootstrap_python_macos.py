#!/usr/bin/env python3
"""Contract tests for the Darwin Python-runtime bootstrap."""

from __future__ import annotations

import importlib
import io
import json
import os
import platform as host_platform
import subprocess
import sys
import tarfile
import tempfile
import unittest
import venv
import zipfile
from contextlib import ExitStack, redirect_stderr
from pathlib import Path
from unittest.mock import patch

import bootstrap_python_macos


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python_embedded"))


class MacRequirementsContractTests(unittest.TestCase):
    """Protect the validated scientific stack from accidental Darwin drift."""

    def test_macos_requirements_only_replace_kaleido_and_add_darwin_trust_pins(self):
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
        expected["certifi"] = "2026.7.22"
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


class BundledInterpreterArchiveTests(unittest.TestCase):
    """The immutable archive boundary must fail before touching a live runtime."""

    def test_selects_the_exact_native_astral_archive_pin(self):
        # Mutation caught: changing the release, filename, URL, checksum, or native mapping.
        expected = {
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
        for arch, literal in expected.items():
            with self.subTest(arch=arch):
                self.assertEqual(
                    bootstrap_python_macos.select_archive_pin("Darwin", arch), literal
                )
        with self.assertRaisesRegex(RuntimeError, "Darwin"):
            bootstrap_python_macos.select_archive_pin("Linux", "x86_64")
        with self.assertRaisesRegex(RuntimeError, "native"):
            bootstrap_python_macos.select_archive_pin("Darwin", "aarch64")

    def test_archive_hash_is_verified_before_any_tar_member_is_read(self):
        # Mutation caught: opening/extracting an unverified runtime archive.
        events = []
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / "runtime.tar.gz"
            archive.write_bytes(b"not-the-pinned-archive")
            destination = Path(temporary) / "unpacked"
            with patch.object(
                bootstrap_python_macos.tarfile,
                "open",
                side_effect=lambda *_args, **_kwargs: events.append("tar-open"),
            ):
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    bootstrap_python_macos.verify_and_extract_archive(
                        archive,
                        destination,
                        expected_sha256="0" * 64,
                    )
        self.assertEqual(events, [])

    def test_safe_extraction_rejects_traversal_and_escaping_links_without_writes(self):
        # Mutation caught: trusting tar member paths or link targets.
        unsafe_members = (
            ("../escape", None, tarfile.REGTYPE),
            ("/absolute", None, tarfile.REGTYPE),
            ("python/link", "../../escape", tarfile.SYMTYPE),
            ("python/hard", "../escape", tarfile.LNKTYPE),
        )
        for name, linkname, member_type in unsafe_members:
            with self.subTest(name=name, linkname=linkname):
                with tempfile.TemporaryDirectory() as temporary:
                    archive_path = Path(temporary) / "unsafe.tar.gz"
                    with tarfile.open(archive_path, "w:gz") as archive:
                        member = tarfile.TarInfo(name)
                        member.type = member_type
                        member.linkname = linkname or ""
                        if member_type == tarfile.REGTYPE:
                            member.size = 1
                            archive.addfile(member, io.BytesIO(b"x"))
                        else:
                            archive.addfile(member)
                    digest = bootstrap_python_macos.sha256(archive_path)
                    destination = Path(temporary) / "unpacked"
                    with self.assertRaisesRegex(RuntimeError, "unsafe"):
                        bootstrap_python_macos.verify_and_extract_archive(
                            archive_path, destination, expected_sha256=digest
                        )
                    self.assertFalse(destination.exists())
                    self.assertFalse((Path(temporary) / "escape").exists())


class BundledModuleIsolationTests(unittest.TestCase):
    def test_backend_launch_uses_real_site_packages_and_ignores_poisoned_pythonpath(self):
        # Mutation caught: dropping -I/-B or staging only on PYTHONPATH.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            environment = root / "runtime"
            venv.EnvBuilder(with_pip=False).create(environment)
            interpreter = environment / "bin" / "python"
            version = f"python{sys.version_info.major}.{sys.version_info.minor}"
            site_packages = environment / "lib" / version / "site-packages"
            poison = root / "poison"
            poison.mkdir()
            (site_packages / "stats.py").write_text(
                "import json,sys\njson.loads(sys.stdin.read())\nprint(json.dumps({'success': True, 'source': 'staged'}, indent=2))\n",
                encoding="utf-8",
            )
            (poison / "stats.py").write_text(
                "print('{\"success\": true, \"source\": \"poisoned\"}')\n",
                encoding="utf-8",
            )
            result = bootstrap_python_macos.run_backend_protocol(
                interpreter,
                "stats",
                {"action": "ping"},
                environment={**os.environ, "PYTHONPATH": str(poison)},
            )
            self.assertEqual(result, {"success": True, "source": "staged"})


class HashedArchitectureLockTests(unittest.TestCase):
    def test_both_final_locks_cover_the_same_exact_63_package_tree(self):
        # Mutation caught: architecture drift, a bare transitive dependency, or a hash-only lock with no filename.
        intel = bootstrap_python_macos.parse_hashed_lock(
            ROOT / "python_embedded" / "requirements-macos-x86_64.lock"
        )
        arm = bootstrap_python_macos.parse_hashed_lock(
            ROOT / "python_embedded" / "requirements-macos-arm64.lock"
        )
        self.assertEqual(len(intel), 63)
        self.assertEqual(
            {(entry.name, entry.version) for entry in intel},
            {(entry.name, entry.version) for entry in arm},
        )
        for entry in (*intel, *arm):
            self.assertIn(entry.group, {"runtime", "rnaseq-overlay", "intel-source"})
            self.assertTrue(entry.archives)
            self.assertEqual(len(entry.archives), len(entry.hashes))
        intel_gseapy = next(entry for entry in intel if entry.name == "gseapy")
        arm_gseapy = next(entry for entry in arm if entry.name == "gseapy")
        self.assertEqual(intel_gseapy.group, "intel-source")
        self.assertEqual(intel_gseapy.archives, ("gseapy-1.1.11.tar.gz",))
        self.assertEqual(
            intel_gseapy.hashes,
            ("d36a164ee466f7ea6deadfe82ea041f3328ee937ff4c9de862b3e6e2825df0dd",),
        )
        self.assertEqual(arm_gseapy.group, "runtime")
        self.assertEqual(
            arm_gseapy.archives,
            ("gseapy-1.1.11-cp312-cp312-macosx_11_0_arm64.whl",),
        )

    def test_each_lock_preserves_every_normative_runtime_requirement_pin(self):
        # Mutation caught: changing a lock pin without updating either consumed
        # requirements file, or omitting a normative runtime dependency.
        for arch in ("x86_64", "arm64"):
            with self.subTest(arch=arch):
                entries = bootstrap_python_macos.parse_hashed_lock(
                    ROOT / "python_embedded" / f"requirements-macos-{arch}.lock"
                )
                bootstrap_python_macos.validate_lock_matches_requirements(
                    entries,
                    ROOT / "python_embedded" / "requirements-macos.txt",
                    ROOT / "python_embedded" / "requirements-rnaseq.txt",
                )

    def test_download_admission_rejects_unknown_or_hash_mismatched_archives(self):
        # Mutation caught: moving a resolver-added or tampered archive into the wheelhouse.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wheelhouse = root / "downloads"
            wheelhouse.mkdir()
            expected = wheelhouse / "fixture-1.0-py3-none-any.whl"
            expected.write_bytes(b"expected")
            lock = root / "lock.txt"
            lock.write_text(
                "# group: runtime\n"
                "# archive: fixture-1.0-py3-none-any.whl\n"
                f"fixture==1.0 --hash=sha256:{bootstrap_python_macos.sha256(expected)}\n",
                encoding="utf-8",
            )
            entries = bootstrap_python_macos.parse_hashed_lock(lock)
            bootstrap_python_macos.validate_download_set(entries, wheelhouse)
            (wheelhouse / "surprise-9.9-py3-none-any.whl").write_bytes(b"surprise")
            with self.assertRaisesRegex(RuntimeError, "unlocked archive"):
                bootstrap_python_macos.validate_download_set(entries, wheelhouse)
            (wheelhouse / "surprise-9.9-py3-none-any.whl").unlink()
            expected.write_bytes(b"tampered")
            with self.assertRaisesRegex(RuntimeError, "hash mismatch"):
                bootstrap_python_macos.validate_download_set(entries, wheelhouse)


class BackendSourceStagingTests(unittest.TestCase):
    def test_stages_only_the_explicit_backend_allowlist_into_real_site_packages(self):
        # Mutation caught: staging a cache/test/credential or omitting a required backend module.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "python_embedded"
            destination = root / "runtime" / "lib" / "python3.12" / "site-packages"
            source.mkdir()
            for name in (
                "stats.py",
                "rnaseq.py",
                "plot.py",
                "platform_trust.py",
                "plot_exporter.py",
            ):
                (source / name).write_text(f"# {name}\n", encoding="utf-8")
            for name in ("statistics_module", "rnaseq_module", "plots_module"):
                module = source / name
                module.mkdir()
                (module / "__init__.py").write_text(f"# {name}\n", encoding="utf-8")
                (module / "data.json").write_text("{}\n", encoding="utf-8")
                cache = module / "__pycache__"
                cache.mkdir()
                (cache / "bad.pyc").write_bytes(b"cache")
                tests = module / "tests"
                tests.mkdir()
                (tests / "secret-fixture.json").write_text("private", encoding="utf-8")
                (module / "provision.log").write_text("log", encoding="utf-8")
                (module / ".env").write_text("TOKEN=secret", encoding="utf-8")

            staged = bootstrap_python_macos.stage_backend_sources(source, destination)

            self.assertEqual(
                set(path.name for path in destination.iterdir()),
                {
                    "stats.py",
                    "rnaseq.py",
                    "plot.py",
                    "platform_trust.py",
                    "plot_exporter.py",
                    "statistics_module",
                    "rnaseq_module",
                    "plots_module",
                },
            )
            self.assertFalse(any("__pycache__" in path.parts for path in destination.rglob("*")))
            self.assertFalse(any("tests" in path.parts for path in destination.rglob("*")))
            self.assertFalse(any(path.name in {".env", "provision.log"} for path in destination.rglob("*")))
            self.assertTrue(staged["sha256"])
            self.assertIn("statistics_module/data.json", staged["files"])

    def test_rejects_allowed_source_symlinks_that_escape_the_backend_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "python_embedded"
            source.mkdir()
            outside = root / "outside-secret.py"
            outside.write_text("TOKEN = 'secret'\n", encoding="utf-8")
            for name in bootstrap_python_macos.BACKEND_SOURCE_FILES:
                target = source / name
                if name == "stats.py":
                    target.symlink_to(outside)
                else:
                    target.write_text("# fixture\n", encoding="utf-8")
            for name in bootstrap_python_macos.BACKEND_SOURCE_DIRECTORIES:
                directory = source / name
                directory.mkdir()
                (directory / "__init__.py").write_text("# fixture\n", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "symlink"):
                bootstrap_python_macos.backend_source_inventory(source)


class MachOValidationTests(unittest.TestCase):
    def test_macho_architecture_set_must_equal_the_single_native_target(self):
        # Mutation caught: accepting a universal payload merely because it
        # contains the requested slice.
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "native.so"
            binary.write_bytes(b"fixture")
            commands = []

            def valid_runner(command, **_kwargs):
                commands.append(command)
                if command[0] == "/usr/bin/file":
                    return "Mach-O 64-bit bundle x86_64"
                if command[0] == "/usr/bin/lipo":
                    return "x86_64"
                return "cmd LC_BUILD_VERSION\n minos 10.13\ncmd LC_BUILD_VERSION\n minos 14.0\n"

            record = bootstrap_python_macos.validate_macho_file(
                binary, "x86_64", valid_runner
            )
            self.assertEqual(record["minimum_macos_versions"], ["10.13", "14.0"])
            self.assertEqual(commands[0][:2], ["/usr/bin/file", "-b"])
            self.assertEqual(commands[1][:2], ["/usr/bin/lipo", "-archs"])
            self.assertEqual(commands[2][:2], ["/usr/bin/otool", "-l"])
            for native_arch in ("x86_64", "arm64"):
                with self.subTest(native_arch=native_arch):
                    with self.assertRaisesRegex(RuntimeError, "exact native architecture"):
                        bootstrap_python_macos.validate_macho_file(
                            binary,
                            native_arch,
                            lambda command, **_kwargs: (
                                "Mach-O universal binary with 2 architectures: x86_64 arm64"
                                if command[0] == "/usr/bin/file"
                                else "x86_64 arm64"
                                if command[0] == "/usr/bin/lipo"
                                else "cmd LC_BUILD_VERSION\n minos 10.15\n"
                            ),
                        )
            unrelated_versions = bootstrap_python_macos.validate_macho_file(
                binary,
                "x86_64",
                lambda command, **_kwargs: (
                    "Mach-O x86_64"
                    if command[0] == "/usr/bin/file"
                    else "x86_64"
                    if command[0] == "/usr/bin/lipo"
                    else "cmd LC_BUILD_VERSION\n minos 10.15\n sdk 22.1\n"
                    "cmd LC_LOAD_DYLIB\n current version 3502.1.255\n compatibility version 150.0.0\n"
                ),
            )
            self.assertEqual(unrelated_versions["minimum_macos_versions"], ["10.15"])
            arch_named = Path(temporary) / "x86_64" / "native.so"
            arch_named.parent.mkdir()
            arch_named.write_bytes(b"fixture")
            with self.assertRaisesRegex(RuntimeError, "x86_64"):
                bootstrap_python_macos.validate_macho_file(
                    arch_named,
                    "x86_64",
                    lambda command, **_kwargs: (
                        "Mach-O arm64"
                        if command[0] == "/usr/bin/file"
                        else "arm64"
                        if command[0] == "/usr/bin/lipo"
                        else "cmd LC_BUILD_VERSION\n minos 13.0"
                    ),
                )
            with self.assertRaisesRegex(RuntimeError, "14.0"):
                bootstrap_python_macos.validate_macho_file(
                    binary,
                    "x86_64",
                    lambda command, **_kwargs: (
                        "Mach-O x86_64"
                        if command[0] == "/usr/bin/file"
                        else "x86_64"
                        if command[0] == "/usr/bin/lipo"
                        else "cmd LC_BUILD_VERSION\n minos 14.1"
                    ),
                )

    def test_universal_machos_are_atomically_thinned_with_hash_provenance(self):
        # Mutation caught: leaving either universal2 slice in the final runtime
        # or recording hashes that do not describe the before/after bytes.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "fixture.c"
            source.write_text("int easycris_fixture(void) { return 42; }\n", encoding="utf-8")
            slices = {}
            for arch in ("x86_64", "arm64"):
                output = root / f"fixture-{arch}.dylib"
                subprocess.run(
                    [
                        "/usr/bin/xcrun",
                        "clang",
                        "-arch",
                        arch,
                        "-mmacosx-version-min=10.15",
                        "-dynamiclib",
                        str(source),
                        "-o",
                        str(output),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                slices[arch] = output
            universal = root / "universal.dylib"
            subprocess.run(
                [
                    "/usr/bin/lipo",
                    "-create",
                    str(slices["x86_64"]),
                    str(slices["arm64"]),
                    "-output",
                    str(universal),
                ],
                check=True,
                capture_output=True,
                text=True,
            )

            for arch in ("x86_64", "arm64"):
                with self.subTest(arch=arch):
                    runtime = root / f"runtime-{arch}"
                    runtime.mkdir()
                    candidate = runtime / "fixture.dylib"
                    candidate.write_bytes(universal.read_bytes())
                    source_hash = bootstrap_python_macos.sha256(candidate)
                    logger = bootstrap_python_macos.ProvisionLogger(
                        root / f"provision-{arch}.log"
                    )

                    records = bootstrap_python_macos.thin_universal_machos(
                        runtime, arch, root, logger
                    )

                    self.assertEqual(
                        subprocess.run(
                            ["/usr/bin/lipo", "-archs", str(candidate)],
                            check=True,
                            capture_output=True,
                            text=True,
                        ).stdout.strip(),
                        arch,
                    )
                    self.assertEqual(
                        records,
                        [
                            {
                                "path": "fixture.dylib",
                                "source_architectures": ["x86_64", "arm64"],
                                "source_sha256": source_hash,
                                "result_architectures": [arch],
                                "result_sha256": bootstrap_python_macos.sha256(candidate),
                            }
                        ],
                    )
                    self.assertNotEqual(source_hash, records[0]["result_sha256"])

    def test_thinning_provenance_must_match_the_final_macho_inventory(self):
        # Mutation caught: publishing a before/after thinning record whose
        # result bytes are not the bytes independently inventoried at the end.
        thinning = [
            {
                "path": "lib/native.dylib",
                "source_architectures": ["x86_64", "arm64"],
                "source_sha256": "1" * 64,
                "result_architectures": ["x86_64"],
                "result_sha256": "2" * 64,
            }
        ]
        inventory = {
            "files": [
                {
                    "path": "lib/native.dylib",
                    "architectures": ["x86_64"],
                    "minimum_macos_versions": ["10.15"],
                    "sha256": "3" * 64,
                }
            ]
        }

        with self.assertRaisesRegex(RuntimeError, "final Mach-O inventory"):
            bootstrap_python_macos.validate_macho_thinning_provenance(
                thinning, inventory
            )

        inventory["files"][0]["sha256"] = "2" * 64
        bootstrap_python_macos.validate_macho_thinning_provenance(thinning, inventory)


class ManifestCheckpointAndCacheTests(unittest.TestCase):
    def test_checkpoint_cannot_pass_until_every_real_probe_succeeds(self):
        # Mutation caught: publishing a passed checkpoint after a failed export or protocol result.
        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "checkpoint.json"
            bootstrap_python_macos.atomic_write_json(checkpoint, {"status": "running"})
            results = {
                "stats": {"success": True},
                "rnaseq": {"success": True},
                "plot": {"success": True},
                "pdf": {"success": True},
                "tiff": {"success": False},
            }
            with self.assertRaisesRegex(RuntimeError, "tiff"):
                bootstrap_python_macos.mark_checkpoint_passed(
                    checkpoint, "a" * 64, results
                )
            self.assertEqual(json.loads(checkpoint.read_text())["status"], "running")
            results["tiff"] = {"success": True}
            bootstrap_python_macos.mark_checkpoint_passed(checkpoint, "a" * 64, results)
            passed = json.loads(checkpoint.read_text())
            self.assertEqual(passed["status"], "passed")
            self.assertEqual(passed["manifest_sha256"], "a" * 64)

    def test_cache_fingerprint_changes_with_sources_and_protected_modes_reject_reuse(self):
        # Mutation caught: reusing a snapshot after source drift or from a protected validation lane.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "python_embedded"
            source.mkdir()
            for name in (
                "stats.py", "rnaseq.py", "plot.py", "platform_trust.py", "plot_exporter.py",
                "requirements-macos.txt", "requirements-rnaseq.txt",
                "requirements-macos-x86_64.lock", "requirements-macos-arm64.lock",
            ):
                (source / name).write_text(name + "\n", encoding="utf-8")
            for name in ("statistics_module", "rnaseq_module", "plots_module"):
                directory = source / name
                directory.mkdir()
                (directory / "__init__.py").write_text(name + "\n", encoding="utf-8")
            scripts = root / "scripts"
            scripts.mkdir()
            for name in (
                "bootstrap_python_macos.py",
                "apply_rnaseq_pydeseq2_patch.py",
                "validate_rnaseq_runtime.py",
            ):
                (scripts / name).write_text(name + "\n", encoding="utf-8")
            patch_payload = scripts / "rnaseq_patches" / "pydeseq2_0_5_3"
            patch_payload.mkdir(parents=True)
            (patch_payload / "dds.py").write_text("patch v1\n", encoding="utf-8")
            first = bootstrap_python_macos.compute_content_fingerprint(root, "x86_64")
            (patch_payload / "dds.py").write_text("patch v2\n", encoding="utf-8")
            second = bootstrap_python_macos.compute_content_fingerprint(root, "x86_64")
            self.assertNotEqual(first, second)
            (source / "stats.py").write_text("changed\n", encoding="utf-8")
            third = bootstrap_python_macos.compute_content_fingerprint(root, "x86_64")
            self.assertNotEqual(second, third)
            with self.assertRaisesRegex(RuntimeError, "protected"):
                bootstrap_python_macos.validate_dev_cache_request(True, {"CI": "true"})
            bootstrap_python_macos.validate_dev_cache_request(True, {})

    def test_artifact_cache_rejects_tampered_archive_and_wheel_bytes(self):
        # Mutation caught: trusting cache-owned metadata or filenames instead
        # of re-hashing immutable CPython and lock archive pins.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache_archive = root / "cache" / "cpython.tar.gz"
            destination_archive = root / "output" / "cpython.tar.gz"
            cache_archive.parent.mkdir(parents=True)
            cache_archive.write_bytes(b"tampered")
            expected_archive = root / "expected-cpython.tar.gz"
            expected_archive.write_bytes(b"pinned-cpython")
            self.assertFalse(
                bootstrap_python_macos._copy_hash_verified_file(
                    cache_archive,
                    destination_archive,
                    bootstrap_python_macos.sha256(expected_archive),
                )
            )
            self.assertFalse(destination_archive.exists())

            wheel_cache = root / "cache" / "wheelhouse"
            wheel_cache.mkdir()
            wheel = wheel_cache / "fixture-1.0-py3-none-any.whl"
            wheel.write_bytes(b"tampered-wheel")
            locked_wheel = root / "locked.whl"
            locked_wheel.write_bytes(b"locked-wheel")
            entries = (
                bootstrap_python_macos.LockEntry(
                    "fixture",
                    "1.0",
                    "runtime",
                    (wheel.name,),
                    (bootstrap_python_macos.sha256(locked_wheel),),
                ),
            )
            destination_wheelhouse = root / "output" / "wheelhouse"
            self.assertIsNone(
                bootstrap_python_macos._reuse_cached_wheelhouse(
                    wheel_cache, destination_wheelhouse, entries
                )
            )
            self.assertFalse(destination_wheelhouse.exists())

            cache_archive.write_bytes(expected_archive.read_bytes())
            wheel.write_bytes(locked_wheel.read_bytes())
            self.assertTrue(
                bootstrap_python_macos._copy_hash_verified_file(
                    cache_archive,
                    destination_archive,
                    bootstrap_python_macos.sha256(expected_archive),
                )
            )
            self.assertEqual(destination_archive.read_bytes(), b"pinned-cpython")
            self.assertEqual(
                bootstrap_python_macos._reuse_cached_wheelhouse(
                    wheel_cache, destination_wheelhouse, entries
                ),
                {wheel.name: bootstrap_python_macos.sha256(locked_wheel)},
            )
            self.assertEqual(
                (destination_wheelhouse / wheel.name).read_bytes(), b"locked-wheel"
            )

    def test_cached_wheelhouse_rejects_extra_files_and_cross_paired_hashes(self):
        # Mutation caught: copying an unrecognized regular file or accepting
        # archive A under archive B's hash from the same package entry.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / "cache"
            cache.mkdir()
            archive_a = "fixture-1.0-a.whl"
            archive_b = "fixture-1.0-b.whl"
            payload_a = b"archive-a"
            payload_b = b"archive-b"
            expected_a = root / archive_a
            expected_b = root / archive_b
            expected_a.write_bytes(payload_a)
            expected_b.write_bytes(payload_b)
            entries = (
                bootstrap_python_macos.LockEntry(
                    "fixture",
                    "1.0",
                    "runtime",
                    (archive_a, archive_b),
                    (
                        bootstrap_python_macos.sha256(expected_a),
                        bootstrap_python_macos.sha256(expected_b),
                    ),
                ),
            )

            (cache / archive_a).write_bytes(payload_a)
            (cache / "unverified.payload").write_bytes(b"not-in-lock")
            self.assertIsNone(
                bootstrap_python_macos._reuse_cached_wheelhouse(
                    cache, root / "extra-output", entries
                )
            )
            self.assertFalse((root / "extra-output").exists())

            (cache / "unverified.payload").unlink()
            (cache / archive_a).write_bytes(payload_b)
            self.assertIsNone(
                bootstrap_python_macos._reuse_cached_wheelhouse(
                    cache, root / "cross-paired-output", entries
                )
            )
            self.assertFalse((root / "cross-paired-output").exists())

    def test_reuse_flag_ignores_forged_runtime_snapshot_and_stages_current_sources(self):
        # Mutation caught: copying a self-asserted cached runtime/manifest and
        # representing stale backend bytes as the current checkout.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source_root = root / "python_embedded"
            source_root.mkdir()
            for name in bootstrap_python_macos.BACKEND_SOURCE_FILES:
                (source_root / name).write_text(f"current-{name}\n", encoding="utf-8")
            for name in bootstrap_python_macos.BACKEND_SOURCE_DIRECTORIES:
                directory = source_root / name
                directory.mkdir()
                (directory / "__init__.py").write_text(
                    f"current-{name}\n", encoding="utf-8"
                )

            fingerprint = "f" * 64
            snapshot = (
                root
                / "_tmp"
                / "python-runtime-cache"
                / fingerprint
                / "x86_64"
                / "runtime-snapshot"
            )
            (snapshot / "bin").mkdir(parents=True)
            (snapshot / "bin" / "python3.12").write_bytes(b"stale-python")
            stale_site = snapshot / "lib" / "python3.12" / "site-packages"
            stale_site.mkdir(parents=True)
            (stale_site / "stats.py").write_text("stale-source\n", encoding="utf-8")
            (snapshot / "stale-runtime-marker").write_text("stale\n", encoding="utf-8")
            bootstrap_python_macos.atomic_write_json(
                snapshot / "easycris_runtime_manifest.json",
                {
                    "architecture": "x86_64",
                    "content_fingerprint": fingerprint,
                    "runtime_tree_sha256": bootstrap_python_macos.runtime_tree_sha256(
                        snapshot
                    ),
                    "wheel_archive_sha256": {"forged.whl": "a" * 64},
                },
            )
            artifact_root = snapshot.parent / "artifacts"
            cached_archive = artifact_root / "cpython" / "cpython.tar.gz"
            cached_archive.parent.mkdir(parents=True)
            cached_archive.write_bytes(b"hash-verified-cpython")
            cached_wheelhouse = artifact_root / "wheelhouse"
            cached_wheelhouse.mkdir()
            cached_payloads = {
                "fixture-1.0-py3-none-any.whl": b"runtime-wheel",
                "overlay-1.0-py3-none-any.whl": b"overlay-wheel",
                "source-1.0.tar.gz": b"source-archive",
            }
            for name, payload in cached_payloads.items():
                (cached_wheelhouse / name).write_bytes(payload)

            probe_results = {
                name: {"success": True}
                for name in ("stats", "rnaseq", "plot", "pdf", "tiff")
            }

            def fake_extract(_archive, extracted, **_kwargs):
                runtime_source = extracted / "python"
                (runtime_source / "bin").mkdir(parents=True)
                (runtime_source / "bin" / "python3.12").write_bytes(b"fresh-python")
                (runtime_source / "lib" / "python3.12" / "site-packages").mkdir(
                    parents=True
                )
                (runtime_source / "fresh-runtime-marker").write_text(
                    "fresh\n", encoding="utf-8"
                )

            def fake_manifest(**kwargs):
                path = kwargs["runtime"] / "easycris_runtime_manifest.json"
                bootstrap_python_macos.atomic_write_json(
                    path,
                    {
                        "development_reuse": kwargs["development_reuse"],
                        "backend_sources": kwargs["source_inventory"],
                    },
                )
                return path

            entries = tuple(
                bootstrap_python_macos.LockEntry(
                    name.split("-")[0],
                    "1.0",
                    group,
                    (name,),
                    (bootstrap_python_macos.sha256(cached_wheelhouse / name),),
                )
                for name, group in (
                    ("fixture-1.0-py3-none-any.whl", "runtime"),
                    ("overlay-1.0-py3-none-any.whl", "rnaseq-overlay"),
                    ("source-1.0.tar.gz", "intel-source"),
                )
            )
            patchers = [
                patch.object(bootstrap_python_macos, "validate_host", return_value="x86_64"),
                patch.object(
                    bootstrap_python_macos,
                    "select_archive_pin",
                    return_value={
                        "filename": "cpython.tar.gz",
                        "sha256": bootstrap_python_macos.sha256(cached_archive),
                        "python_version": "3.12.13",
                    },
                ),
                patch.object(
                    bootstrap_python_macos,
                    "capture_git_state",
                    return_value={
                        "head": "head",
                        "clean_tree": True,
                        "dirty_entry_count": 0,
                        "state_sha256": "a" * 64,
                    },
                ),
                patch.object(bootstrap_python_macos, "_ensure_ignored"),
                patch.object(
                    bootstrap_python_macos,
                    "compute_content_fingerprint",
                    return_value=fingerprint,
                ),
                patch.object(
                    bootstrap_python_macos,
                    "_requirements_hashes",
                    return_value={"requirements-macos.txt": "b" * 64},
                ),
                patch.object(
                    bootstrap_python_macos,
                    "parse_hashed_lock",
                    return_value=entries,
                ),
                patch.object(bootstrap_python_macos, "validate_lock_matches_requirements"),
                patch.object(
                    bootstrap_python_macos,
                    "_download_archive",
                    side_effect=AssertionError("valid cached CPython was not reused"),
                ),
                patch.object(
                    bootstrap_python_macos,
                    "verify_and_extract_archive",
                    side_effect=fake_extract,
                ),
                patch.object(
                    bootstrap_python_macos,
                    "_verify_relocated_interpreter",
                    return_value={"path": "bin/python3.12"},
                ),
                patch.object(bootstrap_python_macos, "_ensure_builder", return_value=Path("/builder")),
                patch.object(
                    bootstrap_python_macos,
                    "_download_locked_groups",
                    side_effect=AssertionError("valid cached lock artifacts were not reused"),
                ),
                patch.object(bootstrap_python_macos, "_install_locked_dependencies"),
                patch.object(bootstrap_python_macos, "_apply_and_validate_overlay"),
                patch.object(bootstrap_python_macos, "validate_pruned_runtime"),
                patch.object(
                    bootstrap_python_macos,
                    "final_runtime_distribution_inventory",
                    return_value=[{"name": "fixture", "version": "1.0"}],
                ),
                patch.object(bootstrap_python_macos, "_verify_required_imports"),
                patch.object(
                    bootstrap_python_macos,
                    "_run_real_probes",
                    return_value=probe_results,
                ),
                patch.object(
                    bootstrap_python_macos,
                    "_verify_macho_inventory",
                    return_value={"count": 1},
                ),
                patch.object(
                    bootstrap_python_macos,
                    "_write_runtime_manifest",
                    side_effect=fake_manifest,
                ),
                patch.object(
                    bootstrap_python_macos,
                    "_populate_artifact_cache",
                    create=True,
                ),
            ]
            with ExitStack() as stack:
                for patcher in patchers:
                    stack.enter_context(patcher)
                runtime = bootstrap_python_macos.provision(
                    root=root, reuse_dev_cache=True, environment={}
                )

            self.assertEqual((runtime / "fresh-runtime-marker").read_text(), "fresh\n")
            self.assertFalse((runtime / "stale-runtime-marker").exists())
            self.assertEqual(
                (runtime / "lib" / "python3.12" / "site-packages" / "stats.py").read_text(),
                "current-stats.py\n",
            )
            manifest = json.loads(
                (runtime / "easycris_runtime_manifest.json").read_text(encoding="utf-8")
            )
            self.assertTrue(manifest["development_reuse"])

    def test_manifest_inventory_uses_final_exact_distributions_and_relative_paths(self):
        entries = (
            bootstrap_python_macos.LockEntry("gseapy", "1.1.11", "runtime", ("g.whl",), ("a" * 64,)),
            bootstrap_python_macos.LockEntry("numpy", "1.26.4", "runtime", ("n.whl",), ("b" * 64,)),
        )
        inventory = bootstrap_python_macos.validate_final_distribution_inventory(
            {"numpy": "1.26.4", "gseapy": "1.1.11"}, entries
        )
        self.assertEqual(
            inventory,
            [
                {"name": "gseapy", "version": "1.1.11"},
                {"name": "numpy", "version": "1.26.4"},
            ],
        )
        self.assertNotIn("file://", json.dumps(inventory))
        with self.assertRaisesRegex(RuntimeError, "final runtime distribution"):
            bootstrap_python_macos.validate_final_distribution_inventory(
                {"gseapy": "1.1.11", "pip": "26.1.2"}, entries
            )
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            interpreter = runtime / "bin" / "python3.12"
            self.assertEqual(
                bootstrap_python_macos.runtime_relative_path(runtime, interpreter),
                "bin/python3.12",
            )

    def test_final_inventory_rejects_duplicate_normalized_distribution_metadata(self):
        # Mutation caught: collecting or comparing distributions through a
        # dictionary, which collapses two metadata rows for the same package.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = root / "runtime"
            venv.EnvBuilder(with_pip=False).create(runtime)
            version = f"python{sys.version_info.major}.{sys.version_info.minor}"
            site_packages = runtime / "lib" / version / "site-packages"
            for directory in ("numpy-1.26.4.dist-info", "numpy-copy-1.26.4.dist-info"):
                metadata = site_packages / directory / "METADATA"
                metadata.parent.mkdir()
                metadata.write_text(
                    "Metadata-Version: 2.1\nName: numpy\nVersion: 1.26.4\n",
                    encoding="utf-8",
                )
            logger = bootstrap_python_macos.ProvisionLogger(root / "provision.log")
            entries = (
                bootstrap_python_macos.LockEntry(
                    "numpy", "1.26.4", "runtime", ("numpy.whl",), ("a" * 64,)
                ),
            )

            with self.assertRaisesRegex(RuntimeError, "duplicate.*numpy"):
                bootstrap_python_macos.final_runtime_distribution_inventory(
                    runtime, entries, root, logger
                )

    def test_prunes_cpython_development_payloads(self):
        # Mutation caught: pruning installers but retaining headers, build
        # configuration, static archives, and compiler object files.
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            (runtime / "bin").mkdir(parents=True)
            site_packages = runtime / "lib" / "python3.12" / "site-packages"
            site_packages.mkdir(parents=True)
            build_files = (
                runtime / "include" / "python3.12" / "Python.h",
                runtime / "lib" / "pkgconfig" / "python-3.12.pc",
                runtime / "lib" / "python3.12" / "config-3.12-darwin" / "Makefile",
                runtime / "lib" / "libpython-fixture.a",
                site_packages / "numpy" / "core" / "include" / "numpy" / "arrayobject.h",
                site_packages / "numpy" / "core" / "lib" / "libnpymath.a",
                runtime / "lib" / "python3.12" / "config-3.12-darwin" / "python.o",
            )
            for path in build_files:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"build-only")

            bootstrap_python_macos.prune_provisioning_artifacts(runtime)

            self.assertFalse((runtime / "include").exists())
            self.assertFalse((runtime / "lib" / "pkgconfig").exists())
            self.assertFalse(
                (runtime / "lib" / "python3.12" / "config-3.12-darwin").exists()
            )
            self.assertFalse(any(path.is_dir() for path in runtime.rglob("include")))
            self.assertFalse(any(runtime.rglob("*.a")))
            self.assertFalse(any(runtime.rglob("*.o")))

    def test_final_validation_rejects_each_development_payload_class(self):
        # Mutation caught: relying only on pruning and allowing a build-only
        # artifact reintroduced before manifest publication.
        relative_paths = (
            "include/python3.12/Python.h",
            "lib/pkgconfig/python-3.12.pc",
            "lib/python3.12/config-3.12-darwin/Makefile",
            "lib/python3.12/site-packages/numpy/core/include/numpy/arrayobject.h",
            "lib/libpython-fixture.a",
            "lib/python3.12/config-3.12-darwin/python.o",
        )
        for relative in relative_paths:
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                runtime = root / "runtime"
                (runtime / "bin").mkdir(parents=True)
                (runtime / "lib" / "python3.12" / "site-packages").mkdir(parents=True)
                artifact = runtime / relative
                artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_bytes(b"build-only")
                logger = bootstrap_python_macos.ProvisionLogger(root / "provision.log")

                pip_absent = subprocess.CompletedProcess(
                    [str(runtime / "bin" / "python3.12"), "-m", "pip"],
                    1,
                    stdout="",
                    stderr="No module named pip",
                )
                with (
                    patch.object(
                        bootstrap_python_macos.subprocess,
                        "run",
                        return_value=pip_absent,
                    ),
                    self.assertRaisesRegex(RuntimeError, "provisioning-only"),
                ):
                    bootstrap_python_macos.validate_pruned_runtime(runtime, root, logger)

    def test_prunes_pip_launchers_ensurepip_and_bytecode_before_final_validation(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            venv.EnvBuilder(with_pip=False).create(runtime)
            pyvenv = runtime / "pyvenv.cfg"
            pyvenv.write_text(
                pyvenv.read_text(encoding="utf-8").replace(temporary, "/relocated"),
                encoding="utf-8",
            )
            version = f"python{sys.version_info.major}.{sys.version_info.minor}"
            site_packages = runtime / "lib" / version / "site-packages"
            (site_packages / "pip").mkdir()
            (site_packages / "pip" / "__init__.py").write_text("# pip\n")
            (site_packages / "pip-26.1.2.dist-info").mkdir()
            bytecode = site_packages / "fixture" / "__pycache__"
            bytecode.mkdir(parents=True)
            (bytecode / "fixture.pyc").write_bytes(b"cache")
            ensurepip = runtime / "lib" / version / "ensurepip" / "_bundled"
            ensurepip.mkdir(parents=True)
            (ensurepip / "pip-25.0.1-py3-none-any.whl").write_bytes(b"wheel")
            for name in ("pip", "pip3", f"pip{sys.version_info.major}.{sys.version_info.minor}"):
                (runtime / "bin" / name).write_text("launcher\n")
            (runtime / "bin" / "gseapy").write_text(
                f"#!{runtime}/bin/python3.12\n", encoding="utf-8"
            )
            direct_url = site_packages / "gseapy-1.1.11.dist-info" / "direct_url.json"
            direct_url.parent.mkdir()
            direct_url.write_text(
                '{"url":"file:///Users/example/private/gseapy.whl"}\n',
                encoding="utf-8",
            )

            bootstrap_python_macos.prune_provisioning_artifacts(runtime)
            logger = bootstrap_python_macos.ProvisionLogger(
                Path(temporary) / "provision.log"
            )
            bootstrap_python_macos.validate_pruned_runtime(runtime, Path(temporary), logger)

            self.assertFalse((site_packages / "pip").exists())
            self.assertFalse((site_packages / "pip-26.1.2.dist-info").exists())
            self.assertFalse((runtime / "lib" / version / "ensurepip").exists())
            self.assertFalse(any((runtime / "bin").glob("pip*")))
            self.assertEqual(
                {path.name for path in (runtime / "bin").iterdir()},
                {"python", "python3", f"python{sys.version_info.major}.{sys.version_info.minor}"},
            )
            self.assertFalse(any(runtime.rglob("direct_url.json")))
            self.assertFalse(any(runtime.rglob("__pycache__")))
            self.assertFalse(any(runtime.rglob("*.pyc")))

            (site_packages / "nuitka-2.8.9.dist-info").mkdir()
            with self.assertRaisesRegex(RuntimeError, "provisioning-only"):
                bootstrap_python_macos.validate_pruned_runtime(
                    runtime, Path(temporary), logger
                )

            (runtime / "bin" / "gseapy").write_text("#!/local/python\n")
            with self.assertRaisesRegex(RuntimeError, "provisioning-only"):
                bootstrap_python_macos.validate_pruned_runtime(
                    runtime, Path(temporary), logger
                )

    def test_final_runtime_rejects_local_build_paths_in_text_binary_and_symlinks(self):
        # Mutation caught: scanning only manifest values while private paths remain
        # in wheel metadata, launchers, native extensions, or symlink targets.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "checkout"
            runtime = root / "python_embedded" / "runtime"
            runtime.mkdir(parents=True)
            bootstrap_python_macos.validate_no_local_build_paths(runtime, (root,))

            leaked = runtime / "native.so"
            leaked.write_bytes(b"Mach-O\0" + os.fsencode(root / "cargo" / "src.rs"))
            with self.assertRaisesRegex(RuntimeError, "local build path"):
                bootstrap_python_macos.validate_no_local_build_paths(runtime, (root,))
            leaked.unlink()

            (runtime / "absolute-link").symlink_to(root / "outside")
            with self.assertRaisesRegex(RuntimeError, "local build path"):
                bootstrap_python_macos.validate_no_local_build_paths(runtime, (root,))

    def test_intel_rust_build_remaps_machine_local_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "checkout"
            environment = bootstrap_python_macos.gseapy_build_environment(root)
            rust_flags = environment["RUSTFLAGS"]
            for local_root in (
                root.resolve(),
                Path.home().resolve(),
                Path(tempfile.gettempdir()).resolve(),
            ):
                self.assertIn(f"--remap-path-prefix={local_root}=", rust_flags)
            self.assertIn("=easycris-build/", rust_flags)
            self.assertEqual(environment["CARGO_INCREMENTAL"], "0")

    def test_pip_orchestration_is_isolated_from_python_environment_variables(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            logger = bootstrap_python_macos.ProvisionLogger(root / "provision.log")
            with (
                patch.dict(
                    os.environ,
                    {"PYTHONPATH": "/poison", "PYTHONHOME": "/redirect"},
                    clear=False,
                ),
                patch.object(
                    bootstrap_python_macos,
                    "run_captured",
                    return_value="gseapy @ file:///private/build/gseapy.whl\n",
                ) as captured,
            ):
                bootstrap_python_macos._run_pip(
                    Path("/runtime/bin/python3.12"),
                    ["freeze", "--all"],
                    root=root,
                    logger=logger,
                    capture=True,
                )
            command = captured.call_args.args[0]
            environment = captured.call_args.kwargs["env"]
            self.assertEqual(command[1:5], ["-I", "-B", "-m", "pip"])
            self.assertNotIn("PYTHONPATH", environment)
            self.assertNotIn("PYTHONHOME", environment)


class ProvisionOrchestrationBoundaryTests(unittest.TestCase):
    def test_runtime_replacement_is_atomic_and_preserves_the_old_tree_on_copy_failure(self):
        # Mutation caught: deleting the live runtime before the candidate tree is complete.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "extracted" / "python"
            (source / "bin").mkdir(parents=True)
            (source / "bin" / "python3.12").write_text("new", encoding="utf-8")
            runtime = root / "python_embedded" / "runtime"
            runtime.mkdir(parents=True)
            (runtime / "old-marker").write_text("old", encoding="utf-8")

            with patch.object(bootstrap_python_macos.shutil, "copytree", side_effect=RuntimeError("copy failed")):
                with self.assertRaisesRegex(RuntimeError, "copy failed"):
                    bootstrap_python_macos.atomic_materialize_runtime(source, runtime)
            self.assertEqual((runtime / "old-marker").read_text(), "old")

            bootstrap_python_macos.atomic_materialize_runtime(source, runtime)
            self.assertEqual((runtime / "bin" / "python3.12").read_text(), "new")
            self.assertFalse((runtime / "old-marker").exists())

    def test_provision_rejects_complete_input_state_drift_before_publication(self):
        # Mutation caught: sampling HEAD/tree/fingerprint/inventories only at
        # startup, then publishing an old-head passed checkpoint after drift.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            initial_git = {
                "head": "a" * 40,
                "clean_tree": True,
                "dirty_entry_count": 0,
                "state_sha256": "1" * 64,
            }
            changed_git = {**initial_git, "state_sha256": "2" * 64}
            initial_requirements = {"requirements-macos.txt": "3" * 64}
            changed_requirements = {"requirements-macos.txt": "4" * 64}
            initial_sources = {"files": ["stats.py"], "sha256": "5" * 64}
            changed_sources = {"files": ["stats.py"], "sha256": "6" * 64}
            probe_results = {
                name: {"success": True}
                for name in ("stats", "rnaseq", "plot", "pdf", "tiff")
            }

            def materialize(_source, runtime):
                (runtime / "lib" / "python3.12" / "site-packages").mkdir(
                    parents=True
                )

            def write_manifest(**kwargs):
                path = kwargs["runtime"] / "easycris_runtime_manifest.json"
                bootstrap_python_macos.atomic_write_json(path, {})
                return path

            capture_git = patch.object(
                bootstrap_python_macos,
                "capture_git_state",
                side_effect=(initial_git, changed_git),
                create=True,
            )
            fingerprint = patch.object(
                bootstrap_python_macos,
                "compute_content_fingerprint",
                side_effect=("7" * 64, "8" * 64),
            )
            requirements = patch.object(
                bootstrap_python_macos,
                "_requirements_hashes",
                side_effect=(initial_requirements, changed_requirements),
            )
            sources = patch.object(
                bootstrap_python_macos,
                "backend_source_inventory",
                side_effect=(initial_sources, changed_sources),
            )
            patchers = [
                patch.object(bootstrap_python_macos, "validate_host", return_value="x86_64"),
                patch.object(
                    bootstrap_python_macos,
                    "select_archive_pin",
                    return_value={
                        "filename": "cpython.tar.gz",
                        "sha256": "9" * 64,
                        "python_version": "3.12.13",
                    },
                ),
                patch.object(
                    bootstrap_python_macos,
                    "_git_state",
                    return_value=("a" * 40, True, 0),
                ),
                capture_git,
                patch.object(bootstrap_python_macos, "_ensure_ignored"),
                fingerprint,
                requirements,
                sources,
                patch.object(bootstrap_python_macos, "parse_hashed_lock", return_value=()),
                patch.object(bootstrap_python_macos, "validate_lock_matches_requirements"),
                patch.object(bootstrap_python_macos, "_download_archive"),
                patch.object(bootstrap_python_macos, "verify_and_extract_archive"),
                patch.object(
                    bootstrap_python_macos,
                    "atomic_materialize_runtime",
                    side_effect=materialize,
                ),
                patch.object(
                    bootstrap_python_macos,
                    "_verify_relocated_interpreter",
                    return_value={"path": "bin/python3.12"},
                ),
                patch.object(bootstrap_python_macos, "_ensure_builder", return_value=Path("/builder")),
                patch.object(
                    bootstrap_python_macos,
                    "_download_locked_groups",
                    return_value=(root / "wheelhouse", {}),
                ),
                patch.object(bootstrap_python_macos, "_install_locked_dependencies"),
                patch.object(bootstrap_python_macos, "_apply_and_validate_overlay"),
                patch.object(bootstrap_python_macos, "prune_provisioning_artifacts"),
                patch.object(
                    bootstrap_python_macos,
                    "stage_backend_sources",
                    return_value=initial_sources,
                ),
                patch.object(bootstrap_python_macos, "validate_pruned_runtime"),
                patch.object(
                    bootstrap_python_macos,
                    "final_runtime_distribution_inventory",
                    return_value=[{"name": "fixture", "version": "1.0"}],
                ),
                patch.object(bootstrap_python_macos, "thin_universal_machos", return_value=[]),
                patch.object(bootstrap_python_macos, "_verify_required_imports"),
                patch.object(bootstrap_python_macos, "_run_real_probes", return_value=probe_results),
                patch.object(
                    bootstrap_python_macos,
                    "_verify_macho_inventory",
                    return_value={"count": 1, "files": []},
                ),
                patch.object(
                    bootstrap_python_macos,
                    "_write_runtime_manifest",
                    side_effect=write_manifest,
                ),
                patch.object(bootstrap_python_macos, "_populate_artifact_cache"),
            ]
            with ExitStack() as stack:
                mocks = [stack.enter_context(patcher) for patcher in patchers]
                with self.assertRaisesRegex(RuntimeError, "changed during provisioning"):
                    bootstrap_python_macos.provision(root=root, environment={})

            self.assertEqual(mocks[2].call_count, 0)
            self.assertEqual(mocks[3].call_count, 2)
            self.assertEqual(mocks[5].call_count, 2)
            self.assertEqual(mocks[6].call_count, 2)
            self.assertEqual(mocks[7].call_count, 2)
            checkpoint = json.loads(
                (root / "_tmp" / "python-runtime" / ("a" * 40) / "x86_64" / "checkpoint.json").read_text()
            )
            self.assertEqual(checkpoint["status"], "failed")

    def test_output_and_cache_cleanup_reject_symlinked_managed_roots(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            external = Path(temporary) / "external"
            (root / "_tmp").mkdir(parents=True)
            (external / "head" / "x86_64").mkdir(parents=True)
            marker = external / "head" / "x86_64" / "keep.txt"
            marker.write_text("keep", encoding="utf-8")
            (root / "_tmp" / "python-runtime").symlink_to(external, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                bootstrap_python_macos._safe_recreate_output(
                    root,
                    root / "_tmp" / "python-runtime" / "head" / "x86_64",
                    "x86_64",
                )
            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_filtered_pip_inputs_keep_hashes_and_partition_the_final_lock(self):
        # Mutation caught: resolving an overlay dependency bare or sending the Intel source to normal install.
        entries = bootstrap_python_macos.parse_hashed_lock(
            ROOT / "python_embedded" / "requirements-macos-x86_64.lock"
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = bootstrap_python_macos.write_filtered_lock(entries, root / "runtime.txt", {"runtime"})
            overlay = bootstrap_python_macos.write_filtered_lock(entries, root / "overlay.txt", {"rnaseq-overlay"})
            source = bootstrap_python_macos.write_filtered_lock(entries, root / "source.txt", {"intel-source"})
            self.assertIn("requests==2.34.2 --hash=sha256:", runtime.read_text())
            self.assertNotIn("pydeseq2", runtime.read_text())
            self.assertIn("pydeseq2==0.5.3 --hash=sha256:", overlay.read_text())
            self.assertEqual(
                [line for line in source.read_text().splitlines() if line],
                [
                    "gseapy==1.1.11 --hash=sha256:d36a164ee466f7ea6deadfe82ea041f3328ee937ff4c9de862b3e6e2825df0dd"
                ],
            )

    def test_failure_output_is_limited_to_the_final_80_log_lines(self):
        # Mutation caught: dumping an unbounded provisioning log to the agent transcript.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            head = "a" * 40
            log = root / "_tmp" / "python-runtime" / head / "x86_64" / "provision.log"
            log.parent.mkdir(parents=True)
            log.write_text("".join(f"line-{index}\n" for index in range(120)), encoding="utf-8")
            tail = bootstrap_python_macos.managed_failure_log_tail(
                root, head, "x86_64"
            )
            self.assertEqual(len(tail.splitlines()), 80)
            self.assertTrue(tail.startswith("line-40\n"))
            self.assertTrue(tail.endswith("line-119"))

    def test_failure_path_rejection_never_opens_external_symlink_content(self):
        # Mutation caught: reconstructing provision.log after a failure and
        # following either the log or a managed-root symlink to external data.
        for link_kind in ("log", "managed-root"):
            with self.subTest(link_kind=link_kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / "repo"
                external = Path(temporary) / "external"
                head = "b" * 40
                arch = "x86_64"
                output = root / "_tmp" / "python-runtime" / head / arch
                external_output = external / head / arch
                external_output.mkdir(parents=True)
                secret = external_output / "provision.log"
                secret.write_text("DO-NOT-DISCLOSE-EXTERNAL-CONTENT\n", encoding="utf-8")
                if link_kind == "log":
                    output.mkdir(parents=True)
                    (output / "provision.log").symlink_to(secret)
                else:
                    (root / "_tmp").mkdir(parents=True)
                    (root / "_tmp" / "python-runtime").symlink_to(
                        external, target_is_directory=True
                    )

                original_open = Path.open

                def reject_external_open(path, *args, **kwargs):
                    if path.resolve(strict=False) == secret.resolve():
                        raise AssertionError("external provision log was opened")
                    return original_open(path, *args, **kwargs)

                stderr = io.StringIO()
                git_result = subprocess.CompletedProcess(
                    ["git", "rev-parse", "HEAD"], 0, stdout=head + "\n", stderr=""
                )
                with (
                    patch.object(bootstrap_python_macos, "ROOT", root),
                    patch.object(
                        bootstrap_python_macos,
                        "provision",
                        side_effect=RuntimeError("fixture provision failure"),
                    ),
                    patch.object(bootstrap_python_macos.platform, "machine", return_value=arch),
                    patch.object(bootstrap_python_macos.subprocess, "run", return_value=git_result),
                    patch.object(Path, "open", reject_external_open),
                    redirect_stderr(stderr),
                ):
                    self.assertEqual(bootstrap_python_macos.main([]), 1)

                diagnostic = stderr.getvalue()
                self.assertIn("provision-log-rejected", diagnostic)
                self.assertIn("macos-python-runtime-failed", diagnostic)
                self.assertNotIn("DO-NOT-DISCLOSE", diagnostic)

    def test_failure_tail_rejects_parent_directory_symlink_swap_after_validation(self):
        # Mutation caught: relying on final-component O_NOFOLLOW after releasing
        # path validation, allowing a verified parent to be swapped to a symlink.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            head = "c" * 40
            arch = "x86_64"
            output = root / "_tmp" / "python-runtime" / head / arch
            output.mkdir(parents=True)
            (output / "provision.log").write_text("SAFE\n", encoding="utf-8")
            external = Path(temporary) / "external"
            external.mkdir()
            (external / "provision.log").write_text(
                "SECRET-FROM-SWAPPED-PARENT\n", encoding="utf-8"
            )
            backup = output.with_name("x86_64-before-swap")
            original_validate = bootstrap_python_macos._validate_managed_path
            swapped = False

            def validate_then_swap(validate_root, path, managed_name):
                nonlocal swapped
                original_validate(validate_root, path, managed_name)
                if path.name == "provision.log" and not swapped:
                    output.rename(backup)
                    output.symlink_to(external, target_is_directory=True)
                    swapped = True

            with patch.object(
                bootstrap_python_macos,
                "_validate_managed_path",
                side_effect=validate_then_swap,
            ):
                with self.assertRaisesRegex(RuntimeError, "safe|symlink|directory"):
                    bootstrap_python_macos.managed_failure_log_tail(root, head, arch)
            self.assertTrue(swapped)

    def test_archive_download_uses_system_https_trust_and_the_exact_pinned_url(self):
        # Mutation caught: falling back to an unconfigured Python CA path or weakening HTTPS.
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            logger = bootstrap_python_macos.ProvisionLogger(root / "provision.log")
            destination = root / "archive" / "runtime.tar.gz"
            pin = bootstrap_python_macos.select_archive_pin("Darwin", "x86_64")

            def runner(command, **_kwargs):
                calls.append(command)
                output = Path(command[command.index("--output") + 1])
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b"archive")

            bootstrap_python_macos._download_archive(
                pin, destination, logger, runner=runner
            )
            self.assertEqual(destination.read_bytes(), b"archive")
            self.assertEqual(calls[0][0], "/usr/bin/curl")
            self.assertIn("--fail", calls[0])
            self.assertIn("--location", calls[0])
            self.assertEqual(calls[0][calls[0].index("--proto") + 1], "=https")
            self.assertIn("--tlsv1.2", calls[0])
            self.assertEqual(calls[0][-1], pin["url"])


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


if __name__ == "__main__":
    unittest.main()
