/**
 * viewFilter.ts
 *
 * Pure helper: applies a FilterConfig to a sorted row-index array.
 *
 * Design invariants:
 *   - `baseSortedOrder` is never mutated. Filter derives a subset from it.
 *   - Buffer rows (indices >= dataRowCount) are always preserved, never filtered.
 *     Note: buffer rows are collected in encounter order but emitted at the tail,
 *     after all filtered data rows.
 *   - Missing rows (not in fullRowsByIndex) are kept — fail-safe, no data loss.
 *   - Sort order is preserved among data rows in filtered output.
 *   - Any error from DataTransformService.filter returns the full unfiltered order.
 */

import { DataTransformService } from '@/services/dataTransformService'
import type { FilterConfig } from '@/services/dataTransformService'

/**
 * Sentinel key injected into row records to recover original row index after
 * Arquero-based filtering. Uses a deliberately obscure name with zero-width
 * space characters to avoid collision with any user-defined column name.
 * A Symbol would be ideal, but Arquero's columnar representation drops Symbols.
 */
const VF_ROW_IDX_KEY = '\u200B__vf_row_idx__\u200B'

/**
 * Apply a view filter to a sorted row-index array.
 *
 * @param order           Sorted row indices (from baseSortedOrderRef)
 * @param filterConfig    The filter to apply, or null to return order unchanged
 * @param fullRowsByIndex Full column data for rows 0..dataRowCount-1 (from filterColumnsSnapshot)
 * @param dataRowCount    Number of real data rows; indices >= this are buffer rows
 * @returns Filtered subset of data rows (preserving sort order) followed by buffer rows
 */
export function applyViewFilter(
  order: number[],
  filterConfig: FilterConfig | null,
  fullRowsByIndex: Map<number, Record<string, unknown>>,
  dataRowCount: number
): number[] {
  // Pass-through: no filter
  if (!filterConfig) return order

  // Pass-through: all groups have no conditions
  if (filterConfig.groups.length === 0 || filterConfig.groups.every((g) => g.conditions.length === 0)) {
    return order
  }

  // Partition data rows and buffer rows
  const dataRows: number[] = []
  const bufferRows: number[] = []
  for (const idx of order) {
    if (idx < dataRowCount) {
      dataRows.push(idx)
    } else {
      bufferRows.push(idx)
    }
  }

  // Build records with embedded sentinel for post-filter index recovery.
  // Rows missing from fullRowsByIndex go into the fail-safe set (never dropped).
  const knownRecords: Array<Record<string, unknown>> = []
  const missingIndices = new Set<number>()

  for (const idx of dataRows) {
    const record = fullRowsByIndex.get(idx)
    if (record === undefined) {
      missingIndices.add(idx)
    } else {
      knownRecords.push({ ...record, [VF_ROW_IDX_KEY]: idx })
    }
  }

  // Run filter on known records — wrapped in try/catch so a malformed or stale
  // FilterConfig (e.g. referencing a deleted column) never crashes the pipeline.
  let passingIndices: Set<number>
  try {
    if (knownRecords.length === 0) {
      passingIndices = new Set()
    } else {
      const filtered = DataTransformService.filter(knownRecords as Record<string, any>[], filterConfig)
      passingIndices = new Set(filtered.map((r) => r[VF_ROW_IDX_KEY] as number))
    }
  } catch (err) {
    console.error('[applyViewFilter] DataTransformService.filter threw — returning unfiltered order:', err)
    return order
  }

  // Rebuild filtered data order preserving input sort order
  const filteredDataOrder = dataRows.filter(
    (idx) => passingIndices.has(idx) || missingIndices.has(idx)
  )

  // Buffer rows always appended at the end (after data rows)
  return [...filteredDataOrder, ...bufferRows]
}
