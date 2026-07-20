/**
 * Formula Engine
 *
 * Excel-like formula support using fast-formula-parser.
 */

// Main service
export {
  FormulaService,
  createFormulaService,
  type FormulaEdit,
  type ColumnLookup,
} from './formulaService'

// Types
export {
  type CellPosition,
  type CellRef,
  type RangeRef,
  type FormulaResult,
  type FormulaError,
  type FormulaErrorType,
  type CellGetter,
  type RangeGetter,
  type CellKey,
  type StoredFormula,
  toCellKey,
  parseCellKey,
} from './formulaTypes'

// Utilities
export {
  columnIndexToLetter,
  columnLetterToIndex,
  positionToA1,
  a1ToPosition,
  cellRefToKey,
  keyToPosition,
  isFormula,
  stripFormulaPrefix,
  topologicalSort,
} from './formulaUtils'
