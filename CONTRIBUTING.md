# Contributing to easyCris

## Before You Open a PR

1. Read `README.md`.
2. Sign the contributor license agreement in `CLA.md`.
3. Run local checks:
   - `npm ci --legacy-peer-deps`
   - `pwsh -ExecutionPolicy Bypass -File scripts/bootstrap-python.ps1`
   - For RNA-seq source work: `pwsh -ExecutionPolicy Bypass -File scripts/bootstrap-python.ps1 -IncludeRnaseq`
   - `npm run -s typecheck`
   - `npm run -s license:summary:check`
   - `npm run -s test:run -- src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts src/utils/__tests__/lmmAnovaTables.test.ts`

## Python Dev Setup

- Base setup (`bootstrap-python.ps1`) installs validated stats dependencies.
- `-IncludeRnaseq` installs pinned RNA-seq-specific dependencies.
- Backend script mode resolves interpreter in this order: `EASYCRIS_PYTHON_EXE` -> `python_embedded/python.exe` -> `.venv-public/Scripts/python.exe` -> `python` on PATH.
- Quick verification:
  - `.venv-public\\Scripts\\python.exe -c "import statistics_module; print('stats-ok')"`
  - `.venv-public\\Scripts\\python.exe -c "import rnaseq_module; print('rnaseq-ok')"` (after `-IncludeRnaseq`)

## Pull Request Rules

1. Keep changes scoped and reviewable.
2. Include tests for behavior changes.
3. Do not commit secrets, local environment files, or generated binary payloads.
4. PR checks and CLA check must pass before merge.
5. Public updates are generated from private master via a curated export process.
6. If install fails with `ERESOLVE` peer dependency conflicts, re-run with `--legacy-peer-deps` (this is expected with current `tauri-controls` peer constraints).

## License of Contributions

By contributing, you agree your contribution is licensed under the project dual-license model:

- AGPL-3.0-only
- Commercial license option managed by easyCris Software

See `LICENSE`, `COMMERCIAL_LICENSE.md`, and `CLA.md`.
