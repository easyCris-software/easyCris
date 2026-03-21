param(
  [string]$VenvPath = ".venv-public",
  [switch]$Recreate
)

$ErrorActionPreference = "Stop"

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureMessage
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit code: $LASTEXITCODE)"
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$requirementsPath = Join-Path $repoRoot "python_embedded\requirements-validated.txt"
if (-not (Test-Path $requirementsPath)) {
  throw "Missing requirements file: $requirementsPath"
}

if ($Recreate -and (Test-Path $VenvPath)) {
  Remove-Item -Recurse -Force $VenvPath
}

if (-not (Test-Path $VenvPath)) {
  $pyCmd = Get-Command py -ErrorAction SilentlyContinue
  if ($pyCmd) {
    & py -3.12 -m venv $VenvPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $VenvPath "Scripts\python.exe"))) {
      Write-Warning "py -3.12 was not available; falling back to python on PATH."
      Invoke-CheckedCommand -FilePath "python" -Arguments @("-m", "venv", $VenvPath) -FailureMessage "Failed to create virtual environment using python on PATH"
    }
  } else {
    Invoke-CheckedCommand -FilePath "python" -Arguments @("-m", "venv", $VenvPath) -FailureMessage "Failed to create virtual environment using python on PATH"
  }
}

$venvPython = Join-Path $VenvPath "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
  throw "Virtual environment python not found: $venvPython"
}

Invoke-CheckedCommand -FilePath $venvPython -Arguments @("-c", "import sys; raise SystemExit(0 if sys.version_info[:2]==(3,12) else 1)") -FailureMessage "Python 3.12 is required. Re-run with Python 3.12 installed and available via 'py -3.12' or 'python'"

Invoke-CheckedCommand -FilePath $venvPython -Arguments @("-m", "pip", "install", "--upgrade", "pip") -FailureMessage "Failed to upgrade pip"

$allLines = Get-Content -Path $requirementsPath
$validSpecPattern = "^\s*[A-Za-z0-9_.-]+(\[[A-Za-z0-9_,.-]+\])?\s*(==|>=|<=|~=|!=|>|<).+$"
$sanitizedLines = @()
$removedLines = @()
foreach ($line in $allLines) {
  $trimmed = $line.Trim()
  if ($trimmed -eq "" -or $trimmed.StartsWith("#") -or $trimmed -match $validSpecPattern) {
    $sanitizedLines += $line
  } else {
    $removedLines += $line
  }
}

$tempRequirements = Join-Path $env:TEMP ("easycris-requirements-" + [guid]::NewGuid().ToString() + ".txt")
$sanitizedLines | Set-Content -Path $tempRequirements -Encoding UTF8

if ($removedLines.Count -gt 0) {
  Write-Warning "Ignored non-requirement lines in requirements-validated.txt:"
  $removedLines | ForEach-Object { Write-Warning "  $_" }
}

$requirementsText = Get-Content -Raw -Path $tempRequirements
try {
  if ($requirementsText -match "--hash=") {
    Invoke-CheckedCommand -FilePath $venvPython -Arguments @("-m", "pip", "install", "--require-hashes", "-r", $tempRequirements) -FailureMessage "Failed to install requirements with hash enforcement"
  } else {
    Invoke-CheckedCommand -FilePath $venvPython -Arguments @("-m", "pip", "install", "-r", $tempRequirements) -FailureMessage "Failed to install requirements"
  }
} finally {
  if (Test-Path $tempRequirements) {
    Remove-Item -Force $tempRequirements -ErrorAction SilentlyContinue
  }
}

# Minimal runtime health check for stats backend stack.
Invoke-CheckedCommand -FilePath $venvPython -Arguments @("-c", "import numpy, pandas, scipy, statsmodels, lmfit, lifelines, scikit_posthocs; print('python-runtime-ok')") -FailureMessage "Runtime import health check failed"

Write-Host "Bootstrap complete: $VenvPath"
