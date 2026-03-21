# Linear Mixed Model UI Wiring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire `lmm_anova` into the test registry, module registry, controller/dialog flow, and payload mapping so users can configure and run the backend from the UI.

**Architecture:** Add a dedicated parametric LMM module plus one dedicated configuration dialog, then reuse the existing multi-factorial simple-effects dialog only after the model structure is chosen. Keep the frontend payload strictly aligned to the current Python backend contract: `data.subject` is the real grouping series, predictor typing is explicit, and random-effects options are limited to the two supported structures.

**Tech Stack:** React, TypeScript, Zustand, Vitest, existing modular statistical test framework.

---

### Task 1: Register `lmm_anova`

**Files:**
- Modify: `src/config/testRegistry.ts`
- Modify: `src/lib/modules/core/ModuleRegistry.ts`
- Test: `src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts`

**Step 1: Write the failing test**
- Assert `getTestDefinition('lmm_anova')` exists, has `family: 'parametric'`, `moduleId: 'lmm_anova'`, and appears in `hypothesis_testing`.

**Step 2: Run test to verify it fails**
- Run: `npm run test:run -- src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts`

**Step 3: Write minimal implementation**
- Add `lmm_anova` registry entry with flexible candidate-field selection.
- Register `lmm_anova` in `ModuleRegistry.ts`.

**Step 4: Run test to verify it passes**
- Run the same Vitest command.

### Task 2: Add the dedicated LMM module

**Files:**
- Create: `src/lib/modules/parametric/lmmAnovaModule.ts`
- Test: `src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts`

**Step 1: Write the failing test**
- Cover `validateSelection()` for:
  - fails with fewer than 3 columns
  - passes with mixed candidate columns
  - warns when no clear numeric DV exists
- Cover `buildPayload()` for:
  - `data.dependent`
  - `data.subject`
  - `data.predictors`
  - `data.predictor_types`
  - `parameters.reml`
  - `parameters.random_effects_config`

**Step 2: Run test to verify it fails**
- Run: `npm run test:run -- src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts`

**Step 3: Write minimal implementation**
- Implement module contract matching Python payload keys exactly.

**Step 4: Run test to verify it passes**
- Run the same Vitest command.

### Task 3: Add dedicated LMM dialog state and controller orchestration

**Files:**
- Modify: `src/lib/analysis/StatisticalAnalysisController.ts`
- Modify: `src/hooks/useStatisticalAnalysisController.ts`
- Test: `src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts`

**Step 1: Write the failing test**
- Add a controller test that:
  - recognizes `lmm_anova`
  - opens the LMM configuration flow
  - injects `reml`, `random_effects_config`, and `simple_effects` into payload parameters

**Step 2: Run test to verify it fails**
- Run: `npm run test:run -- src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts`

**Step 3: Write minimal implementation**
- Add LMM context/result types, dialog service methods, `hasLmmAnova()`, `orchestrateLmmAnova()`, and payload injection in `executeTest()`.

**Step 4: Run test to verify it passes**
- Run the same Vitest command.

### Task 4: Add the dedicated LMM configuration dialog

**Files:**
- Create: `src/components/dialogs/LmmAnovaConfigDialog.tsx`
- Modify: `src/components/layout/AppShell.tsx`
- Modify: `src/hooks/useStatisticalAnalysisController.ts`
- Test: `src/components/dialogs/LmmAnovaConfigDialog.test.tsx`

**Step 1: Write the failing test**
- Verify the dialog:
  - renders `data-testid` hooks
  - enforces one subject column
  - lets users set predictor types
  - disables slope selection until a continuous predictor is available
  - returns structured config on confirm

**Step 2: Run test to verify it fails**
- Run: `npm run test:run -- src/components/dialogs/LmmAnovaConfigDialog.test.tsx`

**Step 3: Write minimal implementation**
- Build the dialog and mount it in `AppShell.tsx`.

**Step 4: Run test to verify it passes**
- Run the same Vitest command.

### Task 5: Reuse simple-effects flow after LMM configuration

**Files:**
- Modify: `src/lib/analysis/StatisticalAnalysisController.ts`
- Possibly modify: `src/components/dialogs/MultiFactorialSimpleEffectsDialog.tsx`
- Test: `src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts`

**Step 1: Write the failing test**
- Assert simple-effects dialog only appears when 2+ selected predictors are typed categorical.

**Step 2: Run test to verify it fails**
- Run: `npm run test:run -- src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts`

**Step 3: Write minimal implementation**
- Filter selected categorical predictors and reuse the existing simple-effects dialog behavior.

**Step 4: Run test to verify it passes**
- Run the same Vitest command.

### Task 6: Verify and typecheck

**Files:**
- No code changes expected

**Step 1: Run focused tests**
- `npm run test:run -- src/lib/modules/parametric/__tests__/lmmAnovaModule.test.ts`
- `npm run test:run -- src/components/dialogs/LmmAnovaConfigDialog.test.tsx`
- `npm run test:run -- src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts`

**Step 2: Run neighboring regression/ANOVA tests if impacted**
- `npm run test:run -- src/lib/modules/regression/__tests__/regressionModule.test.ts`

**Step 3: Run typecheck**
- `npm run typecheck`

**Step 4: Commit**
- Commit after all tests and typecheck pass.
