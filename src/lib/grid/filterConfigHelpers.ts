/**
 * filterConfigHelpers
 *
 * Pure helpers for per-column FilterConfig management.
 * Used by the ColumnFilterPopover integration in SpreadsheetView.
 */

import type { FilterConfig, FilterCondition } from '@/services/dataTransformService'

/**
 * Sentinel string used to represent blank (null / empty-string) cells in the
 * per-column value checklist.  It must not be a value that can appear in real
 * data; the leading NUL byte makes collisions effectively impossible.
 *
 * When building `ne` filter conditions the sentinel is mapped back to `''`
 * (empty string), which the `ne` evaluator in dataTransformService already
 * handles correctly via its blank-comparison logic.
 */
export const VIEW_FILTER_BLANK_TOKEN = '\u0000__blank__'

/**
 * Derive the sorted, deduplicated list of unique string values shown in the
 * per-column filter checklist.
 *
 * - `null` and empty-string cells are collapsed into a single
 *   `VIEW_FILTER_BLANK_TOKEN` entry appended after all normal values.
 * - Other values are stringified, deduplicated, and sorted alphabetically.
 */
export function deriveUniqueFilterValues(raw: unknown[]): string[] {
  const hasBlank = raw.some((v) => v == null || v === '')
  const normal = Array.from(
    new Set(
      raw
        .filter((v) => v != null && v !== '')
        .map((v) => String(v))
    )
  ).sort()
  return hasBlank ? [...normal, VIEW_FILTER_BLANK_TOKEN] : normal
}

/**
 * Merge new conditions for a single column into an existing FilterConfig.
 *
 * - Removes all existing conditions for `columnId` from every group.
 * - Drops groups that become empty.
 * - If `conditions` is non-null and non-empty, appends a new AND group.
 * - Returns `null` when the result would be an empty config.
 *
 * This preserves conditions for all other columns and the `groupOperator`.
 */
export function mergeColumnConditions(
  prev: FilterConfig | null,
  columnId: string,
  conditions: FilterCondition[] | null
): FilterConfig | null {
  // Strip this column's conditions from every existing group, drop empty groups
  const retainedGroups = (prev?.groups ?? [])
    .map((group) => ({
      ...group,
      conditions: group.conditions.filter((c) => c.columnId !== columnId),
    }))
    .filter((group) => group.conditions.length > 0)

  // Append a fresh group for the new conditions
  if (conditions && conditions.length > 0) {
    retainedGroups.push({ op: 'AND', conditions })
  }

  if (retainedGroups.length === 0) return null

  return {
    groups: retainedGroups,
    groupOperator: prev?.groupOperator ?? 'AND',
  }
}

/**
 * Build a new FilterConfig containing only conditions for a single `columnId`.
 * Used when escalating from the column quick-filter popover to the Advanced Filter
 * dialog so the dialog opens pre-scoped to that column's conditions only.
 *
 * Returns `null` when:
 *   - `config` is null, or
 *   - no conditions reference `columnId`
 *
 * Preserves `groupOperator` from the original config.
 */
export function buildScopedFilterConfig(
  config: FilterConfig | null,
  columnId: string
): FilterConfig | null {
  if (!config) return null
  const scopedGroups = config.groups
    .map((group) => ({
      ...group,
      conditions: group.conditions.filter((c) => c.columnId === columnId),
    }))
    .filter((group) => group.conditions.length > 0)
  if (scopedGroups.length === 0) return null
  return {
    groups: scopedGroups,
    groupOperator: config.groupOperator ?? 'AND',
  }
}

/**
 * Extract all conditions that reference `columnId` from a FilterConfig.
 * Returns `null` when there are none (column has no active filter).
 */
export function extractColumnConditions(
  config: FilterConfig | null,
  columnId: string
): FilterCondition[] | null {
  if (!config) return null
  const found = config.groups.flatMap((g) => g.conditions).filter((c) => c.columnId === columnId)
  return found.length > 0 ? found : null
}
