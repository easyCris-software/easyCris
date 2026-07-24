/**
 * Core Type Definitions for Statistical Test Modules
 *
 * These types define the contract for all statistical test modules
 * in the modular validation/extraction system.
 */

// ============================================================================
// COLUMN CLASSIFICATION
// ============================================================================

/**
 * Column data type classification
 */
export enum ColumnDataType {
  /** Numeric/continuous data (e.g., height, weight, age) */
  Numeric = "Numeric",

  /** Categorical/nominal data (e.g., gender, treatment group) */
  Categorical = "Categorical",

  /** Binary data - exactly 2 unique non-missing values (e.g., yes/no, 0/1) */
  Binary = "Binary",

  /** Ordinal data - numeric with discrete ordered levels (e.g., Likert scale) */
  Ordinal = "Ordinal",

  /** Mixed - contains both numeric and categorical values */
  Mixed = "Mixed",

  /** Empty - all values are missing */
  Empty = "Empty",
}

/**
 * Complete classification of a single column
 * Ported from Avalonia ColumnDataExtractor.cs
 */
export interface ColumnClassification {
  /** Index of the column in the dataset */
  columnIndex: number

  /** Name/header of the column */
  columnName: string

  /** Column ID (used to access row data in cache) */
  columnId?: string

  /** Classified data type */
  dataType: ColumnDataType
  /** Auto-detected type before user override (if any) */
  detectedType?: ColumnDataType
  /** User-selected override type (if any) */
  overrideType?: ColumnDataType
  /** Effective type used for validation/execution */
  effectiveType?: ColumnDataType

  // Counts
  /** Total number of values (including missing) */
  totalValues: number

  /** Number of values that can be parsed as numeric */
  numericValues: number

  /** Number of non-numeric string values */
  categoricalValues: number

  /** Number of missing/null/NA values */
  missingValues: number

  /** Number of unique non-missing values */
  uniqueValueCount: number

  // Metadata
  /** True if column is binary (exactly 2 unique non-missing values) */
  isBinary: boolean

  /** True if column appears to be ordinal (all numeric, discrete levels) */
  isOrdinal: boolean
  /** True if column has <=1 unique non-missing value */
  isConstant?: boolean

  /** True if column has any missing values */
  hasMissingData: boolean

  /** Ratio of numeric values to total non-missing values (0.0 to 1.0) */
  numericRatio: number

  // For ordinal detection
  /** Minimum numeric value (if numeric/ordinal) */
  minNumericValue?: number

  /** Maximum numeric value (if numeric/ordinal) */
  maxNumericValue?: number

  /** True if all numeric values are integers */
  allIntegerValues: boolean

  // Unique values list (for categorical/binary)
  /** Array of unique values (limited to first 100 for large datasets) */
  uniqueValues: string[]

  // Suggested tests based on column type
  /** Array of test IDs that are appropriate for this column */
  suggestedTests: string[]
}

/**
 * Summary of data extraction operation
 */
export interface DataExtractionSummary {
  /** Number of valid (non-missing) values extracted */
  validValues: number

  /** Number of missing values encountered */
  missingValues: number

  /** Total number of rows processed */
  totalRows: number

  /** Array of row indices that had missing values */
  missingIndices: number[]

  /** Encoding map for categorical data (value -> numeric code) */
  encoding?: Map<string, number>

  /** Reverse encoding map (numeric code -> original value) */
  reversedEncoding?: Map<number, string>
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Result of pre-execution validation
 */
export interface TestValidationResult {
  /** True if validation passed (test can proceed) */
  isValid: boolean

  /** Critical errors that prevent test execution */
  errors: string[]

  /** Non-critical warnings (test can still run) */
  warnings: string[]

  /** Helpful suggestions for the user */
  suggestions: string[]
}

/**
 * Options for validation
 */
export interface ValidateOptions {
  /** Index of the dependent variable (for regression/ANOVA) */
  dependentVarIndex?: number

  /** True if data is paired (for paired tests) */
  pairedData?: boolean

  /** Minimum required sample size */
  requireMinimumN?: number

  /** Significance level (alpha) */
  alpha?: number
}

// ============================================================================
// MODULE INTERFACE
// ============================================================================

/**
 * Standard interface for all test modules
 * Each module is a collection of pure functions (no classes needed)
 */
export interface ITestModule {
  /**
   * Unique module identifier (matches testRegistry.ts)
   */
  moduleId: string

  /**
   * Validate column selection before test execution
   * Implements 5-layer validation:
   *   1. Column count
   *   2. Data type
   *   3. Sample size
   *   4. Assumptions
   *   5. Domain-specific rules
   *
   * @param columns - Array of classified columns
   * @param options - Validation options
   * @returns Validation result with errors/warnings/suggestions
   */
  validateSelection: (
    columns: ColumnClassification[],
    options?: ValidateOptions
  ) => TestValidationResult

  /**
   * Build Python payload from selected columns and parameters
   *
   * @param columns - Array of classified columns
   * @param selectedColumnIndices - Original column indices in dataset
   * @param rows - Full dataset rows
   * @param parameters - Test parameters (alpha, etc.)
   * @returns JSON payload for Python backend
   */
  buildPayload: (
    columns: ColumnClassification[],
    selectedColumnIndices: number[],
    rows: any[],
    parameters: Record<string, any>
  ) => BuildPayloadResult

  /**
   * Default parameters for this test
   * @returns Default parameter values
   */
  defaultParameters: () => Record<string, any>

  /**
   * 🔥 DEPRECATED - DO NOT IMPLEMENT
   *
   * Result parsing is handled by EXISTING Tauri infrastructure:
   * - `parseTestResults()` in AppShell.tsx (statistics summary cards)
   * - `buildECPTables()` in src/utils/ecpTableBuilders/ (publication tables)
   *
   * These already expose ALL Python output. Don't reinvent them.
   *
   * This method exists for backwards compatibility only.
   */
  parseResults?: (
    testName: string,
    jsonResult: string,
    encodingMappings?: Map<string, Map<string, number>>
  ) => StatisticalTestResult[]
}

/**
 * Result of payload building
 */
export interface BuildPayloadResult {
  /** True if payload was built successfully */
  success: boolean

  /** Python payload (if successful) */
  payload?: {
    /** Test identifier (matches Python backend) */
    test: string

    /** Test data (arrays, column names, etc.) */
    data: Record<string, any>

    /** Test parameters (alpha, method, etc.) */
    parameters: Record<string, any>

    /** Optional metadata (variable names, format info, etc.) */
    metadata?: Record<string, any>
  }

  /** Error message (if failed) */
  error?: string

  /** Encoding mappings for categorical variables (for result decoding) */
  encodingMappings?: Map<string, Map<string, number>>

  /** Non-fatal warnings from payload building (e.g. trajectory_roles dropped). */
  warnings?: string[]
}

/**
 * Formatted statistical test result (for legacy parseResults)
 * @deprecated Use existing parseTestResults() and buildECPTables() instead
 */
export interface StatisticalTestResult {
  /** Test type/name */
  testType: string

  /** Statistic name (e.g., "t-statistic", "F-statistic") */
  statistic?: string

  /** Formatted value */
  value?: string

  /** Formatted p-value */
  pValue?: string

  /** Significance indicator (*, **, ***) */
  significance?: string

  /** Additional details */
  details?: string

  /** Error message (if parsing failed) */
  error?: string
}

