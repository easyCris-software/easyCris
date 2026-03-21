# Contributing to easyCris

## Before You Open a PR

1. Read `README.md`.
2. Sign the contributor license agreement in `CLA.md`.
3. Run local checks:
   - `npm ci`
   - `pwsh -ExecutionPolicy Bypass -File scripts/bootstrap-python.ps1`
   - `npm run -s typecheck`
   - `npm run -s license:summary:check`
   - `npm run -s test:run -- src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts src/utils/__tests__/lmmAnovaTables.test.ts`

## Pull Request Rules

1. Keep changes scoped and reviewable.
2. Include tests for behavior changes.
3. Do not commit secrets, local environment files, or generated binary payloads.
4. PR checks and CLA check must pass before merge.
5. Public updates are generated from private master via a curated export process.

## License of Contributions

By contributing, you agree your contribution is licensed under the project dual-license model:

- AGPL-3.0-only
- Commercial license option managed by easyCris Software

See `LICENSE`, `COMMERCIAL_LICENSE.md`, and `CLA.md`.
