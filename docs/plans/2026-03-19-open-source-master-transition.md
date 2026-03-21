# easyCris Public Snapshot Plan (Private Master Preserved)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep `easycris_tauri` as the private/internal master and publish `easyCris` as a curated, fresh-history open-source snapshot that excludes heavy/internal artifacts while preserving build stability.

**Architecture:** Use a two-repo model:
- private repo (`easycris_tauri`) keeps full history, internal docs, embedded runtimes, and release operations.
- public repo (`easyCris`) is generated from a curated export with new clean history.

**Tech Stack:** Git/GitHub, PowerShell, Node/npm, Tauri, GitHub Actions, gitleaks.

---

## Final Strategy (Locked)

1. Do **not** publish this repo history directly.
2. Do **not** rewrite this private repo unless needed for internal reasons.
3. Generate public OSS from curated snapshot export (new history).
4. Keep Python vendored binaries out of public git.
5. Ship bundled runtime only through release CI artifacts.

---

## No-Go Gates

Public launch is blocked until all pass:

- CLA mechanism active before accepting external PRs.
- Public export scope approved (what is public vs what stays internal).
- Public repo history starts fresh (single clean initial commit or clean import sequence).
- Public repo passes gitleaks tree scan.
- Public repo passes gitleaks history scan (`gitleaks git`) on every release candidate.
- Public repo contains no vendored Python binary payload.
- Public snapshot metadata is license-consistent across `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
- Public `README.md` is license-consistent (no “all rights reserved” contradiction) and reflects dual-license messaging.
- Public `README.md` includes both official binary install path and source build path for contributors.
- Public legal UI does not require EULA-only assets in OSS lane.
- Public license scripts run without private `_documentation` dependencies (or are explicitly removed from public lane).
- Public `main` branch protection requires PR workflow checks and at least one reviewer approval before merge.
- Public CI release job publishes installer + updater artifacts successfully.

---

## Phase 0: Keep Private Repo Stable (No Disruption)

### Task 0.1: Freeze disruptive cleanup in private master

**Files:** none

1. No bulk deletion in private master for open-source prep.
2. Only minimal hygiene commits allowed if they are useful internally.
3. Publicization work happens in a separate export workspace.

---

## Phase 1: Define Public Export Contract

### Task 1.1: Define public-repo scope in human language

**Files:**
- Create: `docs/release/public-repo-content-policy.md`

Document this with plain wording in the public-facing version:

**What goes in the public repo (baseline):**
- `src/`
- `src-tauri/` (minus internal/proprietary-only assets)
- `scripts/` (public-safe only)
- `e2e/` (smoke + representative parity paths)
- `docs/` (public-safe docs)
- root config/build files required for contributors

**What stays internal (baseline):**
- `python_embedded/python_dependencies/`
- embedded Python binaries (`python.exe`, `python312.dll`, `*.pyd`, zipped runtimes)
- `backup/`, `old_documentation/`, private sections of `_documentation/`
- `memory/`, `memory_db/`, `.claude/`
- local artifacts (`playwright-report/`, `edgedriver_win*/`, env files)
- internal agent docs and machine-specific assistant files (`AGENTS.md`, `CLAUDE.md`, `.mcp.json`) unless explicitly scrubbed for public use
- `_test_validation/` raw private/biological datasets unless explicitly approved
- `RNA_seq/validation/` caches/data payloads unless explicitly approved

Also include a short contributor-facing summary in `README`/`CONTRIBUTING`:
- “Public repo contains source code, build scripts, and contributor docs.”
- “Private repo keeps release operations, internal notes, and heavyweight runtime artifacts.”
- “Public updates are generated from private master via curated export.”

Note: strict path rules remain in internal tooling/scripts, not in contributor docs.

### Task 1.2: Lock dual-license/legal model for public repo

**Files (public export target):**
- `LICENSE` (AGPL)
- `COMMERCIAL_LICENSE.md`
- `docs/licensing-faq.md`
- `README.md` dual-license statement

Decide and pin exact SPDX (`AGPL-3.0-only` or `AGPL-3.0-or-later`) with no placeholder language.

### Task 1.3: Explicitly align runtime/package license metadata in exported public repo

**Files (public export target):**
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Required changes in export lane:
1. `package.json` `license` must be set to pinned SPDX value (no `UNLICENSED`).
2. `Cargo.toml` license policy must not point to EULA-only path for OSS lane.
3. `tauri.conf.json` installer `licenseFile` must match OSS lane policy (or be removed/overridden for OSS build lane).
4. Document if `package.json private: true` remains intentional (npm publish not intended).
5. Replace placeholder public metadata (`authors = [\"you\"]`) in `Cargo.toml`.

### Task 1.4: Split legal artifacts by lane (public OSS vs commercial installer)

**Files (public export target):**
- `LICENSE` (AGPL)
- `COMMERCIAL_LICENSE.md`
- `docs/licensing-faq.md`
- `legal/THIRD_PARTY_LICENSES.txt` (or generated equivalent used in OSS lane)

**Files (private/commercial lane):**
- `src-tauri/resources/legal/EULA.txt`
- any commercial-installer-only terms and proprietary distribution legal text

Required policy:
1. Public source must not be governed by EULA-only metadata.
2. Commercial EULA stays in private/commercial packaging lane.
3. If EULA text is retained in public repo for reference, mark it clearly as commercial-installer-only and non-governing for OSS source.
4. Keep third-party notices available in the public lane (source or generated artifact path), so attribution obligations remain satisfied.

### Task 1.5: Update legal UI resources for OSS lane

**Files (public export target):**
- `src/components/layout/ActionToolbar.tsx`
- `src/components/layout/AppShell.tsx`
- `legal/` (or `docs/legal/`) public legal resources

Current dependency:
- `ActionToolbar` legal menu points to `legal/EULA.txt`.
- `AppShell` legal resource/acceptance flow currently depends on EULA resource wiring.

Required OSS-lane behavior:
1. Replace EULA entry with an OSS-appropriate terms/license entry (AGPL and/or licensing FAQ), **or** explicitly hide EULA menu item in OSS builds.
2. Ensure legal dialog links resolve in public repo layout.
3. Keep privacy and third-party notices links valid in OSS lane.

---

## Phase 2: Public Snapshot Export Pipeline

### Task 2.1: Create export script from private -> public workspace

**Files:**
- Create: `scripts/export-public-snapshot.ps1`
- Create: `docs/release/public-export-runbook.md`

Script responsibilities:

1. Prepare a clean temp folder.
2. Copy only files/directories marked as public scope.
3. Prune files/directories marked internal scope.
4. Verify no forbidden paths/files remain.
5. Initialize fresh git repo in export folder.
6. Create first commit (`chore: initial public snapshot`).
7. Apply export-time scrubs for machine-specific paths if any file is intentionally retained (e.g., `CLAUDE.md` only if scrubbed).
8. Apply OSS-lane post-processing hooks (legal resource remap, metadata rewrites).

### Task 2.2: Add export validation checks

In internal script/runbook, enforce strict path checks (machine rules):

```powershell
# forbidden paths in export
git ls-files | rg "^(backup/|old_documentation/|memory/|memory_db/|playwright-report/|edgedriver_win|\.env$|\.env\.production$|\.claude/|AGENTS\.md$|CLAUDE\.md$|\.mcp\.json$|python_embedded/python_dependencies/|python_embedded/python\.exe|python_embedded/python312\.dll|python_embedded/.*\.pyd$|python_embedded/.*\.dll$|python_embedded/.*embed.*\.zip$|python_embedded/.*runtime.*\.zip$)"
```

Expected: no output.

Also enforce dataset policy explicitly:

```powershell
# deny raw/private validation datasets by default
git ls-files | rg "^(_test_validation/|RNA_seq/validation/)"
```

Expected: no output unless explicitly approved in policy doc with legal/data-use signoff.

Also enforce legal-lane separation in export:

```powershell
# EULA should not ship in public OSS lane by default
git ls-files | rg "^src-tauri/resources/legal/EULA\.txt$"
```

Expected: no output unless policy explicitly marks it as commercial-reference-only (non-governing).

### Task 2.3: Large-file guard in public snapshot

Run in export repo:

```powershell
git ls-files | % { if(Test-Path $_){ $s=(gi $_).Length/1MB; if($s -gt 5){ "{0:N2} MB`t{1}" -f $s,$_ } } } | sort {[double]($_ -split ' MB')[0]} -desc
```

Define threshold exceptions explicitly (if any). Default target: no unexpected large binaries.

---

## Phase 3: Python Runtime Strategy for Public OSS

### Task 3.1: Track only Python source + locked manifests

**Public repo should keep:**
- `python_embedded/statistics_module/**`
- `python_embedded/stats_backend.py`
- dependency lock manifests (`requirements-validated.txt` with pinned versions/hashes)

**Public repo should not keep:**
- vendored `python_dependencies/`
- embedded runtime binaries (`python.exe`, dll/pyd payloads)

### Task 3.2: Contributor bootstrap (public)

**Files:**
- Create: `scripts/bootstrap-python.ps1`
- Create: `docs/setup/python-runtime.md`

Bootstrap does:
1. Create venv.
2. Install exact runtime deps from pinned manifest (`requirements-validated.txt`).
3. Run minimal health check import command.

### Task 3.3: Release bundling (private CI/public artifacts)

Release workflow should:
1. Build runtime bundle in CI.
2. Package installer with runtime.
3. Publish artifacts + updater metadata (`latest.json`) to releases.

Public git stays lean; end users still get full installer.

---

## Phase 4: Governance and Contribution Controls (Public)

### Task 4.1: CLA gate

**Files:**
- `CLA.md`
- `.github/workflows/cla.yml` (or CLA bot integration)
- `CONTRIBUTING.md`

Enable required CLA status check before merge.

### Task 4.2: Public docs baseline

**Files:**
- `README.md`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`

Keep docs minimal and contributor-focused.

Required `README.md` updates (preserve existing section order; no structural distortion):
1. Replace conflicting proprietary wording in `## ⚖️ License`:
   - remove “all rights reserved / unauthorized copying prohibited” text in OSS lane
   - add explicit dual-license statement (`AGPL` + commercial license option)
   - add commercial contact: `hello@easycris.com`
2. In `## ⬇️ Download`, explicitly split:
   - official signed binaries from GitHub Releases (recommended for end users)
   - source/developer builds (unsigned/dev-oriented)
3. Add a short `Build from Source (Developers)` section near `## 🚀 Getting Started` with bootstrap pointers:
   - `scripts/bootstrap-python.ps1`
   - contributor setup docs path
4. In intro/privacy/product text, qualify local runtime claim:
   - “no external software installation required” applies to official installer builds
5. Add `Contributing & Security` pointers:
   - `CONTRIBUTING.md`
   - `SECURITY.md`
   - Discussions/Issues links as applicable

README acceptance checks:
- installer path and source-build path are both present
- official-vs-source trust model is explicit (signed release binaries vs unsigned local builds)
- no text conflict with dual-license policy

---

## Phase 5: Release Workflow Implementation (Public)

### Task 5.1: implement real release workflow (not stub checks only)

**Files:**
- `.github/workflows/release.yml`
- release helper scripts referenced by workflow

Required behavior:
1. Build installer artifacts in CI for tagged releases.
2. Publish artifacts to GitHub Releases.
3. Publish updater metadata expected by app (`latest.json` and signature if used).
4. Fail workflow on artifact publishing errors.

No-go gate depends on this task being implemented and verified.

### Task 5.2: implement public PR workflow with required checks

**Files:**
- `.github/workflows/pr.yml`

Required behavior on `pull_request`:
1. Run install/bootstrap steps needed for contributor validation.
2. Run required quality gates:
   - `npm run -s typecheck`
   - `npm run -s test:run -- src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts src/utils/__tests__/lmmAnovaTables.test.ts`
3. Run secret/config hygiene checks needed for public contribution safety.
4. Publish clear status checks with stable names so branch protection can require them.

Branch protection requirement:
- Configure `main` in public repo to require the PR workflow checks from `pr.yml` before merge.

### Task 5.3: make public license tooling self-contained

**Files:**
- `scripts/generate-license-summary-index.mjs`
- `scripts/check-third-party-license-sync.ps1`
- `package.json` scripts (`license:*`)
- public source-of-truth location (e.g., `docs/license/source-of-truth.json` or `legal/source-of-truth.json`)

Current drift:
- license scripts depend on `_documentation/license/source-of-truth.json`, which is outside intended public scope.

Required fix:
1. Move source-of-truth input for public lane into a public-tracked path.
2. Update scripts to read from the new location.
3. Ensure `npm run -s license:summary` and `npm run -s license:summary:check` work in the public snapshot without `_documentation/`.
4. If these checks are intentionally private-lane only, disable/remove them from public lane scripts and document the split explicitly.

---

## Phase 6: Security and Quality Verification (Public Snapshot)

### Task 6.1: gitleaks scan public snapshot

```powershell
gitleaks detect --source . --no-git --report-format json --report-path .tmp-gitleaks-tree.json
```

### Task 6.2: fresh-clone test of public snapshot

Required stable gate:

```powershell
cd $env:TEMP
git clone <public-repo-url-or-local-export> easycris-public-smoke
cd easycris-public-smoke
pwsh -ExecutionPolicy Bypass -File scripts/bootstrap-python.ps1
npm ci
npm run -s typecheck
npm run -s test:run -- src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts src/utils/__tests__/lmmAnovaTables.test.ts
```

Optional extended gate (non-blocking for routine release cadence):

```powershell
npm run -s test:run
```

Record output in `docs/release/fresh-clone-verification-YYYY-MM-DD.md` and clearly mark smoke vs full matrix results.

### Task 6.3: release smoke (public CI)

Trigger tag build and verify:
- artifact upload exists
- updater endpoint serves valid file

### Task 6.4: periodic history secret scan (public repo)

Run on release candidates (and at least weekly):

```powershell
gitleaks git --report-format json --report-path .tmp-gitleaks-history.json
```

Treat any verified secret finding as release-blocking until rotated/remediated.

---

## Phase 7: Cutover and Ongoing Sync

### Task 7.1: Create/seed `easyCris` public repo

1. Push curated snapshot repo as initial public history.
2. Configure protections/required checks.

### Task 7.2: Establish repeatable sync cadence

Use export script per release (manual or CI-driven) with explicit model:
1. each release cycle generates one new curated snapshot commit in public repo
2. internal private commit history is intentionally squashed/abstracted away
3. public continuity is by release-tagged snapshot commits, not mirrored private commit-by-commit history

Document in `docs/release/public-sync-process.md`.

### Task 7.3: Define public PR ingestion back into private master (required)

Before each export cycle:
1. Triage merged public PRs and map them to private implementation branches.
2. Cherry-pick or re-implement accepted public changes into private master with provenance notes (public PR link + commit hash mapping).
3. Resolve conflicts/tests in private master first; only then generate the next public snapshot export.
4. Maintain an auditable mapping file:
   - `docs/release/public-pr-ingestion-log.md`

No-go condition: do not run next export if merged public PRs have not been reviewed for ingestion/disposition.

---

## Recommended Commit Structure

Private repo commits (planning + export tooling only):
1. `docs: add public snapshot strategy and content policy`
2. `build: add public snapshot export script and runbook`

Public repo commits:
1. `chore: initial public snapshot`
2. `legal: add AGPL and commercial licensing docs`
3. `docs: add contributor and security docs`
4. `ci: add public quality and release workflows`

---

## Acceptance Criteria

- Private repo remains fully functional and undisturbed.
- Public repo is fresh-history, lean, and cloneable.
- Public repo excludes vendored Python/runtime binary payloads.
- Contributors can bootstrap from source via documented scripts.
- Release artifacts still include full runtime for end users.
- Dual-license and CLA controls are in place.
