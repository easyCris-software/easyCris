@echo off
REM ===================================================================
REM Setup pywin32 for Embedded Python
REM
REM This script copies required DLLs from pywin32_system32 to the
REM embedded Python directory so win32clipboard, pythoncom, etc. work.
REM
REM Run this after: pip install pywin32 --target python_dependencies
REM ===================================================================

echo.
echo ================================================================
echo pywin32 Setup for Embedded Python
echo ================================================================
echo.

set SCRIPT_DIR=%~dp0
set PYTHON_DIR=%SCRIPT_DIR%
set DEPS_DIR=%SCRIPT_DIR%python_dependencies

echo Checking pywin32 installation...

if not exist "%DEPS_DIR%\pywin32_system32\pythoncom312.dll" (
    echo ERROR: pythoncom312.dll not found
    echo.
    echo Please install pywin32 first:
    echo   python_embedded\python.exe -m pip install pywin32==311 --target python_embedded\python_dependencies
    echo.
    pause
    exit /b 1
)

if not exist "%DEPS_DIR%\pywin32_system32\pywintypes312.dll" (
    echo ERROR: pywintypes312.dll not found
    echo.
    echo Please install pywin32 first:
    echo   python_embedded\python.exe -m pip install pywin32==311 --target python_embedded\python_dependencies
    echo.
    pause
    exit /b 1
)

echo Found pywin32 DLLs - OK
echo.

echo Copying DLLs to embedded Python directory...
copy /Y "%DEPS_DIR%\pywin32_system32\pythoncom312.dll" "%PYTHON_DIR%"
copy /Y "%DEPS_DIR%\pywin32_system32\pywintypes312.dll" "%PYTHON_DIR%"

if %errorLevel% neq 0 (
    echo ERROR: Failed to copy DLLs
    pause
    exit /b 1
)

echo.
echo ================================================================
echo SUCCESS: pywin32 DLLs copied
echo ================================================================
echo.
echo pythoncom312.dll   -> %PYTHON_DIR%
echo pywintypes312.dll  -> %PYTHON_DIR%
echo.

echo Testing pywin32 imports...
"%PYTHON_DIR%\python.exe" -c "import win32clipboard, win32con, pythoncom; print('SUCCESS: All pywin32 modules imported')"

if %errorLevel% neq 0 (
    echo.
    echo ERROR: pywin32 import test failed
    pause
    exit /b 1
)

echo.
echo pywin32 is ready for OLE clipboard operations!
echo.
pause
