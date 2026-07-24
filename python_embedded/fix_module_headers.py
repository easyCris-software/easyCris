"""
Fix VERSION/DATE headers in statistics modules.
Wraps them inside docstrings so Python doesn't try to execute them.
"""

import re
from pathlib import Path

def fix_module_header(file_path: Path):
    """Fix a single module's header."""
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Pattern: VERSION and DATE lines followed by docstring
    pattern = r'^(VERSION:\s*[\d.]+)\s*\n(DATE:\s*[\d\-]+)\s*\n\s*\n("""[\s\S]*?""")'

    def replacer(match):
        version = match.group(1)
        date = match.group(2)
        docstring = match.group(3)

        # Extract docstring content (without triple quotes)
        doc_content = docstring.strip('"""').strip()

        # Build new docstring with VERSION/DATE inside
        new_docstring = f'"""\n{doc_content}\n\n{version}\n{date}\n"""'
        return new_docstring

    # Apply fix
    new_content = re.sub(pattern, replacer, content, flags=re.MULTILINE)

    if new_content != content:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        return True
    return False

def main():
    stats_dir = Path(__file__).parent / "statistics_module"

    if not stats_dir.exists():
        print(f"ERROR: {stats_dir} not found")
        return

    fixed_count = 0
    for py_file in stats_dir.glob("*.py"):
        if py_file.name.startswith("__"):
            continue

        try:
            if fix_module_header(py_file):
                print(f"Fixed: {py_file.name}")
                fixed_count += 1
            else:
                print(f"Skipped (already OK or no match): {py_file.name}")
        except Exception as e:
            print(f"ERROR fixing {py_file.name}: {e}")

    print(f"\nFixed {fixed_count} files")

if __name__ == "__main__":
    main()
