# Public Repo Content Policy

## What goes in the public repo
- Application source (`src/`, `src-tauri/`)
- Public build/test scripts
- Contributor-focused docs
- Public CI workflow definitions

## What stays internal
- Embedded runtime binaries and vendored dependencies
- Internal operations notes and memory stores
- Local machine artifacts and test runners
- Private datasets/caches unless explicitly approved
- Agent-only or machine-local assistant files (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `.claude/`) unless explicitly scrubbed for public use

## Contributor-facing summary
- Public repo contains source code, build scripts, and contributor docs.
- Private repo keeps release operations, internal notes, and heavyweight runtime artifacts.
- Public updates are generated from private master via curated export.
- `package.json` keeps `"private": true` intentionally (npm publishing is not part of this distribution model).

## Commercial licensing contact
For commercial licensing, contact: `hello@easycris.com`

## Branch protection baseline (public `main`)
- Require PR review approval before merge.
- Require status checks:
  - `pr-quality-gates`
  - `cla-check`
