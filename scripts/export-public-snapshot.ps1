param(
  [string]$OutputPath,
  [switch]$SkipGitInit,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  throw "OutputPath is required. Example: pwsh scripts/export-public-snapshot.ps1 -OutputPath C:\\tmp\\easycris-public"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$includePaths = @(
  "src",
  "src-tauri",
  "python_embedded/statistics_module",
  "python_embedded/rnaseq_module",
  "python_embedded/stats_backend.py",
  "python_embedded/rnaseq_backend.py",
  "python_embedded/requirements-validated.txt",
  "python_embedded/requirements-rnaseq.txt",
  "python_embedded/.gitignore",
  "scripts",
  "e2e",
  "docs",
  "public",
  "legal",
  "runtime-licenses-js.json",
  "runtime-licenses-rust.json",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "vitest.config.ts",
  "vite.config.ts",
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  ".github"
)

$excludePrefixes = @(
  "backup/",
  "old_documentation/",
  "_documentation/",
  "memory/",
  "memory_db/",
  ".claude/",
  "playwright-report/",
  "edgedriver_win",
  "python_embedded/python_dependencies/",
  "python_embedded/python.exe",
  "python_embedded/python312.dll",
  "python_embedded/python._pth",
  "python_embedded/statistics_module/__pycache__/",
  "python_embedded/rnaseq_module/__pycache__/",
  "src-tauri/resources/legal/EULA.txt",
  "scripts/check-commercial-license.ps1",
  "scripts/generate-license-key.ps1",
  "scripts/generate-commercial-license-key.ps1",
  "AGENTS.md",
  "CLAUDE.md",
  ".mcp.json"
)

$requiredPaths = @(
  "src",
  "src-tauri",
  "scripts",
  "package.json",
  ".github"
)

if (Test-Path $OutputPath) {
  if (-not $DryRun) {
    Remove-Item -Recurse -Force $OutputPath
  }
}

if (-not $DryRun) {
  New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
}

foreach ($item in $includePaths) {
  if (-not (Test-Path $item)) { continue }
  $dest = Join-Path $OutputPath $item
  if ($DryRun) {
    Write-Host "[DRY] copy $item -> $dest"
    continue
  }

  $parent = Split-Path $dest -Parent
  New-Item -ItemType Directory -Path $parent -Force | Out-Null

  if ((Get-Item $item).PSIsContainer) {
    Copy-Item -Recurse -Force $item $dest
  } else {
    Copy-Item -Force $item $dest
  }
}

if (-not $DryRun) {
  foreach ($required in $requiredPaths) {
    if (-not (Test-Path (Join-Path $OutputPath $required))) {
      throw "Required public export path missing: $required"
    }
  }

  Set-Location $OutputPath

  # Drop excluded paths if they slipped in via broad folder copy.
  foreach ($prefix in $excludePrefixes) {
    $pattern = $prefix.TrimEnd('/')
    Get-ChildItem -Recurse -Force -ErrorAction SilentlyContinue |
      Where-Object {
        $relative = $_.FullName.Substring($OutputPath.Length).TrimStart([char]92,[char]47) -replace '\\','/'
        $relative.StartsWith($pattern)
      } |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }

  if ($SkipGitInit) {
    throw "SkipGitInit is not supported for validated exports. Remove -SkipGitInit so forbidden-path checks can run against staged files."
  }

  git init | Out-Null
  git add .

  # Hard validation checks (run after staging so git ls-files is authoritative).
  $forbiddenPattern = "^(backup/|old_documentation/|_documentation/|memory/|memory_db/|playwright-report/|edgedriver_win|\.env$|\.env\.production$|\.claude/|AGENTS\.md$|CLAUDE\.md$|\.mcp\.json$|python_embedded/python_dependencies/|python_embedded/python\.exe|python_embedded/python312\.dll|python_embedded/python\._pth$|python_embedded/.*\.pyd$|python_embedded/.*\.dll$|python_embedded/.*\.pyc$|python_embedded/.*embed.*\.zip$|python_embedded/.*runtime.*\.zip$|src-tauri/resources/legal/EULA\.txt$)"
  $forbidden = git ls-files 2>$null | Where-Object { $_ -match $forbiddenPattern }
  if ($forbidden) {
    throw ("Forbidden paths found in export:`n" + ($forbidden -join "`n"))
  }

  $datasetPaths = git ls-files 2>$null | Where-Object { $_ -match "^(_test_validation/|RNA_seq/validation/)" }
  if ($datasetPaths) {
    throw ("Validation datasets/caches found in export without explicit signoff:`n" + ($datasetPaths -join "`n"))
  }

  $largeFiles = git ls-files | ForEach-Object {
    if (Test-Path $_) {
      $sizeMb = (Get-Item $_).Length / 1MB
      if ($sizeMb -gt 5) {
        "{0:N2} MB`t{1}" -f $sizeMb, $_
      }
    }
  }
  if ($largeFiles) {
    Write-Host "Large files detected (>5MB):"
    $largeFiles | Sort-Object { [double](($_ -split ' MB')[0]) } -Descending | ForEach-Object { Write-Host $_ }
  }

  git commit -m "chore: initial public snapshot" | Out-Null
}

Write-Host "Export complete: $OutputPath"
