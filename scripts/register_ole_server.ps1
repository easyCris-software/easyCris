# PowerShell Script: Register easyCris as OLE LocalServer
# Enables double-click activation of embedded easyCris plots in PowerPoint.

# Requires Administrator privileges
#Requires -RunAsAdministrator

# Parameter declaration MUST be first executable statement
param(
    [string]$ExePathOverride
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "easyCris OLE Server Registration" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Generate unique CLSID for easyCris (consistent across runs)

$CLSID = "{7E8A4C2D-1F3B-4E5D-9A8F-2B6C7D8E9F0A}"
$ProgID = "easyCris.Project.1"
$AppName = "easyCris Project"
# Registry root (use explicit provider to avoid missing HKCR PS drive)
$RegRoot = "Registry::HKEY_CLASSES_ROOT"

# Resolve executable path (ole-server.exe only)
if ($ExePathOverride) {
    $ExePath = (Resolve-Path $ExePathOverride).Path
} else {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $ProjectRoot = Split-Path -Parent $ScriptDir

    # Preferred: COM LocalServer (ole-server.exe)
    $ExePath = Join-Path $ProjectRoot "ole-server\target\release\ole-server.exe"

    # Fallback: debug build
    if (-not (Test-Path $ExePath)) {
        $ExePath = Join-Path $ProjectRoot "ole-server\target\debug\ole-server.exe"
    }
}

# Verify executable exists
if (-not (Test-Path $ExePath)) {
    Write-Host "[ERROR] ole-server executable not found!" -ForegroundColor Red
    Write-Host "Expected locations:" -ForegroundColor Yellow
    Write-Host "  - $ProjectRoot\ole-server\target\release\ole-server.exe" -ForegroundColor Yellow
    Write-Host "  - $ProjectRoot\ole-server\target\debug\ole-server.exe" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Please build ole-server first:" -ForegroundColor Yellow
    Write-Host "  cd ole-server; cargo build --release" -ForegroundColor Yellow
    exit 1
}

Write-Host "[INFO] Found COM server executable at:" -ForegroundColor Green
Write-Host "  $ExePath" -ForegroundColor White
Write-Host ""

# Display registration details
Write-Host "[INFO] Registration Details:" -ForegroundColor Green
Write-Host "  CLSID:   $CLSID" -ForegroundColor White
Write-Host "  ProgID:  $ProgID" -ForegroundColor White
Write-Host "  AppName: $AppName" -ForegroundColor White
Write-Host ""

# Confirm with user
$Confirm = Read-Host "Proceed with registration? (y/N)"
if ($Confirm -ne "y" -and $Confirm -ne "Y") {
    Write-Host "[ABORTED] Registration cancelled by user." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "[1/4] Registering CLSID..." -ForegroundColor Cyan

# Register CLSID
$CLSIDPath = Join-Path $RegRoot "CLSID\$CLSID"
New-Item -Path $CLSIDPath -Force | Out-Null
Set-ItemProperty -Path $CLSIDPath -Name "(Default)" -Value $AppName
Set-ItemProperty -Path $CLSIDPath -Name "AppID" -Value $CLSID

# LocalServer32 (OLE activation)
$LocalServer32Path = "$CLSIDPath\LocalServer32"
New-Item -Path $LocalServer32Path -Force | Out-Null
Set-ItemProperty -Path $LocalServer32Path -Name "(Default)" -Value "`"$ExePath`" /Embedding"

# ProgID reference
$ProgIDKeyPath = "$CLSIDPath\ProgID"
New-Item -Path $ProgIDKeyPath -Force | Out-Null
Set-ItemProperty -Path $ProgIDKeyPath -Name "(Default)" -Value $ProgID

# Verb: Edit (double-click action)
$VerbPath = "$CLSIDPath\Verb\0"
New-Item -Path $VerbPath -Force | Out-Null
Set-ItemProperty -Path $VerbPath -Name "(Default)" -Value "&Edit"

$VerbCommandPath = "$VerbPath\command"
New-Item -Path $VerbCommandPath -Force | Out-Null
Set-ItemProperty -Path $VerbCommandPath -Name "(Default)" -Value "`"$ExePath`" /ole `"%1`""

Write-Host "[OK] CLSID registered." -ForegroundColor Green

Write-Host "[2/4] Registering ProgID..." -ForegroundColor Cyan

# Register ProgID
$ProgIDPath = Join-Path $RegRoot $ProgID
New-Item -Path $ProgIDPath -Force | Out-Null
Set-ItemProperty -Path $ProgIDPath -Name "(Default)" -Value $AppName

# CLSID reference
$ProgIDCLSIDPath = "$ProgIDPath\CLSID"
New-Item -Path $ProgIDCLSIDPath -Force | Out-Null
Set-ItemProperty -Path $ProgIDCLSIDPath -Name "(Default)" -Value $CLSID

Write-Host "[OK] ProgID registered." -ForegroundColor Green

Write-Host "[3/4] Setting AppID (optional)..." -ForegroundColor Cyan

# AppID (optional, for security settings)
$AppIDPath = Join-Path $RegRoot "AppID\$CLSID"
New-Item -Path $AppIDPath -Force | Out-Null
Set-ItemProperty -Path $AppIDPath -Name "(Default)" -Value $AppName

Write-Host "[OK] AppID set." -ForegroundColor Green

Write-Host "[4/4] Verifying registration..." -ForegroundColor Cyan

# Verify registration
$CLSIDExists = Test-Path $CLSIDPath
$ProgIDExists = Test-Path $ProgIDPath
$LocalServer32Exists = Test-Path $LocalServer32Path

if ($CLSIDExists -and $ProgIDExists -and $LocalServer32Exists) {
    Write-Host "[OK] Registration verified successfully!" -ForegroundColor Green
} else {
    Write-Host "[WARN] Registration incomplete. Check registry manually." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Registration Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next Steps:" -ForegroundColor Yellow
Write-Host "  1. Build ole-server and easyCris" -ForegroundColor White
Write-Host "  2. Test: Copy plot -> Paste in PowerPoint -> Double-click" -ForegroundColor White
Write-Host ""
Write-Host "To unregister, run: .\unregister_ole_server.ps1" -ForegroundColor Cyan
Write-Host ""
