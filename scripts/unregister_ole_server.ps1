# PowerShell Script: Unregister easyCris OLE LocalServer
# Removes registry entries created by register_ole_server.ps1

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "easyCris OLE Server Unregistration" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$CLSID = "{7E8A4C2D-1F3B-4E5D-9A8F-2B6C7D8E9F0A}"
$ProgID = "easyCris.Project.1"
# Registry root (explicit provider avoids missing HKCR drive)
$RegRoot = "Registry::HKEY_CLASSES_ROOT"

Write-Host "[INFO] Removing registry entries..." -ForegroundColor Yellow
Write-Host "  CLSID:  $CLSID" -ForegroundColor White
Write-Host "  ProgID: $ProgID" -ForegroundColor White
Write-Host ""

# Confirm
$Confirm = Read-Host "Proceed with unregistration? (y/N)"
if ($Confirm -ne "y" -and $Confirm -ne "Y") {
    Write-Host "[ABORTED] Unregistration cancelled." -ForegroundColor Yellow
    exit 0
}

Write-Host ""

# Remove CLSID
$CLSIDPath = Join-Path $RegRoot "CLSID\$CLSID"
if (Test-Path $CLSIDPath) {
    Remove-Item -Path $CLSIDPath -Recurse -Force
    Write-Host "[OK] CLSID removed." -ForegroundColor Green
} else {
    Write-Host "[SKIP] CLSID not found." -ForegroundColor Yellow
}

# Remove ProgID
$ProgIDPath = Join-Path $RegRoot $ProgID
if (Test-Path $ProgIDPath) {
    Remove-Item -Path $ProgIDPath -Recurse -Force
    Write-Host "[OK] ProgID removed." -ForegroundColor Green
} else {
    Write-Host "[SKIP] ProgID not found." -ForegroundColor Yellow
}

# Remove AppID
$AppIDPath = Join-Path $RegRoot "AppID\$CLSID"
if (Test-Path $AppIDPath) {
    Remove-Item -Path $AppIDPath -Recurse -Force
    Write-Host "[OK] AppID removed." -ForegroundColor Green
} else {
    Write-Host "[SKIP] AppID not found." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Unregistration Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
