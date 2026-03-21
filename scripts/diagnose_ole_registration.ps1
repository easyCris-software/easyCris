# Diagnostic script for OLE server registration
# Run: powershell -ExecutionPolicy Bypass -File .\scripts\diagnose_ole_registration.ps1

$ErrorActionPreference = "SilentlyContinue"

$CLSID = "{7E8A4C2D-1F3B-4E5D-9A8F-2B6C7D8E9F0A}"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "easyCris OLE Registration Diagnostic" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check CLSID root
$clsidPath = "Registry::HKEY_CLASSES_ROOT\CLSID\$CLSID"
$clsidExists = Test-Path $clsidPath

Write-Host "[1] CLSID Registration" -ForegroundColor Yellow
if ($clsidExists) {
    $clsidDefault = (Get-ItemProperty -Path $clsidPath -Name "(default)" -ErrorAction SilentlyContinue)."(default)"
    Write-Host "    Path: $clsidPath" -ForegroundColor Gray
    Write-Host "    Status: EXISTS" -ForegroundColor Green
    Write-Host "    Default: $clsidDefault" -ForegroundColor White
} else {
    Write-Host "    Path: $clsidPath" -ForegroundColor Gray
    Write-Host "    Status: NOT FOUND" -ForegroundColor Red
}
Write-Host ""

# Check LocalServer32 (CRITICAL)
Write-Host "[2] LocalServer32 (CRITICAL)" -ForegroundColor Yellow
$localServerPath = "$clsidPath\LocalServer32"
$localServerExists = Test-Path $localServerPath

if ($localServerExists) {
    $localServerValue = (Get-ItemProperty -Path $localServerPath -Name "(default)" -ErrorAction SilentlyContinue)."(default)"
    Write-Host "    Path: $localServerPath" -ForegroundColor Gray
    Write-Host "    Status: EXISTS" -ForegroundColor Green
    Write-Host "    Value: $localServerValue" -ForegroundColor White

    # Validate format
    if ($localServerValue -match '/Embedding') {
        Write-Host "    Format: CORRECT (/Embedding)" -ForegroundColor Green
    } elseif ($localServerValue -match '/ole') {
        Write-Host "    Format: INCORRECT (/ole found - should be /Embedding)" -ForegroundColor Red
        Write-Host ""
        Write-Host "    >>> PROBLEM FOUND! <<<" -ForegroundColor Red
        Write-Host "    LocalServer32 should end with /Embedding, not /ole" -ForegroundColor Red
        Write-Host "    COM activation passes IStorage via interfaces, not command line" -ForegroundColor Red
    } elseif ($localServerValue -match '%1') {
        Write-Host "    Format: INCORRECT (%1 found - this is for file associations)" -ForegroundColor Red
    } else {
        Write-Host "    Format: MISSING /Embedding flag" -ForegroundColor Yellow
    }

    # Check if exe exists
    $exePath = $localServerValue -replace '"' -replace ' /.*$'
    if (Test-Path $exePath) {
        Write-Host "    Executable: EXISTS ($exePath)" -ForegroundColor Green
    } else {
        Write-Host "    Executable: NOT FOUND ($exePath)" -ForegroundColor Red
    }
} else {
    Write-Host "    Path: $localServerPath" -ForegroundColor Gray
    Write-Host "    Status: NOT FOUND" -ForegroundColor Red
}
Write-Host ""

# Check ProgID
Write-Host "[3] ProgID Reference" -ForegroundColor Yellow
$progIdRefPath = "$clsidPath\ProgID"
if (Test-Path $progIdRefPath) {
    $progIdRef = (Get-ItemProperty -Path $progIdRefPath -Name "(default)" -ErrorAction SilentlyContinue)."(default)"
    Write-Host "    Status: EXISTS" -ForegroundColor Green
    Write-Host "    Value: $progIdRef" -ForegroundColor White
} else {
    Write-Host "    Status: NOT FOUND (optional)" -ForegroundColor Yellow
}
Write-Host ""

# Check AppID reference in CLSID (important for DCOM)
Write-Host "[4] AppID Reference in CLSID" -ForegroundColor Yellow
$appIdInClsid = (Get-ItemProperty -Path $clsidPath -Name "AppID" -ErrorAction SilentlyContinue).AppID
if ($appIdInClsid) {
    Write-Host "    Status: EXISTS" -ForegroundColor Green
    Write-Host "    Value: $appIdInClsid" -ForegroundColor White
} else {
    Write-Host "    Status: NOT SET (may cause DCOM issues)" -ForegroundColor Yellow
}
Write-Host ""

# Check AppID registry
Write-Host "[5] AppID Registry" -ForegroundColor Yellow
$appIdPath = "Registry::HKEY_CLASSES_ROOT\AppID\$CLSID"
if (Test-Path $appIdPath) {
    $appIdDefault = (Get-ItemProperty -Path $appIdPath -Name "(default)" -ErrorAction SilentlyContinue)."(default)"
    Write-Host "    Path: $appIdPath" -ForegroundColor Gray
    Write-Host "    Status: EXISTS" -ForegroundColor Green
    Write-Host "    Default: $appIdDefault" -ForegroundColor White

    # Check for RunAs setting
    $runAs = (Get-ItemProperty -Path $appIdPath -Name "RunAs" -ErrorAction SilentlyContinue).RunAs
    if ($runAs) {
        Write-Host "    RunAs: $runAs" -ForegroundColor White
    }
} else {
    Write-Host "    Status: NOT FOUND (optional for LocalServer)" -ForegroundColor Yellow
}
Write-Host ""

# Check ProgID registration
Write-Host "[6] ProgID Registration" -ForegroundColor Yellow
$progIdPath = "Registry::HKEY_CLASSES_ROOT\easyCris.Project.1"
if (Test-Path $progIdPath) {
    $progIdDefault = (Get-ItemProperty -Path $progIdPath -Name "(default)" -ErrorAction SilentlyContinue)."(default)"
    Write-Host "    Path: $progIdPath" -ForegroundColor Gray
    Write-Host "    Status: EXISTS" -ForegroundColor Green
    Write-Host "    Default: $progIdDefault" -ForegroundColor White

    $progIdClsid = "Registry::HKEY_CLASSES_ROOT\easyCris.Project.1\CLSID"
    if (Test-Path $progIdClsid) {
        $clsidRef = (Get-ItemProperty -Path $progIdClsid -Name "(default)" -ErrorAction SilentlyContinue)."(default)"
        Write-Host "    CLSID ref: $clsidRef" -ForegroundColor White
    }
} else {
    Write-Host "    Status: NOT FOUND" -ForegroundColor Yellow
}
Write-Host ""

# Check Verb registration
Write-Host "[7] Verb Registration" -ForegroundColor Yellow
$verbPath = "$clsidPath\Verb\0"
if (Test-Path $verbPath) {
    $verbDefault = (Get-ItemProperty -Path $verbPath -Name "(default)" -ErrorAction SilentlyContinue)."(default)"
    Write-Host "    Verb 0: $verbDefault" -ForegroundColor White

    $verbCmdPath = "$verbPath\command"
    if (Test-Path $verbCmdPath) {
        $verbCmd = (Get-ItemProperty -Path $verbCmdPath -Name "(default)" -ErrorAction SilentlyContinue)."(default)"
        Write-Host "    Command: $verbCmd" -ForegroundColor White
    }
} else {
    Write-Host "    Status: NOT FOUND (optional)" -ForegroundColor Yellow
}
Write-Host ""

# Summary
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Summary" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$issues = @()

if (-not $clsidExists) {
    $issues += "CLSID not registered"
}

if (-not $localServerExists) {
    $issues += "LocalServer32 not registered"
} elseif ($localServerValue -notmatch '/Embedding') {
    $issues += "LocalServer32 missing /Embedding flag"
}

if ($localServerValue -match '/ole.*%1') {
    $issues += "LocalServer32 has /ole %1 (wrong format for COM activation)"
}

if (-not $appIdInClsid) {
    $issues += "AppID not linked to CLSID (may cause DCOM issues)"
}

if ($issues.Count -eq 0) {
    Write-Host "No critical issues found." -ForegroundColor Green
} else {
    Write-Host "Issues found:" -ForegroundColor Red
    foreach ($issue in $issues) {
        Write-Host "  - $issue" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "To fix LocalServer32, re-run registration with:" -ForegroundColor Yellow
Write-Host "  powershell -ExecutionPolicy Bypass -File .\ole-server\scripts\register_ole_server.ps1" -ForegroundColor White
Write-Host ""
