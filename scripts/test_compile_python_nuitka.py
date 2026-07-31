#!/usr/bin/env python3
"""Platform option contracts for the shared Nuitka compiler."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import compile_python_nuitka
from compile_python_nuitka import executable_name, platform_nuitka_args, validate_kaleido_payload


class PlatformCompileTests(unittest.TestCase):
    def test_windows_keeps_existing_flags(self):
        args = platform_nuitka_args("win32", "x86_64", "stats")
        self.assertIn("--windows-console-mode=force", args)
        self.assertIn("--msvc=latest", args)
        self.assertNotIn("--output-filename=stats", args)
        self.assertEqual(executable_name("stats", "win32"), "stats.exe")

    def test_darwin_uses_standalone_cli_output(self):
        args = platform_nuitka_args("darwin", "x86_64")
        self.assertNotIn("--windows-console-mode=force", args)
        self.assertNotIn("--msvc=latest", args)
        self.assertIn("--macos-target-arch=x86_64", args)
        self.assertIn("--static-libpython=no", args)
        self.assertEqual(executable_name("stats", "darwin"), "stats")

    def test_darwin_stats_compile_command_names_extensionless_output(self):
        # Mutation caught: Nuitka defaults to a .bin launcher, breaking the Darwin stats contract.
        with tempfile.TemporaryDirectory() as temporary:
            staged_source = Path(temporary) / "source"
            staged_source.mkdir()
            (staged_source / "stats.py").write_text("print('fixture')\n")
            captured_commands: list[list[str]] = []

            with (
                patch.object(compile_python_nuitka, "TARGET_PLATFORM", "darwin"),
                patch.object(compile_python_nuitka, "TARGET_ARCH", "x86_64"),
                patch.object(compile_python_nuitka, "remove_previous_outputs"),
                patch.object(compile_python_nuitka, "prepare_compile_source_tree", return_value=staged_source),
                patch.object(
                    compile_python_nuitka,
                    "run_checked",
                    side_effect=lambda command, **_kwargs: captured_commands.append(command),
                ),
                patch.object(compile_python_nuitka, "ensure_output"),
                patch.object(compile_python_nuitka, "sync_top_level_exe"),
            ):
                compile_python_nuitka.compile_backend("stats.py", "stats", (), True)

        self.assertEqual(len(captured_commands), 1)
        self.assertIn("--output-filename=stats", captured_commands[0])

    def test_kaleido_payload_keeps_non_macho_files_and_validates_only_macho(self):
        # Mutation caught: rejecting shell/assets by filename/bit or accepting no native payload.
        with tempfile.TemporaryDirectory() as temporary:
            payload = Path(temporary)
            shell = payload / "launcher"
            ogg = payload / "sound.ogg"
            macho = payload / "bin" / "kaleido"
            macho.parent.mkdir()
            for entry in (shell, ogg, macho):
                entry.write_bytes(b"fixture")
                entry.chmod(0o755)

            def inspect(path: Path) -> str:
                return "Mach-O 64-bit executable x86_64" if path == macho else "POSIX shell script text executable"

            validate_kaleido_payload(payload, "darwin", "x86_64", inspect)
            self.assertTrue(shell.exists())
            self.assertTrue(ogg.exists())
            with self.assertRaisesRegex(RuntimeError, "No Mach-O"):
                validate_kaleido_payload(payload, "darwin", "x86_64", lambda _path: "Ogg data")


if __name__ == "__main__":
    unittest.main()
