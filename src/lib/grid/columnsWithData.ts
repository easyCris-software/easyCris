/**
 * Shared utility for filtering columns to those with actual data.
 *
 * Used by AppShell (Advanced Filter) and SpreadsheetView (Sort, Outline) so
 * all three dialogs share one contract.
 *
 * ## Column presence contract
 * A column is considered "present" when `nonNullCount > 0` in the stats response.
 * A column whose ID is absent from the stats response entirely is treated as a
 * partial-coverage signal: if any column IDs are missing from stats, the function
 * falls back to the full list rather than silently hiding those columns.
 *
 * ## Guarantees
 * - Force-included IDs (active sort column, active group column) are always kept
 *   so currently-active state never disappears from the dialog.
 *   Note: force IDs not present in `columns` are ignored (cannot manufacture a
 *   ColumnMetadata entry for an ID that doesn't exist in the schema).
 * - Falls back to the full column list when:
 *     • stats are unavailable (network/backend error)
 *     • every column is empty (nonNullCount = 0 for all)
 *     • stats coverage is partial (some columns missing from response)
 *   so the dialog is never left with an unexpectedly short list due to stale data.
 */

import type { ColumnMetadata } from '@/store/data-store'
import cacheService from '@/services/cacheService'

/**
 * Controls how columns absent from the stats response are treated.
 *
 * - `'strict_fallback'` (default): any missing column → return full list.
 *   Safe for callers that need conservative behavior.
 * - `'missing_as_empty'`: columns absent from stats are treated as having
 *   nonNullCount=0 and are filtered out. Use for Sort/Outline/Advanced Filter
 *   dialogs where padded schema columns legitimately have no stats entries.
 */
export type ColumnStatsMissingPolicy = 'strict_fallback' | 'missing_as_empty'

/**
 * Returns the subset of `columns` that have at least one non-null value,
 * plus any IDs listed in `forceIncludeIds` regardless of data presence.
 *
 * Falls back to the full `columns` list when all columns are empty or the
 * stats call fails. Partial-coverage behavior is controlled by `missingCoveragePolicy`.
 *
 * @param datasetId              Dataset to fetch stats for.
 * @param columns                Full column list from the dataset.
 * @param forceIncludeIds        Column IDs that must always be included (e.g. the
 *                               currently active sort column or group-by column).
 *                               IDs not present in `columns` are silently ignored.
 * @param contextLabel           Label used in console messages for diagnostics.
 * @param missingCoveragePolicy  How to handle columns absent from stats response.
 */
export async function filterColumnsWithData(
  datasetId: string,
  columns: ColumnMetadata[],
  forceIncludeIds: string[] = [],
  contextLabel = 'dialog',
  missingCoveragePolicy: ColumnStatsMissingPolicy = 'strict_fallback'
): Promise<ColumnMetadata[]> {
  try {
    const stats = await cacheService.getAllColumnStats(datasetId)

    const statColumnIds = new Set(stats.map((s) => s.columnId))

    if (missingCoveragePolicy === 'strict_fallback') {
      // Partial-coverage guard: if any column ID is missing from the stats response
      // we cannot reliably determine its data presence — fall back to the full list.
      const hasPartialCoverage = columns.some((c) => !statColumnIds.has(c.id))
      if (hasPartialCoverage) {
        console.info(
          `[columnsWithData] ${contextLabel}: partial stats coverage detected, using full list.`
        )
        return columns
      }
    }
    // missing_as_empty: columns absent from stats are implicitly treated as
    // nonNullCount=0 — they simply won't appear in withDataIds below.

    const withDataIds = new Set(
      stats.filter((s) => s.nonNullCount > 0).map((s) => s.columnId)
    )
    // Always keep currently-active IDs so existing sort/group stays visible
    for (const id of forceIncludeIds) {
      if (id) withDataIds.add(id)
    }
    const filtered = columns.filter((c) => withDataIds.has(c.id))
    if (filtered.length === 0) {
      console.info(
        `[columnsWithData] ${contextLabel}: no non-empty columns detected, using full list.`
      )
      return columns
    }
    if (filtered.length < columns.length) {
      console.info(`[columnsWithData] ${contextLabel}: filtered by data presence.`, {
        before: columns.length,
        after: filtered.length,
      })
    }
    return filtered
  } catch (error) {
    console.warn(
      `[columnsWithData] ${contextLabel}: stats unavailable, using full list.`,
      error
    )
    return columns
  }
}
