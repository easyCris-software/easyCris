# Public Sync Process

## Purpose
Define the repeatable process to publish curated OSS updates from private master to the public `easyCris` repository.

## Repositories
- Private source-of-truth: `easyCris-software/easycris_tauri`
- Public OSS repo: `easyCris-software/easyCris`

## Cadence
- Default cadence: once per planned release cycle.
- Additional syncs allowed for urgent fixes.

## Sync Model
1. Build changes in private master.
2. Export curated snapshot from private repo using:
   - `pwsh -ExecutionPolicy Bypass -File scripts/export-public-snapshot.ps1 -OutputPath <temp-path>`
3. Run public snapshot validation gates:
   - forbidden path checks
   - gitleaks tree + history scans
   - fresh-clone smoke checks
4. Apply snapshot to public repo working tree.
5. Commit as one curated snapshot commit in public repo.
6. Push to public repo and run CI checks.
7. Tag and release in public repo when release criteria are met.

## History Policy
- Public repo history is curated snapshot history.
- Private commit-by-commit history is intentionally not mirrored.
- Public continuity is maintained by release-tagged snapshot commits.

## Required Checks Before Public Push
1. `pr-quality-gates` and `cla-check` are active as required checks on public `main`.
2. License artifacts are in sync:
   - `npm run -s license:summary:check`
3. Snapshot excludes private/internal payloads (runtime binaries, private docs, local artifacts).
4. Verification report is current under `docs/release/`.

## Release Notes
- Summarize user-visible changes from private cycle.
- Include any known limitations or deferred work.

## Ownership
- Maintainer owns export integrity and legal/compliance checks.
- Public PR intake back to private master is tracked in `docs/release/public-pr-ingestion-log.md`.
