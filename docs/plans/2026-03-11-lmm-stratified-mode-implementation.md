# Stratified LMM Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a generic stratified LMM mode that reuses the current single-fit `lmm_anova` engine, labels each subgroup result, and exports one stacked report with subgroup context columns.

**Architecture:** Keep `python_embedded/statistics_module/lmm_anova.py` as the single-fit worker and add a new stratified orchestration path that splits rows by user-selected categorical factors and invokes the worker once per subgroup. The TypeScript LMM config, payload builder, and result/report layers will pass `stratify_by` through unchanged and render subgroup-labeled results on one sheet/report.

**Tech Stack:** Python (`statsmodels`, existing `lmm_anova` helpers), TypeScript/React, Rust export layer, existing LMM ECP table builders and tests.

---

### Task 1: Backend Contract Tests For Stratified Mode

**Files:**
- Modify: `python_embedded/statistics_module/tests/test_lmm_anova_contract.py`

**Step 1: Write the failing tests**

Add tests for:
- generic `stratify_by` support without hardcoded factor names
- stacked `strata_results`
- subgroup labels attached to each result
- per-stratum warnings do not fail the whole batch

**Step 2: Run test to verify it fails**

Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`

Expected: FAIL because stratified mode does not exist yet.

**Step 3: Write minimal backend implementation**

Implement only enough wrapper logic to make the first stratified tests pass.

**Step 4: Run test to verify it passes**

Run the same pytest command.

**Step 5: Commit**

Commit once the contract tests pass cleanly.

### Task 2: Backend Stratified Wrapper

**Files:**
- Modify: `python_embedded/statistics_module/lmm_anova.py`

**Step 1: Write the failing tests**

Add or extend tests for:
- subgroup row splitting
- subgroup minimum-size rejection
- one bad stratum warning with overall success
- preservation of existing per-fit result shape inside `strata_results`

**Step 2: Run tests to verify failure**

Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`

**Step 3: Write minimal implementation**

Add a stratified wrapper path that:
- validates `stratify_by`
- builds subgroup masks
- calls `lmm_anova()` on each subset
- tags each child result with `stratum` and `stratum_label`
- returns one combined top-level result

**Step 4: Run tests**

Run the contract tests again.

**Step 5: Commit**

Commit when the wrapper is stable.

### Task 3: TypeScript Config And Payload Plumbing

**Files:**
- Modify: `src/components/dialogs/LmmAnovaConfigDialog.tsx`
- Modify: `src/lib/modules/parametric/lmmAnovaModule.ts`
- Modify: `src/hooks/useStatisticalAnalysisController.ts`
- Modify: `src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts`
- Modify: `src/components/dialogs/LmmAnovaConfigDialog.test.tsx`
- Modify: `src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts`

**Step 1: Write the failing tests**

Add tests that:
- config supports `stratified` and `stratifyBy`
- payload passes `stratify_by` generically
- controller keeps using the same LMM execution path with the new config

**Step 2: Run the tests to verify they fail**

Run the focused frontend test commands.

**Step 3: Write minimal implementation**

Add a stratified toggle and subgroup-factor selection to the LMM config and pass those values through the payload.

**Step 4: Run tests**

Run the same focused tests again.

**Step 5: Commit**

Commit once payload plumbing is green.

### Task 4: Stratified Report/Export Surface

**Files:**
- Modify: `src/utils/ecpTableBuilders/lmmAnovaTables.ts`
- Modify: `src/utils/__tests__/lmmAnovaTables.test.ts`
- Modify: `src/lib/analysis/resultParser.ts`
- Modify: `src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts`

**Step 1: Write the failing tests**

Add tests for:
- subgroup context columns in the report
- one stacked report from multiple strata
- no hardcoded factor names in report columns

**Step 2: Run tests to verify they fail**

Run the focused table/parser tests.

**Step 3: Write minimal implementation**

Render subgroup columns ahead of inferential columns and stack the per-stratum rows into one report/export surface.

**Step 4: Run tests**

Run the focused table/parser tests again.

**Step 5: Commit**

Commit when report/export behavior is stable.

### Task 5: Oracle Validation Hooks

**Files:**
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/python/run_test.py`
- Modify: `_test_validation/Group1_Hypothesis_Testing/linear_mixed_models/r/run_test.R`
- Modify: `python_embedded/statistics_module/tests/test_lmm_anova_contract.py`

**Step 1: Write failing validation-oriented tests**

Add tests that assert the stratified runner shape matches the intended subgroup-keyed export shape.

**Step 2: Run tests**

Run the Python tests to see them fail.

**Step 3: Write minimal implementation**

Add a stats-only stratified validation/export path that mirrors the subgroup logic from `lmm_anova_test.R`.

**Step 4: Run tests**

Run the targeted validation and contract tests.

**Step 5: Commit**

Commit once validation hooks are in place.

### Task 6: Verification And Memory Update

**Files:**
- Modify: `memory/session-memory.md`

**Step 1: Run verification**

Run:
- `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`
- `npm run test:run -- src/components/dialogs/LmmAnovaConfigDialog.test.tsx src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts src/utils/__tests__/lmmAnovaTables.test.ts src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts`
- `npm run typecheck`

**Step 2: Update memory**

Write key decisions and remaining risks to `memory/session-memory.md`.

**Step 3: Commit**

Commit verification-safe final state.
