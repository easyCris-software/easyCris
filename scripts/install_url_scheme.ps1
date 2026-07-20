param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Register", "Unregister")]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RegisterScript = Join-Path $ScriptDir "register_url_scheme.ps1"

if (-not (Test-Path $RegisterScript)) {
    throw "URL scheme registration script not found: $RegisterScript"
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RegisterScript -Action $Action -InstallDir $InstallDir
exit $LASTEXITCODE
