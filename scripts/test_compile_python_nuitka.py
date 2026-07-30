#!/usr/bin/env python3
"""Platform option contracts for the shared Nuitka compiler."""

import unittest

from compile_python_nuitka import executable_name, platform_nuitka_args


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


if __name__ == "__main__":
    unittest.main()
