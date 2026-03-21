/**
 * Formula Types
 *
 * Type definitions for the formula engine.
 * Supports Excel-like formulas with dependency tracking.
 */

/**
 * Cell position in A1 notation context
 */
export interface CellPosition {
  row: number // 1-based row index (Excel style)
  col: number // 1-based column index (Excel style) - NOTE: FormulaService uses 1-based for parser compatibility
  sheet: string // Sheet name (default: 'Sheet1')
}

/**
 * Cell reference from dependency parsing
 */
export interface CellRef {
  row: number
  col: number
  sheet?: string
}

/**
 * Range reference from dependency parsing
 */
export interface RangeRef {
  from: CellRef
  to: CellRef
  sheet?: string
}

/**
 * Formula evaluation result
 */
export interface FormulaResult {
  value: unknown
  error?: FormulaError
}

/**
 * Formula error types (matches Excel)
 */
export type FormulaErrorType =
  | '#NULL!'
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#NUM!'
  | '#N/A'
  | '#ERROR!'
  | '#CIRCULAR!'

/**
 * Formula error with type and message
 */
export interface FormulaError {
  type: FormulaErrorType
  message: string
}

/**
 * Stored formula data
 */
export interface StoredFormula {
  formula: string // Raw formula string (e.g., "=SUM(A1:A5)")
  position: CellPosition // Cell position where formula is stored
  dependencies: string[] // Cell keys this formula depends on
  lastValue: unknown // Last computed value
  lastError?: FormulaError // Last error (if any)
}

/**
 * Cell getter callback for formula parser
 * Returns the value at the specified cell position
 */
export type CellGetter = (row: number, col: number, sheet?: string) => unknown

/**
 * Range getter callback for formula parser
 * Returns a 2D array of values for the specified range
 */
export type RangeGetter = (ref: RangeRef) => unknown[][]

/**
 * Cell key format: "row:columnId" (e.g., "0:col-a", "5:col-price")
 */
export type CellKey = string

/**
 * Convert row/columnId to cell key
 */
export function toCellKey(row: number, columnId: string): CellKey {
  return `${row}:${columnId}`
}

/**
 * Parse cell key to row/columnId
 */
export function parseCellKey(key: CellKey): { row: number; columnId: string } | null {
  const parts = key.split(':')
  if (parts.length !== 2) return null

  const row = parseInt(parts[0]!, 10)
  if (isNaN(row)) return null

  return { row, columnId: parts[1]! }
}
