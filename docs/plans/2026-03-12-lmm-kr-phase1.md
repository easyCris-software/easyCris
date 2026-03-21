# LMM Kenward-Roger Phase KR-1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a pure-Python `kenward_roger` df method for LMM simple and marginal one-dimensional contrasts without introducing any runtime R dependency.

**Architecture:** Keep `python_embedded/statistics_module/lmm_anova.py` as the fit/orchestration engine. Add a parallel KR inference layer that reuses the current parameter bridge and fit objects, initially scoped to random-intercept models only. If KR is unsupported or numerically unstable, fail validation early rather than silently changing methods.

**Tech Stack:** Python, statsmodels `MixedLM`, numpy, scipy, existing LMM helper modules, React/TypeScript dialog wiring.

---

### Task 1: Add KR contract and scope tests

**Files:**
- Modify: `python_embedded/statistics_module/tests/test_lmm_anova_contract.py`
- Modify: `src/components/dialogs/LmmAnovaConfigDialog.test.tsx`
- Modify: `src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts`

**Step 1: Write failing backend tests**
- Add tests that assert:
  - `df_method="kenward_roger"` is accepted only for random-intercept models.
  - `kenward_roger` rejects random-slope fits with a clear unsupported message.
  - KR result payload exposes `requested_df_method="kenward_roger"` and `applied_df_method="kenward_roger"` for supported cases.

**Step 2: Run the failing backend tests**
- Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`
- Expected: failures mentioning unsupported/missing KR handling.

**Step 3: Write failing frontend tests**
- Add dialog/module tests for:
  - the `Kenward-Roger` option reappearing in the LMM df-method select
  - payload forwarding of `df_method: "kenward_roger"`

**Step 4: Run the failing frontend tests**
- Run: `npm run test:run -- src/components/dialogs/LmmAnovaConfigDialog.test.tsx src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts`
- Expected: failures because the UI/backend contract does not yet support KR.

### Task 2: Add a dedicated KR inference helper module

**Files:**
- Create: `python_embedded/statistics_module/lmm_inference_kr.py`
- Modify: `python_embedded/statistics_module/tests/test_lmm_anova_contract.py`

**Step 1: Write failing helper-facing tests**
- Add focused tests for:
  - supported-fit validation (`k_re == 1`, no variance components)
  - adjusted covariance shape/symmetry
  - 1D KR inference payload shape (`estimate`, `se`, `df`, `t_ratio`, `p_value`)

**Step 2: Run the new failing tests**
- Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`
- Expected: import or behavior failures for missing KR helpers.

**Step 3: Implement minimal KR helper**
- Add:
  - fit support validation
  - random-intercept-only group covariance helpers
  - KR-adjusted covariance scaffold
  - 1D KR contrast test helper

**Step 4: Re-run backend tests**
- Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`
- Expected: targeted KR helper tests pass or move failures to integration points.

### Task 3: Wire KR into `lmm_anova.py`

**Files:**
- Modify: `python_embedded/statistics_module/lmm_anova.py`
- Modify: `python_embedded/stats_backend.py`

**Step 1: Add failing integration test**
- Assert a supported KR run returns:
  - `requested_df_method = "kenward_roger"`
  - `applied_df_method = "kenward_roger"`
  - finite `se`, `df`, `t_ratio`, `p_raw` on simple contrasts

**Step 2: Run the failing integration test**
- Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`
- Expected: failure because `lmm_anova.py` still rejects/normalizes KR.

**Step 3: Implement minimal wiring**
- Extend allowed df methods.
- Build a KR inference bundle for supported fits.
- Route pairwise/simple contrasts through KR 1D inference when selected.
- Keep omnibus on the current path for KR-1; do not change omnibus labeling yet.
- Surface explicit warnings/errors when KR is unsupported.

**Step 4: Re-run backend tests**
- Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`
- Expected: backend suite green.

### Task 4: Restore frontend method support

**Files:**
- Modify: `src/components/dialogs/LmmAnovaConfigDialog.tsx`
- Modify: `src/lib/modules/parametric/lmmAnovaModule.ts`

**Step 1: Write failing UI assertions if still missing**
- Verify the KR option is visible and selected value is forwarded.

**Step 2: Implement minimal UI contract**
- Add `kenward_roger` back to the df method type/option list.
- Do not add any R-specific wording.

**Step 3: Re-run focused frontend tests**
- Run: `npm run test:run -- src/components/dialogs/LmmAnovaConfigDialog.test.tsx src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts`
- Expected: pass.

### Task 5: Verify and document limits

**Files:**
- Modify: `python_embedded/statistics_module/lmm_anova.py`
- Modify: `docs/plans/2026-03-12-lmm-kr-phase1.md`

**Step 1: Add explicit limitations**
- Random-intercept only
- 1D simple/marginal contrasts only
- no runtime R
- no omnibus KR yet

**Step 2: Run verification**
- Run: `./python_embedded/python.exe -m pytest python_embedded/statistics_module/tests/test_lmm_anova_contract.py -q`
- Run: `npm run test:run -- src/components/dialogs/LmmAnovaConfigDialog.test.tsx src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts src/utils/__tests__/lmmAnovaTables.test.ts src/lib/analysis/__tests__/resultParser.lmmAnova.test.ts`
- Run: `npm run typecheck`
- Expected: all pass.

**Step 3: Stop before commits**
- User explicitly wants implementation first and did not request a commit in this phase.
