/**
 * filterColumnsSnapshot.ts
 *
 * Loads full column vectors for all columns referenced in a FilterConfig
 * and builds a Map<rowIndex, Record<columnId, value>> for use by applyViewFilter.
 *
 * This avoids the sparse-viewport-cache false-negative problem: by fetching
 * full column data, every row is represented regardless of scroll position.
 */

import { cacheService } from '@/services/cacheService'
import type { FilterConfig } from '@/services/dataTransformService'

/**
 * Thrown when the cache fetch for filter column data fails.
 * Callers should catch this, preserve the prior filter state, and toast once.
 */
export class ViewFilterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ViewFilterError'
  }
}

/**
 * Extracts the unique set of non-empty column IDs referenced in a FilterConfig.
 */
function resolveFilterColumnIds(filterConfig: FilterConfig): string[] {
  const ids = new Set<string>()
  for (const group of filterConfig.groups) {
    for (const cond of group.conditions) {
      if (cond.columnId && cond.columnId.trim() !== '') {
        ids.add(cond.columnId)
      }
    }
  }
  return Array.from(ids)
}

/**
 * Returns true if filterConfig has no meaningful conditions to evaluate.
 */
function isEmptyFilter(filterConfig: FilterConfig | null): boolean {
  if (!filterConfig) return true
  if (filterConfig.groups.length === 0) return true
  return filterConfig.groups.every((g) => g.conditions.length === 0)
}

/**
 * Load full column vectors for each column referenced in `filterConfig`,
 * then assemble a per-row record map spanning rows 0..dataRowCount-1.
 *
 * Returns an empty map (without fetching) when filterConfig is null or has
 * no conditions.
 *
 * Throws `ViewFilterError` (with dataset id + column ids in the message) when
 * the cache fetch fails — the caller should preserve the prior filter state
 * and surface a toast to the user.
 *
 * @param datasetId    Active dataset ID
 * @param dataRowCount Number of real data rows (buffer rows excluded)
 * @param filterConfig The filter whose column refs must be loaded
 */
export async function buildFullRowsByIndex(
  datasetId: string,
  dataRowCount: number,
  filterConfig: FilterConfig | null
): Promise<Map<number, Record<string, unknown>>> {
  if (isEmptyFilter(filterConfig)) {
    return new Map()
  }

  const columnIds = resolveFilterColumnIds(filterConfig!)

  if (columnIds.length === 0) {
    return new Map()
  }

  await cacheService.ensureLatestCache(datasetId)

  let columnsData: Record<string, unknown[]>
  try {
    columnsData = await cacheService.getColumnsData(datasetId, columnIds)
  } catch (cause) {
    throw new ViewFilterError(
      `Failed to fetch filter columns [${columnIds.join(', ')}] for dataset "${datasetId}"`,
      { cause }
    )
  }

  const map = new Map<number, Record<string, unknown>>()
  for (let rowIdx = 0; rowIdx < dataRowCount; rowIdx++) {
    const record: Record<string, unknown> = {}
    for (const colId of columnIds) {
      const vector = columnsData[colId]
      record[colId] = vector ? vector[rowIdx] : undefined
    }
    map.set(rowIdx, record)
  }

  return map
}
