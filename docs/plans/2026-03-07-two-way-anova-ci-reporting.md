# Two-Way ANOVA CI Reporting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add validated pairwise confidence interval fields to Two-Way ANOVA adjustment outputs, keep standard errors, and update the UI to display `Estimate | Std Error | 95% CI | DF | t Ratio | p` for marginal and simple effects.

**Architecture:** Keep the existing validated two-way ANOVA math paths in place. Extend the backend/result contract with flat CI fields derived from the existing pairwise payload, update the R baseline generator and shipped baselines to validate those new fields, then update the factorial ANOVA table builder to render CI alongside SE without changing the underlying pooled-error calculations.

**Tech Stack:** Python statistics backend, R baseline generator, TypeScript table builders, Node/Selenium E2E validation

---

### Task 1: Add failing frontend table tests for CI columns

**Files:**
- Create: `src/utils/__tests__/factorialAnovaTables.ciColumns.test.ts`
- Reference: `src/utils/ecpTableBuilders/factorialAnovaTables.ts`

**Step 1: Write the failing test**

Add tests that build factorial ANOVA tables from a two-way result payload containing:
- marginal effect rows with `mean_diff`, `se`, `df`, `t_stat`, `p_adjusted`, `ci_lower`, `ci_upper`
- simple effect rows with the same fields plus `factor_scope`

Assertions:
- marginal effects table columns contain `Estimate`, `Std Error`, `95% CI`, `DF`, `t Ratio`, `Pr > |t|`
- simple effects table columns contain the same
- rendered row value for CI is combined as `[lower, upper]`
- existing estimate and SE values remain present

**Step 2: Run test to verify it fails**

Run: `npm run -s test:run -- src/utils/__tests__/factorialAnovaTables.ciColumns.test.ts`

Expected: FAIL because the current table builder has no CI column.

### Task 2: Add failing backend validation checks for flat CI fields

**Files:**
- Modify: `_test_validation/Group1_Hypothesis_Testing/anova_two_way/r/run_test.R`
- Modify: `validate_two_way_simple_effects.py`
- Reference: `_test_validation/Group1_Hypothesis_Testing/anova_two_way/results/adjustments/r_result_tukey.csv`

**Step 1: Extend the validation expectation**

Update the local validation script expectations so each simple effect also requires:
- `ci_lower`
- `ci_upper`

Update R output logic to plan for:
- `me*_ci_lower`, `me*_ci_upper`
- `se*_ci_lower`, `se*_ci_upper`

**Step 2: Run the current R/Python generation flow to verify those fields are missing**

Run: `& 'C:\Program Files\R\R-4.5.1\bin\R.exe' --vanilla -f '_test_validation/Group1_Hypothesis_Testing/anova_two_way/r/run_test.R'`

Expected: Generated CSV lacks the new flat CI fields.

### Task 3: Extend Python two-way output with flat CI fields

**Files:**
- Modify: `python_embedded/statistics_module/anova.py`

**Step 1: Write a focused failing backend test or script assertion**

Add or use a focused script that calls `anova_two_way()` with:
- encoded factor inputs
- `factor_level_labels`
- `simple_effects`

Assert that returned result now contains:
- `me1_ci_lower`, `me1_ci_upper`
- `se1_ci_lower`, `se1_ci_upper`

**Step 2: Run it to verify it fails**

Run the focused script with `.\python_embedded\python.exe`

Expected: FAIL because flat CI fields are not currently exported.

**Step 3: Implement minimal backend change**

In `anova.py`, extend the flattening logic that currently writes `me*_estimate`, `me*_se`, `me*_df`, `me*_t`, `me*_p` and `se*_...` to also include:
- `*_ci_lower`
- `*_ci_upper`

Do not remove or rename the existing SE fields.

**Step 4: Re-run the focused script**

Expected: PASS with new flat CI fields populated from the existing pairwise comparison contract.

### Task 4: Extend the R reference generator with flat CI fields

**Files:**
- Modify: `_test_validation/Group1_Hypothesis_Testing/anova_two_way/r/run_test.R`

**Step 1: Add flat CI export for main and simple effects**

When serializing `me*` and `se*` rows, write:
- `*_ci_lower`
- `*_ci_upper`

Use the CI columns produced by `emmeans` summaries for the selected adjustment path.

**Step 2: Run the R generator**

Run: `& 'C:\Program Files\R\R-4.5.1\bin\R.exe' --vanilla -f '_test_validation/Group1_Hypothesis_Testing/anova_two_way/r/run_test.R'`

Expected: The regenerated CSV now includes flat CI fields.

### Task 5: Validate Python vs R for CI on two-way adjustments

**Files:**
- Modify as needed: `_test_validation/Group1_Hypothesis_Testing/anova_two_way/r/run_test.R`
- Modify as needed: `_test_validation/scripts/data_adapters.py`
- Reference: `_test_validation/Group1_Hypothesis_Testing/anova_two_way/results/adjustments/*.csv`

**Step 1: Run method-by-method R generation for all 7 adjustments**

Generate outputs for:
- tukey
- bonferroni
- holm
- holm-sidak
- sidak
- dunnett
- fdr_bh

**Step 2: Run or extend comparison scripts**

Verify Python and R match for:
- `me*_ci_lower`, `me*_ci_upper`
- `se*_ci_lower`, `se*_ci_upper`

Expected: Any CI semantic mismatches are discovered here before UI changes.

### Task 6: Regenerate shipped JSON baselines

**Files:**
- Modify generated files under: `e2e/fixtures/baselines/adjustments/anova_two_way/*/r_baseline.json`

**Step 1: Regenerate baseline JSON**

Update the shipped baselines so they include the new flat CI metrics alongside existing SE metrics.

**Step 2: Sanity-check one or two methods**

Use `rg` to verify that `se1_ci_lower` / `se1_ci_upper` and `me1_ci_lower` / `me1_ci_upper` exist in the shipped baselines.

### Task 7: Update E2E expectations

**Files:**
- Modify: `e2e/features/r-validation/anova-two-way-adjustments.test.mjs`
- Modify as needed: `e2e/utils/r-validation.mjs`

**Step 1: Add CI assertions**

Ensure extraction and comparison include the new flat CI fields from the stats table output.

**Step 2: Run the targeted E2E or extraction path**

Run the smallest viable validation command for two-way adjustments in this environment.

Expected: The test fails until the UI renders the new CI data-stat fields.

### Task 8: Update the two-way factorial table builder UI

**Files:**
- Modify: `src/utils/ecpTableBuilders/factorialAnovaTables.ts`

**Step 1: Implement minimal table change**

For marginal and simple effects tables:
- keep Estimate
- keep Std Error
- add `95% CI`
- render CI as `[lower, upper]`
- add stable `data-stat` keys for CI values, likely separate lower/upper attrs even if displayed in one combined cell

Do not remove existing SE display or existing data-stat names.

**Step 2: Run the targeted unit tests**

Run: `npm run -s test:run -- src/utils/__tests__/factorialAnovaTables.ciColumns.test.ts src/utils/__tests__/factorialAnovaTables.simpleEffectsWarning.test.ts`

Expected: PASS.

### Task 9: Run verification

**Files:**
- No new files

**Step 1: Run frontend tests**

Run: `npm run -s test:run -- src/utils/__tests__/factorialAnovaTables.ciColumns.test.ts src/utils/__tests__/factorialAnovaTables.simpleEffectsWarning.test.ts`

**Step 2: Run typecheck**

Run: `npm run -s typecheck`

**Step 3: Run Python syntax check**

Run: `.\python_embedded\python.exe -m py_compile python_embedded/statistics_module/anova.py`

**Step 4: Run R baseline generation**

Run: `& 'C:\Program Files\R\R-4.5.1\bin\R.exe' --vanilla -f '_test_validation/Group1_Hypothesis_Testing/anova_two_way/r/run_test.R'`

**Step 5: Run targeted adjustment validation**

Run the smallest viable two-way adjustment validation command available in this repo.

