param(
  [string]$VenvPath = ".venv-nuitka-build",
  [string]$NuitkaVersion = "2.8.10",
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

if ($Recreate -and (Test-Path $VenvPath)) {
  Remove-Item -Recurse -Force $VenvPath
}

if (-not (Test-Path $VenvPath)) {
  $pyCmd = Get-Command py -ErrorAction SilentlyContinue
  if ($pyCmd) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & py -3.12 -m venv $VenvPath 2>$null
      $pyExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($pyExitCode -ne 0 -or -not (Test-Path (Join-Path $VenvPath "Scripts\python.exe"))) {
      Write-Warning "py -3.12 was not available; falling back to python on PATH."
      Invoke-CheckedCommand -FilePath "python" -Arguments @("-m", "venv", $VenvPath) -FailureMessage "Failed to create Nuitka virtual environment using python on PATH"
    }
  } else {
    Invoke-CheckedCommand -FilePath "python" -Arguments @("-m", "venv", $VenvPath) -FailureMessage "Failed to create Nuitka virtual environment using python on PATH"
  }
}

$venvPython = Join-Path $VenvPath "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
  throw "Nuitka builder Python not found: $venvPython"
}

Invoke-CheckedCommand -FilePath $venvPython -Arguments @("-c", "import sys; raise SystemExit(0 if sys.version_info[:2]==(3,12) else 1)") -FailureMessage "Python 3.12 is required for the Nuitka builder"
Invoke-CheckedCommand -FilePath $venvPython -Arguments @("-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel") -FailureMessage "Failed to upgrade Nuitka builder packaging tools"
Invoke-CheckedCommand -FilePath $venvPython -Arguments @("-m", "pip", "install", "nuitka==$NuitkaVersion") -FailureMessage "Failed to install Nuitka"
Invoke-CheckedCommand -FilePath $venvPython -Arguments @("-c", "import nuitka; print('nuitka-builder-ok')") -FailureMessage "Nuitka import health check failed"

Write-Host "Nuitka bootstrap complete: $VenvPath"
