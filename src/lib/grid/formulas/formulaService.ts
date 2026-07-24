/**
 * Formula Service
 *
 * Excel-like formula evaluation using fast-formula-parser.
 * Manages dependency graph and recalculation order.
 *
 * Key responsibilities:
 * - Parse and evaluate formulas (=SUM, =AVERAGE, etc.)
 * - Track dependencies (which cells depend on which)
 * - Recalculate dependents when source cells change
 * - Detect circular references
 * - Provide autocomplete suggestions for function names
 *
 * NOTE: dataCache stores COMPUTED values, not formula strings.
 * Formula strings are stored separately in formulaStorage.
 */

import FormulaParser, { DepParser } from 'fast-formula-parser'
import {
  SPILL_DEFERRED_SET,
  DENIED_SET,
  SEMANTICS_DEFERRED_SET,
  BACKEND_SCALAR_ROUTING_SET,
  FORMULA_CATALOG,
} from './formulaCatalog'

/**
 * Excel function names supported by fast-formula-parser
 * Organized by category for better UX
 */
export const EXCEL_FUNCTIONS = {
  // Math & Trigonometry
  math: [
    'ABS', 'ACOS', 'ACOSH', 'ACOT', 'ACOTH', 'ASIN', 'ASINH', 'ATAN', 'ATAN2', 'ATANH',
    'CEILING', 'COS', 'COSH', 'COT', 'COTH', 'DEGREES', 'EVEN', 'EXP', 'FACT', 'FACTDOUBLE',
    'FLOOR', 'GCD', 'INT', 'LCM', 'LN', 'LOG', 'LOG10', 'MOD', 'MROUND', 'MULTINOMIAL',
    'ODD', 'PI', 'POWER', 'PRODUCT', 'QUOTIENT', 'RADIANS', 'RAND', 'RANDBETWEEN',
    'ROMAN', 'ROUND', 'ROUNDDOWN', 'ROUNDUP', 'SEC', 'SECH', 'SIGN', 'SIN', 'SINH',
    'SQRT', 'SQRTPI', 'SUBTOTAL', 'SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'SUMSQ',
    'SUMX2MY2', 'SUMX2PY2', 'SUMXMY2', 'TAN', 'TANH', 'TRUNC',
  ],
  // Statistical
  statistical: [
    'AVEDEV', 'AVERAGE', 'AVERAGEA', 'AVERAGEIF', 'AVERAGEIFS', 'BETA.DIST', 'BETA.INV',
    'BINOM.DIST', 'BINOM.INV', 'CHISQ.DIST', 'CHISQ.DIST.RT', 'CHISQ.INV', 'CHISQ.INV.RT',
    'CONFIDENCE.NORM', 'CONFIDENCE.T', 'CORREL', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF',
    'COUNTIFS', 'COVARIANCE.P', 'COVARIANCE.S', 'DEVSQ', 'EXPON.DIST', 'F.DIST', 'F.DIST.RT',
    'F.INV', 'F.INV.RT', 'FISHER', 'FISHERINV', 'FORECAST', 'FREQUENCY', 'GAMMA', 'GAMMA.DIST',
    'GAMMA.INV', 'GAMMALN', 'GAUSS', 'GEOMEAN', 'GROWTH', 'HARMEAN', 'HYPGEOM.DIST',
    'INTERCEPT', 'KURT', 'LARGE', 'LINEST', 'LOGEST', 'LOGNORM.DIST', 'LOGNORM.INV',
    'MAX', 'MAXA', 'MEDIAN', 'MIN', 'MINA', 'MODE.MULT', 'MODE.SNGL', 'NEGBINOM.DIST',
    'NORM.DIST', 'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'PEARSON', 'PERCENTILE.EXC',
    'PERCENTILE.INC', 'PERCENTRANK.EXC', 'PERCENTRANK.INC', 'PERMUT', 'PERMUTATIONA',
    'PHI', 'POISSON.DIST', 'PROB', 'QUARTILE.EXC', 'QUARTILE.INC', 'RANK.AVG', 'RANK.EQ',
    'RSQ', 'SKEW', 'SKEW.P', 'SLOPE', 'SMALL', 'STANDARDIZE', 'STDEV.P', 'STDEV.S',
    'STDEVA', 'STDEVPA', 'STEYX', 'T.DIST', 'T.DIST.2T', 'T.DIST.RT', 'T.INV', 'T.INV.2T',
    'TREND', 'TRIMMEAN', 'VAR.P', 'VAR.S', 'VARA', 'VARPA', 'WEIBULL.DIST', 'Z.TEST',
  ],
  // Logical
  logical: [
    'AND', 'FALSE', 'IF', 'IFERROR', 'IFNA', 'IFS', 'NOT', 'OR', 'SWITCH', 'TRUE', 'XOR',
  ],
  // Text
  text: [
    'CHAR', 'CLEAN', 'CODE', 'CONCATENATE', 'EXACT', 'FIND', 'FINDB', 'FIXED', 'LEFT',
    'LEFTB', 'LEN', 'LENB', 'LOWER', 'MID', 'MIDB', 'PROPER', 'REPLACE', 'REPLACEB',
    'REPT', 'RIGHT', 'RIGHTB', 'SEARCH', 'SEARCHB', 'SUBSTITUTE', 'T', 'TEXT', 'TEXTJOIN',
    'TRIM', 'UNICHAR', 'UNICODE', 'UPPER', 'VALUE',
  ],
  // Date & Time
  date: [
    'DATE', 'DATEDIF', 'DATEVALUE', 'DAY', 'DAYS', 'DAYS360', 'EDATE', 'EOMONTH', 'HOUR',
    'ISOWEEKNUM', 'MINUTE', 'MONTH', 'NETWORKDAYS', 'NETWORKDAYS.INTL', 'NOW', 'SECOND',
    'TIME', 'TIMEVALUE', 'TODAY', 'WEEKDAY', 'WEEKNUM', 'WORKDAY', 'WORKDAY.INTL', 'YEAR',
    'YEARFRAC',
  ],
  // Lookup & Reference
  reference: [
    'CHOOSE', 'COLUMN', 'COLUMNS', 'FORMULATEXT', 'HLOOKUP', 'INDEX', 'INDIRECT', 'LOOKUP',
    'MATCH', 'OFFSET', 'ROW', 'ROWS', 'TRANSPOSE',
    // VLOOKUP and XLOOKUP are classified `denied` in the formula catalog — removed from all lists.
  ],
  // Information
  information: [
    'CELL', 'ERROR.TYPE', 'ISBLANK', 'ISERR', 'ISERROR', 'ISEVEN', 'ISFORMULA', 'ISLOGICAL',
    'ISNA', 'ISNONTEXT', 'ISNUMBER', 'ISODD', 'ISREF', 'ISTEXT', 'N', 'NA', 'SHEET', 'SHEETS',
    'TYPE',
  ],
  // Financial
  financial: [
    'ACCRINT', 'ACCRINTM', 'AMORDEGRC', 'AMORLINC', 'COUPDAYBS', 'COUPDAYS', 'COUPDAYSNC',
    'COUPNCD', 'COUPNUM', 'COUPPCD', 'CUMIPMT', 'CUMPRINC', 'DB', 'DDB', 'DISC', 'DOLLARDE',
    'DOLLARFR', 'DURATION', 'EFFECT', 'FV', 'FVSCHEDULE', 'INTRATE', 'IPMT', 'IRR', 'ISPMT',
    'MDURATION', 'MIRR', 'NOMINAL', 'NPER', 'NPV', 'ODDFPRICE', 'ODDFYIELD', 'ODDLPRICE',
    'ODDLYIELD', 'PDURATION', 'PMT', 'PPMT', 'PRICE', 'PRICEDISC', 'PRICEMAT', 'PV', 'RATE',
    'RECEIVED', 'RRI', 'SLN', 'SYD', 'TBILLEQ', 'TBILLPRICE', 'TBILLYIELD', 'VDB', 'XIRR',
    'XNPV', 'YIELD', 'YIELDDISC', 'YIELDMAT',
  ],
  // Engineering
  engineering: [
    'BESSELI', 'BESSELJ', 'BESSELK', 'BESSELY', 'BIN2DEC', 'BIN2HEX', 'BIN2OCT', 'BITAND',
    'BITLSHIFT', 'BITOR', 'BITRSHIFT', 'BITXOR', 'COMPLEX', 'CONVERT', 'DEC2BIN', 'DEC2HEX',
    'DEC2OCT', 'DELTA', 'ERF', 'ERF.PRECISE', 'ERFC', 'ERFC.PRECISE', 'GESTEP', 'HEX2BIN',
    'HEX2DEC', 'HEX2OCT', 'IMABS', 'IMAGINARY', 'IMARGUMENT', 'IMCONJUGATE', 'IMCOS', 'IMCOSH',
    'IMCOT', 'IMCSC', 'IMCSCH', 'IMDIV', 'IMEXP', 'IMLN', 'IMLOG10', 'IMLOG2', 'IMPOWER',
    'IMPRODUCT', 'IMREAL', 'IMSEC', 'IMSECH', 'IMSIN', 'IMSINH', 'IMSQRT', 'IMSUB', 'IMSUM',
    'IMTAN', 'OCT2BIN', 'OCT2DEC', 'OCT2HEX',
  ],
} as const

// Custom sync-only functions we inject into the parser (not in fast-formula-parser).
const CUSTOM_SYNC_FUNCTIONS = new Set<string>([
  'MAX',
  'MIN',
])

// Functions visible in autocomplete because they require backend routing.
// Derived from catalog: scalar + backendRequired + autocompleteVisible.
const BACKEND_AUTOCOMPLETE_FUNCTIONS = new Set<string>(
  FORMULA_CATALOG
    .filter((f) => f.backendRequired && f.autocompleteVisible)
    .map((f) => f.name)
)
let BACKEND_ONLY_AUTOCOMPLETE_FUNCTIONS = new Set<string>(BACKEND_AUTOCOMPLETE_FUNCTIONS)
let BACKEND_AUTOCOMPLETE_ENABLED = false

// Functions that the backend can actually evaluate as scalars.
// Spill-deferred functions are NOT included: they are blocked before routing reaches the backend.
export const BACKEND_SUPPORTED_FUNCTIONS = new Set<string>(BACKEND_SCALAR_ROUTING_SET)

// Re-export DENIED_SET for Phase 1 guard (added in Phase 1)
export { DENIED_SET }

// All functions visible in autocomplete — catalog-derived.
// Includes every catalog entry with autocompleteVisible: true, plus legacy
// EXCEL_FUNCTIONS entries not yet in the catalog (kept for backwards compat).
const CATALOG_VISIBLE_NAMES = new Set<string>(
  FORMULA_CATALOG.filter((f) => f.autocompleteVisible).map((f) => f.name)
)
const LEGACY_FUNCTIONS = [
  ...EXCEL_FUNCTIONS.math,
  ...EXCEL_FUNCTIONS.statistical,
  ...EXCEL_FUNCTIONS.logical,
  ...EXCEL_FUNCTIONS.text,
  ...EXCEL_FUNCTIONS.date,
  ...EXCEL_FUNCTIONS.reference,
  ...EXCEL_FUNCTIONS.information,
  ...EXCEL_FUNCTIONS.financial,
  ...EXCEL_FUNCTIONS.engineering,
]
const ALLOWED_FUNCTIONS = [
  ...new Set([...CATALOG_VISIBLE_NAMES, ...LEGACY_FUNCTIONS]),
].sort()

// Scalar functions explicitly hidden from autocomplete.
// Derived from catalog: classification === 'scalar' && autocompleteVisible === false.
const EXCLUDED_AUTOCOMPLETE_FUNCTIONS = new Set<string>(
  FORMULA_CATALOG
    .filter((f) => f.classification === 'scalar' && !f.autocompleteVisible)
    .map((f) => f.name)
)

/**
 * Determine which Excel-style functions are actually supported by fast-formula-parser.
 *
 * We use the parser's supportedFunctions() API so that the autocomplete dropdown
 * only shows functions that can be evaluated. We also inject a few custom sync
 * functions (e.g., MAX/MIN) so they remain available in the UI.
 */
let SUPPORTED_FUNCTIONS_SET: Set<string> | null = null
let FILTERED_FUNCTIONS: string[] = ALLOWED_FUNCTIONS

try {
  const parser = new FormulaParser()
  const supported =
    typeof (parser as unknown as { supportedFunctions?: () => string[] }).supportedFunctions === 'function'
      ? (parser as unknown as { supportedFunctions: () => string[] }).supportedFunctions()
      : []

  if (Array.isArray(supported) && supported.length > 0) {
    SUPPORTED_FUNCTIONS_SET = new Set(supported.map(fn => fn.toUpperCase()))
    for (const fn of CUSTOM_SYNC_FUNCTIONS) {
      SUPPORTED_FUNCTIONS_SET.add(fn)
    }
    // Keep spill-risk, denied, and semantics-deferred functions hidden.
    FILTERED_FUNCTIONS = ALLOWED_FUNCTIONS.filter(fn => {
      const upperFn = fn.toUpperCase()
      if (EXCLUDED_AUTOCOMPLETE_FUNCTIONS.has(upperFn)) return false
      if (SPILL_DEFERRED_SET.has(upperFn)) return false
      if (DENIED_SET.has(upperFn)) return false
      if (SEMANTICS_DEFERRED_SET.has(upperFn)) return false
      const parserVisible = SUPPORTED_FUNCTIONS_SET!.has(upperFn)
      return parserVisible || BACKEND_AUTOCOMPLETE_FUNCTIONS.has(upperFn)
    })
    BACKEND_ONLY_AUTOCOMPLETE_FUNCTIONS = new Set(
      [...BACKEND_AUTOCOMPLETE_FUNCTIONS].filter((fn) => !SUPPORTED_FUNCTIONS_SET!.has(fn))
    )
  }
} catch {
  // Fallback: keep autocomplete broadly available but continue hiding spill-risk functions.
  FILTERED_FUNCTIONS = ALLOWED_FUNCTIONS.filter(fn => {
    const upperFn = fn.toUpperCase()
    return !SPILL_DEFERRED_SET.has(upperFn)
      && !DENIED_SET.has(upperFn)
      && !SEMANTICS_DEFERRED_SET.has(upperFn)
      && !EXCLUDED_AUTOCOMPLETE_FUNCTIONS.has(upperFn)
  })
  BACKEND_ONLY_AUTOCOMPLETE_FUNCTIONS = new Set(BACKEND_AUTOCOMPLETE_FUNCTIONS)
}

/**
 * Get function name suggestions based on prefix
 * @param prefix - Partial function name (case-insensitive)
 * @param limit - Maximum number of suggestions to return
 * @returns Array of matching function names
 */
const FUNCTION_SIGNATURES: Record<string, string> = {
  // Statistical & Aggregation
  SUM: 'SUM(number1, [number2], ...)',
  AVERAGE: 'AVERAGE(number1, [number2], ...)',
  COUNT: 'COUNT(value1, [value2], ...)',
  COUNTA: 'COUNTA(value1, [value2], ...)',
  COUNTIF: 'COUNTIF(range, criteria)',
  COUNTIFS: 'COUNTIFS(criteria_range1, criteria1, ...)',
  SUMIF: 'SUMIF(range, criteria, [sum_range])',
  SUMIFS: 'SUMIFS(sum_range, criteria_range1, criteria1, ...)',
  MAX: 'MAX(number1, [number2], ...)',
  MIN: 'MIN(number1, [number2], ...)',
  MEDIAN: 'MEDIAN(number1, [number2], ...)',
  'STDEV.P': 'STDEV.P(number1, [number2], ...)',
  'STDEV.S': 'STDEV.S(number1, [number2], ...)',
  'VAR.P': 'VAR.P(number1, [number2], ...)',
  'VAR.S': 'VAR.S(number1, [number2], ...)',

  // Math Functions
  ABS: 'ABS(number)',
  ROUND: 'ROUND(number, digits)',
  ROUNDUP: 'ROUNDUP(number, digits)',
  ROUNDDOWN: 'ROUNDDOWN(number, digits)',
  SQRT: 'SQRT(number)',
  POWER: 'POWER(number, power)',
  EXP: 'EXP(number)',
  LN: 'LN(number)',
  LOG: 'LOG(number, [base])',
  LOG10: 'LOG10(number)',
  MOD: 'MOD(number, divisor)',
  QUOTIENT: 'QUOTIENT(numerator, denominator)',
  SIGN: 'SIGN(number)',
  INT: 'INT(number)',
  TRUNC: 'TRUNC(number, [digits])',
  CEILING: 'CEILING(number, significance)',
  FLOOR: 'FLOOR(number, significance)',
  'CEILING.MATH': 'CEILING.MATH(number, [significance], [mode])',
  'FLOOR.MATH': 'FLOOR.MATH(number, [significance], [mode])',
  RAND: 'RAND()',
  RANDBETWEEN: 'RANDBETWEEN(bottom, top)',
  ODD: 'ODD(number)',
  EVEN: 'EVEN(number)',
  SQRTPI: 'SQRTPI(number)',

  // Trigonometric
  SIN: 'SIN(angle)',
  COS: 'COS(angle)',
  TAN: 'TAN(angle)',
  ASIN: 'ASIN(number)',
  ACOS: 'ACOS(number)',
  ATAN: 'ATAN(number)',
  ATAN2: 'ATAN2(x, y)',
  SINH: 'SINH(number)',
  COSH: 'COSH(number)',
  TANH: 'TANH(number)',
  ASINH: 'ASINH(number)',
  ACOSH: 'ACOSH(number)',
  ATANH: 'ATANH(number)',
  SEC: 'SEC(angle)',
  SECH: 'SECH(number)',
  CSC: 'CSC(angle)',
  CSCH: 'CSCH(number)',
  COT: 'COT(angle)',
  COTH: 'COTH(number)',
  ACOT: 'ACOT(number)',
  ACOTH: 'ACOTH(number)',
  DEGREES: 'DEGREES(angle)',
  RADIANS: 'RADIANS(angle)',
  PI: 'PI()',

  // Logical
  IF: 'IF(condition, value_if_true, [value_if_false])',
  IFERROR: 'IFERROR(value, value_if_error)',
  IFNA: 'IFNA(value, value_if_na)',
  AND: 'AND(logical1, [logical2], ...)',
  OR: 'OR(logical1, [logical2], ...)',
  NOT: 'NOT(logical)',
  XOR: 'XOR(logical1, [logical2], ...)',
  TRUE: 'TRUE()',
  FALSE: 'FALSE()',

  // Lookup & Reference
  // VLOOKUP and XLOOKUP removed: classified `denied` in formula catalog.
  HLOOKUP: 'HLOOKUP(search_key, range, index, [is_sorted])',
  INDEX: 'INDEX(range, row_num, [column_num])',
  MATCH: 'MATCH(lookup_value, lookup_array, [match_type])',
  FILTER: 'FILTER(array, include, [if_empty])',
  UNIQUE: 'UNIQUE(array, [by_column], [exactly_once])',
  SEQUENCE: 'SEQUENCE(rows, [columns], [start], [step])',
  TAKE: 'TAKE(array, rows, [axis])',
  DROP: 'DROP(array, rows, [axis])',
  CHOOSECOLS: 'CHOOSECOLS(array, column_num_or_range, ...)',
  CHOOSEROWS: 'CHOOSEROWS(array, row_num_or_range, ...)',
  HSTACK: 'HSTACK(array1, array2, ...)',
  VSTACK: 'VSTACK(array1, array2, ...)',

  // Text Functions
  TEXTJOIN: 'TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)',
  CONCAT: 'CONCAT(text1, [text2], ...)',
  CONCATENATE: 'CONCATENATE(text1, [text2], ...)',
  SUBSTITUTE: 'SUBSTITUTE(text, old_text, new_text, [instance_num])',
  REPLACE: 'REPLACE(old_text, start, num_chars, new_text)',
  LEFT: 'LEFT(text, [num_chars])',
  RIGHT: 'RIGHT(text, [num_chars])',
  MID: 'MID(text, start, num_chars)',
  LEN: 'LEN(text)',
  TRIM: 'TRIM(text)',
  UPPER: 'UPPER(text)',
  LOWER: 'LOWER(text)',
  PROPER: 'PROPER(text)',
  FIND: 'FIND(search_text, text, [start_num])',
  SEARCH: 'SEARCH(search_text, text, [start_num])',

  // Date & Time
  NOW: 'NOW()',
  TODAY: 'TODAY()',
  DATE: 'DATE(year, month, day)',
  TIME: 'TIME(hour, minute, second)',
  YEAR: 'YEAR(date)',
  MONTH: 'MONTH(date)',
  DAY: 'DAY(date)',
  HOUR: 'HOUR(time)',
  MINUTE: 'MINUTE(time)',
  SECOND: 'SECOND(time)',
  WEEKDAY: 'WEEKDAY(date, [type])',

  // Ranking
  RANK: 'RANK(number, ref, [order])',
  'RANK.AVG': 'RANK.AVG(number, ref, [order])',
  'RANK.EQ': 'RANK.EQ(number, ref, [order])',

  // Additional Statistical
  SUMPRODUCT: 'SUMPRODUCT(array1, [array2], ...)',
  SUMSQ: 'SUMSQ(number1, [number2], ...)',
  CORREL: 'CORREL(array1, array2)',
  'COVARIANCE.P': 'COVARIANCE.P(array1, array2)',
  'COVARIANCE.S': 'COVARIANCE.S(array1, array2)',
  STANDARDIZE: 'STANDARDIZE(x, mean, standard_dev)',

  // Financial
  FV: 'FV(rate, nper, pmt, [pv], [type])',
  IRR: 'IRR(values, [guess])',
  NPER: 'NPER(rate, pmt, pv, [fv], [type])',
  NPV: 'NPV(rate, value1, [value2], ...)',
  PMT: 'PMT(rate, nper, pv, [fv], [type])',
  PV: 'PV(rate, nper, pmt, [fv], [type])',
  RATE: 'RATE(nper, pmt, pv, [fv], [type], [guess])',

  // T-Distribution
  'T.DIST': 'T.DIST(x, deg_freedom, cumulative)',
  'T.DIST.2T': 'T.DIST.2T(x, deg_freedom)',
  'T.DIST.RT': 'T.DIST.RT(x, deg_freedom)',
  'T.INV': 'T.INV(probability, deg_freedom)',
  'T.INV.2T': 'T.INV.2T(probability, deg_freedom)',

  // F-Distribution
  'F.DIST': 'F.DIST(x, deg_freedom1, deg_freedom2, cumulative)',
  'F.DIST.RT': 'F.DIST.RT(x, deg_freedom1, deg_freedom2)',
  'F.INV': 'F.INV(probability, deg_freedom1, deg_freedom2)',
  'F.INV.RT': 'F.INV.RT(probability, deg_freedom1, deg_freedom2)',

  // Chi-Square Distribution
  'CHISQ.DIST': 'CHISQ.DIST(x, deg_freedom, cumulative)',
  'CHISQ.DIST.RT': 'CHISQ.DIST.RT(x, deg_freedom)',
  'CHISQ.INV': 'CHISQ.INV(probability, deg_freedom)',
  'CHISQ.INV.RT': 'CHISQ.INV.RT(probability, deg_freedom)',

  // Normal Distribution
  'NORM.DIST': 'NORM.DIST(x, mean, standard_dev, cumulative)',
  'NORM.INV': 'NORM.INV(probability, mean, standard_dev)',
  'NORM.S.DIST': 'NORM.S.DIST(z, cumulative)',
  'NORM.S.INV': 'NORM.S.INV(probability)',
}

/**
 * Function suggestion with inline hint
 */
export interface FunctionSuggestion {
  name: string
  signature: string
}

// Catalog-derived signature lookup — preferred over hardcoded FUNCTION_SIGNATURES.
const CATALOG_SIGNATURES: Record<string, string> = Object.fromEntries(
  FORMULA_CATALOG
    .filter((f) => f.signature)
    .map((f) => [f.name.toUpperCase(), f.signature])
)

export function getFunctionSignature(name: string): string | null {
  if (!name) return null
  const upper = name.toUpperCase()
  // Catalog is the source of truth; fall back to legacy hardcoded map.
  return CATALOG_SIGNATURES[upper] ?? FUNCTION_SIGNATURES[upper] ?? `${upper}(...)`
}

export function getFunctionSuggestions(prefix: string, limit = 10): string[] {
  if (!prefix) return []

  const upperPrefix = prefix.toUpperCase()
  const source = BACKEND_AUTOCOMPLETE_ENABLED
    ? FILTERED_FUNCTIONS
    : FILTERED_FUNCTIONS.filter((fn) => !BACKEND_ONLY_AUTOCOMPLETE_FUNCTIONS.has(fn))
  const matches = source.filter((fn) => fn.startsWith(upperPrefix))

  return matches.slice(0, limit)
}

/**
 * Get function suggestions with inline hints (signatures)
 * Returns both function name and signature for display
 * Only includes functions with informative signatures (not generic "..." fallbacks)
 */
export function getFunctionSuggestionsWithHints(prefix: string, limit = 10): FunctionSuggestion[] {
  if (!prefix) return []

  const upperPrefix = prefix.toUpperCase()
  const source = BACKEND_AUTOCOMPLETE_ENABLED
    ? FILTERED_FUNCTIONS
    : FILTERED_FUNCTIONS.filter((fn) => !BACKEND_ONLY_AUTOCOMPLETE_FUNCTIONS.has(fn))
  const matches = source.filter((fn) => fn.startsWith(upperPrefix))

  // Use catalog-first signature lookup; every function gets at least a generic hint.
  return matches.slice(0, limit).map((name) => ({
    name,
    signature: getFunctionSignature(name) ?? name,
  }))
}
import type {
  CellPosition,
  CellRef,
  RangeRef,
  FormulaResult,
  FormulaError,
  FormulaErrorType,
  CellGetter,
  RangeGetter,
  CellKey,
} from './formulaTypes'
import {
  columnIndexToLetter,
  columnLetterToIndex,
  isFormula,
  stripFormulaPrefix,
  topologicalSort,
  annotateA1WithColumnNames,
} from './formulaUtils'
import { FORMULA_PENDING_SENTINEL, isPendingCalculation } from '@/utils/formulaSentinel'

/**
 * Edit produced by formula recalculation
 */
export interface FormulaEdit {
  row: number
  columnId: string
  computedValue: unknown
  error?: FormulaError
}

/**
 * Context for async aggregate formula support (Phase 5.2)
 * Enables large dataset aggregates via DuckDB backend
 */
export interface AsyncAggregateContext {
  /** Whether dataset is stored in DuckDB (large dataset) */
  isLargeDataset: boolean
  /** Whether dataset is sorted (async disabled if sorted) */
  isSorted: boolean
  /** Whether dataset is grouped (async disabled if grouped) */
  isGrouped: boolean
  /** Whether a toolbar/view filter is active */
  isViewFiltered?: boolean
  /** Complete model-row evaluation domain for active view filters */
  scopedRowOrder?: number[]
  /** Whether view row bounds can be resolved to model rows (lazy grouping) */
  supportsViewRowBounds?: boolean
  /** Function to get current row data */
  getRowData: () => Map<number, Record<string, unknown>>
  /** Function to enqueue async aggregate request */
  enqueueAggregate: (request: AsyncAggregateRequest) => void
}

/**
 * Request to compute aggregate via backend
 */
export interface AsyncAggregateRequest {
  cellKey: string
  requestId: string
  columnId: string
  func: string
  /** Optional row bounds (0-based, inclusive) for range aggregates */
  startRow?: number
  endRow?: number
  /** Optional explicit model row indices (used for sorted/grouped view ranges) */
  rowIndices?: number[]
  /** Complete model-row evaluation domain for active view filters */
  scopedRowOrder?: number[]
  /** Optional view row bounds (0-based, inclusive) for lazy grouped ranges */
  viewRowBounds?: { start: number; end: number }
}

/**
 * Context for backend formula evaluation via Formualizer (Phase 3)
 * Enables evaluation of formulas referencing unloaded ranges on large datasets
 */
export interface BackendEvaluationContext {
  /** Whether dataset is stored in DuckDB (large dataset) */
  isLargeDataset: boolean
  /** Whether dataset is sorted (requires rowOrder for correct results) */
  isSorted: boolean
  /** Whether dataset is grouped (requires rowOrder for correct results) */
  isGrouped: boolean
  /** Whether a toolbar/view filter is active (requires rowOrder for correct results) */
  isViewFiltered?: boolean
  /** Total row count in dataset */
  totalRows: number
  /** Loaded row range in cache */
  loadedRowRange: { start: number; end: number }
  /** Column lookup functions */
  columnLookup: ColumnLookup
  /** View->model row mapping (null if identity/unsorted) */
  rowOrder: number[] | null
  /** Whether the caller can build rowOrder slices from view bounds (lazy grouping) */
  supportsRowOrderSlice?: boolean
  /** Dataset ID for backend commands */
  datasetId: string
  /** Check if a view row is currently loaded in the local cache */
  isRowLoaded?: (viewRow: number) => boolean
  /** Function to enqueue backend formula evaluation */
  enqueueBackendEval: (request: BackendEvalRequest) => void
}

/**
 * Request to evaluate formula via Formualizer backend
 */
export interface BackendEvalRequest {
  cellKey: string
  requestId: string
  formula: string
  position: { row: number; col: number }  // VIEW coords (0-based)
  columnLetterToIdMap: Record<string, string>
  rowOrderSlice?: { start: number; data: number[] }
  rowBounds?: { start: number; end: number }
}

/**
 * Column lookup functions for converting between A1 notation and internal keys
 */
export interface ColumnLookup {
  /** Convert column index (0-based) to columnId */
  indexToId: (index: number) => string
  /** Convert columnId to column index (0-based) */
  idToIndex: (columnId: string) => number
}

/**
 * Formula Service - manages formula evaluation and dependency tracking
 */
export class FormulaService {
  // ============ Async Aggregate Support (Phase 5.2) ============
  /** Sentinel value for pending calculations - stored in rowData */
  static readonly CALC_PENDING_SENTINEL = FORMULA_PENDING_SENTINEL

  /** Timeout (ms) after which a pending backend eval is abandoned and settled to #VALUE! */
  static readonly BACKEND_EVAL_TIMEOUT_MS = 15_000

  /**
   * Full-column reference pattern: A:A, B:B, $A:$A, etc.
   * Matches delegatable aggregate functions with full-column references.
   * Includes MIN/MAX for backend routing on large datasets.
   * Supports absolute column refs ($A:$A).
   */
  private static readonly FULL_COLUMN_PATTERN = /^=?\s*(SUM|AVG|AVERAGE|COUNT|COUNTA|STDEV|STDEV\.S|STDEV\.P|VAR|VAR\.S|VAR\.P|MIN|MAX)\s*\(\s*\$?([A-Z]+)\s*:\s*\$?\2\s*\)$/i

  /**
   * Large row range pattern for aggregates: =SUM(A1:A100000), =AVERAGE(B5:B50000), etc.
   * Matches simple aggregate functions with single-column row ranges.
   * These can be routed to backend for performance.
   * Supports absolute refs ($A$1:$A$50000).
   */
  private static readonly ROW_RANGE_AGGREGATE_PATTERN = /^=?\s*(SUM|AVG|AVERAGE|COUNT|COUNTA|STDEV|STDEV\.S|STDEV\.P|VAR|VAR\.S|VAR\.P|MIN|MAX)\s*\(\s*\$?([A-Z]+)\$?(\d+)\s*:\s*\$?\2\$?(\d+)\s*\)$/i

  /**
   * Performance thresholds for range handling
   */
  private static readonly LARGE_RANGE_THRESHOLD = 10000  // Route to backend if range > 10k rows
  private static readonly MAX_RANGE_SIZE = 100000        // Hard limit - error if range > 100k cells
  private static readonly MAX_BACKEND_RANGE_CELLS = 250000 // Matches backend guard (formula_backend.rs)
  private static readonly DEPENDENCY_EXPANSION_THRESHOLD = 10000 // Max cells to expand for dependency tracking
  private static readonly MAX_SCOPED_ROW_ORDER_IPC = 50000 // Temporary IPC guard for filtered full-column aggregates

  private parser: FormulaParser
  private depParser: DepParser

  /** Temporary overrides for recalculation so downstream evaluations see updated upstream values */
  private overrideValues: Map<CellKey, unknown> | null = null
  private baseCellGetter: CellGetter
  private baseRangeGetter: RangeGetter

  // WE BUILD AND MAINTAIN THESE:
  /** Map from cell key to set of cell keys that depend on it */
  private dependencyGraph: Map<string, Set<string>> = new Map()
  /** Map from cell key to formula string (e.g., "=SUM(A1:A5)") */
  private formulaStorage: Map<string, string> = new Map()
  /** Map from cell key to its dependencies (reverse of dependencyGraph) */
  private reverseDependencies: Map<string, Set<string>> = new Map()

  // ============ Async Aggregate State ============
  /** Context for async aggregate support (set by SpreadsheetView) */
  private asyncAggregateContext?: AsyncAggregateContext
  /** Map of pending async aggregate requests */
  private pendingAggregates: Map<string, { requestId: string; formula: string; position: CellPosition }> = new Map()
  /** Callback when async aggregate completes */
  private onAsyncAggregateComplete?: (cellKey: string, value: number, requestId: string) => void

  // ============ Backend Evaluation State (Phase 3) ============
  /** Context for backend formula evaluation via Formualizer */
  private backendEvalContext?: BackendEvaluationContext
  /** Map of pending backend formula evaluation requests */
  private pendingBackendEvals: Map<string, { requestId: string; formula: string; position: CellPosition }> = new Map()
  /** Callback when backend evaluation completes */
  private onBackendEvalComplete?: (cellKey: string, value: unknown, requestId: string) => void

  private columnLookup: ColumnLookup
  private getRowOrder?: () => number[]
  private columnCount: number
  private volatileCells: Set<CellKey> = new Set()
  private volatileBackendEvalTimestamps: Map<CellKey, number> = new Map()
  private static readonly VOLATILE_BACKEND_COOLDOWN_MS = 5000

  constructor(
    cellGetter: CellGetter,
    rangeGetter: RangeGetter,
    columnLookup: ColumnLookup,
    getRowOrder?: () => number[],
    columnCount: number = 0
  ) {
    BACKEND_AUTOCOMPLETE_ENABLED = false

    this.columnLookup = columnLookup
    this.baseCellGetter = cellGetter
    this.baseRangeGetter = rangeGetter
    this.getRowOrder = getRowOrder
    this.columnCount = columnCount

    const parserStatics = FormulaParser as unknown as {
      FormulaHelpers?: {
        flattenParams: (
          params: unknown[],
          type: number,
          allowArrays: boolean,
          callback: (item: unknown, info: { isLiteral: boolean }) => void
        ) => void
      }
      Types?: { NUMBER: number }
    }

    const helpers = parserStatics.FormulaHelpers
    const types = parserStatics.Types

    const buildMinMax = (mode: 'MIN' | 'MAX') => (...params: unknown[]) => {
      if (!helpers || !types) {
        return mode === 'MIN' ? 0 : 0
      }

      let hasValue = false
      let result = mode === 'MIN' ? Infinity : -Infinity

      helpers.flattenParams(params, types.NUMBER, true, (item, info) => {
        if (info.isLiteral) {
          if (typeof item === 'number') {
            result = mode === 'MIN' ? Math.min(result, item) : Math.max(result, item)
            hasValue = true
          }
          return
        }

        if (typeof item === 'number') {
          result = mode === 'MIN' ? Math.min(result, item) : Math.max(result, item)
          hasValue = true
        }
      })

      return hasValue ? result : 0
    }

    // Initialize fast-formula-parser with data callbacks + custom functions
    this.parser = new FormulaParser({
      onCell: (ref: { row: number; col: number; sheet?: string }) => {
        return this.getCellValue(ref.row, ref.col, ref.sheet)
      },
      onRange: (ref: RangeRef) => {
        return this.getRangeValues(ref)
      },
      functions: {
        MAX: buildMinMax('MAX'),
        MIN: buildMinMax('MIN'),
      },
    })

    this.depParser = new DepParser()
  }

  /**
   * Convert view row (1-based, from parser) to model row (0-based).
   * Used for dependency tracking to keep keys in model space.
   */
  private viewToModelRow(parserRow: number): number {
    const viewRow = parserRow - 1 // Convert 1-based to 0-based
    if (!this.getRowOrder) return viewRow // No sorting, identity mapping
    const rowOrder = this.getRowOrder()
    return rowOrder[viewRow] ?? viewRow // Fallback to identity if out of bounds
  }

  private getCellValue(row: number, col: number, sheet?: string): unknown {
    // Parser uses 1-based rows/cols. Our cellKey is 0-based row + columnId.
    if (this.overrideValues) {
      const row0 = this.viewToModelRow(row)
      const colId = this.columnLookup.indexToId(col - 1)
      const key = `${row0}:${colId}`
      if (this.overrideValues.has(key)) {
        return this.overrideValues.get(key)
      }
    }

    return this.baseCellGetter(row, col, sheet)
  }

  private getRangeValues(ref: RangeRef): unknown[][] {
    const startRow = Math.min(ref.from.row, ref.to.row)
    const endRow = Math.max(ref.from.row, ref.to.row)
    const startCol = Math.min(ref.from.col, ref.to.col)
    const endCol = Math.max(ref.from.col, ref.to.col)

    const rowCount = endRow - startRow + 1
    const colCount = endCol - startCol + 1
    const totalCells = rowCount * colCount
    if (totalCells > FormulaService.MAX_RANGE_SIZE) {
      throw new Error(`Range too large: ${totalCells.toLocaleString()} cells`)
    }

    if (!this.overrideValues) {
      return this.baseRangeGetter(ref)
    }

    const result: unknown[][] = []

    for (let row = startRow; row <= endRow; row++) {
      const rowValues: unknown[] = []
      for (let col = startCol; col <= endCol; col++) {
        rowValues.push(this.getCellValue(row, col, ref.sheet))
      }
      result.push(rowValues)
    }

    return result
  }

  /**
   * Normalize accidental whitespace inside A1 references (e.g. `B 1`).
   *
   * In Excel syntax, a space between references means 'intersection'. When a user
   * accidentally types/pastes `B 1`, fast-formula-parser interprets it as an
   * intersection between whole column B and whole row 1 and throws:
   * 'Cannot intersect the whole row or column.'
   *
   * This helper collapses whitespace between the column letters and row number
   * (including absolute refs like `$B $ 1`) without touching string literals.
   *
   * IMPORTANT: This logic is duplicated in Rust backend (src-tauri/src/modules/formula_backend.rs
   * strip_a1_annotations). Any changes here MUST be mirrored there to avoid parsing divergence.
   */
  private normalizeA1ReferenceWhitespace(formula: string): string {
    const stripA1Annotations = (segment: string): string => {
      let out = ''
      let i = 0

      while (i < segment.length) {
        const slice = segment.slice(i)
        const match = slice.match(/^(\$?[A-Za-z]{1,3}\$?\d+)/)

        if (match) {
          const ref = match[1] ?? ''
          out += ref
          i += ref.length

          // Skip whitespace between the ref and an annotation.
          let j = i
          while (j < segment.length && /\s/.test(segment[j]!)) {
            j++
          }

          if (segment[j] === '(') {
            // Skip balanced parentheses, allowing nested () inside names.
            let depth = 0
            let k = j
            while (k < segment.length) {
              const ch = segment[k]!
              if (ch === '(') depth++
              if (ch === ')') {
                depth--
                if (depth === 0) {
                  k++
                  break
                }
              }
              k++
            }

            if (depth === 0) {
              i = k
              continue
            }
          }

          i = j
          continue
        }

        out += segment[i]!
        i++
      }

      return out
    }

    const normalizeOutsideStrings = (segment: string): string => {
      // Strip optional column-name annotations inserted by the UI (e.g., "A1 (Age)").
      const withoutAnnotations = stripA1Annotations(segment)

      return withoutAnnotations.replace(
        /(^|[^A-Za-z0-9_])(\$?[A-Za-z]{1,3})\s*(\$?)\s*(\d+)/g,
        '$1$2$3$4'
      )
    }

    let out = ''
    let buf = ''
    let inString = false

    const flush = () => {
      if (buf.length === 0) return
      out += inString ? buf : normalizeOutsideStrings(buf)
      buf = ''
    }

    for (let i = 0; i < formula.length; i++) {
      const ch = formula[i]!
      if (ch === '"') {
        // Excel escapes quotes inside strings with a doubled quote: ""
        if (inString && formula[i + 1] === '"') {
          buf += '""'
          i++
          continue
        }

        flush()
        out += '"'
        inString = !inString
        continue
      }

      buf += ch
    }

    flush()
    return out
  }
  /**
   * Check if a value is a formula (starts with '=')
   */
  isFormula(value: unknown): value is string {
    return isFormula(value)
  }

  /**
   * Get stored formula for a cell
   */
  getFormula(cellKey: CellKey): string | undefined {
    return this.formulaStorage.get(cellKey)
  }

  /**
   * Check if a cell has a formula
   */
  hasFormula(cellKey: CellKey): boolean {
    return this.formulaStorage.has(cellKey)
  }

  /**
   * Evaluate a formula and return the result
   * @param formula - Formula string (with or without '=' prefix)
   * @param position - Cell position for relative references
   */
  evaluate(
    formula: string,
    position: CellPosition,
    options?: { source?: 'volatile' }
  ): FormulaResult {
    const cleanFormula = this.normalizeA1ReferenceWhitespace(stripFormulaPrefix(formula))
    if (cleanFormula.trim() === '') {
      return {
        value: null,
        error: {
          type: '#VALUE!' as FormulaErrorType,
          message: 'Formula is empty',
        },
      }
    }

    // Phase 1: Hard product denylist — first check after empty guard, before all routing.
    // Uses extractFunctionNames so nested denied calls (=IF(x,VLOOKUP(...),0)) are caught.
    // extractFunctionNames uppercases names, so lowercase input is handled.
    const usedFunctionNames = this.extractFunctionNames(cleanFormula)
    const deniedFn = usedFunctionNames.find((fn) => DENIED_SET.has(fn))
    if (deniedFn) {
      return {
        value: null,
        error: {
          type: '#NAME?' as FormulaErrorType,
          message: `${deniedFn} is not supported in EasyCris. Use INDEX/MATCH instead.`,
        },
      }
    }

    // Semantics-deferred guard — functions with known backend semantic gaps.
    // Distinct from spill (array result risk) and deny (product decision).
    // Message contains "not yet available" so tests can distinguish all three guard types.
    const semanticsFn = usedFunctionNames.find((fn) => SEMANTICS_DEFERRED_SET.has(fn))
    if (semanticsFn) {
      return {
        value: null,
        error: {
          type: '#NAME?' as FormulaErrorType,
          message: `${semanticsFn} is not yet available in EasyCris.`,
        },
      }
    }

    // Guard against malformed range syntax like "B1:50000"
    if (this.hasInvalidRangeSyntax(cleanFormula)) {
      return {
        value: null,
        error: {
          type: '#REF!' as FormulaErrorType,
          message: 'Invalid range reference',
        },
      }
    }

    // Guard against invalid column references (out of bounds)
    if (this.hasInvalidColumnRefs(cleanFormula, position)) {
      return {
        value: null,
        error: {
          type: '#REF!' as FormulaErrorType,
          message: 'Invalid column reference',
        },
      }
    }

    // ============ Async Aggregate Check (Phase 5.2) ============
    // Check if this is a delegatable full-column aggregate on a large dataset
    const aggregateSpec = this.detectDelegatableAggregate(cleanFormula)
    const largeRangeSpec = !aggregateSpec ? this.detectLargeRowRangeAggregate(cleanFormula) : null
    const needsBackendForFunctions = this.usesBackendScalarFunctions(cleanFormula)
    const returnsCircularSelfReference = (): FormulaResult => ({
      value: null,
      error: {
        type: '#CIRCULAR!' as FormulaErrorType,
        message: 'Formula range includes the formula cell',
      },
    })

    if (this.referencesOwnCell(cleanFormula, position)) {
      return returnsCircularSelfReference()
    }

    if (aggregateSpec && this.asyncAggregateContext) {
      const { isLargeDataset, enqueueAggregate } = this.asyncAggregateContext

      // GUARDS:
      // 1. Must be large dataset (small datasets use sync path)
      // NOTE: Sorting/grouping guards REMOVED for full-column aggregates.
      // Full-column aggregates (SUM(A:A), COUNT(B:B), etc.) are order-insensitive,
      // so the result is the same regardless of view order. The backend uses
      // get_column_aggregate which is a direct SQL aggregate - no rowOrderSlice needed.
      // This is the SQL aggregate fast-path for sorted/grouped data.
      const canUseAsync = isLargeDataset

      if (canUseAsync) {
        // Enqueue backend request and return pending sentinel
        const row0 = position.row - 1 // Convert 1-based to 0-based
        const columnId = this.columnLookup.indexToId(position.col - 1)
        const cellKey = `${row0}:${columnId}`
        const requestId = crypto.randomUUID()

        // Map function name to backend format
        const backendFunc = aggregateSpec.func
          .replace('.S', '_S')      // STDEV.S → STDEV_S
          .replace('.P', '_P')      // STDEV.P → STDEV_P

        // Get column ID for the referenced column
        const refColumnId = this.columnLookup.indexToId(aggregateSpec.columnIndex)
        const scopedRowOrder = this.asyncAggregateContext.isViewFiltered
          ? this.asyncAggregateContext.scopedRowOrder
          : undefined

        if (
          this.asyncAggregateContext.isViewFiltered &&
          (!Array.isArray(scopedRowOrder) || scopedRowOrder.length === 0)
        ) {
          return {
            value: null,
            error: {
              type: '#VALUE!' as FormulaErrorType,
              message: 'Toolbar view filter did not provide a scoped row domain. Use the Advanced Filter dropdown option under Data to create a permanent filtered dataset.',
            },
          }
        }
        if (
          this.asyncAggregateContext.isViewFiltered &&
          Array.isArray(scopedRowOrder) &&
          scopedRowOrder.length > FormulaService.MAX_SCOPED_ROW_ORDER_IPC
        ) {
          return {
            value: null,
            error: {
              type: '#VALUE!' as FormulaErrorType,
              message: 'Toolbar view filter scope is too large for this full-column formula. Use the Advanced Filter dropdown option under Data to create a permanent filtered dataset, or use a bounded range.',
            },
          }
        }

        this.pendingAggregates.set(cellKey, { requestId, formula, position })

        enqueueAggregate({
          cellKey,
          requestId,
          columnId: refColumnId,
          func: backendFunc,
          scopedRowOrder,
        })

        // Return sentinel VALUE (not error) - getCellContent will render as "Calculating..."
        return {
          value: FormulaService.CALC_PENDING_SENTINEL,
          // No error field - this is a pending calculation, not an error
        }
      }
      // Else: fall through to sync evaluation (may show partial/null for large ranges)
    }

    // ============ Large Row Range Aggregate Check (Option A: Smart Routing) ============
    // Check if this is a large row range aggregate (e.g., =SUM(B1:B1875677))
    // Route to backend evaluation to avoid freezing and preserve correct bounds

    // If sorted/grouped large dataset lacks rowOrder, block backend routing with clear error
    if (
      this.backendEvalContext?.isLargeDataset &&
      (this.backendEvalContext.isSorted || this.backendEvalContext.isGrouped || this.backendEvalContext.isViewFiltered) &&
      (!this.backendEvalContext.rowOrder || this.backendEvalContext.rowOrder.length === 0)
    ) {
      const canResolveRowOrderSlice = !!this.backendEvalContext.supportsRowOrderSlice
      if (!canResolveRowOrderSlice && !this.canSyncEvaluateWithoutBackend(cleanFormula, position)) {
        return {
          value: null,
          error: {
            type: '#VALUE!' as FormulaErrorType,
            message: 'Formula requires row order in sorted/grouped large datasets. Disable sorting/grouping or reduce the range.',
          },
        }
      }
    }

    // Block array functions that would return #SPILL! in single-cell context
    if (this.usesBackendArrayFunctions(cleanFormula)) {
      return {
        value: null,
        error: {
          type: '#NAME?' as FormulaErrorType,
          message: 'Array function not supported (would return #SPILL!)',
        },
      }
    }

    // Enable backend routing for scalar functions (MAX, MIN, MEDIAN, etc.)
    const allowBackendForFunctions = needsBackendForFunctions && !!this.backendEvalContext

    // DEBUG: Log function routing decision
    const hasUnsupported = this.hasUnsupportedFunctions(cleanFormula)
    if (hasUnsupported && !this.backendEvalContext) {
      console.warn('[FormulaService] Formula uses backend-only functions but backendEvalContext is not set:',
        cleanFormula, '| Will attempt sync evaluation (may fail)')
    }
    if (needsBackendForFunctions) {
      console.log('[FormulaService] Formula needs backend for scalar functions:', cleanFormula,
        '| backendEvalContext:', !!this.backendEvalContext,
        '| allowBackend:', allowBackendForFunctions)
    }

    // ============ Large Row Range Aggregate (SQL Fast Path) ============
    // For unsorted/ungrouped large datasets, use SQL aggregate over a row range
    if (largeRangeSpec && this.asyncAggregateContext) {
      const { isLargeDataset, isSorted, isGrouped, isViewFiltered, enqueueAggregate } = this.asyncAggregateContext

      if (isLargeDataset) {
        const row0 = position.row - 1 // Convert 1-based to 0-based
        const columnId = this.columnLookup.indexToId(position.col - 1)
        const cellKey = `${row0}:${columnId}`
        const requestId = crypto.randomUUID()

        const backendFunc = largeRangeSpec.func
          .replace('.S', '_S')
          .replace('.P', '_P')

        const refColumnId = this.columnLookup.indexToId(largeRangeSpec.columnIndex)

        if (!isSorted && !isGrouped && !isViewFiltered) {
          this.pendingAggregates.set(cellKey, { requestId, formula, position })

          enqueueAggregate({
            cellKey,
            requestId,
            columnId: refColumnId,
            func: backendFunc,
            startRow: largeRangeSpec.startRow,
            endRow: largeRangeSpec.endRow,
          })

          return { value: FormulaService.CALC_PENDING_SENTINEL }
        }

        const rowOrder = this.getRowOrder?.()
        if (!rowOrder || rowOrder.length === 0) {
          if (this.asyncAggregateContext.supportsViewRowBounds) {
            this.pendingAggregates.set(cellKey, { requestId, formula, position })

            enqueueAggregate({
              cellKey,
              requestId,
              columnId: refColumnId,
              func: backendFunc,
              viewRowBounds: { start: largeRangeSpec.startRow, end: largeRangeSpec.endRow },
            })
            return { value: FormulaService.CALC_PENDING_SENTINEL }
          }
          return { value: '#REF!' }
        }

        if (largeRangeSpec.endRow >= rowOrder.length) {
          return { value: '#REF!' }
        }

        const slice = rowOrder.slice(largeRangeSpec.startRow, largeRangeSpec.endRow + 1)
        if (slice.length !== largeRangeSpec.rowCount) {
          return { value: '#REF!' }
        }

        if (
          isViewFiltered &&
          slice.length > FormulaService.MAX_SCOPED_ROW_ORDER_IPC
        ) {
          return {
            value: null,
            error: {
              type: '#VALUE!' as FormulaErrorType,
              message: 'Toolbar view filter scope is too large for this formula range. Use the Advanced Filter dropdown option under Data to create a permanent filtered dataset, or reduce the range.',
            },
          }
        }

        this.pendingAggregates.set(cellKey, { requestId, formula, position })

        enqueueAggregate({
          cellKey,
          requestId,
          columnId: refColumnId,
          func: backendFunc,
          rowIndices: slice,
        })

        return { value: FormulaService.CALC_PENDING_SENTINEL }
      }
    }

    // ============ Backend Evaluation Check (Phase 3) ============
    // For large ranges (forced) or formulas referencing unloaded ranges
    if (!aggregateSpec && this.backendEvalContext) {
      const forceBackend = !!largeRangeSpec && this.backendEvalContext.isLargeDataset
      const needsBackend =
        forceBackend ||
        allowBackendForFunctions ||
        this.shouldUseBackendEval(cleanFormula, position, this.backendEvalContext)

      if (needsBackend) {
        console.log('[FormulaService] Backend eval required:', cleanFormula,
          '| reason: forceBackend:', forceBackend, 'allowBackendForFunctions:', allowBackendForFunctions)

        return this.enqueueBackendEvalForFormula(cleanFormula, position, 'pre-sync')
      }
    }

    // ============ Pre-Sync Safety Checks ============
    // Block INDIRECT - never supported, would give wrong results over partial cache
    const hasIndirect = /\bINDIRECT\s*\(/i.test(cleanFormula)
    if (hasIndirect) {
      return {
        value: null,
        error: {
          type: '#NAME?' as FormulaErrorType,
          message: 'INDIRECT function is not supported',
        },
      }
    }

    // Block large ranges that couldn't be routed to backend
    // (backend context missing but formula needs it for correctness)
    if (largeRangeSpec && !this.backendEvalContext && this.asyncAggregateContext?.isLargeDataset) {
      return {
        value: null,
        error: {
          type: '#VALUE!' as FormulaErrorType,
          message: `Range too large for sync evaluation (${largeRangeSpec.rowCount.toLocaleString()} rows). Backend not available.`,
        },
      }
    }

    // Block backend-only functions when context unavailable on large datasets
    if (needsBackendForFunctions && !this.backendEvalContext && this.asyncAggregateContext?.isLargeDataset) {
      return {
        value: null,
        error: {
          type: '#VALUE!' as FormulaErrorType,
          message: 'Formula requires backend evaluation which is not available',
        },
      }
    }

    // If backend context is missing on large datasets, only allow sync eval
    // when all referenced rows are currently loaded. Otherwise return clear error.
    if (!this.backendEvalContext && this.asyncAggregateContext?.isLargeDataset) {
      if (!this.canSyncEvaluateWithoutBackend(cleanFormula, position)) {
        return {
          value: null,
          error: {
            type: '#VALUE!' as FormulaErrorType,
            message: 'Formula requires backend evaluation which is not available',
          },
        }
      }
    }

    // ============ Normal Sync Evaluation ============
    try {
      const result = this.parser.parse(cleanFormula, position)

      // fast-formula-parser can return error objects instead of throwing
      if (result && typeof result === 'object' && '_error' in result) {
        const errorObj = result as { _error: string; message?: string }
        console.warn('[FormulaService] Sync eval returned error:', cleanFormula, '| error:', errorObj._error)
        const fallback = this.tryBackendFallback(
          cleanFormula,
          position,
          errorObj.message || errorObj._error,
          options?.source
        )
        if (fallback) {
          return fallback
        }
        return {
          value: null,
          error: {
            type: errorObj._error as FormulaErrorType,
            message: errorObj.message || errorObj._error,
          },
        }
      }

      console.log('[FormulaService] Sync eval success:', cleanFormula, '| result:', result)
      return { value: result }
    } catch (e) {
      const error = this.parseError(e)
      console.error('[FormulaService] Sync eval exception:', cleanFormula, '| error:', error, '| exception:', e)
      const fallback = this.tryBackendFallback(cleanFormula, position, error.message, options?.source)
      if (fallback) {
        return fallback
      }
      return { value: null, error }
    }
  }

  /**
   * Extract cell references from a formula using DepParser.
   * For large ranges (> DEPENDENCY_EXPANSION_THRESHOLD), returns column-level marker refs instead of
   * expanding all cells, so that column edits still trigger recalculation.
   */
  extractDependencies(formula: string, position: CellPosition): CellRef[] {
    const cleanFormula = this.normalizeA1ReferenceWhitespace(stripFormulaPrefix(formula))

    try {
      const deps = this.depParser.parse(cleanFormula, position)
      const cellRefs: CellRef[] = []

      // DepParser returns an array of references (cells or ranges)
      if (Array.isArray(deps)) {
        for (const dep of deps) {
          // Check if it's a range reference (has 'from' and 'to')
          if ('from' in dep && 'to' in dep) {
            const range = dep as RangeRef
            const expanded = this.expandRange(range)
            if (expanded.length > 0) {
              cellRefs.push(...expanded)
            } else {
              // Large range - expandRange returned [] to avoid freeze
              // Add column-level marker dependencies (row -1 signals "whole column")
              // This ensures edits to these columns still trigger recalculation
              const startCol = Math.min(range.from.col, range.to.col)
              const endCol = Math.max(range.from.col, range.to.col)
              for (let col = startCol; col <= endCol; col++) {
                cellRefs.push({ row: -1, col, sheet: range.sheet })
              }
            }
          } else {
            // It's a single cell reference
            cellRefs.push(dep as CellRef)
          }
        }
      }

      return cellRefs
    } catch {
      return []
    }
  }

  /**
   * Expand a range reference to individual cell references
   *
   * IMPORTANT: This method has a hard size limit (Safety Guard)
   * If a range exceeds DEPENDENCY_EXPANSION_THRESHOLD, returns empty array instead of freezing.
   * Caller (extractDependencies) handles empty array by adding column-level markers.
   * Large ranges should be routed to backend for evaluation.
   */
  private expandRange(range: RangeRef): CellRef[] {
    const startRow = Math.min(range.from.row, range.to.row)
    const endRow = Math.max(range.from.row, range.to.row)
    const startCol = Math.min(range.from.col, range.to.col)
    const endCol = Math.max(range.from.col, range.to.col)

    // Calculate total cells in range
    const rowCount = endRow - startRow + 1
    const colCount = endCol - startCol + 1
    const totalCells = rowCount * colCount

    // Safety guard: prevent expansion of huge ranges that would freeze the app
    // Return empty array - caller will add column-level markers for dependency tracking
    if (totalCells > FormulaService.DEPENDENCY_EXPANSION_THRESHOLD) {
      const rangeStr = `${columnIndexToLetter(startCol - 1)}${startRow}:${columnIndexToLetter(endCol - 1)}${endRow}`
      console.warn(
        `[FormulaService] Range expansion skipped (using column-level deps): ${rangeStr} has ${totalCells.toLocaleString()} cells (limit: ${FormulaService.DEPENDENCY_EXPANSION_THRESHOLD.toLocaleString()})`
      )
      return []
    }

    const cells: CellRef[] = []
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        cells.push({ row, col, sheet: range.sheet })
      }
    }

    return cells
  }

  /**
   * Register a formula and update the dependency graph
   */
  registerFormula(cellKey: CellKey, formula: string, position: CellPosition): void {
    const cleanFormula = this.normalizeA1ReferenceWhitespace(stripFormulaPrefix(formula))
    const pendingBackend = this.pendingBackendEvals.get(cellKey)
    const pendingAggregate = this.pendingAggregates.get(cellKey)
    const shouldPreserveBackend =
      pendingBackend && pendingBackend.formula === cleanFormula
    const shouldPreserveAggregate =
      pendingAggregate &&
      this.normalizeA1ReferenceWhitespace(stripFormulaPrefix(pendingAggregate.formula)) === cleanFormula

    // Remove old dependencies first (but preserve pending entries for same formula)
    this.unregisterFormula(cellKey)
    if (shouldPreserveBackend && pendingBackend) {
      this.pendingBackendEvals.set(cellKey, pendingBackend)
    }
    if (shouldPreserveAggregate && pendingAggregate) {
      this.pendingAggregates.set(cellKey, pendingAggregate)
    }

    // CRITICAL: Sanitize formula before storage to remove UI-only annotations
    // like "B1 (Column Name)" which are display-only and break parsers.
    // This ensures formulaStorage only contains raw, parseable formulas.
    const sanitizedFormula = this.normalizeA1ReferenceWhitespace(formula)

    // Store the sanitized formula string
    this.formulaStorage.set(cellKey, sanitizedFormula)
    if (this.isVolatileFormula(sanitizedFormula)) {
      this.volatileCells.add(cellKey)
    } else {
      this.volatileCells.delete(cellKey)
    }

    // Extract dependencies (use sanitized formula)
    const deps = this.extractDependencies(sanitizedFormula, position)

    // Build reverse dependencies (what this cell depends on)
    const thisCellDeps = new Set<string>()

    // Update dependency graph
    for (const dep of deps) {
      const depKey = this.refToKey(dep)
      if (!depKey) continue
      if (depKey === cellKey) continue
      thisCellDeps.add(depKey)

      // Add this cell as a dependent of the referenced cell
      if (!this.dependencyGraph.has(depKey)) {
        this.dependencyGraph.set(depKey, new Set())
      }
      this.dependencyGraph.get(depKey)!.add(cellKey)
    }

    // Store reverse dependencies for cleanup
    this.reverseDependencies.set(cellKey, thisCellDeps)
  }

  /**
   * Unregister a formula and clean up the dependency graph
   */
  unregisterFormula(cellKey: CellKey): void {
    // Remove formula string
    this.formulaStorage.delete(cellKey)
    this.volatileCells.delete(cellKey)
    this.volatileBackendEvalTimestamps.delete(cellKey)
    // Clear any pending async operations for this cell
    this.clearPendingAggregate(cellKey)
    this.clearPendingBackendEval(cellKey)

    // Get what this cell depended on
    const deps = this.reverseDependencies.get(cellKey)
    if (deps) {
      // Remove this cell from each dependency's dependents list
      for (const depKey of deps) {
        const dependents = this.dependencyGraph.get(depKey)
        if (dependents) {
          dependents.delete(cellKey)
          if (dependents.size === 0) {
            this.dependencyGraph.delete(depKey)
          }
        }
      }
    }

    // Clear reverse dependencies
    this.reverseDependencies.delete(cellKey)
  }

  /**
   * Get cells that depend on a given cell
   */
  getDependents(cellKey: CellKey): Set<string> {
    return this.dependencyGraph.get(cellKey) || new Set()
  }

  /**
   * Get all formula cells that depend on any cell in the given columns
   * Used for column-level dependency invalidation (e.g., paste, fill, cut)
   *
   * @param columnIds - Array of column IDs that were modified
   * @returns Array of cell keys (formula cells) that depend on any cell in those columns
   */
  getDependentsForColumns(columnIds: string[]): string[] {
    const dependentCellKeys = new Set<string>()

    // For each column that changed
    for (const columnId of columnIds) {
      // Check all cells in the dependency graph
      for (const [sourceCellKey, dependents] of this.dependencyGraph.entries()) {
        // If this source cell is in one of the changed columns
        const parts = sourceCellKey.split(':')
        if (parts.length === 2 && parts[1] === columnId) {
          // Add all cells that depend on it
          for (const dependent of dependents) {
            dependentCellKeys.add(dependent)
          }
        }
      }
    }

    return Array.from(dependentCellKeys)
  }

  /**
   * Batch recalculate formulas for specific cells (column-level invalidation)
   * More efficient than recalculating one by one.
   *
   * @param cellKeys - Array of cell keys (formula cells) to recalculate
   * @returns Array of formula edits with computed values
   */
  recalculateFormulaCells(cellKeys: string[]): FormulaEdit[] {
    const edits: FormulaEdit[] = []

    // Sort cells in dependency order to handle chains correctly
    const { sorted, circular } = topologicalSort(
      cellKeys,
      (key) => Array.from(this.getDependents(key))
    )

    // Mark circular references as errors
    for (const circularKey of circular) {
      const formula = this.formulaStorage.get(circularKey)
      if (formula) {
        const { row, columnId } = this.keyToParts(circularKey)
        if (row !== null && columnId) {
          edits.push({
            row,
            columnId,
            computedValue: null,
            error: {
              type: '#CIRCULAR!' as FormulaErrorType,
              message: 'Circular reference detected',
            },
          })
        }
      }
    }

    // Use temporary overrides for chained dependencies
    const overrides = new Map<CellKey, unknown>()
    this.overrideValues = overrides

    try {
      for (const key of sorted) {
        const formula = this.formulaStorage.get(key)
        if (!formula) continue // Not a formula cell

        const { row, columnId } = this.keyToParts(key)
        if (row === null || !columnId) continue

        const position = this.keyToPosition(key)
        if (!position) continue

        const result = this.evaluate(formula, position)
        const computedValue = result.error ? null : result.value

        // Make this computed value visible to downstream evaluations
        overrides.set(key, computedValue)

        edits.push({
          row,
          columnId,
          computedValue: computedValue,
          error: result.error,
        })
      }
    } finally {
      this.overrideValues = null
    }

    return edits
  }

  /**
   * Recalculate volatile formulas and any dependents that hang off them.
   * Used for explicit spreadsheet recalculation events (edit-driven or manual recalc),
   * not for background polling.
   */
  recalculateVolatileCells(excludeCellKeys: Iterable<CellKey> = []): FormulaEdit[] {
    const excluded = new Set(excludeCellKeys)
    const volatileKeys = this.getVolatileFormulaCells()
      .filter((cellKey) => !excluded.has(cellKey))
    if (volatileKeys.length === 0) return []
    return this.recalculateFormulaCells(volatileKeys)
  }

  /**
   * Recalculate all formulas that depend on a changed cell
   * Returns edits to apply (with source='formula')
   */
  recalculateDependents(cellKey: CellKey): FormulaEdit[] {
    const edits: FormulaEdit[] = []

    // Get all cells that need recalculation in dependency order
    const { sorted, circular } = topologicalSort(
      [cellKey],
      (key) => Array.from(this.getDependents(key))
    )

    // Mark circular references as errors
    for (const circularKey of circular) {
      const formula = this.formulaStorage.get(circularKey)
      if (formula) {
        const { row, columnId } = this.keyToParts(circularKey)
        if (row !== null && columnId) {
          edits.push({
            row,
            columnId,
            computedValue: null,
            error: {
              type: '#CIRCULAR!' as FormulaErrorType,
              message: 'Circular reference detected',
            },
          })
        }
      }
    }

    // Recalculate in dependency order (skip the source cell itself).
    // IMPORTANT: apply temporary overrides so that downstream dependents
    // see updated upstream computed values within the same recalculation pass.
    const overrides = new Map<CellKey, unknown>()
    this.overrideValues = overrides

    try {
      for (const key of sorted) {
        if (key === cellKey) continue // Skip source cell

        const formula = this.formulaStorage.get(key)
        if (!formula) continue // Not a formula cell

        const { row, columnId } = this.keyToParts(key)
        if (row === null || !columnId) continue

        const position = this.keyToPosition(key)
        if (!position) continue

        const result = this.evaluate(formula, position)
        const computedValue = result.error ? null : result.value

        // Make this computed value visible to downstream evaluations immediately
        overrides.set(key, computedValue)

        edits.push({
          row,
          columnId,
          computedValue: computedValue,
          error: result.error,
        })
      }
    } finally {
      this.overrideValues = null
    }

    return edits
  }

  /**
   * Detect if a cell is part of a circular reference
   */
  detectCycle(cellKey: CellKey): boolean {
    const visited = new Set<string>()
    const inStack = new Set<string>()

    const hasCycle = (key: string): boolean => {
      if (inStack.has(key)) return true
      if (visited.has(key)) return false

      visited.add(key)
      inStack.add(key)

      const dependents = this.getDependents(key)
      for (const dep of dependents) {
        if (hasCycle(dep)) return true
      }

      inStack.delete(key)
      return false
    }

    return hasCycle(cellKey)
  }

  /**
   * Get all formula cells
   */
  getAllFormulaCells(): Map<CellKey, string> {
    return new Map(this.formulaStorage)
  }

  /**
   * Clear all formulas (e.g., when loading new data)
   */
  clear(): void {
    this.formulaStorage.clear()
    this.dependencyGraph.clear()
    this.reverseDependencies.clear()
    this.pendingAggregates.clear()
    this.pendingBackendEvals.clear()
    this.volatileCells.clear()
    this.volatileBackendEvalTimestamps.clear()
  }

  // ============ Async Aggregate Methods (Phase 5.2) ============

  /**
   * Check if a value is the pending calculation sentinel
   */
  static isPendingCalculation(value: unknown): boolean {
    return isPendingCalculation(value)
  }

  /**
   * Set async aggregate context (called by SpreadsheetView)
   */
  setAsyncAggregateContext(context: AsyncAggregateContext | undefined): void {
    this.asyncAggregateContext = context
  }

  /**
   * Set callback for async aggregate completion
   */
  setAsyncAggregateCallback(callback: ((cellKey: string, value: number, requestId: string) => void) | undefined): void {
    this.onAsyncAggregateComplete = callback
  }

  /**
   * Set backend evaluation context (called by SpreadsheetView)
   */
  setBackendEvalContext(context: BackendEvaluationContext | undefined): void {
    this.backendEvalContext = context
    BACKEND_AUTOCOMPLETE_ENABLED = !!context
  }

  /**
   * Set callback for backend evaluation completion
   */
  setBackendEvalCallback(callback: ((cellKey: string, value: unknown, requestId: string) => void) | undefined): void {
    this.onBackendEvalComplete = callback
  }

  private enqueueBackendEvalForFormula(cleanFormula: string, position: CellPosition, reason?: string): FormulaResult {
    if (!this.backendEvalContext) {
      return {
        value: null,
        error: {
          type: '#VALUE!' as FormulaErrorType,
          message: 'Formula requires backend evaluation which is not available',
        },
      }
    }

    const row0 = position.row - 1 // Convert 1-based to 0-based
    const columnId = this.columnLookup.indexToId(position.col - 1)
    const cellKey = `${row0}:${columnId}`

    if (reason) {
      console.log('[FormulaService] Enqueue backend eval (', reason, '):', cleanFormula, '| cellKey:', cellKey)
    }

    const existingPending = this.pendingBackendEvals.get(cellKey)
    if (existingPending && existingPending.formula === cleanFormula) {
      return { value: FormulaService.CALC_PENDING_SENTINEL }
    }

    const estimatedCellCount = this.estimateReferencedCellCount(cleanFormula, position)
    if (estimatedCellCount !== null && estimatedCellCount > FormulaService.MAX_BACKEND_RANGE_CELLS) {
      return {
        value: null,
        error: {
          type: '#VALUE!' as FormulaErrorType,
          message: `Range too large for backend evaluation (${estimatedCellCount.toLocaleString()} cells). Use an aggregate or reduce the range.`,
        },
      }
    }

    // Build rowOrderSlice if needed (sorted/grouped data)
    let rowOrderSlice: { start: number; data: number[] } | undefined
    let rowBounds: { start: number; end: number } | undefined
    if (
      this.backendEvalContext.rowOrder &&
      this.backendEvalContext.rowOrder.length > 0 &&
      (this.backendEvalContext.isSorted || this.backendEvalContext.isGrouped || this.backendEvalContext.isViewFiltered)
    ) {
      const bounds = this.extractRowBounds(cleanFormula, position)
      if (bounds) {
        if (bounds.minRow < 0 || bounds.maxRow < 0 || bounds.maxRow >= this.backendEvalContext.rowOrder.length) {
          return { value: '#REF!' }
        }
        const sliceStart = Math.max(0, bounds.minRow)
        const sliceEnd = bounds.maxRow + 1 // Slice is exclusive at end
        const sliceData = this.backendEvalContext.rowOrder.slice(sliceStart, sliceEnd)
        if (sliceData.length !== sliceEnd - sliceStart) {
          return { value: '#REF!' }
        }
        rowOrderSlice = { start: sliceStart, data: sliceData }
      }
    } else if (
      (this.backendEvalContext.isSorted || this.backendEvalContext.isGrouped || this.backendEvalContext.isViewFiltered) &&
      this.backendEvalContext.supportsRowOrderSlice
    ) {
      const bounds = this.extractRowBounds(cleanFormula, position)
      if (bounds) {
        rowBounds = { start: bounds.minRow, end: bounds.maxRow }
      }
    }

    const requestId = crypto.randomUUID()
    this.pendingBackendEvals.set(cellKey, { requestId, formula: cleanFormula, position })

    // Build columnLetterToIdMap from DepParser (without expanding ranges)
    const columnLetterToIdMap: Record<string, string> = {}
    try {
      const deps = this.depParser.parse(cleanFormula, position)
      if (Array.isArray(deps)) {
        for (const dep of deps) {
          if ('from' in dep && 'to' in dep) {
            // Range reference - extract column bounds
            const range = dep as RangeRef
            const startCol = Math.min(range.from.col, range.to.col)
            const endCol = Math.max(range.from.col, range.to.col)
            for (let col = startCol; col <= endCol; col++) {
              const colIndex = col - 1 // Convert to 0-based
              const colLetter = columnIndexToLetter(colIndex)
              const colId = this.columnLookup.indexToId(colIndex)
              columnLetterToIdMap[colLetter] = colId
            }
          } else {
            // Single cell reference
            const cell = dep as CellRef
            const colIndex = cell.col - 1 // Convert to 0-based
            const colLetter = columnIndexToLetter(colIndex)
            const colId = this.columnLookup.indexToId(colIndex)
            columnLetterToIdMap[colLetter] = colId
          }
        }
      }
    } catch (e) {
      console.error('[FormulaService] Failed to parse formula dependencies:', e)
    }

    this.backendEvalContext.enqueueBackendEval({
      cellKey,
      requestId,
      formula: cleanFormula,
      position: { row: row0, col: position.col - 1 }, // Convert to 0-based
      columnLetterToIdMap,
      rowOrderSlice,
      rowBounds,
    })

    return { value: FormulaService.CALC_PENDING_SENTINEL }
  }

  /**
   * Detect if formula is a delegatable full-column aggregate
   * Returns null if not delegatable, or { func, columnIndex } if it is
   *
   * Examples that match:
   * - =SUM(A:A) -> { func: 'SUM', columnIndex: 0 }
   * - =AVERAGE(B:B) -> { func: 'AVERAGE', columnIndex: 1 }
   *
   * Examples that DON'T match (fall back to sync):
   * - =SUM(A1:A100) -> row range, view order issue
   * - =SUM(A:A, B:B) -> multiple ranges
   * - =SUM(A:A) + 1 -> mixed expression
   */
  private detectDelegatableAggregate(formula: string): { func: string; columnIndex: number } | null {
    const match = formula.match(FormulaService.FULL_COLUMN_PATTERN)
    if (!match) return null

    const func = match[1]!.toUpperCase()
    const columnLetter = match[2]!.toUpperCase()

    // Convert column letter to index
    const columnIndex = columnLetterToIndex(columnLetter)

    return { func, columnIndex }
  }

  /**
   * Detect if formula is a large row range aggregate that should be routed to backend
   * Returns null if not applicable, or details if it should be delegated
   *
   * Examples that match (if range > threshold):
   * - =SUM(B1:B1875677) -> { func: 'SUM', columnIndex: 1, startRow: 0, endRow: 1875676, rowCount: 1875677 }
   * - =AVERAGE(A100:A50000) -> { func: 'AVERAGE', columnIndex: 0, startRow: 99, endRow: 49999, rowCount: 49900 }
   *
   * Examples that DON'T match:
   * - =SUM(A1:A100) -> too small (< LARGE_RANGE_THRESHOLD)
   * - =SUM(A1:B100) -> multi-column range
   * - =SUM(A1:A100) + 1 -> mixed expression
   */
  private detectLargeRowRangeAggregate(formula: string): {
    func: string
    columnIndex: number
    startRow: number
    endRow: number
    rowCount: number
  } | null {
    const match = formula.match(FormulaService.ROW_RANGE_AGGREGATE_PATTERN)
    if (!match) return null

    const func = match[1]!.toUpperCase()
    const columnLetter = match[2]!.toUpperCase()
    const startRowStr = match[3]!
    const endRowStr = match[4]!

    // Parse row numbers (1-based in formula)
    const startRow1Based = parseInt(startRowStr, 10)
    const endRow1Based = parseInt(endRowStr, 10)
    if (startRow1Based <= 0 || endRow1Based <= 0) {
      return null
    }

    // Convert to 0-based and calculate range
    const startRow = Math.min(startRow1Based, endRow1Based) - 1
    const endRow = Math.max(startRow1Based, endRow1Based) - 1
    const rowCount = endRow - startRow + 1

    // Only route to backend if range is large enough
    if (rowCount < FormulaService.LARGE_RANGE_THRESHOLD) {
      return null
    }

    const columnIndex = columnLetterToIndex(columnLetter)

    return { func, columnIndex, startRow, endRow, rowCount }
  }

  /**
   * Extract min/max row numbers from formula dependencies without expanding ranges
   * Returns null if no dependencies, or { minRow, maxRow } in 0-based VIEW coordinates
   */
  private extractRowBounds(formula: string, position: CellPosition): { minRow: number; maxRow: number } | null {
    try {
      const deps = this.depParser.parse(
        this.normalizeA1ReferenceWhitespace(stripFormulaPrefix(formula)),
        position
      )
      if (!Array.isArray(deps) || deps.length === 0) return null

      let minRow = Infinity
      let maxRow = -Infinity

      for (const dep of deps) {
        if ('from' in dep && 'to' in dep) {
          // Range reference
          const range = dep as RangeRef
          const startRow = Math.min(range.from.row, range.to.row)
          const endRow = Math.max(range.from.row, range.to.row)
          minRow = Math.min(minRow, startRow)
          maxRow = Math.max(maxRow, endRow)
        } else {
          // Single cell reference
          const cell = dep as CellRef
          minRow = Math.min(minRow, cell.row)
          maxRow = Math.max(maxRow, cell.row)
        }
      }

      if (minRow === Infinity || maxRow === -Infinity) return null

      // Convert from 1-based (parser) to 0-based
      return { minRow: minRow - 1, maxRow: maxRow - 1 }
    } catch {
      return null
    }
  }

  /**
   * Estimate total referenced cell count without expanding ranges.
   * Returns null if dependencies cannot be parsed.
   */
  private estimateReferencedCellCount(formula: string, position: CellPosition): number | null {
    try {
      const deps = this.depParser.parse(
        this.normalizeA1ReferenceWhitespace(stripFormulaPrefix(formula)),
        position
      )
      if (!Array.isArray(deps) || deps.length === 0) return null

      let total = 0
      for (const dep of deps) {
        if ('from' in dep && 'to' in dep) {
          const range = dep as RangeRef
          const rowCount = Math.abs(range.to.row - range.from.row) + 1
          const colCount = Math.abs(range.to.col - range.from.col) + 1
          total += rowCount * colCount
        } else {
          total += 1
        }
      }

      return total
    } catch {
      return null
    }
  }

  /**
   * Determine if formula should use backend evaluation
   * Returns true if formula references unloaded ranges on a large dataset
   */
  private shouldUseBackendEval(
    formula: string,
    position: CellPosition,
    ctx: BackendEvaluationContext
  ): boolean {
    // Only route to backend for large datasets
    if (!ctx.isLargeDataset) return false

    const needsRowOrder = ctx.isSorted || ctx.isGrouped || ctx.isViewFiltered
    const missingRowOrder = needsRowOrder && (!ctx.rowOrder || ctx.rowOrder.length === 0)
    // CRITICAL: If view mapping is active but rowOrder is missing, only proceed if we can resolve slices lazily.
    if (missingRowOrder && !ctx.supportsRowOrderSlice) {
      console.warn('[FormulaService] Backend eval blocked: view-mapped data but rowOrder missing')
      return false
    }

    // Extract row bounds without expanding ranges
    const bounds = this.extractRowBounds(formula, position)
    if (!bounds) return false

    const rowCount = bounds.maxRow - bounds.minRow + 1

    // Prefer actual row cache knowledge when available (covers non-contiguous loads).
    let hasUnloadedRefs = false
    if (missingRowOrder && ctx.supportsRowOrderSlice) {
      // Force backend eval to avoid incorrect sync evaluation without a full rowOrder.
      hasUnloadedRefs = true
    } else if (ctx.isRowLoaded) {
      if (rowCount > FormulaService.LARGE_RANGE_THRESHOLD) {
        hasUnloadedRefs = true
      } else {
        for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
          if (!ctx.isRowLoaded(row)) {
            hasUnloadedRefs = true
            break
          }
        }
      }
    } else {
      // Fallback to viewport-based range when row cache visibility isn't provided.
      hasUnloadedRefs =
        bounds.minRow < ctx.loadedRowRange.start ||
        bounds.maxRow >= ctx.loadedRowRange.end
    }

    // Only route to backend if references unloaded data
    if (!hasUnloadedRefs) return false

    // Block INDIRECT (not supported by backend)
    const hasIndirect = /\bINDIRECT\s*\(/i.test(formula)
    if (hasIndirect) return false

    return true
  }

  /**
   * Handle async aggregate result injection
   * Called by SpreadsheetView when backend returns result
   */
  injectAsyncAggregateResult(cellKey: string, value: number, requestId: string): boolean {
    const pending = this.pendingAggregates.get(cellKey)
    if (!pending || pending.requestId !== requestId) {
      // Stale result - cell was re-edited or different request
      return false
    }

    this.pendingAggregates.delete(cellKey)

    // Notify callback (SpreadsheetView will update rowData and recalc dependents)
    this.onAsyncAggregateComplete?.(cellKey, value, requestId)
    return true
  }

  /**
   * Clear a pending async aggregate request without applying a value.
   * Useful when a formula is removed or an async request fails.
   */
  clearPendingAggregate(cellKey: string, requestId?: string): void {
    if (!requestId) {
      this.pendingAggregates.delete(cellKey)
      return
    }

    const pending = this.pendingAggregates.get(cellKey)
    if (pending && pending.requestId === requestId) {
      this.pendingAggregates.delete(cellKey)
    }
  }

  // ============ Backend Evaluation Methods (Phase 3) ============

  /**
   * Handle backend evaluation result injection
   * Called by SpreadsheetView when backend returns result
   */
  injectBackendEvalResult(cellKey: string, value: unknown, requestId: string): boolean {
    const pending = this.pendingBackendEvals.get(cellKey)

    console.log('[FormulaService] injectBackendEvalResult:', cellKey, '| value:', value, '| requestId:', requestId.slice(0, 8),
      '| hasPending:', !!pending, '| pendingId:', pending?.requestId.slice(0, 8))

    if (!pending || pending.requestId !== requestId) {
      // Stale result - cell was re-edited or different request
      console.warn('[FormulaService] Discarding stale backend result:', cellKey,
        '| expected:', pending?.requestId.slice(0, 8), '| received:', requestId.slice(0, 8))
      return false
    }

    // Notify callback BEFORE deleting pending entry.
    // If the callback triggers a re-render that calls evaluate(), the pending
    // entry must still be alive so dedup returns SENTINEL without a second enqueue (B5).
    console.log('[FormulaService] Calling onBackendEvalComplete callback for:', cellKey)
    this.onBackendEvalComplete?.(cellKey, value, requestId)

    // Delete AFTER callback has returned so any synchronous re-evaluate during
    // the callback sees the pending entry and deduplicates correctly.
    this.pendingBackendEvals.delete(cellKey)
    return true
  }

  /**
   * Clear a pending backend evaluation request without applying a value.
   * Useful when a formula is removed or a backend request fails.
   */
  clearPendingBackendEval(cellKey: string, requestId?: string): void {
    if (!requestId) {
      this.pendingBackendEvals.delete(cellKey)
      return
    }

    const pending = this.pendingBackendEvals.get(cellKey)
    if (pending && pending.requestId === requestId) {
      this.pendingBackendEvals.delete(cellKey)
    }
  }

  /**
   * Detect malformed range syntax to avoid parser crashes.
   * Accepts valid cell ranges (A1:B2), full columns (A:B), and row ranges (1:10).
   */
  private hasInvalidRangeSyntax(formula: string): boolean {
    if (!formula.includes(':')) return false

    const sanitized = this.stripStringLiterals(formula)
    if (!sanitized.includes(':')) return false

    let remaining = sanitized

    // Cell range: A1:B2 (supports $ absolute refs)
    remaining = remaining.replace(
      /\$?[A-Za-z]{1,3}\$?\d+\s*:\s*\$?[A-Za-z]{1,3}\$?\d+/g,
      ''
    )
    // Full column range: A:B
    remaining = remaining.replace(
      /\$?[A-Za-z]{1,3}\s*:\s*\$?[A-Za-z]{1,3}/g,
      ''
    )
    // Row range: 1:10 (ensure it's not part of a cell ref like B1:50000)
    remaining = remaining.replace(
      /(^|[^A-Za-z])(\$?\d+\s*:\s*\$?\d+)(?=$|[^A-Za-z])/g,
      '$1'
    )

    return remaining.includes(':')
  }

  /**
   * Extract function names from a formula (e.g., SUM, XLOOKUP, STDEV.S).
   * Ignores text inside string literals.
   */
  private extractFunctionNames(formula: string): string[] {
    const sanitized = this.stripStringLiterals(formula)
    const names = new Set<string>()
    const regex = /\b([A-Za-z][A-Za-z0-9\.]*)\s*\(/g
    let match: RegExpExecArray | null

    while ((match = regex.exec(sanitized)) !== null) {
      const name = match[1]!.toUpperCase()
      names.add(name)
    }

    return Array.from(names)
  }

  private hasUnsupportedFunctions(formula: string): boolean {
    const functions = this.extractFunctionNames(formula)
    if (functions.length === 0) return false

    const isSupported = (fn: string): boolean => {
      if (SUPPORTED_FUNCTIONS_SET && SUPPORTED_FUNCTIONS_SET.size > 0) {
        if (SUPPORTED_FUNCTIONS_SET.has(fn)) return true
      }
      return false
    }

    return functions.some(fn => !isSupported(fn))
  }

  /**
   * Detect if formula uses backend scalar functions (MAX, MIN, MEDIAN, etc.)
   * These can safely be routed to backend evaluation.
   */
  private usesBackendScalarFunctions(formula: string): boolean {
    const functions = this.extractFunctionNames(formula)
    if (functions.length === 0) return false
    return functions.some(fn => BACKEND_SCALAR_ROUTING_SET.has(fn))
  }

  /**
   * Detect if formula uses spill-deferred functions (FILTER, UNIQUE, etc.)
   * These return arrays and would cause #SPILL! in single-cell context.
   */
  private usesBackendArrayFunctions(formula: string): boolean {
    const functions = this.extractFunctionNames(formula)
    if (functions.length === 0) return false
    return functions.some(fn => SPILL_DEFERRED_SET.has(fn))
  }

  private getUnsupportedFunctionNameFromMessage(message: string): string | null {
    const match = message.match(/Function\s+([A-Za-z0-9\._]+)\s+is not implemented/i)
    if (!match) return null
    return match[1] ? match[1].toUpperCase() : null
  }

  private getBackendFallbackFunction(formula: string, message?: string): string | null {
    const text = message ?? ''
    const explicit = this.getUnsupportedFunctionNameFromMessage(text)
    if (explicit) return explicit

    if (!/unknown function|not implemented/i.test(text)) {
      return null
    }

    const functions = this.extractFunctionNames(formula)
    for (const fn of functions) {
      if (BACKEND_SCALAR_ROUTING_SET.has(fn)) {
        if (!SUPPORTED_FUNCTIONS_SET || !SUPPORTED_FUNCTIONS_SET.has(fn)) {
          return fn
        }
      }
    }

    return null
  }

  private tryBackendFallback(
    cleanFormula: string,
    position: CellPosition,
    message?: string,
    source?: 'volatile'
  ): FormulaResult | null {
    if (!this.backendEvalContext) return null

    const fn = this.getBackendFallbackFunction(cleanFormula, message)
    if (!fn) return null

    if (SPILL_DEFERRED_SET.has(fn)) {
      return null
    }
    if (!BACKEND_SCALAR_ROUTING_SET.has(fn)) {
      return null
    }

    if (source === 'volatile') {
      const row0 = position.row - 1
      const columnId = this.columnLookup.indexToId(position.col - 1)
      const cellKey = `${row0}:${columnId}`
      const now = Date.now()
      const last = this.volatileBackendEvalTimestamps.get(cellKey) ?? 0
      if (now - last < FormulaService.VOLATILE_BACKEND_COOLDOWN_MS) {
        return null
      }
      this.volatileBackendEvalTimestamps.set(cellKey, now)
    }

    return this.enqueueBackendEvalForFormula(cleanFormula, position, 'sync-fallback')
  }

  /**
   * Remove string literals so we don't misinterpret ":" inside quotes.
   */
  private stripStringLiterals(input: string): string {
    let out = ''
    let inString = false

    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!
      if (ch === '"') {
        // Excel escapes quotes inside strings with a doubled quote: ""
        if (inString && input[i + 1] === '"') {
          out += '""'
          i++
          continue
        }

        inString = !inString
        out += ' '
        continue
      }

      out += inString ? ' ' : ch
    }

    return out
  }

  /**
   * Bulk-load formulas from persistence layer (e.g., project file)
   * Registers each formula and builds the dependency graph.
   *
   * @param formulas - Map of cellKey to formula string
   * @returns Array of formula edits to apply (with computed values)
   */
  loadFormulas(formulas: Map<CellKey, string>): FormulaEdit[] {
    const edits: FormulaEdit[] = []

    for (const [cellKey, formula] of formulas.entries()) {
      // Parse cellKey to get position
      const { row, columnId } = this.keyToParts(cellKey)
      if (row === null || !columnId) {
        console.warn(`[FormulaService] Invalid cellKey: ${cellKey}`)
        continue
      }

      const position = this.keyToPosition(cellKey)
      if (!position) {
        console.warn(`[FormulaService] Cannot determine position for cellKey: ${cellKey}`)
        continue
      }

      // Register formula (builds dependency graph)
      this.registerFormula(cellKey, formula, position)

      // Evaluate formula to get initial computed value
      const result = this.evaluate(formula, position)

      edits.push({
        row,
        columnId,
        computedValue: result.value,
        error: result.error,
      })
    }

    return edits
  }

  // ============ Persistence API ============

  /**
   * Get all formulas for persistence (project save)
   * Returns a map of cellKey -> formula string
   */
  getAllFormulas(): Map<CellKey, string> {
    return new Map(this.formulaStorage)
  }

  /**
   * Set formulas from persistence (project load)
   * Registers formulas and returns edits with computed values
   *
   * @param formulas - Map of cellKey to formula string
   * @returns Array of formula edits to apply to rowData
   */
  setFormulas(formulas: Map<CellKey, string>): FormulaEdit[] {
    return this.loadFormulas(formulas)
  }

  /**
   * UI helper: annotate an A1 formula string with current column display names.
   * Example: "=A1+1" → "=A1 (Blood_Pressure)+1"
   *
   * This does NOT affect evaluation; it's only for display.
   */
  formatFormulaWithColumnNames(
    formula: string,
    getColumnNameById: (columnId: string) => string | undefined
  ): string {
    return annotateA1WithColumnNames(formula, (columnIndex0) => {
      const columnId = this.columnLookup.indexToId(columnIndex0)
      return getColumnNameById(columnId)
    })
  }

  /**
   * Convenience: get stored formula for a cell and format it with column names.
   */
  getFormattedFormula(
    cellKey: CellKey,
    getColumnNameById: (columnId: string) => string | undefined
  ): string | undefined {
    const formula = this.getFormula(cellKey)
    if (!formula) return undefined
    return this.formatFormulaWithColumnNames(formula, getColumnNameById)
  }

  // ============ Helper methods ============

  /**
   * Convert CellRef to cell key format.
   * Parser row is treated as VIEW row, mapped to MODEL row for storage.
   * This ensures dependency keys are stable (keyed by model row) even after sorting.
   *
   * Special case: row=-1 indicates a column-level dependency (for large ranges).
   * These keys use format "*:columnId" to signal "any row in this column".
   */
  private refToKey(ref: CellRef): CellKey | null {
    // Parser uses 1-based rows AND columns
    const columnId = this.columnLookup.indexToId(ref.col - 1) // col is 1-based in parser
    if (!columnId) {
      return null
    }

    // Special marker for column-level dependencies (large ranges)
    if (ref.row === -1) {
      return `*:${columnId}`
    }

    // Map view row to model row so dependency keys are in model space
    const modelRow = this.viewToModelRow(ref.row)
    return `${modelRow}:${columnId}`
  }

  /**
   * Check for invalid column references (out of bounds).
   */
  private hasInvalidColumnRefs(formula: string, position: CellPosition): boolean {
    try {
      const deps = this.depParser.parse(
        this.normalizeA1ReferenceWhitespace(stripFormulaPrefix(formula)),
        position
      )
      if (!Array.isArray(deps) || deps.length === 0) return false

      const outOfBounds = (col: number): boolean =>
        col < 1 || col > this.columnCount

      for (const dep of deps) {
        if ('from' in dep && 'to' in dep) {
          const range = dep as RangeRef
          if (outOfBounds(range.from.col) || outOfBounds(range.to.col)) {
            return true
          }
        } else {
          const cell = dep as CellRef
          if (outOfBounds(cell.col)) {
            return true
          }
        }
      }
    } catch {
      return false
    }

    return false
  }

  private referencesOwnCell(formula: string, position: CellPosition): boolean {
    try {
      const deps = this.depParser.parse(
        this.normalizeA1ReferenceWhitespace(stripFormulaPrefix(formula)),
        position
      )
      if (!Array.isArray(deps) || deps.length === 0) return false

      for (const dep of deps) {
        if ('from' in dep && 'to' in dep) {
          const range = dep as RangeRef
          const startRow = Math.min(range.from.row, range.to.row)
          const endRow = Math.max(range.from.row, range.to.row)
          const startCol = Math.min(range.from.col, range.to.col)
          const endCol = Math.max(range.from.col, range.to.col)
          if (
            position.row >= startRow &&
            position.row <= endRow &&
            position.col >= startCol &&
            position.col <= endCol
          ) {
            return true
          }
        } else {
          const cell = dep as CellRef
          if (cell.row === position.row && cell.col === position.col) {
            return true
          }
        }
      }
    } catch {
      return false
    }

    return false
  }

  /**
   * For large datasets without backend context, only allow sync evaluation
   * if all referenced rows are loaded in the local cache.
   */
  private canSyncEvaluateWithoutBackend(formula: string, position: CellPosition): boolean {
    const ctx = this.asyncAggregateContext
    if (!ctx?.isLargeDataset) return true

    const bounds = this.extractRowBounds(formula, position)
    if (!bounds) return true

    const rowCount = bounds.maxRow - bounds.minRow + 1
    if (rowCount > FormulaService.DEPENDENCY_EXPANSION_THRESHOLD) {
      return false
    }

    const rowData = ctx.getRowData()
    for (let row = bounds.minRow; row <= bounds.maxRow; row += 1) {
      const modelRow = this.viewToModelRow(row + 1)
      if (!rowData.has(modelRow)) {
        return false
      }
    }

    return true
  }

  /**
   * Detect volatile formulas that should be recalculated periodically.
   */
  private isVolatileFormula(formula: string): boolean {
    const functions = this.extractFunctionNames(formula)
    if (functions.length === 0) return false
    return functions.some(fn =>
      fn === 'NOW' ||
      fn === 'TODAY' ||
      fn === 'RAND' ||
      fn === 'RANDBETWEEN'
    )
  }

  /**
   * Get all volatile formula cell keys.
   */
  getVolatileFormulaCells(): CellKey[] {
    return Array.from(this.volatileCells)
  }

  /**
   * Convert cell key to CellPosition for parser
   */
  private keyToPosition(key: CellKey): CellPosition | null {
    const parts = key.split(':')
    if (parts.length !== 2) return null

    const row = parseInt(parts[0]!, 10)
    if (isNaN(row)) return null

    const columnId = parts[1]!
    const col = this.columnLookup.idToIndex(columnId)
    if (col < 0) return null

    // Convert 0-based row AND col to 1-based for parser
    return { row: row + 1, col: col + 1, sheet: 'Sheet1' }
  }

  /**
   * Parse cell key to row and columnId
   */
  private keyToParts(key: CellKey): { row: number | null; columnId: string | null } {
    const parts = key.split(':')
    if (parts.length !== 2) return { row: null, columnId: null }

    const row = parseInt(parts[0]!, 10)
    if (isNaN(row)) return { row: null, columnId: null }

    return { row, columnId: parts[1]! }
  }

  /**
   * Parse error from fast-formula-parser into FormulaError
   */
  private parseError(e: unknown): FormulaError {
    const message = e instanceof Error ? e.message : String(e)

    // Detect error type from message
    if (message.includes('DIV') || message.includes('divide')) {
      return { type: '#DIV/0!', message }
    }
    if (message.includes('NAME') || message.includes('Unknown function')) {
      return { type: '#NAME?', message }
    }
    if (message.includes('REF') || message.includes('reference')) {
      return { type: '#REF!', message }
    }
    if (message.includes('VALUE') || message.includes('type')) {
      return { type: '#VALUE!', message }
    }
    if (message.includes('NUM') || message.includes('number')) {
      return { type: '#NUM!', message }
    }
    if (message.includes('NULL')) {
      return { type: '#NULL!', message }
    }
    if (message.includes('N/A')) {
      return { type: '#N/A', message }
    }

    return { type: '#ERROR!', message }
  }

  /**
   * Adjust a formula for fill-handle operation (relative reference shifting)
   *
   * When filling formulas (e.g., drag-to-fill), cell references should shift:
   * - A1 in row 0 becomes A2 when filled to row 1
   * - A1:B3 in row 0 becomes A2:B4 when filled to row 1
   *
   * @param baseFormula - Original formula (e.g., "=A1*2" or "=SUM(A1:B3)")
   * @param fromPos - Source position (row, col 1-based)
   * @param toPos - Target position (row, col 1-based)
   * @returns Adjusted formula with shifted references
   *
   * Example:
   * ```ts
   * getFilledFormula("=A1*2", {row: 1, col: 1}, {row: 2, col: 1})
   * // Returns: "=A2*2"
   *
   * getFilledFormula("=SUM(A1:B3)", {row: 1, col: 1}, {row: 3, col: 1})
   * // Returns: "=SUM(A3:B5)"
   * ```
   */
  getFilledFormula(
    baseFormula: string,
    fromPos: { row: number; col: number },
    toPos: { row: number; col: number }
  ): string {
    const rowDelta = toPos.row - fromPos.row
    const colDelta = toPos.col - fromPos.col

    // If no shift, return original formula
    if (rowDelta === 0 && colDelta === 0) {
      return baseFormula
    }

    // Strip leading = if present, we'll add it back at the end
    const stripped = stripFormulaPrefix(baseFormula)

    // Regex to match A1-style cell references (single cells and ranges)
    // Matches: A1, B2, AB123, A1:B3, $A$1, A$1, $A1, etc.
    // Supports absolute references ($A$1) which should NOT shift
    const cellRefPattern = /(\$?)([A-Z]+)(\$?)(\d+)(?::(\$?)([A-Z]+)(\$?)(\d+))?/gi

    const adjusted = stripped.replace(
      cellRefPattern,
      (
        _match,
        colAbs1,
        col1,
        rowAbs1,
        row1,
        colAbs2,
        col2,
        rowAbs2,
        row2
      ) => {
        // Parse first cell
        const colIndex1 = columnLetterToIndex(col1)
        const rowIndex1 = parseInt(row1, 10)

        // Shift first cell (only if not absolute)
        const newRow1 = rowAbs1 ? rowIndex1 : rowIndex1 + rowDelta
        const newCol1 = colAbs1 ? colIndex1 : colIndex1 + colDelta

        // Validate bounds (1-based row, 0-based col)
        if (newRow1 < 1 || newCol1 < 0) {
          return '#REF!' // Out of bounds
        }

        const newCol1Letter = columnIndexToLetter(newCol1)
        let result = `${colAbs1}${newCol1Letter}${rowAbs1}${newRow1}`

        // Handle range (A1:B3)
        if (col2 && row2) {
          const colIndex2 = columnLetterToIndex(col2)
          const rowIndex2 = parseInt(row2, 10)

          // Shift second cell (only if not absolute)
          const newRow2 = rowAbs2 ? rowIndex2 : rowIndex2 + rowDelta
          const newCol2 = colAbs2 ? colIndex2 : colIndex2 + colDelta

          // Validate bounds
          if (newRow2 < 1 || newCol2 < 0) {
            return '#REF!' // Out of bounds
          }

          const newCol2Letter = columnIndexToLetter(newCol2)
          result += `:${colAbs2}${newCol2Letter}${rowAbs2}${newRow2}`
        }

        return result
      }
    )

    return `=${adjusted}`
  }

  /**
   * Update tracked column count (used by invalid reference checks).
   */
  setColumnCount(columnCount: number): void {
    this.columnCount = Math.max(0, columnCount)
  }

  /**
   * Shift formula references for a structural column insert.
   * All relative references at/after the inserted column are shifted right.
   */
  shiftReferencesForColumnInsert(insertAtColIndex: number): FormulaEdit[] {
    const insertAtCol1 = insertAtColIndex + 1
    const shifted = new Map<CellKey, string>()

    for (const [cellKey, formula] of this.formulaStorage.entries()) {
      shifted.set(
        cellKey,
        this.shiftFormulaReferencesForStructuralInsert(formula, insertAtCol1, null)
      )
    }

    this.clear()
    return this.loadFormulas(shifted)
  }

  /**
   * Shift formula references + formula cell keys for a structural row insert.
   * All relative references at/after the inserted row are shifted down.
   */
  shiftReferencesForRowInsert(insertAtRowIndex: number): FormulaEdit[] {
    const insertAtRow1 = insertAtRowIndex + 1
    const shifted = new Map<CellKey, string>()

    for (const [cellKey, formula] of this.formulaStorage.entries()) {
      const { row, columnId } = this.keyToParts(cellKey)
      if (row === null || !columnId) continue
      const newRow = row >= insertAtRowIndex ? row + 1 : row
      const newKey = `${newRow}:${columnId}`
      shifted.set(
        newKey,
        this.shiftFormulaReferencesForStructuralInsert(formula, null, insertAtRow1)
      )
    }

    this.clear()
    return this.loadFormulas(shifted)
  }

  /**
   * Shift formula references for a structural column delete.
   * All references strictly after the deleted column are shifted left.
   */
  shiftReferencesForColumnDelete(deleteAtColIndex: number): FormulaEdit[] {
    const deleteAtCol1 = deleteAtColIndex + 1
    const shifted = new Map<CellKey, string>()

    for (const [cellKey, formula] of this.formulaStorage.entries()) {
      shifted.set(
        cellKey,
        this.shiftFormulaReferencesForStructuralDelete(formula, deleteAtCol1, null)
      )
    }

    this.clear()
    return this.loadFormulas(shifted)
  }

  /**
   * Shift formula references + formula cell keys for a structural row delete.
   * Formulas on the deleted row are removed.
   * All references strictly after the deleted row are shifted up.
   */
  shiftReferencesForRowDelete(deleteAtRowIndex: number): FormulaEdit[] {
    const deleteAtRow1 = deleteAtRowIndex + 1
    const shifted = new Map<CellKey, string>()

    for (const [cellKey, formula] of this.formulaStorage.entries()) {
      const { row, columnId } = this.keyToParts(cellKey)
      if (row === null || !columnId) continue
      if (row === deleteAtRowIndex) continue
      const newRow = row > deleteAtRowIndex ? row - 1 : row
      const newKey = `${newRow}:${columnId}`
      shifted.set(
        newKey,
        this.shiftFormulaReferencesForStructuralDelete(formula, null, deleteAtRow1)
      )
    }

    this.clear()
    return this.loadFormulas(shifted)
  }

  /**
   * Structural insert migration helper for A1 refs.
   * - Column insert: shifts relative column letters >= insertAtCol1.
   * - Row insert: shifts relative row numbers >= insertAtRow1.
   * Absolute refs (`$A$1`) remain pinned on absolute axis.
   */
  private shiftFormulaReferencesForStructuralInsert(
    formula: string,
    insertAtCol1: number | null,
    insertAtRow1: number | null
  ): string {
    const stripped = stripFormulaPrefix(formula)
    const { maskedFormula, stringLiterals } = this.maskStringLiterals(stripped)
    const fullColumnPattern = /(\$?)([A-Z]+)(\$?)\s*:\s*(\$?)([A-Z]+)(\$?)(?!\d)/gi
    const cellRefPattern = /(\$?)([A-Z]+)(\$?)(\d+)(?::(\$?)([A-Z]+)(\$?)(\d+))?/gi

    const shiftColumnRef = (colLetters: string): string => {
      let colIndex = columnLetterToIndex(colLetters)
      if (insertAtCol1 !== null && colIndex + 1 >= insertAtCol1) {
        colIndex += 1
      }
      return columnIndexToLetter(colIndex)
    }

    const withShiftedFullColumns =
      insertAtCol1 === null
        ? maskedFormula
        : maskedFormula.replace(
            fullColumnPattern,
            (_match, colAbs1, col1, rowAbs1, colAbs2, col2, rowAbs2) =>
              `${colAbs1}${shiftColumnRef(col1)}${rowAbs1}:${colAbs2}${shiftColumnRef(col2)}${rowAbs2}`
          )

    const shifted = withShiftedFullColumns.replace(
      cellRefPattern,
      (
        _match,
        colAbs1,
        col1,
        rowAbs1,
        row1,
        colAbs2,
        col2,
        rowAbs2,
        row2
      ) => {
        const shiftCell = (
          colAbs: string,
          colLetters: string,
          rowAbs: string,
          rowDigits: string
        ) => {
          let colIndex = columnLetterToIndex(colLetters)
          let rowIndex = parseInt(rowDigits, 10)

          // Excel semantics: structural inserts shift both relative and absolute refs.
          if (insertAtCol1 !== null && colIndex + 1 >= insertAtCol1) {
            colIndex += 1
          }
          if (insertAtRow1 !== null && rowIndex >= insertAtRow1) {
            rowIndex += 1
          }

          return `${colAbs}${columnIndexToLetter(colIndex)}${rowAbs}${rowIndex}`
        }

        let out = shiftCell(colAbs1, col1, rowAbs1, row1)
        if (col2 && row2) {
          out += `:${shiftCell(colAbs2, col2, rowAbs2, row2)}`
        }
        return out
      }
    )

    const restored = this.restoreStringLiterals(shifted, stringLiterals)
    return `=${restored}`
  }

  private shiftFormulaReferencesForStructuralDelete(
    formula: string,
    deleteAtCol1: number | null,
    deleteAtRow1: number | null
  ): string {
    const stripped = stripFormulaPrefix(formula)
    const { maskedFormula, stringLiterals } = this.maskStringLiterals(stripped)
    const fullColumnPattern = /(\$?)([A-Z]+)(\$?)\s*:\s*(\$?)([A-Z]+)(\$?)(?!\d)/gi
    const cellRefPattern = /(\$?)([A-Z]+)(\$?)(\d+)(?::(\$?)([A-Z]+)(\$?)(\d+))?/gi

    const shiftColumnRef = (colLetters: string): string => {
      let colIndex = columnLetterToIndex(colLetters)
      if (deleteAtCol1 !== null && colIndex + 1 === deleteAtCol1) {
        return '#REF!'
      }
      if (deleteAtCol1 !== null && colIndex + 1 > deleteAtCol1) {
        colIndex -= 1
      }
      return columnIndexToLetter(colIndex)
    }

    const withShiftedFullColumns =
      deleteAtCol1 === null
        ? maskedFormula
        : maskedFormula.replace(
            fullColumnPattern,
            (_match, colAbs1, col1, rowAbs1, colAbs2, col2, rowAbs2) =>
              `${colAbs1}${shiftColumnRef(col1)}${rowAbs1}:${colAbs2}${shiftColumnRef(col2)}${rowAbs2}`
          )

    const shifted = withShiftedFullColumns.replace(
      cellRefPattern,
      (
        _match,
        colAbs1,
        col1,
        rowAbs1,
        row1,
        colAbs2,
        col2,
        rowAbs2,
        row2
      ) => {
        const shiftCell = (
          colAbs: string,
          colLetters: string,
          rowAbs: string,
          rowDigits: string
        ) => {
          let colIndex = columnLetterToIndex(colLetters)
          let rowIndex = parseInt(rowDigits, 10)

          if (deleteAtCol1 !== null && colIndex + 1 === deleteAtCol1) {
            return '#REF!'
          }
          if (deleteAtRow1 !== null && rowIndex === deleteAtRow1) {
            return '#REF!'
          }

          if (deleteAtCol1 !== null && colIndex + 1 > deleteAtCol1) {
            colIndex -= 1
          }
          if (deleteAtRow1 !== null && rowIndex > deleteAtRow1) {
            rowIndex -= 1
          }

          return `${colAbs}${columnIndexToLetter(colIndex)}${rowAbs}${rowIndex}`
        }

        let out = shiftCell(colAbs1, col1, rowAbs1, row1)
        if (col2 && row2) {
          out += `:${shiftCell(colAbs2, col2, rowAbs2, row2)}`
        }
        return out
      }
    )

    const restored = this.restoreStringLiterals(shifted, stringLiterals)
    return `=${restored}`
  }

  private maskStringLiterals(formula: string): { maskedFormula: string; stringLiterals: string[] } {
    const stringLiterals: string[] = []
    let maskedFormula = ''
    let cursor = 0

    while (cursor < formula.length) {
      const char = formula[cursor]
      if (char !== '"') {
        maskedFormula += char
        cursor += 1
        continue
      }

      let literal = '"'
      cursor += 1
      while (cursor < formula.length) {
        const nextChar = formula[cursor]
        literal += nextChar
        cursor += 1
        if (nextChar !== '"') continue
        if (cursor < formula.length && formula[cursor] === '"') {
          literal += formula[cursor]
          cursor += 1
          continue
        }
        break
      }

      const literalIndex = stringLiterals.push(literal) - 1
      maskedFormula += `__STR_LIT_${literalIndex}__`
    }

    return { maskedFormula, stringLiterals }
  }

  private restoreStringLiterals(formula: string, stringLiterals: string[]): string {
    let restored = formula
    stringLiterals.forEach((literal, index) => {
      restored = restored.replaceAll(`__STR_LIT_${index}__`, literal)
    })
    return restored
  }
}

// ============ Factory function ============

/**
 * Create a FormulaService instance with data accessors
 *
 * @param getRowData - Function to get current row data (keyed by model row)
 * @param columns - Array of column definitions with id property
 * @param getRowOrder - Function to get current view-to-model row mapping.
 *                      rowOrder[viewRow] = modelRow. If not provided, identity mapping is used.
 */
export function createFormulaService(
  getRowData: () => Map<number, Record<string, unknown>>,
  columns: Array<{ id: string }>,
  getRowOrder?: () => number[]
): FormulaService {
  // Build column lookup maps
  const columnIndexById = new Map<string, number>()
  const columnIdByIndex = new Map<number, string>()

  columns.forEach((col, index) => {
    columnIndexById.set(col.id, index)
    columnIdByIndex.set(index, col.id)
  })

  const columnLookup: ColumnLookup = {
    // Return empty string for invalid indices - callers should handle as #REF!
    // Previously returned `col-${index}` which masked invalid column references
    indexToId: (index: number) => columnIdByIndex.get(index) ?? '',
    idToIndex: (columnId: string) => columnIndexById.get(columnId) ?? -1,
  }

  /**
   * Convert view row (1-based, from parser) to model row (0-based, for rowData).
   * Parser uses 1-based rows, so we first convert to 0-based view row,
   * then map through rowOrder to get model row.
   */
  const viewToModelRow = (parserRow: number): number => {
    const viewRow = parserRow - 1 // Convert 1-based to 0-based
    if (!getRowOrder) return viewRow // No sorting, identity mapping
    const rowOrder = getRowOrder()
    return rowOrder[viewRow] ?? viewRow // Fallback to identity if out of bounds
  }

  // Cell getter for parser - uses 1-based rows AND columns
  // Row references (A1, B2, etc.) are interpreted as VIEW rows, then mapped to model rows
  const cellGetter: CellGetter = (row: number, col: number) => {
    const rowData = getRowData()
    // Map view row to model row for data access
    const modelRow = viewToModelRow(row)
    const rowRecord = rowData.get(modelRow)
    if (!rowRecord) return null

    const columnId = columnLookup.indexToId(col - 1) // col is 1-based
    const value = rowRecord[columnId]

    // Return numeric/boolean value if possible
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
      const trimmed = value.trim().toLowerCase()
      if (trimmed === 'true') return true
      if (trimmed === 'false') return false
      const num = parseFloat(value)
      if (!isNaN(num)) return num
    }
    return value ?? null
  }

  // Range getter for parser - uses 1-based rows AND columns
  // Row references are interpreted as VIEW rows, then mapped to model rows
  const rangeGetter: RangeGetter = (ref: RangeRef) => {
    const result: unknown[][] = []
    const rowData = getRowData()

    const startRow = Math.min(ref.from.row, ref.to.row)
    const endRow = Math.max(ref.from.row, ref.to.row)
    const startCol = Math.min(ref.from.col, ref.to.col)
    const endCol = Math.max(ref.from.col, ref.to.col)

    for (let row = startRow; row <= endRow; row++) {
      const rowValues: unknown[] = []
      // Map view row to model row for data access
      const modelRow = viewToModelRow(row)
      const rowRecord = rowData.get(modelRow)

      for (let col = startCol; col <= endCol; col++) {
        if (!rowRecord) {
          rowValues.push(null)
          continue
        }

        const columnId = columnLookup.indexToId(col - 1) // col is 1-based
        const value = rowRecord[columnId]

        // Convert to number/boolean if possible
        if (typeof value === 'number') {
          rowValues.push(value)
        } else if (typeof value === 'string') {
          const trimmed = value.trim().toLowerCase()
          if (trimmed === 'true') {
            rowValues.push(true)
          } else if (trimmed === 'false') {
            rowValues.push(false)
          } else {
            const num = parseFloat(value)
            rowValues.push(isNaN(num) ? value : num)
          }
        } else {
          rowValues.push(value ?? null)
        }
      }

      result.push(rowValues)
    }

    return result
  }

  return new FormulaService(cellGetter, rangeGetter, columnLookup, getRowOrder, columns.length)
}

// Re-export utilities
export { isFormula, columnIndexToLetter, columnLetterToIndex }
