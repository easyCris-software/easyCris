/**
 * Find & Replace functionality for the spreadsheet grid.
 *
 * Key design principles:
 * - Operates in model space (modelRow + columnId)
 * - Uses backend cache for complete data access (works with streaming)
 * - Values mode finds ALL cells including formula outputs
 * - Formula cells can be found but replacement is blocked with messaging
 * - All replacements go through EditExecutor for undo/redo
 */

import cacheService from '@/services/cacheService'
import type { ColumnMetadata } from '@/store/data-store'
import { parseCellKey } from '@/lib/grid/formulas'
import type { FormulaService } from '@/lib/grid/formulas/formulaService'
import type { EditExecutor } from '@/lib/grid/editExecutor'
import type { CellEdit } from '@/lib/grid/types'

// =============================================================================
// Types
// =============================================================================

export interface FindReplaceOptions {
  searchText: string
  replaceText: string
  caseSensitive: boolean
  wholeWord: boolean
  searchScope: 'all' | 'selected'
  searchIn: 'values' | 'formulas'
  selectedColumnIds?: string[]
}

export interface SearchMatch {
  modelRow: number
  columnId: string
  value: string
  isFormula: boolean
  formulaString?: string
}

export interface SearchResult {
  matches: SearchMatch[]
  columnsData: Record<string, unknown[]>
}

export interface ReplaceOneResult {
  success: boolean
  skippedFormula: boolean
}

export interface ReplaceAllGuardrail {
  replaceableCount: number
  formulaSkipCount: number
  requiresConfirmation: boolean
  message?: string
}

export interface ReplaceAllResult {
  replacedCount: number
  skippedFormulaCount: number
}

// =============================================================================
// Constants
// =============================================================================

const LARGE_DATASET_THRESHOLD = 200_000
const LARGE_REPLACE_THRESHOLD = 1_000

// Structural characters that could break formulas if removed
const FORMULA_STRUCTURAL_CHARS = /^[=+\-*/()^%&|<>]$/

// =============================================================================
// Search Functions
// =============================================================================

/**
 * Search the dataset for matches.
 * Uses backend cache for complete data access (works with streaming).
 */
export async function searchDataset(
  datasetId: string,
  columns: ColumnMetadata[],
  dataRowCount: number,
  formulaService: FormulaService | null,
  options: FindReplaceOptions
): Promise<SearchResult> {
  const matches: SearchMatch[] = []

  if (!options.searchText) {
    return { matches, columnsData: {} }
  }

  // Determine columns to search
  const columnIds =
    options.searchScope === 'selected' && options.selectedColumnIds?.length
      ? options.selectedColumnIds
      : columns.filter((c) => !c.name.match(/^Column \d+$/)).map((c) => c.id)

  if (columnIds.length === 0) {
    return { matches, columnsData: {} }
  }

  const columnIdSet = new Set(columnIds)

  if (options.searchIn === 'formulas') {
    if (!formulaService) {
      return { matches, columnsData: {} }
    }

    const allFormulas = formulaService.getAllFormulaCells()
    for (const [cellKey, formula] of allFormulas.entries()) {
      const parts = parseCellKey(cellKey)
      if (!parts) continue
      if (parts.row >= dataRowCount) continue
      if (!columnIdSet.has(parts.columnId)) continue

      if (matchesSearch(formula, options)) {
        matches.push({
          modelRow: parts.row,
          columnId: parts.columnId,
          value: formula,
          isFormula: true,
          formulaString: formula,
        })
      }
    }

    return { matches, columnsData: {} }
  }

  const isLargeDataset = await cacheService.isLargeDataset(datasetId)
  if (isLargeDataset) {
    const backendMatches = await cacheService.searchColumnsValues(
      datasetId,
      columnIds,
      options.searchText,
      options.caseSensitive,
      options.wholeWord
    )

    for (const match of backendMatches) {
      const cellKey = `${match.modelRow}:${match.columnId}`
      const formula = formulaService?.getFormula(cellKey)
      const isFormula = formula !== undefined

      matches.push({
        modelRow: match.modelRow,
        columnId: match.columnId,
        value: match.value,
        isFormula,
        formulaString: isFormula ? formula : undefined,
      })
    }

    return { matches, columnsData: {} }
  }

  // Fetch column data from backend cache
  const columnsData = await cacheService.getColumnsData(datasetId, columnIds)

  // Use dataRowCount as upper bound (not rowCount which includes padding)
  const maxRows = dataRowCount

  for (const columnId of columnIds) {
    const colValues = columnsData[columnId] ?? []

    for (let modelRow = 0; modelRow < maxRows; modelRow++) {
      const cellKey = `${modelRow}:${columnId}`
      const formula = formulaService?.getFormula(cellKey)
      const isFormula = formula !== undefined

      const searchTarget = String(colValues[modelRow] ?? '')

      if (searchTarget && matchesSearch(searchTarget, options)) {
        matches.push({
          modelRow,
          columnId,
          value: searchTarget,
          isFormula,
          formulaString: isFormula ? formula : undefined,
        })
      }
    }
  }

  return { matches, columnsData }
}

/**
 * Check if a value matches the search criteria.
 */
function matchesSearch(value: string, options: FindReplaceOptions): boolean {
  const { searchText, caseSensitive, wholeWord } = options

  if (!searchText) return false

  const haystack = caseSensitive ? value : value.toLowerCase()
  const needle = caseSensitive ? searchText : searchText.toLowerCase()

  if (wholeWord) {
    const regex = new RegExp(`\\b${escapeRegex(needle)}\\b`, caseSensitive ? '' : 'i')
    return regex.test(value)
  }

  return haystack.includes(needle)
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// =============================================================================
// Replace Functions
// =============================================================================

/**
 * Build a cell edit for a replacement.
 */
export function buildReplacementEdit(
  match: SearchMatch,
  options: FindReplaceOptions,
  columnsData: Record<string, unknown[]>,
  columnType?: string
): CellEdit {
  const { modelRow, columnId, isFormula, formulaString } = match

  let oldValue: unknown
  let newValue: unknown

  if (isFormula) {
    // Replace within formula string - keep as string, NO parseReplacementValue
    // This ensures formulas stay as formulas (e.g., "=A1*2" doesn't become a number)
    oldValue = formulaString
    newValue = applyReplace(formulaString!, options) // String in, string out
  } else {
    // Replace in plain value
    const rawValue = columnsData[columnId]?.[modelRow]
    const resolvedValue = rawValue !== undefined ? rawValue : match.value
    oldValue = resolvedValue

    const rawString = String(resolvedValue ?? '')
    const replacedString = applyReplace(rawString, options)

    // Parse using same rules as commitFormulaBarEdit (only for non-formula cells)
    newValue = parseReplacementValue(replacedString, resolvedValue, columnType)
  }

  return {
    row: modelRow,
    columnId,
    oldValue,
    newValue,
  }
}

/**
 * Apply search/replace to a string value.
 */
function applyReplace(value: string, options: FindReplaceOptions): string {
  const { searchText, replaceText, caseSensitive, wholeWord } = options
  const flags = caseSensitive ? 'g' : 'gi'
  const pattern = wholeWord
    ? new RegExp(`\\b${escapeRegex(searchText)}\\b`, flags)
    : new RegExp(escapeRegex(searchText), flags)

  return value.replace(pattern, replaceText)
}

/**
 * Parse replacement value to maintain type consistency.
 * Uses same rules as commitFormulaBarEdit for numeric columns.
 */
function parseReplacementValue(str: string, originalValue: unknown, columnType?: string): unknown {
  const trimmed = str.trim()

  if (trimmed === '') return ''

  // Try numeric parse for numeric columns or if original was number
  // NOTE: ColumnMetadata['type'] uses 'numeric', not 'number'.
  // Uses Number(...) to match commitFormulaBarEdit semantics (supports "1e3", etc.).
  if (columnType === 'numeric' || typeof originalValue === 'number') {
    const num = Number(trimmed)
    if (Number.isFinite(num)) return num
  }

  return trimmed
}

/**
 * Replace a single match.
 */
export async function replaceOne(
  match: SearchMatch,
  options: FindReplaceOptions,
  columnsData: Record<string, unknown[]>,
  editExecutor: EditExecutor,
  columnType?: string
): Promise<ReplaceOneResult> {
  // Block replacement for formula cells in Values mode
  if (match.isFormula && options.searchIn === 'values') {
    return { success: false, skippedFormula: true }
  }

  const edit = buildReplacementEdit(match, options, columnsData, columnType)
  await editExecutor.execute([edit], 'replace')
  return { success: true, skippedFormula: false }
}

// =============================================================================
// Guardrails
// =============================================================================

/**
 * Check guardrails before Replace All.
 */
export function checkReplaceAllGuardrails(
  matches: SearchMatch[],
  dataRowCount: number,
  options: FindReplaceOptions
): ReplaceAllGuardrail {
  const { searchIn, searchText, replaceText } = options

  // Count formula cells that will be skipped (only in values mode)
  const formulaSkipCount = searchIn === 'values' ? matches.filter((m) => m.isFormula).length : 0
  const replaceableCount = matches.length - formulaSkipCount

  // Formula safety guard: warn if removing structural characters from formulas
  if (searchIn === 'formulas' && replaceText === '' && FORMULA_STRUCTURAL_CHARS.test(searchText)) {
    return {
      replaceableCount,
      formulaSkipCount,
      requiresConfirmation: true,
      message: `This will remove "${searchText}" from ${replaceableCount} formula${replaceableCount !== 1 ? 's' : ''}, which may break them. Continue?`,
    }
  }

  // Large dataset warning
  if (dataRowCount > LARGE_DATASET_THRESHOLD) {
    return {
      replaceableCount,
      formulaSkipCount,
      requiresConfirmation: true,
      message: `This dataset has ${dataRowCount.toLocaleString()} rows. Replace All may take a moment. Continue?`,
    }
  }

  // Large number of replacements warning
  if (replaceableCount > LARGE_REPLACE_THRESHOLD) {
    return {
      replaceableCount,
      formulaSkipCount,
      requiresConfirmation: true,
      message: `This will replace ${replaceableCount.toLocaleString()} occurrences. Continue?`,
    }
  }

  return { replaceableCount, formulaSkipCount, requiresConfirmation: false }
}

/**
 * Replace all matches.
 */
export async function replaceAll(
  matches: SearchMatch[],
  options: FindReplaceOptions,
  columnsData: Record<string, unknown[]>,
  editExecutor: EditExecutor,
  columns: ColumnMetadata[]
): Promise<ReplaceAllResult> {
  // Filter out formula cells in Values mode (they can be found but not replaced)
  const replaceableMatches =
    options.searchIn === 'values' ? matches.filter((m) => !m.isFormula) : matches
  const skippedFormulaCount = matches.length - replaceableMatches.length

  if (replaceableMatches.length === 0) {
    return { replacedCount: 0, skippedFormulaCount }
  }

  // Build column type lookup
  const columnTypeMap = new Map(columns.map((c) => [c.id, c.type]))

  const edits = replaceableMatches.map((match) =>
    buildReplacementEdit(match, options, columnsData, columnTypeMap.get(match.columnId))
  )

  await editExecutor.execute(edits, 'replace-all')
  return { replacedCount: edits.length, skippedFormulaCount }
}
