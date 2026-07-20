# Spreadsheet Grid Architecture

This is the durable reviewer note for `src/components/data`. Use it after `ARCHITECTURE.md` Domain 3 and before opening the full `SpreadsheetView.tsx` file.

Source snapshots:
- Graphify anchor: `SpreadsheetView.tsx` is a top graph node at `src/components/data/SpreadsheetView.tsx` with degree 240 and bridge degree 135.
- Understand Anything scoped scan: `src/components/data` on 2026-05-27 analyzed 14 files. `SpreadsheetView.tsx` was 14,427 lines with 29 top-level functions and 3,353 call expressions.

## Agent Workflow

For spreadsheet, grid, paste, formula editing, filtering, sorting, or row-model work:

1. Recall AgentMemory for recent fixes or failures.
2. Read `ARCHITECTURE.md` Domain 3.
3. Read this file.
4. Read `graphify-out/ANCHORS.md` for current anchors and staleness.
5. Use targeted `rg` and raw-file reads for exact symbols, tests, and Tauri invoke strings.

Do not treat `.understand-anything/` as live truth. It is generated and ignored. Regenerate a scoped UA snapshot only when the user asks for visual onboarding, domain flow, dashboard exploration, or diff-impact analysis.

## Core Files

| File | Role |
| --- | --- |
| `src/components/data/SpreadsheetView.tsx` | Main Glide Data Grid host. Owns dataset activation, visible row/column model, selection, paste/copy, context menus, formula bar state, sorting/filtering/grouping, undo/redo precedence, and the rendered `DataEditor`. |
| `src/components/data/FormulaCellEditor.tsx` | Formula-aware cell editor and autocomplete interaction surface. |
| `src/components/data/AutocompleteDropdown.tsx` | Formula/function autocomplete dropdown UI. |
| `src/components/data/ColumnFilterPopover.tsx` | Column filter UI surface and filter interaction. |
| `src/components/data/FilterColumnPickerPopover.tsx` | Column picker for filtering flows. |
| `src/components/data/formulaRangeService.ts` | Formula range parsing/formatting and token/range support. |
| `src/components/data/formulaEditStateMachine.ts` | Formula editing state transitions. |
| `src/components/data/formulaInteractionArbitration.ts` | Arbitration between formula editing, grid focus, and selection gestures. |
| `src/components/data/formulaOwnerManager.ts` | Formula ownership/session coordination. |
| `src/components/data/formulaSessionFocus.ts` | Formula session focus helpers. |
| `src/lib/grid/editExecutor.ts` | Unified edit pipeline for rowData, data store, backend sync, undo, invalidation, dirty state, and formula recalculation. |
| `src/lib/grid/pastePreflight.ts` | Paste bounds, overflow decisions, row/column expansion planning, and transformed-view guards. |
| `src/lib/grid/formulas/formulaService.ts` | Frontend formula parser, dependency graph, autocomplete catalog, recalculation, and backend delegation. |
| `src/services/cacheService.ts` | Frontend Tauri wrapper for cache reads/writes, grid mutation queues, overlay flush, sorting/grouping queries, and `evaluateFormulaBackend`. |

## Main Flow

`SpreadsheetView` renders Glide Data Grid's `DataEditor` and keeps frontend view state aligned with dataset/cache state. It reads current dataset metadata, columns, row order, filters, grouping, sort state, selection, formula editor state, and overlay/local-authority state, then produces a visible grid surface.

The backend path for formula evaluation is:

`SpreadsheetView` -> `FormulaService` -> `cacheService.evaluateFormulaBackend` -> Tauri `evaluate_formula_backend` -> `HybridCacheManager` -> Rust formula backend.

Frontend-only formulas stay inside `FormulaService`; large or unloaded ranges delegate through the backend path.

## Key Behaviors

### Dataset Activation

`SpreadsheetView` has stale-dataset guards around activation and paste paths. Any change touching dataset switching, remount boundaries, cache invalidation, or pending/current dataset state should be checked against activation and remount tests.

### Paste And Overflow

Paste is custom handled; `DataEditor` has `onPaste={false}`. Paste flow reads the clipboard, resolves the active paste context, runs preflight through `pastePreflight`, blocks unsafe overflow when sort/filter/group transforms are active, optionally expands columns/rows, then applies edits through the grid mutation pipeline.

Risk points:
- Header-selected or overflow paste while filters/sorts/groups are active.
- Formula paste while grouped.
- Column expansion rollback after partial failures.
- View-row to model-row conversion when a transformed row order is active.

### Edit Execution

`executeEdits` in `src/lib/grid/editExecutor.ts` is the preferred edit path. It coordinates local row data, data-store computed values, backend sync, undo stack updates, invalidated columns, green-dot change markers, dirty state, and formula recalculation. Avoid bypassing it unless a code path is intentionally read-only or purely visual.

### Formula Editing

Formula editing spans `SpreadsheetView.tsx`, `FormulaCellEditor.tsx`, `formulaService.ts`, and the local formula helper modules. Watch for displayed value versus raw formula string, dependency recalculation, backend-supported functions, and active range selection while the editor is open.

### Sorting, Filtering, And Grouping

Sort/filter/group state changes alter visible row order and can make model-row assumptions wrong. For changed code that touches selection, paste, fill, undo, row expansion, or formula references, verify both untransformed and transformed views.

### Undo And Redo

Undo precedence in `SpreadsheetView` is layered: filter/history undo first, highlight undo next, then dataset undo. Changes that introduce new mutable UI state should not silently bypass this order.

## Test Lanes

Use focused tests before broad suites:

```powershell
npm run -s test:run -- src/components/data/__tests__/SpreadsheetView.paste.dom.test.tsx
npm run -s test:run -- src/components/data/__tests__/SpreadsheetView.formulaFlow.dom.test.tsx
npm run -s test:run -- src/components/data/__tests__/SpreadsheetView.filter.dom.test.tsx
npm run -s test:run -- src/components/data/__tests__/SpreadsheetView.activation.dom.test.tsx
npm run -s test:run -- src/components/data/__tests__/SpreadsheetView.mutation-visibility.dom.test.tsx
npm run -s test:run -- src/lib/grid/__tests__/pastePreflight.test.ts
```

For cross-layer regressions, also inspect `src/components/data/__tests__/SpreadsheetView.transaction-refresh.dom.test.tsx`, `src/components/data/__tests__/SpreadsheetView.local-authority.dom.test.tsx`, and relevant `e2e/features/grid` scenarios.

## Reviewer Checklist

- Does the change preserve dataset activation and stale-context guards?
- Does it use `executeEdits` or a justified equivalent for user edits?
- Does it handle transformed row order under sort/filter/group?
- Does it keep formula raw values, computed display values, and backend recalculation consistent?
- Does paste behavior remain correct for row expansion, column expansion, blocked transforms, and rollback?
- Does undo/redo precedence still match existing behavior?
- Were Graphify anchors checked for changed entry points, and were raw-file checks used for exact call sites?
