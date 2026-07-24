/**
 * Shared RNA-seq sample-match utilities
 *
 * Pure helpers and cache-backed async helpers used by both the import dialog
 * and the Configure preflight in RNAseqWorkspace.
 *
 * Keeping these in one place ensures the two call sites use identical
 * filtering, normalization, and validation semantics.
 */

import type { Dataset } from '@/store/data-store'
import type { SampleMatchResult } from '@/types/rnaseq'
import cacheService from '@/services/cacheService'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DatasetLike = Pick<Dataset, 'id' | 'columns' | 'rowCount' | 'dataRowCount'>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAMPLE_MATCH_SAMPLE_SIZE = 200

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isPlaceholderColumnName(name: string): boolean {
  return /^Column\s+\d+$/.test(name.trim())
}

export function normalizeSampleId(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

export function isNonEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

export function hasNonZeroNumericValue(values: unknown[]): boolean {
  return values.some((value) => {
    const num =
      typeof value === 'number'
        ? value
        : Number.parseFloat(typeof value === 'string' ? value.trim() : String(value ?? ''))
    return Number.isFinite(num) && num !== 0
  })
}

export function columnHasData(column: { name: string }, values: unknown[]): boolean {
  const hasAnyValue = values.some(isNonEmptyValue)
  if (!hasAnyValue) return false
  if (!isPlaceholderColumnName(column.name)) return true
  return hasNonZeroNumericValue(values)
}

export function getCountSampleIdsFromSampleColumns(sampleColumns: Array<{ name: string }>): string[] {
  return sampleColumns
    .filter((c) => !isPlaceholderColumnName(c.name))
    .map((c) => normalizeSampleId(c.name))
    .filter((v) => v.length > 0)
}

/**
 * Returns true when a linked dataset has real imported data (usableRows > 0),
 * meaning cross-dataset sample-match validation is meaningful.
 *
 * A blank scaffold (dataRowCount=0) has no samples to compare — running
 * validation against it always produces a spurious mismatch warning.
 * Legacy datasets without dataRowCount fall back to rowCount.
 * This is the single gate used by both import-time and configure-time checks.
 */
export function hasMatchableSamples(dataset: DatasetLike | null | undefined): boolean {
  if (!dataset) return false
  const usableRows = dataset.dataRowCount ?? dataset.rowCount ?? 0
  return usableRows > 0
}

/**
 * Prompts the user to confirm a sample mismatch via window.confirm.
 *
 * @param sampleMatch  The mismatch result containing the message to show.
 * @param action       Label for the continuation action shown in the prompt
 *                     (e.g. 'import' or 'configure').  Defaults to 'import'.
 * @returns            true if the user confirms, false if they cancel.
 */
export function confirmSampleMismatch(sampleMatch: SampleMatchResult, action = 'import'): boolean {
  const prompt = `${sampleMatch.message}\n\nContinue to ${action} anyway?`
  return window.confirm(prompt)
}

// ---------------------------------------------------------------------------
// Cache-backed async helpers
// ---------------------------------------------------------------------------

export async function getColumnsSampledDataSafe(
  dataset: DatasetLike,
  columns: Array<{ id: string; name: string }>,
  sampleSize: number
): Promise<Record<string, unknown[]>> {
  const requestedIds = columns.map((col) => col.id)
  if (requestedIds.length === 0) return {}

  try {
    return await cacheService.getColumnsSampledData(dataset.id, requestedIds, sampleSize)
  } catch (error) {
    // Dataset metadata can include padded grid columns that don't exist in DuckDB yet.
    // Retry with the intersection of requested IDs and backend-available columns.
    console.warn('Sampled data request included unavailable columns; retrying with available columns.', error)
    try {
      const stats = await cacheService.getAllColumnStats(dataset.id)
      const available = new Set(stats.map((stat) => stat.columnId))
      const retryIds = requestedIds.filter((id) => available.has(id))
      if (retryIds.length === 0) {
        return {}
      }

      const sampled = await cacheService.getColumnsSampledData(dataset.id, retryIds, sampleSize)
      for (const id of requestedIds) {
        if (!(id in sampled)) {
          sampled[id] = []
        }
      }
      return sampled
    } catch (retryError) {
      console.warn('Failed sampled data retry with available-column intersection.', retryError)
      throw error
    }
  }
}

export async function getCountSampleIdsWithData(dataset: DatasetLike): Promise<string[]> {
  const sampleCols = dataset.columns.slice(1).filter((col) => !isPlaceholderColumnName(col.name))
  if (sampleCols.length === 0) return []
  try {
    const data = await getColumnsSampledDataSafe(dataset, sampleCols, SAMPLE_MATCH_SAMPLE_SIZE)
    return sampleCols
      .filter((col) => {
        const values = data[col.id] ?? []
        return columnHasData(col, values)
      })
      .map((col) => normalizeSampleId(col.name))
      .filter((v) => v.length > 0)
  } catch (error) {
    console.warn('Failed to load sampled count column data; falling back to column headers.', error)
    return getCountSampleIdsFromSampleColumns(sampleCols)
  }
}
