# One-Way ANOVA CI Reporting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose validated post-hoc confidence intervals for one-way ANOVA and display them in the post-hoc table without removing standard errors.

**Architecture:** Keep the existing one-way ANOVA math path, extend the backend/R contract with flat post-hoc CI and precision fields, regenerate baselines, then update the one-way post-hoc table to show the validated reporting columns. Reuse the same backend-first validation pattern proven in the two-way and multifactorial work.

**Tech Stack:** Python, R (`emmeans`), TypeScript table builders, Selenium E2E, JSON/CSV baselines

---

### Task 1: Add one-way regression tests first

**Files:**
- Create: `python_embedded/statistics_module/tests/test_one_way_anova_ci_contract.py`
- Create: `src/utils/__tests__/anovaTables.posthocCiColumns.test.ts`

**Step 1: Write the failing backend CI contract test**

- Assert one-way ANOVA exposes `posthoc*_estimate`, `posthoc*_se`, `posthoc*_ci_lower`, `posthoc*_ci_upper`, `posthoc*_df`, and `posthoc*_t` for Tukey.
- Add a Dunnett-specific numeric regression assertion using the adjustment dataset.

**Step 2: Write the failing table-builder test**

- Assert the one-way post-hoc table headers become:
  `Contrast | Estimate | Std Error | 95% CI [lower, upper] | DF | t Ratio | p | Adj. p-value | Sig`
- Assert the visible CI cell contains `[lower, upper]`.
- Assert the CI cell exposes `posthoc*_ci_lower` and `posthoc*_ci_upper` metadata for E2E extraction.

**Step 3: Run the targeted tests and verify they fail for the intended missing CI fields/columns**

Run:
- `python_embedded\python.exe -m pytest python_embedded\statistics_module\tests\test_one_way_anova_ci_contract.py -q`
- `npm run -s test:run -- src/utils/__tests__/anovaTables.posthocCiColumns.test.ts`

### Task 2: Extend the Python one-way post-hoc contract

**Files:**
- Modify: `python_embedded/statistics_module/parametric.py`

**Step 1: Add reportable post-hoc fields to pairwise comparison rows**

- For Tukey, Dunnett, Bonferroni, Holm, Holm-Sidak, Sidak, and FDR-BH, expose:
  - `estimate`
  - `se`
  - `ci_lower`
  - `ci_upper`
  - `df`
  - `t_stat`
- Keep existing:
  - `mean_difference`
  - `p_value`
  - `p_adjusted`
  - `significant`

**Step 2: Flatten those fields into one-way flat metrics**

- Emit:
  - `posthoc1_estimate`
  - `posthoc1_se`
  - `posthoc1_ci_lower`
  - `posthoc1_ci_upper`
  - `posthoc1_df`
  - `posthoc1_t`
- Preserve current `posthoc*_mean_diff`, `posthoc*_p`, `posthoc*_p_adj`.

**Step 3: Run the backend test and make it pass**

Run:
- `python_embedded\python.exe -m pytest python_embedded\statistics_module\tests\test_one_way_anova_ci_contract.py -q`

### Task 3: Update the R one-way validation export

**Files:**
- Modify: `_test_validation/Group1_Hypothesis_Testing/anova_one_way/r/run_test.R`

**Step 1: Export CI/SE/DF/t fields for pairwise results**

- Switch the `summary(pairwise_result)` calls to `summary(pairwise_result, infer = c(TRUE, TRUE))`.
- Emit flat fields:
  - `posthoc*_estimate`
  - `posthoc*_se`
  - `posthoc*_ci_lower`
  - `posthoc*_ci_upper`
  - `posthoc*_df`
  - `posthoc*_t`

**Step 2: Keep existing p-value fields intact**

- Preserve:
  - `posthoc*_mean_diff`
  - `posthoc*_p`
  - `posthoc*_p_adj`

**Step 3: Regenerate one-way adjustment artifacts**

Regenerate:
- `_test_validation/Group1_Hypothesis_Testing/anova_one_way/results/adjustments/*.csv`
- `e2e/fixtures/baselines/adjustments/anova_one_way/*/r_baseline.json`

### Task 4: Update the one-way post-hoc UI table

**Files:**
- Modify: `src/utils/ecpTableBuilders/anovaTables.ts`

**Step 1: Change only the post-hoc comparisons table**

- Keep the group-means table unchanged.
- Update the post-hoc table columns to:
  `Contrast | Estimate | Std Error | 95% CI [lower, upper] | DF | t Ratio | p | Adj. p-value | Sig`

**Step 2: Expose CI bounds via metadata on the visible CI cell**

- Do not add extra hidden cells.
- Use the same metadata pattern already validated in the factorial table builder.

**Step 3: Run the table-builder test and make it pass**

Run:
- `npm run -s test:run -- src/utils/__tests__/anovaTables.posthocCiColumns.test.ts`

### Task 5: Revalidate the one-way adjustment workflow

**Files:**
- Modify if needed: `e2e/features/r-validation/anova-one-way-adjustments.test.mjs`

**Step 1: Keep the existing one-way E2E path but validate new CI metrics**

- Ensure the E2E extraction layer can read the new `posthoc*_ci_*` metrics through the table metadata.
- Keep Dunnett tolerance handling aligned with the current one-way policy unless evidence requires tightening/loosening.

**Step 2: Run targeted verification**

Run:
- `python_embedded\python.exe -m pytest python_embedded\statistics_module\tests\test_one_way_anova_ci_contract.py -q`
- `npm run -s test:run -- src/utils/__tests__/anovaTables.posthocCiColumns.test.ts`
- `cmd /c "set E2E_EXPECT_SHIM=1&& set E2E_APP_PATH=C:\Users\RajLord_new\Desktop\tauri\src-tauri\target\e2e\release\easycris.exe&& node e2e\features\r-validation\anova-one-way-adjustments.test.mjs"`

### Task 6: Commit cleanly

**Files:**
- Stage only one-way CI contract, baseline, UI, and test changes.

**Step 1: Verify tree contents**

Run:
- `git status --short`

**Step 2: Commit**

Suggested message:
- `git commit -m "Validate one-way ANOVA CI reporting"`
