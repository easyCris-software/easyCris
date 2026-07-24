# Arquero Integration Notes

## What Is Wired
- Service: `src/services/dataTransformService.ts`
- Dialogs: `src/components/dialogs/PivotWiderDialog.tsx`, `src/components/dialogs/PivotLongerDialog.tsx`, `src/components/dialogs/AdvancedFilterDialog.tsx`
- AppShell: handlers wired + Data menu actions in `src/components/layout/AppShell.tsx`

## Transform Flow
1. Resolve active family + dataset.
2. Gate large datasets (storageInfo.isLarge or >= 250,000 rows).
3. `cacheService.ensureLatestCache(...)`
4. Fetch columns with `getColumnsData` (or `getColumnsSampledData` for preview).
5. Convert columns to row objects.
6. Apply Arquero transform.
7. Normalize rows + column metadata (new IDs for new columns).
8. Create derived family + dataset, set rowCount with buffer.
9. `cacheService.setDataset(...)` to persist rows.

## Derived Dataset Policy
- Non-destructive: new family name suffixes `_pivoted`, `_gathered`, `_filtered`.
- The blank dataset created by `createFamily` is removed and replaced.

## Notes
- Multi-value pivot columns are prefixed by value column label to avoid name collisions.
- Row buffer uses AppShell constants (MIN_ROWS=100, ROW_BUFFER=50).
- Preview sample size: 100 rows.
