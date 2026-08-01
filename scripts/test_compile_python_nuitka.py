#!/usr/bin/env python3
"""Windows-only contract tests for the unchanged Nuitka compiler lane."""

import io
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

import compile_python_nuitka


class WindowsCompileContractTests(unittest.TestCase):
    def test_main_rejects_non_windows_before_build_checks(self):
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            with (
                patch.object(compile_python_nuitka.sys, "platform", "darwin"),
                patch.dict(
                    compile_python_nuitka.os.environ,
                    {"EASYCRIS_TARGET_PLATFORM": "win32"},
                ),
                patch.object(compile_python_nuitka, "compile_backend") as compile_backend,
            ):
                result = compile_python_nuitka.main()

        self.assertEqual(result, 1)
        self.assertIn("Windows-only", stderr.getvalue())
        compile_backend.assert_not_called()

    def test_windows_stats_command_keeps_arguments_and_exclusions(self):
        with tempfile.TemporaryDirectory() as temporary:
            staged_source = Path(temporary)
            (staged_source / "stats.py").write_text("print('fixture')\n")
            captured_commands = []

            with (
                patch.object(compile_python_nuitka, "remove_previous_outputs"),
                patch.object(
                    compile_python_nuitka,
                    "prepare_compile_source_tree",
                    return_value=staged_source,
                ),
                patch.object(
                    compile_python_nuitka,
                    "run_checked",
                    side_effect=lambda command, **_kwargs: captured_commands.append(command),
                ),
                patch.object(compile_python_nuitka, "validate_no_critical_excluded_dlls"),
                patch.object(compile_python_nuitka, "ensure_output"),
                patch.object(compile_python_nuitka, "sync_top_level_exe"),
                patch.object(compile_python_nuitka, "bundle_msvc_runtime_dlls"),
            ):
                backend = next(
                    item for item in compile_python_nuitka.BACKENDS
                    if item["name"] == "stats"
                )
                compile_python_nuitka.compile_backend(
                    backend["entrypoint"],
                    backend["name"],
                    backend["extra_args"],
                    backend["allow_unittest"],
                )

        self.assertEqual(len(captured_commands), 1)
        command = captured_commands[0]
        self.assertIn("--windows-console-mode=force", command)
        self.assertIn("--msvc=latest", command)
        self.assertNotIn("--macos-target-arch=x86_64", command)
        self.assertEqual(
            [
                arg for arg in command
                if arg.startswith("--nofollow-import-to=")
            ],
            [
                "--nofollow-import-to=pytest",
                "--nofollow-import-to=_pytest",
                "--nofollow-import-to=test",
                "--nofollow-import-to=*.tests",
                "--nofollow-import-to=*.tests.*",
                "--nofollow-import-to=pkg_resources",
                "--nofollow-import-to=setuptools",
                "--nofollow-import-to=_distutils_hack",
            ],
        )
        self.assertTrue(command[-1].endswith("stats.py"))

    def test_windows_output_contract_remains_exe_at_both_locations(self):
        with tempfile.TemporaryDirectory() as temporary:
            dist = Path(temporary)
            nested = dist / "stats.dist"
            nested.mkdir()
            source = nested / "stats.exe"
            source.write_bytes(b"fixture-windows-executable")

            with (
                patch.object(compile_python_nuitka, "DIST_DIR", dist),
            ):
                compile_python_nuitka.ensure_output("stats")
                compile_python_nuitka.sync_top_level_exe("stats")

            self.assertEqual(
                (dist / "stats.exe").read_bytes(),
                b"fixture-windows-executable",
            )


if __name__ == "__main__":
    unittest.main()
