#!/usr/bin/env python3
"""Contract tests for the Darwin Python-runtime bootstrap."""

from __future__ import annotations

import importlib
import io
import json
import os
import platform as host_platform
import sys
import tarfile
import tempfile
import unittest
import venv
import zipfile
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
    def test_macho_must_contain_the_native_arch_and_not_exceed_macos_14(self):
        # Mutation caught: accepting an opposite-architecture wheel or raising the support floor.
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "native.so"
            binary.write_bytes(b"fixture")
            commands = []

            def valid_runner(command, **_kwargs):
                commands.append(command)
                if command[0] == "/usr/bin/file":
                    return "Mach-O universal binary with 2 architectures: x86_64 arm64"
                return "cmd LC_BUILD_VERSION\n minos 10.13\ncmd LC_BUILD_VERSION\n minos 14.0\n"

            record = bootstrap_python_macos.validate_macho_file(
                binary, "x86_64", valid_runner
            )
            self.assertEqual(record["minimum_macos_versions"], ["10.13", "14.0"])
            self.assertEqual(commands[0][:2], ["/usr/bin/file", "-b"])
            self.assertEqual(commands[1][:2], ["/usr/bin/otool", "-l"])
            unrelated_versions = bootstrap_python_macos.validate_macho_file(
                binary,
                "x86_64",
                lambda command, **_kwargs: (
                    "Mach-O x86_64"
                    if command[0] == "/usr/bin/file"
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
                    lambda command, **_kwargs: "Mach-O arm64" if command[0] == "/usr/bin/file" else "minos 13.0",
                )
            with self.assertRaisesRegex(RuntimeError, "14.0"):
                bootstrap_python_macos.validate_macho_file(
                    binary,
                    "x86_64",
                    lambda command, **_kwargs: "Mach-O x86_64" if command[0] == "/usr/bin/file" else "cmd LC_BUILD_VERSION\n minos 14.1",
                )


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

    def test_cache_snapshot_authenticates_every_runtime_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary) / "runtime-snapshot"
            (cache / "bin").mkdir(parents=True)
            (cache / "bin" / "python3.12").write_bytes(b"python")
            (cache / "lib").mkdir()
            payload = cache / "lib" / "payload.so"
            payload.write_bytes(b"trusted")
            manifest = {
                "architecture": "x86_64",
                "content_fingerprint": "f" * 64,
                "runtime_tree_sha256": bootstrap_python_macos.runtime_tree_sha256(cache),
            }
            bootstrap_python_macos.atomic_write_json(
                cache / "easycris_runtime_manifest.json", manifest
            )
            self.assertTrue(
                bootstrap_python_macos._valid_cache_snapshot(cache, "x86_64", "f" * 64)
            )
            payload.write_bytes(b"tampered")
            self.assertFalse(
                bootstrap_python_macos._valid_cache_snapshot(cache, "x86_64", "f" * 64)
            )

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
            log = Path(temporary) / "provision.log"
            log.write_text("".join(f"line-{index}\n" for index in range(120)), encoding="utf-8")
            tail = bootstrap_python_macos.failure_log_tail(log)
            self.assertEqual(len(tail.splitlines()), 80)
            self.assertTrue(tail.startswith("line-40\n"))
            self.assertTrue(tail.endswith("line-119"))

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
