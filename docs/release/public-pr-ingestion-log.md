# Public PR Ingestion Log

Track every merged public PR and how it was handled in private master before the next export.

## Status Values
- `ingested`: merged/cherry-picked into private master
- `reimplemented`: equivalent fix applied manually in private master
- `rejected`: not accepted for private lane (with reason)
- `deferred`: accepted but scheduled for a later cycle

## Entries

| Date | Public PR | Public Commit | Decision | Private Branch/Commit | Notes |
|---|---|---|---|---|---|
| _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## Rules
1. Do not run a new public export until all merged public PRs since the last export have an entry.
2. Each accepted PR must map to a private commit or explicit reimplementation note.
3. Rejections must include a short technical/legal reason.

- 2026-03-21: branch protection smoke PR created to verify pr-quality-gates + cla-check.
