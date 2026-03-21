"""
Version Lock Verification Tool
Fast, simple check that module versions match VALIDATED_VERSIONS.json

Usage:
    python verify_versions.py              # Check all modules
    python verify_versions.py --quiet      # CI mode (exit code only)
    python verify_versions.py --module mediation  # Check one module
"""

import json
import re
import sys
from pathlib import Path

# ANSI colors
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
RESET = "\033[0m"


def extract_version(filepath: Path) -> str:
    """Extract VERSION from first 50 lines of module."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            for i, line in enumerate(f):
                if i >= 50:  # Only scan header
                    break
                # Match: VERSION = "1.7.0" or VERSION: 1.7.0 or VERSION: 2.0
                match = re.search(r'VERSION\s*[=:]\s*["\']?(\d+\.\d+(?:\.\d+)?)["\']?', line)
                if match:
                    return match.group(1)
    except Exception as e:
        return None
    return None


def load_manifest() -> dict:
    """Load manifest, fail gracefully if missing."""
    manifest_path = Path(__file__).parent / "VALIDATED_VERSIONS.json"
    if not manifest_path.exists():
        print(f"{RED}ERROR: VALIDATED_VERSIONS.json not found{RESET}")
        print(f"Expected: {manifest_path}")
        sys.exit(1)

    with open(manifest_path, 'r') as f:
        return json.load(f)


def verify_module(module_name: str, expected_version: str) -> tuple:
    """
    Verify single module.
    Returns: (is_valid, current_version, message)
    """
    module_path = Path(__file__).parent / f"{module_name}.py"

    if not module_path.exists():
        return False, "MISSING", f"File not found: {module_name}.py"

    current_version = extract_version(module_path)

    if current_version is None:
        return False, "NOT_FOUND", f"VERSION not found in first 50 lines of {module_name}.py"

    if current_version != expected_version:
        return False, current_version, f"Expected {expected_version}, found {current_version}"

    return True, current_version, "OK"


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Verify module versions")
    parser.add_argument("--quiet", action="store_true", help="Quiet mode (exit code only)")
    parser.add_argument("--module", type=str, help="Check single module")

    args = parser.parse_args()
    manifest = load_manifest()
    modules = manifest.get("modules", {})

    # Single module check
    if args.module:
        if args.module not in modules:
            if not args.quiet:
                print(f"{RED}Module '{args.module}' not in manifest{RESET}")
            sys.exit(1)

        expected = modules[args.module]["version"]
        is_valid, current, msg = verify_module(args.module, expected)

        if not args.quiet:
            status = f"{GREEN}[OK]{RESET}" if is_valid else f"{RED}[FAIL]{RESET}"
            print(f"{status} {args.module} v{current} - {msg}")

        sys.exit(0 if is_valid else 1)

    # Check all modules
    if not args.quiet:
        print(f"\n{'='*70}")
        print(f"Version Lock Check (Validation Plan v{manifest.get('validation_plan_version')})")
        print(f"{'='*70}\n")

    passed = 0
    failed = 0

    for module_name, info in modules.items():
        expected = info["version"]
        is_valid, current, msg = verify_module(module_name, expected)

        if is_valid:
            passed += 1
            if not args.quiet:
                print(f"{GREEN}[OK]{RESET}   {module_name:20s} v{current}")
        else:
            failed += 1
            if not args.quiet:
                print(f"{RED}[FAIL]{RESET} {module_name:20s} v{current} - {msg}")
                print(f"  {'':24s} Validation: {info.get('validation_group', 'N/A')}")

    if not args.quiet:
        print(f"\n{'='*70}")
        if failed == 0:
            print(f"{GREEN}All {passed} modules match validated versions - PASS{RESET}")
        else:
            print(f"{RED}MISMATCH: {failed} module(s) don't match manifest{RESET}")
            print(f"{YELLOW}Action: Revert changes OR re-run validation tests{RESET}")
        print(f"{'='*70}\n")

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
