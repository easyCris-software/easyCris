param(
  [string]$PythonVersion = "3.12.10",
  [string]$PythonEmbedUrl = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip",
  [string]$PythonEmbedSha256 = "4ACBED6DD1C744B0376E3B1CF57CE906F9DC9E95E68824584C8099A63025A3C3",
  [string]$RuntimeRoot = "python_embedded",
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

function Get-HostPython312 {
  $pyCmd = Get-Command py -ErrorAction SilentlyContinue
  if ($pyCmd) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & py -3.12 -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)" 2>$null
      $pyExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($pyExitCode -eq 0) {
      return @("py", "-3.12")
    }
  }

  & python -c "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)"
  if ($LASTEXITCODE -eq 0) {
    return @("python")
  }

  throw "Python 3.12 is required on PATH or through the py launcher."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$runtimePath = Join-Path $repoRoot $RuntimeRoot
$dependenciesPath = Join-Path $runtimePath "python_dependencies"
$requirementsPath = Join-Path $runtimePath "requirements-validated.txt"
$rnaseqRequirementsPath = Join-Path $runtimePath "requirements-rnaseq.txt"
$rnaseqClearScript = Join-Path $repoRoot "scripts\clear_rnaseq_overlay_packages.py"
$rnaseqPatchScript = Join-Path $repoRoot "scripts\apply_rnaseq_pydeseq2_patch.py"
$rnaseqValidationScript = Join-Path $repoRoot "scripts\validate_rnaseq_runtime.py"

if (-not (Test-Path $requirementsPath)) {
  throw "Missing requirements file: $requirementsPath"
}
if (-not (Test-Path $rnaseqRequirementsPath)) {
  throw "Missing RNA-seq requirements file: $rnaseqRequirementsPath"
}
if (-not (Test-Path $rnaseqClearScript)) {
  throw "Missing RNA-seq overlay cleanup script: $rnaseqClearScript"
}
if (-not (Test-Path $rnaseqPatchScript)) {
  throw "Missing RNA-seq patch script: $rnaseqPatchScript"
}
if (-not (Test-Path $rnaseqValidationScript)) {
  throw "Missing RNA-seq validation script: $rnaseqValidationScript"
}

if ($Recreate) {
  foreach ($target in @(
    (Join-Path $runtimePath "python.exe"),
    (Join-Path $runtimePath "pythonw.exe"),
    (Join-Path $runtimePath "python312.dll"),
    (Join-Path $runtimePath "python312.zip"),
    (Join-Path $runtimePath "python312._pth"),
    (Join-Path $runtimePath "vcruntime140.dll"),
    (Join-Path $runtimePath "vcruntime140_1.dll"),
    $dependenciesPath
  )) {
    if (Test-Path $target) {
      Remove-Item -Recurse -Force $target
    }
  }
}

New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null

$zipPath = Join-Path $env:TEMP ("python-$PythonVersion-embed-amd64.zip")
if (-not (Test-Path $zipPath)) {
  Invoke-WebRequest -Uri $PythonEmbedUrl -OutFile $zipPath
}

$actualHash = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToUpperInvariant()
$expectedHash = $PythonEmbedSha256.ToUpperInvariant()
if ($actualHash -ne $expectedHash) {
  Remove-Item -Force $zipPath -ErrorAction SilentlyContinue
  throw "Embedded Python SHA-256 mismatch. Expected $expectedHash, got $actualHash"
}

Expand-Archive -Path $zipPath -DestinationPath $runtimePath -Force

$pthPath = Join-Path $runtimePath "python312._pth"
if (-not (Test-Path $pthPath)) {
  throw "Missing embedded Python path file: $pthPath"
}

$pthLines = Get-Content -Path $pthPath
$normalized = New-Object System.Collections.Generic.List[string]
foreach ($line in $pthLines) {
  $trimmed = $line.Trim()
  if ($trimmed -eq "#import site") {
    continue
  }
  if ($trimmed -eq "python_dependencies") {
    continue
  }
  $normalized.Add($line)
}
$normalized.Add("python_dependencies")
$normalized.Add("import site")
$normalized | Set-Content -Path $pthPath -Encoding ASCII

if (Test-Path $dependenciesPath) {
  Remove-Item -Recurse -Force $dependenciesPath
}
New-Item -ItemType Directory -Force -Path $dependenciesPath | Out-Null

$hostPython = @(Get-HostPython312)
$hostPythonExe = $hostPython[0]
$hostPythonPrefix = @()
if ($hostPython.Count -gt 1) {
  $hostPythonPrefix = $hostPython[1..($hostPython.Count - 1)]
}

$buildVenv = Join-Path $env:TEMP "easycris-python-embed-provision-3.12"
if ($Recreate -and (Test-Path $buildVenv)) {
  Remove-Item -Recurse -Force $buildVenv
}
if (-not (Test-Path $buildVenv)) {
  Invoke-CheckedCommand -FilePath $hostPythonExe -Arguments @($hostPythonPrefix + @("-m", "venv", $buildVenv)) -FailureMessage "Failed to create embedded-runtime provisioning venv"
}

$buildPython = Join-Path $buildVenv "Scripts\python.exe"
if (-not (Test-Path $buildPython)) {
  throw "Provisioning venv Python not found: $buildPython"
}

Invoke-CheckedCommand -FilePath $buildPython -Arguments @("-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel") -FailureMessage "Failed to upgrade provisioning pip"
Invoke-CheckedCommand -FilePath $buildPython -Arguments @("-m", "pip", "install", "--target", $dependenciesPath, "--upgrade", "-r", $requirementsPath) -FailureMessage "Failed to install validated Python runtime dependencies"
Invoke-CheckedCommand -FilePath $buildPython -Arguments @($rnaseqClearScript, "--dependencies-root", $dependenciesPath, "--requirements", $rnaseqRequirementsPath) -FailureMessage "Failed to clear previous RNA-seq overlay packages"
Invoke-CheckedCommand -FilePath $buildPython -Arguments @("-m", "pip", "install", "--target", $dependenciesPath, "--upgrade", "--no-deps", "-r", $rnaseqRequirementsPath) -FailureMessage "Failed to install RNA-seq Python runtime dependencies"
Invoke-CheckedCommand -FilePath $buildPython -Arguments @($rnaseqPatchScript, "--dependencies-root", $dependenciesPath) -FailureMessage "Failed to apply the validated PyDESeq2 patch"

$embeddedPython = Join-Path $runtimePath "python.exe"
Invoke-CheckedCommand -FilePath $embeddedPython -Arguments @("-c", "import numpy, pandas, scipy, statsmodels, plotly, kaleido; print('embedded-python-ok')") -FailureMessage "Embedded Python health check failed"
Invoke-CheckedCommand -FilePath $embeddedPython -Arguments @($rnaseqValidationScript, "--dependencies-root", $dependenciesPath) -FailureMessage "RNA-seq runtime contract check failed"

Write-Host "Embedded Python provisioned: $runtimePath"
