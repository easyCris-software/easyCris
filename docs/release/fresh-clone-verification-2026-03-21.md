# Fresh Clone Verification - 2026-03-21

## Scope
- Phase 6 verification for OSS/public snapshot readiness.
- Worktree branch: `feature/oss-plan-impl-20260320`

## 1) Public Snapshot Export
- Command:
  - `pwsh -ExecutionPolicy Bypass -File scripts/export-public-snapshot.ps1 -OutputPath C:\tmp\easycris-public-phase6`
- Result:
  - Success.
  - Large-file report only flagged expected license bundles:
    - `legal/THIRD_PARTY_LICENSES.txt` (~7.21 MB)
    - `src-tauri/resources/legal/THIRD_PARTY_LICENSES.txt` (~7.21 MB)

## 2) Secret Scan (Tree)
- `gitleaks` was not preinstalled; portable binary fetched to `C:\tmp\tools\gitleaks\gitleaks.exe`.
- Command:
  - `C:\tmp\tools\gitleaks\gitleaks.exe detect --source C:\tmp\easycris-public-phase6 --no-git --report-format json --report-path C:\tmp\easycris-public-phase6\.tmp-gitleaks-tree.json`
- Result:
  - Success.
  - `no leaks found`

## 2b) Secret Scan (History)
- Command:
  - `C:\tmp\tools\gitleaks\gitleaks.exe git C:\tmp\easycris-public-smoke --report-format json --report-path C:\tmp\easycris-public-smoke\.tmp-gitleaks-history.json`
- Result:
  - Success.
  - `1 commits scanned`
  - `no leaks found`

## 3) Fresh Clone Smoke
- Clone target:
  - `C:\tmp\easycris-public-smoke`
- Commands executed in clone:
  - `pwsh -ExecutionPolicy Bypass -File scripts/bootstrap-python.ps1`
  - `npm ci --legacy-peer-deps --no-audit --no-fund`
  - `npm run -s typecheck`
  - `npm run -s test:run -- src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts src/utils/__tests__/lmmAnovaTables.test.ts`
- Result:
  - All commands succeeded.
  - Targeted smoke tests: `19 passed`.

## 4) Release Smoke (CI)
- Repo: `easyCris-software/easycris_tauri`

### Attempt A (manual dispatch, existing old tag)
- Run: `23373806266`
- Trigger:
  - `workflow_dispatch` on `feature/oss-plan-impl-20260320`
  - `release_tag=v0.1.13`
- Result:
  - Failed at `Bootstrap Python runtime`.
  - Root cause: old tag checkout lacks expected script path (`./scripts/bootstrap-python.ps1` not found).

### Attempt B (push-tag smoke on current branch)
- Temporary tag created and pushed: `v0.1.24`
- Run: `23373869142` (push event)
- Result:
  - Failed at `Validate release signing secrets`.
  - Missing repository secrets:
    - `TAURI_SIGNING_PRIVATE_KEY`
    - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
    - `EASYCRIS_LITCRYPT_KEY` (required only if `EASYCRIS_ENABLE_RUST_OBFUSCATE=1`)
- Cleanup:
  - Temporary tag `v0.1.24` was deleted locally and remotely after test.

## Phase 6 Status
- Tree secret scan: ✅ complete
- History secret scan: ✅ complete
- Fresh-clone smoke: ✅ complete
- Release smoke: ⚠️ blocked by missing GitHub repo secrets (expected fail-fast behavior confirmed)

## Full Matrix Status
- `npm run -s test:run` full matrix: deferred (non-blocking per plan).

## Required Follow-Up
1. Configure release secrets in repository settings for `easyCris-software/easycris_tauri`:
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
   - `EASYCRIS_LITCRYPT_KEY` only if release obfuscation is enabled (`EASYCRIS_ENABLE_RUST_OBFUSCATE=1`)
2. Re-run release smoke on a controlled release tag once secrets are present.

## Remaining Gate Summary
- The only open launch gate is Task 6.3 (release smoke):
  1. NSIS artifact appears in GitHub Release
  2. `latest.json` is accessible at the updater endpoint

## Defer Decision (Approved)
- Task 6.3 release smoke is explicitly deferred until private release secrets are provisioned.
- First production tagged release in `easycris_tauri` will be treated as functional release smoke for signing + artifact upload + `latest.json` publication.
- Release workflow code path has already been hardened and reviewed in:
  - `1adcd4f02` (`ci: harden release workflow tags and pin action SHAs`)
  - `28dc73c13` (`ci: make litcrypt key optional and add gitleaks history evidence`)
