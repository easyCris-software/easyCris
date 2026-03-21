# LMM Simple Effects Dialog Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the shared simple-effects follow-up UI into distinct LMM and multifactorial user-facing dialogs while keeping the same selection behavior.

**Architecture:** Extract the current shared dialog content into an internal base component, then wrap it with thin LMM and multifactorial dialog shells. Keep the controller and payload contract unchanged so only the rendered dialog semantics change.

**Tech Stack:** React, TypeScript, Vitest, Testing Library

---

### Task 1: Add failing dialog tests

**Files:**
- Modify: `src/components/dialogs/LmmAnovaConfigDialog.test.tsx`
- Modify: `src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts`

**Step 1: Write the failing tests**

- Add a test that exercises the LMM follow-up path and expects LMM-specific dialog title/copy.
- Add or update a test that keeps multifactorial ANOVA title/copy unchanged.

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts`

Expected: fail because the LMM path still renders the ANOVA dialog wording.

### Task 2: Extract shared dialog body

**Files:**
- Create: `src/components/dialogs/SimpleEffectsSelectionDialogBase.tsx`
- Modify: `src/components/dialogs/MultiFactorialSimpleEffectsDialog.tsx`

**Step 1: Move shared selection UI into the base component**

Keep:
- factor pair generation
- enabled pair state
- optional adjustment controls
- confirm/cancel behavior

**Step 2: Run targeted tests**

Run: `npm run test:run -- src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts`

Expected: still failing only on LMM-specific wording.

### Task 3: Add LMM wrapper and wire AppShell

**Files:**
- Create: `src/components/dialogs/LmmSimpleEffectsDialog.tsx`
- Modify: `src/components/layout/AppShell.tsx`

**Step 1: Add the LMM-specific wrapper**

Provide:
- LMM title
- LMM description
- LMM explanatory copy

**Step 2: Switch AppShell**

Render:
- `LmmSimpleEffectsDialog` when `testIdPrefix === 'lmm'`
- `MultiFactorialSimpleEffectsDialog` otherwise

**Step 3: Run targeted tests**

Run: `npm run test:run -- src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts`

Expected: pass

### Task 4: Verify and clean up

**Files:**
- Modify as needed from previous tasks

**Step 1: Run affected test suites**

Run: `npm run test:run -- src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts src/components/dialogs/LmmAnovaConfigDialog.test.tsx`

**Step 2: Run typecheck**

Run: `npm run typecheck`

**Step 3: Commit**

```bash
git add src/components/dialogs/SimpleEffectsSelectionDialogBase.tsx src/components/dialogs/LmmSimpleEffectsDialog.tsx src/components/dialogs/MultiFactorialSimpleEffectsDialog.tsx src/components/layout/AppShell.tsx src/lib/analysis/__tests__/StatisticalAnalysisController.test.ts docs/plans/2026-03-12-lmm-simple-effects-dialog-design.md docs/plans/2026-03-12-lmm-simple-effects-dialog-split.md
git commit -m "feat: split lmm and multifactorial simple-effects dialogs"
```
