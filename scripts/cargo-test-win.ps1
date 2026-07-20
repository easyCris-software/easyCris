# cargo-test-win.ps1 — Windows cargo test wrapper
#
# Fixes STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139) for Tauri crates on Windows.
#
# ROOT CAUSE:
#   cargo test binaries built against tauri import TaskDialogIndirect from
#   comctl32.dll. This symbol only exists in Common Controls v6, which requires
#   an application manifest. tauri_build::build() embeds this manifest for the
#   app binary but NOT for test binaries — so the test binary crashes at loader
#   time before a single test runs.
#
# FIX:
#   1. Build the test binary normally (cargo test --no-run)
#   2. Inject the Common Controls v6 manifest using mt.exe
#   3. Run the test binary directly
#
# USAGE:
#   scripts\cargo-test-win.ps1 [cargo test filter args...]
#
# EXAMPLES:
#   scripts\cargo-test-win.ps1 test_wave1
#   scripts\cargo-test-win.ps1 test_wave1_maxifs -- --nocapture
#
# See _documentation/CARGO_TEST_WINDOWS_FIX.md for full diagnosis.

param(
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$TestArgs
)

$ErrorActionPreference = "Stop"
$SrcTauriDir = Join-Path $PSScriptRoot "..\src-tauri"

# ── 1. Find mt.exe ────────────────────────────────────────────────────────────
$mt = Get-ChildItem "C:\Program Files (x86)\Microsoft Visual Studio" -Recurse -Filter "mt.exe" -ErrorAction SilentlyContinue `
    | Where-Object { $_.FullName -like "*x64*" } `
    | Select-Object -First 1 -ExpandProperty FullName

if (-not $mt) {
    Write-Error "mt.exe (x64) not found. Install MSVC Build Tools."
    exit 1
}
Write-Host "[cargo-test-win] mt.exe: $mt"

# ── 2. Build test binary (no run) ────────────────────────────────────────────
Write-Host "[cargo-test-win] Building test binary..."
Push-Location $SrcTauriDir
try {
    cargo test --no-run
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

# ── 3. Find the test binary ───────────────────────────────────────────────────
$testBin = Get-ChildItem "$SrcTauriDir\target\debug\deps" -Filter "tauri_app_lib-*.exe" `
    | Sort-Object LastWriteTime -Descending `
    | Select-Object -First 1 -ExpandProperty FullName

if (-not $testBin) {
    Write-Error "Could not find test binary in target\debug\deps"
    exit 1
}
Write-Host "[cargo-test-win] Test binary: $testBin"

# ── 4. Inject Common Controls v6 manifest ────────────────────────────────────
$manifestPath = Join-Path $PSScriptRoot "..\src-tauri\test-manifest.xml"
$manifestPath = (Resolve-Path $manifestPath).Path

Write-Host "[cargo-test-win] Injecting manifest: $manifestPath"
& $mt -manifest $manifestPath -outputresource:"${testBin};#1" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "mt.exe manifest injection failed (exit $LASTEXITCODE)"
    exit 1
}
Write-Host "[cargo-test-win] Manifest injected OK"

# ── 5. Run the test binary ────────────────────────────────────────────────────
Write-Host "[cargo-test-win] Running: $testBin $TestArgs"
& $testBin @TestArgs
exit $LASTEXITCODE
