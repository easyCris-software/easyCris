# Python Runtime Setup (Public Source Build)

This setup is for contributors building from source.

## Prerequisites
- Windows PowerShell
- Python 3.12 on PATH

This bootstrap script is currently Windows-focused. Linux/macOS contributor setup should be documented separately if/when those lanes are enabled.

## Bootstrap

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/bootstrap-python.ps1
```

Default behavior:
- Creates `.venv-public`
- Installs dependencies from `python_embedded/requirements-validated.txt`
- Runs health check imports for `numpy`, `pandas`, `scipy`, and `statsmodels`

## Recreate the environment

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/bootstrap-python.ps1 -Recreate
```

## Notes
- Official end-user binaries are provided via GitHub Releases.
- Source builds are developer-oriented and unsigned.

## Troubleshooting
- If venv creation fails, verify `py -3.12 --version` works.
- If `py` launcher is unavailable, ensure `python --version` reports `3.12.x`.
- If dependency install fails, delete `.venv-public` and re-run with `-Recreate`.
