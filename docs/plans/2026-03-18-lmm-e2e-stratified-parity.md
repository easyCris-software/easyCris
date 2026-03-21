# LMM Stratified E2E Parity Execution Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan phase-by-phase.

**Goal:** Implement one robust LMM stratified E2E validation flow, modeled on the two-way ANOVA adjustment E2E pattern, that validates all currently instrumented LMM numeric `data-stat` metrics including simple effects.

**Architecture:** Follow the same execution shape used by `anova-two-way-adjustments.test.mjs`: per-run setup, import validation CSV, run UI workflow with explicit config, wait for results, extract metrics, compare to baseline, assert pass. Keep LMM backend/report contracts unchanged and only fix E2E wiring + baseline coverage gaps.

**Tech Stack:** Selenium WebDriver `.mjs` E2E tests, existing `ui-workflow.mjs`, `r-validation.mjs`, `fixtures.mjs`, LMM dialog `data-testid` hooks, LMM ECP table metric keys.

---

## Why This Plan (Aligned to Two-Way Pattern)

The two-way adjustment E2E pattern is:
1. deterministic import source
2. deterministic UI orchestration
3. method/config-specific baseline loading
4. `extractStatsFromUI` -> `compareToRBaseline` -> `assertValidation`
5. clear pass/fail metric counts

For LMM, we will mirror this structure directly and avoid ceremony-heavy TDD loops. We still keep verification gates after each phase.

---

## Scope Decisions

### In Scope
- Add dedicated stratified LMM E2E spec under `e2e/features/r-validation/`.
- Fix stale LMM dialog automation so config is actually applied.
- Explicitly toggle inline LMM simple effects in E2E.
- Validate all currently instrumented numeric inferential metrics:
  - stratified omnibus (`st*_fe*_*`)
  - stratified simple effects (`st*_se*_*`)
  - any additional exposed numeric LMM metrics present in DOM for this run
- Add/maintain `e2e/fixtures/baselines/lmm_anova_r_baseline.json`.
- Add stratified baseline generation path for `dataset_01.csv` (R export + JS baseline assembly), because existing `scripts/generate-lmm-e2e-baselines.js` currently emits non-stratified flat `fe*/se*` keys from `r_result.csv`.

### Out of Scope
- LMM plot parity.
- Numeric-time random-slope parity expansion.
- Re-enabling pooled toggle UX.
- Creating a new duplicate oracle folder outside existing `linear_mixed_models`.

### Optional Phase
- Full stratified diagnostics metric parity if additional `data-stat` hooks are required.

---

## Inputs and Existing References

### Existing E2E Pattern References
- `e2e/features/r-validation/anova-two-way-adjustments.test.mjs`
- `e2e/features/r-validation/multifactorial-anova-adjustments.test.mjs`

### Existing LMM E2E/Data Paths
- `e2e/utils/ui-workflow.mjs` (`runLmmAnova`, `handleLmmAnovaDialog`)
- `e2e/utils/r-validation.mjs`
- `e2e/utils/fixtures.mjs` (`importFromValidation`, `lmm_anova -> linear_mixed_models`)
- `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/data/dataset_01.csv`

### Baseline Reality Check (Must Be Fixed)
- Current generated baseline path (`scripts/generate-lmm-e2e-baselines.js`) reads key-value `r_result*.csv` files and emits flat non-stratified keys (`fe1_*`, `se1_*`).
- Current LMM UI path is stratified-only, so E2E emits `st{S}_fe{N}_*` and `st{S}_se{N}_*`.
- Therefore, current baseline generator output cannot validate current UI output.
- Plan must introduce a stratified baseline source and stratified baseline builder.

### Existing LMM UI Contract (must be driven by E2E)
- `lmm-predictor-toggle-*`
- `lmm-predictor-type-*`
- `lmm-stratify-factor-*`
- `lmm-simple-effect-toggle-*-within-*`
- `lmm-adjustment-method`
- `lmm-next-button`

### Execution Mode (Mandatory)
- Do not run plain `node e2e/features/r-validation/lmm-anova-stratified.test.mjs` without E2E shim mode.
- Preferred targeted command (PowerShell):
  1. `$env:E2E_EXPECT_SHIM='1'`
  2. `$env:E2E_APP_PATH='src-tauri/target/e2e/release/easycris.exe'`
  3. `npm run -s e2e:single -- e2e/features/r-validation/lmm-anova-stratified.test.mjs`
- Alternative suite runner command:
  - `node e2e/run-tests.mjs features/r-validation --mode=e2e --app-path=src-tauri/target/e2e/release/easycris.exe`

---

## Phase 1: Implement LMM E2E Spec Skeleton (Pattern-Matched)

### Files
- Create: `e2e/features/r-validation/lmm-anova-stratified.test.mjs`

### Implementation
Build spec in the same style as two-way adjustment tests:
- local baseline loader function
- `runSingleConfig(...)` style runner
- one `runTest()` entrypoint
- explicit `process.exit(1)` on failure

Use:
- `setupTest`, `cleanupTest`, `verifyCleanState`
- `importFromValidation(driver, 'lmm_anova', { datasetFile: 'dataset_01.csv' })`
- `runLmmAnova(driver, config)`
- `waitForResults(driver)`
- metric extraction/compare/assert flow

### Verification Gate
Run:
- `$env:E2E_EXPECT_SHIM='1'; $env:E2E_APP_PATH='src-tauri/target/e2e/release/easycris.exe'; npm run -s e2e:single -- e2e/features/r-validation/lmm-anova-stratified.test.mjs`

Expected now:
- likely fail due to stale dialog wiring and/or missing baseline.

### Commit Checkpoint
Commit scaffold only.

---

## Phase 2: Add Stratified R Oracle Export for `dataset_01.csv`

### Files
- Create: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/r/export_stratified_inference_dataset_01.R`
- Generate: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/results/r_stratified_omnibus_dataset_01.csv`
- Generate: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/results/r_stratified_simple_contrasts_dataset_01.csv`

### Implementation
Add an R export script for the exact E2E fixture dataset and config:
- input: `dataset_01.csv`
- stratify by: `strain`, `sex`
- fixed effects formula: `value ~ treatment * day`
- random structure: `(1 | subject)`
- df method: `Satterthwaite` (must match E2E config)
- emit per-stratum omnibus and per-stratum simple contrasts as tabular CSV.

### Stratum Ordering Contract (Mandatory)
- Baseline flattening must match Python/UI stratum index order used by `st1`, `st2`, ...
- Use deterministic ordering: selected stratifiers in UI order, with sorted unique level values per stratifier, Cartesian product order.
- For `dataset_01.csv` with `strain` then `sex`: `B6|F`, `B6|M`, `D2|F`, `D2|M`.
- Fail baseline build if observed R rows cannot be mapped to this deterministic order.

### Verification Gate
Run:
- R export command for the new script and verify both stratified CSV outputs exist and are non-empty.

### Commit Checkpoint
Commit new dataset_01 stratified R export script.

---

## Phase 3: Fix LMM Dialog Automation in `ui-workflow.mjs`

### Files
- Modify: `e2e/utils/ui-workflow.mjs`

### Problem to Fix
Current LMM predictor selection logic still uses stale structural selector:
- `section:nth-of-type(2) .rounded.border.p-3`

This can silently no-op and still report success.

### Implementation
Update `handleLmmAnovaDialog` to drive by `data-testid` selectors only.

Hard requirement: unresolved expected controls must fail the test immediately with an error containing requested target + available targets. No silent pass/no-op behavior.

Add/repair handlers for:
1. predictors:
- `lmm-predictor-toggle-${key}`
- `lmm-predictor-type-${key}`

2. stratification:
- `lmm-stratify-factor-${key}`

3. inline simple effects:
- `lmm-simple-effect-toggle-${factorId}-within-${withinId}`

4. adjustment controls:
- `lmm-adjustment-method`
- optional `lmm-posthoc-q`
- optional `lmm-dunnett-control-*` when applicable

5. keep existing controls:
- `lmm-dv-select`, `lmm-group-select`, `lmm-df-method`, random-effects controls

### Config Contract for E2E
`runLmmAnova` config for this test should include:
- `dependentColumn`
- `subjectColumn`
- `predictorColumns` (column names; resolved to dialog keys)
- `predictorTypes`
- `stratifyColumns` (column names; resolved to dialog keys)
- `simpleEffects` (`{ factor, within }`, each provided as column name and resolved to dialog keys)
- `adjustmentMethod`

Normalization rule (explicit):
- Dialog target IDs are keyed by `getColumnKey(column) = columnId || columnName`.
- E2E resolver must map from requested column name -> effective dialog key.
- If a requested predictor/stratifier/simple-effect endpoint cannot be resolved to a concrete `data-testid` target, throw and fail the run.

### Verification Gate
Run:
- `$env:E2E_EXPECT_SHIM='1'; $env:E2E_APP_PATH='src-tauri/target/e2e/release/easycris.exe'; npm run -s e2e:single -- e2e/features/r-validation/lmm-anova-stratified.test.mjs`

Expected:
- dialog completes with intended toggles actually applied
- run reaches metric compare stage.

### Commit Checkpoint
Commit automation fixes + any config normalization helper.

---

## Phase 4: Add Stratified Baseline Builder + LMM Baseline JSON

### Files
- Modify: `scripts/generate-lmm-e2e-baselines.js`
- Create/modify: `e2e/fixtures/baselines/lmm_anova_r_baseline.json`
- Modify: `e2e/features/r-validation/lmm-anova-stratified.test.mjs`

### Implementation
Use existing comparator contract (`compareToRBaseline` numeric keys).

Baseline provenance rule (non-negotiable):
- Baseline values must come from the R oracle outputs under `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/results/` (or generated from the corresponding R oracle script), then mapped to UI metric keys.
- Do not bootstrap baseline values from current UI output.

Builder requirement:
- Add `buildStratifiedBaseline()` to consume tabular stratified R outputs and flatten to UI metric keys:
  - omnibus keys: `st{S}_fe{N}_f_value`, `st{S}_fe{N}_num_df`, `st{S}_fe{N}_den_df`, `st{S}_fe{N}_p`, ...
  - simple-effect keys: `st{S}_se{N}_estimate`, `st{S}_se{N}_se`, `st{S}_se{N}_df`, `st{S}_se{N}_t_ratio`, `st{S}_se{N}_p_raw`, `st{S}_se{N}_p`, ...
- Keep the existing non-stratified builder paths intact for legacy artifacts, but route LMM E2E stratified baseline generation through the new builder.

Simple-effects scale (dataset_01 specific):
- `day` has 3 levels (`D0`, `D1`, `D2`) and `treatment` has 2 levels.
- Per stratum: `treatment within day` = 3 contrasts; `day within treatment` = 6 contrasts; total = 9.
- With 4 strata, expected simple-effect rows = 36.
- Baseline generation and E2E assertions must cover full emitted simple-effect sets, not just one row.

Populate baseline key mapping for currently instrumented numeric UI keys, focusing on:
1. Omnibus:
- `st1_fe1_f_value`, `st1_fe1_num_df`, `st1_fe1_den_df`, `st1_fe1_p`, etc.

2. Simple effects:
- `st1_se1_estimate`, `st1_se1_se`, `st1_se1_df`, `st1_se1_t_ratio`, `st1_se1_p_raw`, `st1_se1_p`, etc.

3. Include any other numeric LMM keys exposed in DOM for this scenario.

Do not depend on non-numeric text fields for numeric comparator pass/fail.

### Verification Gate
Run:
- `$env:E2E_EXPECT_SHIM='1'; $env:E2E_APP_PATH='src-tauri/target/e2e/release/easycris.exe'; npm run -s e2e:single -- e2e/features/r-validation/lmm-anova-stratified.test.mjs`

Expected:
- baseline comparison passes at chosen tolerance (`0.0001` default unless explicitly relaxed).

### Commit Checkpoint
Commit baseline JSON + finalized compare flow.

---

## Phase 5: Enforce "Simple Effects Were Computed" Guard

### Files
- Modify: `e2e/features/r-validation/lmm-anova-stratified.test.mjs`

### Implementation
Before running `assertValidation(comparison)`, assert required simple-effect metrics are present:
- At minimum presence checks:
  - `st1_se1_estimate`
  - `st1_se1_p_raw`
  - `st1_se1_p`
- Coverage checks:
  - assert simple-effect metrics exist for every expected stratum index (`st1`..`st4` for dataset_01 config)
  - assert expected simple-effect row count per stratum (9 for dataset_01 config) or assert exact baseline key coverage
  - fail if any expected stratum/effect block is missing

Fail fast with explicit error if missing.

This ensures E2E cannot pass with simple-effects toggles accidentally skipped.

### Verification Gate
Run:
- `$env:E2E_EXPECT_SHIM='1'; $env:E2E_APP_PATH='src-tauri/target/e2e/release/easycris.exe'; npm run -s e2e:single -- e2e/features/r-validation/lmm-anova-stratified.test.mjs`

Expected:
- fails if simple effects were not computed
- passes when wiring is correct.

### Commit Checkpoint
Commit guard assertions.

---

## Phase 6 (Optional): Expand to Full Diagnostics Metric Parity

### Trigger
Only do this if release bar requires diagnostics rows to be included in "all metrics."

### Files
- Modify: `src/utils/ecpTableBuilders/lmmAnovaTables.ts`
- Modify: `src/utils/__tests__/lmmAnovaTables.test.ts`
- Modify: `e2e/features/r-validation/lmm-anova-stratified.test.mjs`
- Modify: `e2e/fixtures/baselines/lmm_anova_r_baseline.json`

### Implementation
Add stable `data-stat` hooks for stratified diagnostics row values (example naming):
- `st1_diag_converged`
- `st1_diag_singular_fit`
- `st1_diag_finite_df_applied`
- `st1_diag_fallback_reason` (numeric if represented as code, otherwise omit from numeric parity)
- `st1_diag_error` (usually text; omit from numeric parity)

Then include numeric diagnostics keys in LMM baseline and compare flow.

### Verification Gate
Run:
- `npm run -s test:run -- src/utils/__tests__/lmmAnovaTables.test.ts`
- `$env:E2E_EXPECT_SHIM='1'; $env:E2E_APP_PATH='src-tauri/target/e2e/release/easycris.exe'; npm run -s e2e:single -- e2e/features/r-validation/lmm-anova-stratified.test.mjs`

### Commit Checkpoint
Commit diagnostics hook + parity extension.

---

## Global Verification Gates (Final)

Run in this order:
1. Targeted LMM E2E:
- `$env:E2E_EXPECT_SHIM='1'; $env:E2E_APP_PATH='src-tauri/target/e2e/release/easycris.exe'; npm run -s e2e:single -- e2e/features/r-validation/lmm-anova-stratified.test.mjs`

2. Related unit tests:
- `npm run -s test:run -- src/components/dialogs/LmmAnovaConfigDialog.test.tsx src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts src/utils/__tests__/lmmAnovaTables.test.ts src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts`

3. Typecheck:
- `npm run typecheck`

4. Optional full E2E suite:
- `npm run e2e:r-validation`

---

## Acceptance Criteria

1. LMM E2E follows the same orchestration style as two-way adjustment tests.
2. LMM config in E2E explicitly toggles stratification and inline simple effects.
3. E2E hard-fails when any requested predictor/stratify/simple-effect target cannot be resolved in the dialog.
4. Baseline is generated from stratified R oracle outputs for `dataset_01.csv` (not non-stratified `r_result.csv`).
5. Stratum index mapping (`st1..stN`) is deterministic and explicitly verified against ordering contract.
6. E2E fails if requested simple-effects metrics are absent for any expected stratum.
7. Baseline parity passes for all currently instrumented numeric LMM `data-stat` metrics in the tested scenario.
8. Diagnostics are included only if phase 6 instrumentation is completed.
9. No regressions in existing LMM unit/integration tests and typecheck.

---

## Risks and Mitigations

1. Risk: stratum ordering shifts causing `st1/st2/...` mismatch.
- Mitigation: keep deterministic dataset/config and fixed stratifier order.

2. Risk: key/name mismatch from config to dialog `data-testid` keys.
- Mitigation: central normalization helper in `ui-workflow.mjs` and explicit debug logs for resolved keys.

3. Risk: "all metrics" interpreted to include non-exposed diagnostics.
- Mitigation: declare exposed-metric scope in phase 1; execute phase 6 if diagnostics parity is mandatory.

4. Risk: inferential row-comparator path diverges from numeric data-stat path.
- Mitigation: this plan validates via `extractStatsFromUI` numeric key parity only; inferential row-comparator is explicitly out of scope for this milestone.

---

## Execution Notes

- This plan intentionally uses blueprint execution rather than strict red/green TDD ceremony.
- Verification is still mandatory after each phase.
- Use frequent small commits after each completed phase.
