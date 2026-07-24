# Contributing to easyCris

## Before You Open a PR

1. Read `README.md`.
2. Confirm contribution authorization with easyCris maintainers.
3. Run local checks:
   - `npm ci`
   - `pwsh -ExecutionPolicy Bypass -File scripts/bootstrap-python.ps1`
   - For RNA-seq source work: `pwsh -ExecutionPolicy Bypass -File scripts/bootstrap-python.ps1 -IncludeRnaseq`
   - `npm run -s typecheck`
   - `npm run -s license:summary:check`
   - `npm run -s test:run -- src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts src/utils/__tests__/lmmAnovaTables.test.ts`

## Python Dev Setup

- Base setup (`bootstrap-python.ps1`) installs validated stats dependencies.
- `-IncludeRnaseq` installs pinned RNA-seq-specific dependencies.
- Backend script mode resolves interpreter in this order: `EASYCRIS_PYTHON_EXE` -> `python_embedded/python.exe` -> `.venv/Scripts/python.exe` -> `python` on PATH.
- Quick verification:
  - `.venv\\Scripts\\python.exe -c "import statistics_module; print('stats-ok')"`
  - `.venv\\Scripts\\python.exe -c "import rnaseq_module; print('rnaseq-ok')"` (after `-IncludeRnaseq`)

## Pull Request Rules

1. Keep changes scoped and reviewable.
2. Include tests for behavior changes.
3. Do not commit secrets, local environment files, or generated binary payloads.
4. Required CI checks must pass before merge.

## License of Contributions

Unless explicitly stated otherwise, contributions submitted to this repository
are provided under the Apache License, Version 2.0.

Contributors must certify that they have the right to submit their work under
Apache-2.0. We use the Developer Certificate of Origin convention: add a
`Signed-off-by:` line to commits when requested by maintainers.
