# ===================================================================
# Setup pywin32 for Embedded Python
#
# This script copies required DLLs from pywin32_system32 to the
# embedded Python directory so win32clipboard, pythoncom, etc. work.
#
# Run this after: pip install pywin32 --target python_dependencies
# ===================================================================

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "pywin32 Setup for Embedded Python" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonDir = $scriptDir
$depsDir = Join-Path $scriptDir "python_dependencies"

Write-Host "Checking pywin32 installation..."

$pythoncomDll = Join-Path $depsDir "pywin32_system32\pythoncom312.dll"
$pywintypesDll = Join-Path $depsDir "pywin32_system32\pywintypes312.dll"

if (-not (Test-Path $pythoncomDll)) {
    Write-Host "ERROR: pythoncom312.dll not found" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install pywin32 first:" -ForegroundColor Yellow
    Write-Host "  python_embedded\python.exe -m pip install pywin32==311 --target python_embedded\python_dependencies" -ForegroundColor Yellow
    Write-Host ""
    Pause
    exit 1
}

if (-not (Test-Path $pywintypesDll)) {
    Write-Host "ERROR: pywintypes312.dll not found" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install pywin32 first:" -ForegroundColor Yellow
    Write-Host "  python_embedded\python.exe -m pip install pywin32==311 --target python_embedded\python_dependencies" -ForegroundColor Yellow
    Write-Host ""
    Pause
    exit 1
}

Write-Host "Found pywin32 DLLs - OK" -ForegroundColor Green
Write-Host ""

Write-Host "Copying DLLs to embedded Python directory..." -ForegroundColor Yellow

try {
    Copy-Item $pythoncomDll -Destination $pythonDir -Force
    Copy-Item $pywintypesDll -Destination $pythonDir -Force

    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "SUCCESS: pywin32 DLLs copied" -ForegroundColor Green
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "pythoncom312.dll   -> $pythonDir"
    Write-Host "pywintypes312.dll  -> $pythonDir"
    Write-Host ""

} catch {
    Write-Host ""
    Write-Host "ERROR: Failed to copy DLLs" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Pause
    exit 1
}

Write-Host "Testing pywin32 imports..." -ForegroundColor Yellow
$pythonExe = Join-Path $pythonDir "python.exe"

try {
    $result = & $pythonExe -c "import win32clipboard, win32con, pythoncom; print('SUCCESS: All pywin32 modules imported')"
    Write-Host $result -ForegroundColor Green

    Write-Host ""
    Write-Host "pywin32 is ready for OLE clipboard operations!" -ForegroundColor Green
    Write-Host ""

} catch {
    Write-Host ""
    Write-Host "ERROR: pywin32 import test failed" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Pause
    exit 1
}

Pause
