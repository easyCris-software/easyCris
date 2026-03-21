# LMM Numeric-Time R Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Match the numeric-time selected-value LMM follow-up path to the `lmerTest + emmeans(..., at = ...)` oracle, starting with a green random-intercept slice before improving phase1b random-slope parity.

**Architecture:** Keep `python_embedded/statistics_module/lmm_anova.py` as the follow-up entry point and treat the existing `continuous_effects_config` helper as the selected-time contrast engine. Add oracle-driven tests and validation artifacts first, then improve only the phase1b Satterthwaite bundle in `lmm_parameterization.py` and `lmm_inference_satterthwaite.py` once estimate and SE parity are isolated from df drift.

**Tech Stack:** Python (`statsmodels.MixedLM`, local LMM inference helpers), R (`lmerTest`, `emmeans` via local `R.exe`), pytest, existing numeric-time validation scripts.

---

## Scope

- Keep the current categorical publication path unchanged.
- Keep numeric time as a separate follow-up mode.
- Treat the current helper in `python_embedded/statistics_module/lmm_anova.py` as the selected-value contrast engine.
- Use `lmer` / `lmerTest` / `emmeans(..., at = list(Time = ...))` as the oracle for this parity task.
- Do not mix selected-value contrasts with future slope/trend contrasts from `emtrends(...)`.
- Keep random-slope numeric-time follow-up blocked in the normal UI until backend parity is acceptable.

## Oracle Contract

The first parity target is:

- fitted model: `lmer(Value ~ Treatment * Time + (1 + Time | ID), ...)`
- follow-up surface: `emmeans(fit, ~ Treatment | Time, at = list(Time = c(...)))`
- inference target: `lmerTest` Satterthwaite output for the selected-time contrast rows

This is the right oracle for the current backend because the app is fitting subject-specific mixed models with random slopes, not `mmrm` marginal covariance models.

The oracle must keep these aligned with Python for every parity slice:

- same factor coding
- same selected time grid
- same df method
- same REML/ML choice

The R export must therefore pin the inference surface explicitly:

- `lmer.df = "satterthwaite"`
- selected-value `emmeans(..., at = list(Time = ...))`
- no silent Kenward-Roger defaulting

## Non-Goals

- Do not add `emtrends(...)` in this slice.
- Do not expose random-slope numeric-time follow-up back into the normal UI.
- Do not change report shape or product wording beyond what is already gated.
- Do not rewrite the fitter away from `statsmodels.MixedLM`.

## Root-Cause Framing

Current evidence already narrows the problem:

- row coverage matches R
- factor mapping is correct
- selected-time row construction is logically correct
- the remaining drift is mainly in finite-df inference for random-slope rows

The debugging surface should therefore be decomposed in this order:

1. `C beta` parity
- confirm the contrast estimates match the R oracle

2. `C V C'` parity
- confirm the fixed-effect covariance produces comparable contrast variances / SEs before df adjustment

3. contrast-specific df parity
- isolate divergence in the Satterthwaite layer only after estimate and SE are already close

## Technical Focus

The likely implementation surface is:

- `python_embedded/statistics_module/lmm_anova.py`
- `python_embedded/statistics_module/lmm_inference_satterthwaite.py`
- `python_embedded/statistics_module/lmm_parameterization.py`
- `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/r/export_numeric_time_inference.R`
- `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/python/compare_numeric_time_inference.py`

The main risk area is the phase1b variance-parameter bundle:

- `theta_cov`
- numerical Jacobian step sizing
- contrast-level Satterthwaite df path

The current parameterization uses a packed covariance-parameter plus sigma bridge. That is still likely too fragile near positive-definite boundaries for random-slope fits.

## Success Criteria

- Random-intercept numeric-time selected-value contrasts match the R oracle closely enough on estimate, SE, df, t, and raw p.
- Random-slope validation reports whether drift is in estimate, SE, or df rather than collapsing everything into a generic fallback.
- Phase1b changes improve random-slope selected-value parity without regressing existing categorical LMM behavior.
- `emtrends` remains a separate later feature.

## Best Merged Path

1. Lock the oracle around selected-value contrasts only.
- Prove the exported surface is `emmeans(..., at = list(Time = ...))`.
- Prove the output contains selected-time fields such as `time_value`, `contrast_variance`, `p_raw`.
- Prove the output does not contain slope/trend-specific surfaces.

2. Add a true random-intercept baseline first.
- Use `(1 | ID)` with the same time grid and the same selected-time contrast surface.
- Get estimate, SE, df, t, and p parity green here before touching random-slope phase1b.

3. Instrument random-slope parity diagnostically before fixing it.
- Compare the same rows on:
  - estimate diff
  - SE diff
  - df diff
  - t diff
  - p diff
- Emit enough comparator detail to tell whether the remaining drift is in `C beta`, `C V C'`, or df.
- Add perturbation-surface diagnostics so the plan can distinguish:
  - RC1: wrong parameterization
  - RC2: PD-boundary / Jacobian instability
- Treat the comparator/output schema expansion as a prerequisite for the stronger parity assertions used later in Task 4 and Task 5.

4. Fix phase1b in the right order.
- First test RC1 as the leading fix hypothesis:
  - implement and validate an experimental Cholesky-style random-effects parameterization in `extract_finite_df_varpar_spec()`
  - for the one-random-slope case, test whether a Cholesky-style random-effects parameterization, with or without sigma in the varpar bridge, improves parity and perturbation stability
  - keep this framed as a hypothesis to validate against the oracle, not as a pre-proven fix
- Then address RC2 explicitly:
  - tighten step sizing in `finite_difference_step_sizes()`
  - keep one-sided / PD-safe perturbation fallback local to the Jacobian evaluator

5. Accept only parity improvement, not merely path execution.
- It is not enough that finite df exists.
- The post-fix acceptance must show:
  - fewer fallback rows
  - improved df accuracy on the targeted rows
  - stable estimate / SE / t / p parity on rows that remain in the finite-df path

### Task 1: Freeze The Oracle Surface

**Files:**
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/r/export_numeric_time_inference.R`
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/python/compare_numeric_time_inference.py`
- Test: `python_embedded/statistics_module/tests/test_lmm_anova_contract.py`

**Step 1: Write the failing test**

Add a contract test that asserts the numeric-time oracle/export path is explicitly selected-value based:

```python
def test_numeric_time_oracle_uses_selected_value_emmeans_surface():
    summary = json.loads(
        (
            PROJECT_ROOT
            / "_test_validation"
            / "Group1_Hypothesis_Testing"
            / "linear_mixed_models"
            / "results"
            / "numeric_time_contrast_diff_summary.json"
        ).read_text(encoding="utf-8")
    )
    assert summary["oracle"]["surface"] == "emmeans_at_values"
    assert summary["oracle"]["df_method"] == "satterthwaite"
    assert summary["oracle"]["time_grid"]
    assert "time_value" in summary["oracle"]["required_row_fields"]
    assert "contrast_variance" in summary["oracle"]["required_row_fields"]
    assert "p_raw" in summary["oracle"]["required_row_fields"]
    assert "trend" not in summary["oracle"]["surface"]
```

**Step 2: Run test to verify it fails**

Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`

Expected: FAIL because the oracle contract test does not exist yet.

**Step 3: Write minimal implementation**

Update the R export and Python comparator so they clearly encode:

- selected-time `emmeans(..., at = list(Time = ...))`
- explicit `lmer.df = "satterthwaite"`
- no `emtrends(...)` logic in this path
- output fields for `estimate`, `contrast_variance`, `se`, `df`, `t_ratio`, `p_raw`
- top-level oracle metadata proving the selected-time surface

**Step 4: Run test to verify it passes**

Run the same pytest command.

**Step 5: Commit**

```bash
git add python_embedded/statistics_module/tests/test_lmm_anova_contract.py _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/r/export_numeric_time_inference.R _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/python/compare_numeric_time_inference.py
git commit -m "test: freeze numeric-time oracle surface"
```

### Task 2: Add A Green Random-Intercept Parity Slice

**Files:**
- Modify: `python_embedded/statistics_module/tests/test_lmm_anova_contract.py`
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/python/compare_numeric_time_inference.py`
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/r/export_numeric_time_inference.R`
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/results/numeric_time_random_intercept_diff_summary.json`

**Step 1: Write the failing test**

Add a focused parity test for a random-intercept numeric-time model:

```python
def test_numeric_time_random_intercept_selected_value_parity_is_close():
    summary = json.loads(
        (
            PROJECT_ROOT
            / "_test_validation"
            / "Group1_Hypothesis_Testing"
            / "linear_mixed_models"
            / "results"
            / "numeric_time_random_intercept_diff_summary.json"
        ).read_text(encoding="utf-8")
    )
    assert summary["matched_rows"] > 0
    assert summary["max_abs_diff"]["estimate"]["abs_diff"] <= 1e-4
    assert summary["max_abs_diff"]["se"]["abs_diff"] <= 1e-4
    assert summary["max_abs_diff"]["df"]["abs_diff"] <= 1e-2
    assert summary["max_abs_diff"]["t_ratio"]["abs_diff"] <= 1e-4
    assert summary["max_abs_diff"]["p_raw"]["abs_diff"] <= 1e-4
```

**Step 2: Run test to verify it fails**

Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`

Expected: FAIL until the validation path can isolate a random-intercept-only slice and persist its summary.

**Step 3: Write minimal implementation**

Add a random-intercept validation mode to the R export and Python comparator:

- fit `Treatment * Time + (1 | ID)`
- export selected-time contrasts at the chosen time grid
- emit a dedicated summary JSON for the random-intercept slice
- pin `lmer.df = "satterthwaite"` there as well

**Step 4: Run test to verify it passes**

Run:

```bash
./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q
"C:\Program Files\R\R-4.5.1\bin\R.exe" --vanilla -f _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/r/export_numeric_time_inference.R
./python_embedded/python.exe _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/python/compare_numeric_time_inference.py
```

Expected: random-intercept parity summary is generated and the targeted pytest assertion passes.

**Step 5: Commit**

```bash
git add python_embedded/statistics_module/tests/test_lmm_anova_contract.py _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/r/export_numeric_time_inference.R _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/python/compare_numeric_time_inference.py
git commit -m "test: add random-intercept numeric-time oracle slice"
```

### Task 3: Prove Where Random-Slope Parity Breaks

**Files:**
- Modify: `python_embedded/statistics_module/tests/test_lmm_anova_contract.py`
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/python/compare_numeric_time_inference.py`
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/results/numeric_time_contrast_diff_summary.json`

**Step 1: Write the failing test**

Add a diagnostic test that requires a decomposition of random-slope drift:

```python
def test_random_slope_numeric_time_summary_separates_estimate_se_and_df_drift():
    summary = json.loads(
        (
            PROJECT_ROOT
            / "_test_validation"
            / "Group1_Hypothesis_Testing"
            / "linear_mixed_models"
            / "results"
            / "numeric_time_contrast_diff_summary.json"
        ).read_text(encoding="utf-8")
    )
    assert "max_abs_diff" in summary
    assert "estimate" in summary["max_abs_diff"]
    assert "se" in summary["max_abs_diff"]
    assert "df" in summary["max_abs_diff"]
    assert "t_ratio" in summary["max_abs_diff"]
    assert "p_raw" in summary["max_abs_diff"]
    assert "stable_slope_rows" in summary
    assert "max_rel_df_diff" in summary["stable_slope_rows"]
    assert "perturbation_surface" in summary
    assert "pd_failures" in summary["perturbation_surface"]
```

**Step 2: Run test to verify it fails**

Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`

Expected: FAIL until the summary contract is tightened around the decomposition you need for debugging.

**Step 3: Write minimal implementation**

Extend the comparator to emit per-row and summary diagnostics that let you answer:

- does `C beta` match
- does `C V C'` match
- does drift appear only after the Satterthwaite df step
- does the variance-parameter perturbation stay positive-definite often enough to trust the Jacobian path

This task must extend the artifact schema before Task 4 or Task 5 can pass. The summary needs to grow enough to support later assertions such as:

- `targeted_stratum`
- `baseline_estimate_abs_diff`
- `baseline_se_abs_diff`
- `baseline_df_abs_diff`
- `perturbation_surface.pd_failures`
- stable-row parity aggregates used by the post-fix thresholds

Keep this slice diagnostic only. Do not change inference code yet.

**Step 4: Run test to verify it passes**

Run the same pytest command plus the R/Python validation commands from Task 2.

**Step 5: Commit**

```bash
git add python_embedded/statistics_module/tests/test_lmm_anova_contract.py _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/python/compare_numeric_time_inference.py _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/results/numeric_time_contrast_diff_summary.json
git commit -m "test: decompose random-slope numeric-time parity drift"
```

### Task 4: Add A Failing Phase1b Regression Test

**Files:**
- Modify: `python_embedded/statistics_module/tests/test_lmm_anova_contract.py`
- Modify: `python_embedded/statistics_module/lmm_anova.py`
- Modify: `python_embedded/statistics_module/lmm_inference_satterthwaite.py`
- Modify: `python_embedded/statistics_module/lmm_parameterization.py`

**Step 1: Write the failing test**

Add one targeted regression test for the worst random-slope stratum identified by the comparator:

```python
def test_phase1b_random_slope_numeric_time_reduces_df_drift_for_targeted_stratum():
    summary = json.loads(
        (
            PROJECT_ROOT
            / "_test_validation"
            / "Group1_Hypothesis_Testing"
            / "linear_mixed_models"
            / "results"
            / "numeric_time_contrast_diff_summary.json"
        ).read_text(encoding="utf-8")
    )
    targeted = summary["targeted_stratum"]
    assert targeted["estimate_abs_diff"] <= targeted["baseline_estimate_abs_diff"]
    assert targeted["se_abs_diff"] <= targeted["baseline_se_abs_diff"]
    assert targeted["df_abs_diff"] <= targeted["baseline_df_abs_diff"]
    assert targeted["finite_df_applied"] is True
```

**Step 2: Run test to verify it fails**

Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`

Expected: FAIL on the chosen regression case before any phase1b changes.

**Step 3: Write minimal implementation**

Do not touch the fitter. Change only the phase1b inference layer.

Address the two root causes separately:

- RC1: parameterization mismatch hypothesis
  - change `extract_finite_df_varpar_spec()` away from the current packed covariance-parameter plus sigma bridge
  - implement and validate an experimental Cholesky-style random-effects parameterization for the one-random-slope case
  - test whether keeping sigma in the varpar bridge or excluding it produces better parity and perturbation stability
- RC2: PD-boundary / Jacobian instability
  - tighten perturbation rules in `finite_difference_step_sizes()`
  - prefer PD-safe one-sided perturbations when symmetric perturbations fail
  - keep perturbation failures local to the Jacobian path instead of letting them destroy the contrast path

**Step 4: Run test to verify it passes**

Run the same pytest command.

**Step 5: Commit**

```bash
git add python_embedded/statistics_module/tests/test_lmm_anova_contract.py python_embedded/statistics_module/lmm_anova.py python_embedded/statistics_module/lmm_inference_satterthwaite.py python_embedded/statistics_module/lmm_parameterization.py
git commit -m "fix: stabilize phase1b numeric-time finite df"
```

### Task 5: Re-Run Oracle Comparison And Tighten Thresholds

**Files:**
- Modify: `python_embedded/statistics_module/tests/test_lmm_anova_contract.py`
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/results/numeric_time_contrast_diff_summary.json`
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/results/numeric_time_contrast_diff.csv`

**Step 1: Write the failing test**

Add threshold assertions for the improved random-slope slice:

```python
def test_random_slope_numeric_time_parity_improves_after_phase1b_change():
    summary = json.loads(
        (
            PROJECT_ROOT
            / "_test_validation"
            / "Group1_Hypothesis_Testing"
            / "linear_mixed_models"
            / "results"
            / "numeric_time_contrast_diff_summary.json"
        ).read_text(encoding="utf-8")
    )
    assert summary["fallback_row_count"] < 48
    assert summary["stable_slope_rows"]["max_rel_df_diff"] < 0.02
    assert summary["stable_slope_rows"]["max_abs_se_diff"] < summary["baseline"]["stable_slope_rows"]["max_abs_se_diff"]
    assert summary["stable_slope_rows"]["max_abs_t_ratio_diff"] < summary["baseline"]["stable_slope_rows"]["max_abs_t_ratio_diff"]
    assert summary["stable_slope_rows"]["max_abs_p_raw_diff"] < summary["baseline"]["stable_slope_rows"]["max_abs_p_raw_diff"]
```

**Step 2: Run test to verify it fails**

Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`

Expected: FAIL until the new validation artifacts show fewer fallback rows or better parity on the chosen slice.

**Step 3: Write minimal implementation**

Regenerate the oracle artifacts and only tighten thresholds that are actually achieved by the updated phase1b logic.

Do not accept a half-fix here:

- fallback reduction alone is insufficient
- finite df existence alone is insufficient
- the regenerated summary must prove df accuracy improved while estimate / SE / t / p remained acceptable on the stable rows

**Step 4: Run test to verify it passes**

Run:

```bash
"C:\Program Files\R\R-4.5.1\bin\R.exe" --vanilla -f _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/r/export_numeric_time_inference.R
./python_embedded/python.exe _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/python/compare_numeric_time_inference.py
./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q
```

**Step 5: Commit**

```bash
git add python_embedded/statistics_module/tests/test_lmm_anova_contract.py _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/results/numeric_time_contrast_diff_summary.json _test_validation/Group1_Hypothesis_Testing/linear_mixed_models/results/numeric_time_contrast_diff.csv
git commit -m "test: lock improved numeric-time parity thresholds"
```

### Task 6: Full Verification And Memory Update

**Files:**
- Modify: `memory/session-memory.md`

**Step 1: Run verification**

Run:

```bash
./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q
npm run test:run -- src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts src/utils/__tests__/lmmAnovaTables.test.ts src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts
npm run typecheck
```

Expected: Python contract tests, LMM TS tests, and typecheck all pass with the random-slope UI gate still intact.

**Step 2: Update memory**

Record:

- the oracle target is `lmerTest + emmeans(..., at = ...)`
- random-intercept slice status
- random-slope phase1b status
- whether fallback rows dropped
- whether the UI gate remains necessary

**Step 3: Commit**

```bash
git add memory/session-memory.md
git commit -m "docs: record numeric-time parity status"
```
