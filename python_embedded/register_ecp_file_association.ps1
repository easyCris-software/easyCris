# ===================================================================
# Register .ecp file extension for easyCris plot linking
#
# This script registers .ecp files with Windows so the Package CLSID
# can activate easyCris when users double-click OLE objects in Office.
#
# IMPORTANT: Run as Administrator
# ===================================================================

param(
    [string]$ExePathOverride,
    [switch]$Silent
)

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "easyCris .ecp File Association Registration" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "This script will register the .ecp file extension with Windows"
Write-Host "so that OLE linking in PowerPoint/Word/Excel works correctly."
Write-Host ""

if (-not $Silent) {
    Write-Host "Running with user-level registry (HKCU)" -ForegroundColor Green
    Write-Host ""
}

# Get script directory and find executable
if ($ExePathOverride) {
    $exePath = (Resolve-Path $ExePathOverride).Path
} else {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $tauriRoot = Split-Path -Parent $scriptDir

    # Detect executable location (prefer debug easyCris.exe for dev workflows)
    $candidates = @(
        (Join-Path $tauriRoot "src-tauri\target\debug\easyCris.exe"),
        (Join-Path $tauriRoot "src-tauri\target\debug\tauri-app.exe"),
        (Join-Path $tauriRoot "src-tauri\target\release\easyCris.exe"),
        (Join-Path $tauriRoot "src-tauri\target\release\tauri-app.exe")
    )

    $exePath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not (Test-Path $exePath)) {
    Write-Host "ERROR: Cannot find tauri-app.exe" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please build the application first:" -ForegroundColor Yellow
    Write-Host "  npm run tauri:build" -ForegroundColor Yellow
    Write-Host ""
    if (-not $Silent) { Pause }
    exit 1
}

Write-Host "Found easyCris executable:"
Write-Host "  $exePath" -ForegroundColor Gray
Write-Host ""

# Register file extension using registry
Write-Host "Registering .ecp file extension..." -ForegroundColor Yellow

try {
    # Create file extension key
    $extKey = "HKCU:\Software\Classes\.ecp"
    if (-not (Test-Path $extKey)) {
        New-Item -Path $extKey -Force | Out-Null
    }
    Set-ItemProperty -Path $extKey -Name "(Default)" -Value "easyCris.Project"

    # Create ProgID key
    $progIdKey = "HKCU:\Software\Classes\easyCris.Project"
    if (-not (Test-Path $progIdKey)) {
        New-Item -Path $progIdKey -Force | Out-Null
    }
    Set-ItemProperty -Path $progIdKey -Name "(Default)" -Value "easyCris Project"

    # Create shell\open\command key
    $commandKey = "$progIdKey\shell\open\command"
    if (-not (Test-Path $commandKey)) {
        New-Item -Path $commandKey -Force | Out-Null
    }
    Set-ItemProperty -Path $commandKey -Name "(Default)" -Value "`"$exePath`" `"%1`""

    Write-Host "SUCCESS: Registry keys created" -ForegroundColor Green

} catch {
    Write-Host "ERROR: Failed to register file association" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if (-not $Silent) { Pause }
    exit 1
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "SUCCESS: .ecp file association registered" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "File extension: .ecp"
Write-Host "File type: easyCris.Project"
Write-Host "Application: $exePath"
Write-Host ""
Write-Host "You can now:" -ForegroundColor Yellow
Write-Host "  1. Copy plots from easyCris to clipboard"
Write-Host "  2. Paste into PowerPoint (shows as image)"
Write-Host "  3. Double-click the image to re-open in easyCris"
Write-Host ""
Write-Host "To test file association:" -ForegroundColor Yellow
Write-Host "  - Double-click any .ecp file"
Write-Host "  - Should launch easyCris with that file"
Write-Host ""

# Verify registration
Write-Host "Verifying registration..." -ForegroundColor Yellow
Write-Host ""

$extValue = (Get-ItemProperty -Path "HKCU:\Software\Classes\.ecp" -Name "(Default)" -ErrorAction SilentlyContinue)."(Default)"
$cmdValue = (Get-ItemProperty -Path "HKCU:\Software\Classes\easyCris.Project\shell\open\command" -Name "(Default)" -ErrorAction SilentlyContinue)."(Default)"

Write-Host ".ecp -> $extValue" -ForegroundColor Gray
Write-Host "easyCris.Project command -> $cmdValue" -ForegroundColor Gray
Write-Host ""

if (-not $Silent) { Pause }
