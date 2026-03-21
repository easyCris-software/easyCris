Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = Resolve-Path "$PSScriptRoot\\.."
Set-Location $repo

$pythonArgs = @()
$pythonPath = $null
$pythonCandidates = @()

if ($env:PYTHON_AUDIT -and (Test-Path $env:PYTHON_AUDIT)) {
  $pythonCandidates += $env:PYTHON_AUDIT
}

$localPyRoot = Join-Path $env:LOCALAPPDATA "Programs\\Python"
if (Test-Path $localPyRoot) {
  $py312 = Join-Path $localPyRoot "Python312\\python.exe"
  if (Test-Path $py312) { $pythonCandidates += $py312 }

  $pythonCandidates += Get-ChildItem -Path "$localPyRoot\\Python*\\python.exe" -ErrorAction SilentlyContinue |
    Sort-Object { [int]($_.Directory.Name -replace "[^0-9]", "") } -Descending |
    Select-Object -ExpandProperty FullName
}

$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if ($pythonCmd) { $pythonCandidates += $pythonCmd.Path }

$pythonCandidates = $pythonCandidates | Select-Object -Unique
if (-not $pythonCandidates) {
  Write-Error "python not found on PATH. Install system Python first."
  exit 1
}

$oldPref = $ErrorActionPreference
$ErrorActionPreference = "Continue"
foreach ($candidate in $pythonCandidates) {
  & $candidate @pythonArgs -m pip show pip-licenses *> $null
  if ($LASTEXITCODE -eq 0) {
    $pythonPath = $candidate
    break
  }
}
$ErrorActionPreference = $oldPref
if (-not $pythonPath) {
  Write-Error "pip-licenses is not installed in any detected Python. Install with: python -m pip install --upgrade pip pip-licenses"
  exit 1
}

& $pythonPath @pythonArgs -m piplicenses --format=csv > python_licenses.csv
if ($LASTEXITCODE -ne 0) { pip-licenses --format=csv > python_licenses.csv }

& $pythonPath @pythonArgs -m piplicenses --format=markdown > python_licenses.md
if ($LASTEXITCODE -ne 0) { pip-licenses --format=markdown > python_licenses.md }

& $pythonPath @pythonArgs -m piplicenses --format=plain > python_licenses.txt
if ($LASTEXITCODE -ne 0) { pip-licenses --format=plain > python_licenses.txt }

Write-Output "Wrote python_licenses.csv, python_licenses.md, python_licenses.txt in $repo"
