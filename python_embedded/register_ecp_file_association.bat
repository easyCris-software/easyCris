@echo off
REM ===================================================================
REM Register .ecp file extension for easyCris plot linking
REM
REM This script registers .ecp files with Windows so the Package CLSID
REM can activate easyCris when users double-click OLE objects in Office.
REM
REM IMPORTANT: Run as Administrator
REM ===================================================================

echo.
echo ================================================================
echo easyCris .ecp File Association Registration
echo ================================================================
echo.
echo This script will register the .ecp file extension with Windows
echo so that OLE linking in PowerPoint/Word/Excel works correctly.
echo.
echo IMPORTANT: You must run this as Administrator!
echo.

REM Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This script requires Administrator privileges.
    echo.
    echo Right-click this file and select "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo Running as Administrator - OK
echo.

REM Get the directory where this script is located
set SCRIPT_DIR=%~dp0
set TAURI_ROOT=%SCRIPT_DIR%..

REM Detect executable location (prefer release, fallback to debug)
set EXE_PATH=%TAURI_ROOT%\src-tauri\target\release\tauri-app.exe
if not exist "%EXE_PATH%" (
    set EXE_PATH=%TAURI_ROOT%\src-tauri\target\debug\tauri-app.exe
)

if not exist "%EXE_PATH%" (
    echo ERROR: Cannot find tauri-app.exe
    echo.
    echo Please build the application first:
    echo   npm run tauri:build
    echo.
    pause
    exit /b 1
)

echo Found easyCris executable:
echo   %EXE_PATH%
echo.

REM Register file extension
echo Registering .ecp file extension...
assoc .ecp=easyCris.Project
if %errorLevel% neq 0 (
    echo ERROR: Failed to register .ecp extension
    pause
    exit /b 1
)

REM Register file type with application
echo Registering file type handler...
ftype easyCris.Project="%EXE_PATH%" "%%1"
if %errorLevel% neq 0 (
    echo ERROR: Failed to register file type handler
    pause
    exit /b 1
)

echo.
echo ================================================================
echo SUCCESS: .ecp file association registered
echo ================================================================
echo.
echo File extension: .ecp
echo File type: easyCris.Project
echo Application: %EXE_PATH%
echo.
echo You can now:
echo   1. Copy plots from easyCris to clipboard
echo   2. Paste into PowerPoint (shows as image)
echo   3. Double-click the image to re-open in easyCris
echo.
echo To test file association:
echo   - Double-click any .ecp file
echo   - Should launch easyCris with that file
echo.

REM Verify registration
echo Verifying registration...
echo.
assoc .ecp
ftype easyCris.Project
echo.

pause
