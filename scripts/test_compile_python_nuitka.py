#!/usr/bin/env python3
"""Platform option contracts for the shared Nuitka compiler."""

import tempfile
import unittest
from pathlib import Path

from compile_python_nuitka import executable_name, platform_nuitka_args, validate_kaleido_payload


class PlatformCompileTests(unittest.TestCase):
    def test_windows_keeps_existing_flags(self):
        args = platform_nuitka_args("win32", "x86_64")
        self.assertIn("--windows-console-mode=force", args)
        self.assertIn("--msvc=latest", args)
        self.assertEqual(executable_name("stats", "win32"), "stats.exe")

    def test_darwin_uses_standalone_cli_output(self):
        args = platform_nuitka_args("darwin", "x86_64")
        self.assertNotIn("--windows-console-mode=force", args)
        self.assertNotIn("--msvc=latest", args)
        self.assertIn("--macos-target-arch=x86_64", args)
        self.assertEqual(executable_name("stats", "darwin"), "stats")

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
