# Public Export Runbook

## Purpose
Generate a curated public snapshot from the private `easycris_tauri` master without exposing internal artifacts.

## Command

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/export-public-snapshot.ps1 -OutputPath C:\tmp\easycris-public
```

## Dry Run

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/export-public-snapshot.ps1 -OutputPath C:\tmp\easycris-public -DryRun
```

## What the script does
1. Copies only public-scope paths.
2. Removes known internal/forbidden paths.
3. Enforces forbidden-path checks.
4. Initializes fresh git history and creates `chore: initial public snapshot` commit.

## Verification
Run from export directory:

```powershell
git ls-files | rg "^(backup/|old_documentation/|_documentation/|memory/|memory_db/|playwright-report/|edgedriver_win|\.env$|\.env\.production$|\.claude/|AGENTS\.md$|CLAUDE\.md$|\.mcp\.json$|python_embedded/python_dependencies/|python_embedded/python\.exe|python_embedded/python312\.dll|python_embedded/.*\.pyd$|python_embedded/.*\.dll$|python_embedded/.*embed.*\.zip$|python_embedded/.*runtime.*\.zip$|src-tauri/resources/legal/EULA\.txt$)"
```

Expected: no output.

Dataset/caches policy check:

```powershell
git ls-files | rg "^(_test_validation/|RNA_seq/validation/)"
```

Expected: no output unless explicitly approved with legal/data-use signoff.

Large file review:

```powershell
git ls-files | % { if(Test-Path $_){ $s=(gi $_).Length/1MB; if($s -gt 5){ "{0:N2} MB`t{1}" -f $s,$_ } } } | sort {[double]($_ -split ' MB')[0]} -desc
```

Expected: no unexpected binary/runtime payloads.

## Notes
- Public docs and licensing copy should reference: `hello@easycris.com` for commercial licensing.
- For official releases, artifacts come from CI release workflow, not from git-tracked runtimes.
- Configure public `main` branch protection with required checks:
  - `pr-quality-gates`
  - `cla-check`
