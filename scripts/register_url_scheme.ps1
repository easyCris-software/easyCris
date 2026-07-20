param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Register", "Unregister")]
    [string]$Action,

    [string]$InstallDir = "",
    [string]$ExePath = ""
)

$ErrorActionPreference = "Stop"
$Scheme = "easycris-remote"
$SchemePath = "Registry::HKEY_CURRENT_USER\Software\Classes\$Scheme"

if ($Action -eq "Unregister") {
    if (Test-Path $SchemePath) {
        Remove-Item -Path $SchemePath -Recurse -Force
    }
    exit 0
}

if (-not $ExePath) {
    if (-not $InstallDir) {
        throw "InstallDir or ExePath is required when registering $Scheme."
    }
    $ExePath = Join-Path $InstallDir "easyCris.exe"
}

if (-not (Test-Path $ExePath)) {
    throw "easyCris executable not found: $ExePath"
}

New-Item -Path $SchemePath -Force | Out-Null
Set-ItemProperty -Path $SchemePath -Name "(Default)" -Value "URL:easyCris Remote Invite"
Set-ItemProperty -Path $SchemePath -Name "URL Protocol" -Value ""

$CommandPath = Join-Path $SchemePath "shell\open\command"
New-Item -Path $CommandPath -Force | Out-Null
Set-ItemProperty -Path $CommandPath -Name "(Default)" -Value "`"$ExePath`" `"%1`""

