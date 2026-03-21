# Multifactorial ANOVA CI Reporting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add validated pairwise confidence interval fields to Multifactorial ANOVA adjustment outputs, keep standard errors, and expose `Estimate | Std Error | 95% CI | DF | t Ratio | p` for both Marginal Effects and Simple Effects using the existing shared factorial table builder.

**Architecture:** Keep the current multifactorial ANOVA math path unchanged. Extend the backend/result contract with flat CI fields derived from existing pairwise and simple-effects payloads, update the R reference generator and shipped baselines to validate those fields, then verify the shared factorial table/E2E path already renders and extracts them correctly for multifactorial ANOVA.

**Tech Stack:** Python statistics backend, R baseline generator, TypeScript table builders, Node/Selenium E2E validation

---

### Task 1: Add focused failing backend CI contract test

**Files:**
- Create: `python_embedded/statistics_module/tests/test_multifactorial_anova_ci_contract.py`
- Reference: `python_embedded/statistics_module/multifactorial_anova.py`

**Step 1: Write the failing test**

Add a test that calls the multifactorial ANOVA backend on the bundled adjustment dataset and asserts the returned payload includes:
- `me1_ci_lower`, `me1_ci_upper`
- `se1_ci_lower`, `se1_ci_upper`

Also assert existing fields remain:
- `me1_se`
- `se1_se`

**Step 2: Run test to verify it fails**

Run: `.\python_embedded\python.exe -m pytest python_embedded/statistics_module/tests/test_multifactorial_anova_ci_contract.py -q`

Expected: FAIL because the flat CI fields are not yet exported.

### Task 2: Extend Python multifactorial output with flat CI fields

**Files:**
- Modify: `python_embedded/statistics_module/multifactorial_anova.py`

**Step 1: Implement minimal backend change**

Extend the flattening logic for marginal and simple effects so it exports:
- `me*_ci_lower`, `me*_ci_upper`
- `se*_ci_lower`, `se*_ci_upper`

Do not remove or rename:
- `me*_se`
- `se*_se`

**Step 2: Re-run the backend test**

Run: `.\python_embedded\python.exe -m pytest python_embedded/statistics_module/tests/test_multifactorial_anova_ci_contract.py -q`

Expected: PASS.

### Task 3: Extend the R multifactorial generator with CI fields

**Files:**
- Modify: `_test_validation/Group1_Hypothesis_Testing/multifactorial_anova/r/run_test.R`

**Step 1: Add flat CI export for marginal and simple effects**

When serializing `me*` and `se*` rows, write:
- `*_ci_lower`
- `*_ci_upper`

For Dunnett, preserve the same contrast orientation logic as the two-way implementation so estimates, test statistics, and CI bounds stay aligned.

**Step 2: Run the R generator**

Run: `& 'C:\Program Files\R\R-4.5.1\bin\R.exe' --vanilla -f '_test_validation/Group1_Hypothesis_Testing/multifactorial_anova/r/run_test.R'`

Expected: Generated CSV includes the new CI fields.

### Task 4: Regenerate multifactorial adjustment outputs and shipped baselines

**Files:**
- Modify generated files under: `_test_validation/Group1_Hypothesis_Testing/multifactorial_anova/results/adjustments`
- Modify generated files under: `e2e/fixtures/baselines/adjustments/multifactorial_anova/*/r_baseline.json`

**Step 1: Regenerate method-specific outputs**

Produce updated outputs for:
- tukey
- bonferroni
- holm
- holm-sidak
- sidak
- dunnett
- fdr_bh

**Step 2: Refresh shipped JSON baselines**

Update the JSON baselines so they include:
- `me*_ci_lower`, `me*_ci_upper`
- `se*_ci_lower`, `se*_ci_upper`

**Step 3: Sanity-check one or two methods**

Use `rg` to verify the new CI keys exist in the generated JSON baselines.

### Task 5: Update multifactorial E2E tolerance behavior if needed

**Files:**
- Modify: `e2e/features/r-validation/multifactorial-anova-adjustments.test.mjs`
- Reference: `e2e/features/r-validation/anova-two-way-adjustments.test.mjs`
- Reference: `e2e/utils/r-validation.mjs`

**Step 1: Align Dunnett tolerance config**

If multifactorial Dunnett needs explicit absolute tolerance mode like two-way, update the tolerance config accordingly.

**Step 2: Verify extractor path**

Confirm the shared extractor already captures CI metadata from the visible combined CI cell. No new UI extraction code should be needed if the shared factorial builder path is already working.

### Task 6: Run verification

**Files:**
- No new files

**Step 1: Run backend CI contract test**

Run: `.\python_embedded\python.exe -m pytest python_embedded/statistics_module/tests/test_multifactorial_anova_ci_contract.py -q`

**Step 2: Run targeted factorial table tests**

Run: `npm run -s test:run -- src/utils/__tests__/factorialAnovaTables.ciColumns.test.ts src/utils/__tests__/factorialAnovaTables.simpleEffectsWarning.test.ts`

**Step 3: Run multifactorial adjustment E2E syntax check**

Run: `node --check e2e/features/r-validation/multifactorial-anova-adjustments.test.mjs`

**Step 4: Run multifactorial adjustment E2E**

Run:
```powershell
$env:E2E_EXPECT_SHIM='1'
$env:E2E_APP_PATH='C:\Users\RajLord_new\Desktop\tauri\src-tauri\target\e2e\release\easycris.exe'
node e2e/features/r-validation/multifactorial-anova-adjustments.test.mjs
```

Expected: PASS for all 7 adjustment methods, including CI metrics for both marginal and simple effects.
