/**
 * Transform Preflight Policy
 *
 * Evaluates whether a data transform should proceed, require confirmation,
 * or be hard-blocked based on the operation type and dataset size.
 *
 * Called BEFORE expensive row loading so the gate is cheap.
 */

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Show indeterminate spinner for sync transforms above this row count. */
export const SPINNER_ROWS = 20_000

/** Require user confirmation before proceeding. */
export const CONFIRM_ROWS = 50_000

/**
 * Hard block for non-streaming sync transforms.
 * pivot_longer, filter, group_aggregate, and the small pivot_wider path
 * run synchronously on the main thread; above this limit the UI will
 * freeze unacceptably.
 */
export const HARD_BLOCK_ROWS = 100_000

/**
 * Pivot-longer projected-output row cap.
 * projectedRows = dataRowCount * selectedPivotColumns.
 * Even if base row count is modest, the output can explode.
 */
export const PIVOT_LONGER_OUTPUT_CAP = 500_000

/**
 * Sort hard block for client-side (small-dataset) sort path.
 * Server-side (DuckDB) sort has no cap; this only applies to the
 * in-browser JavaScript sort.
 */
export const SORT_HARD_BLOCK_ROWS = 75_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransformType =
  | 'pivot_wider'
  | 'pivot_longer'
  | 'filter'
  | 'group_aggregate'
  | 'sort'

export interface PreflightResult {
  /** Whether the transform is allowed to proceed at all. */
  allow: boolean
  /** Whether to show a confirmation dialog before proceeding. */
  confirm: boolean
  /** Human-readable reason when blocked (allow=false). */
  blockReason: string | null
  /** Whether to show an indeterminate spinner during execution. */
  showSpinner: boolean
  /** Spinner message to display. */
  spinnerMessage: string
}

export interface PreflightInput {
  type: TransformType
  dataRowCount: number
  /**
   * For pivot_longer only: the number of columns being pivoted.
   * Used to compute projected output row count.
   */
  pivotColumnCount?: number
}

// ---------------------------------------------------------------------------
// Spinner messages
// ---------------------------------------------------------------------------

const SPINNER_MESSAGES: Record<TransformType, string> = {
  pivot_wider: 'Pivoting data...',
  pivot_longer: 'Reshaping data...',
  filter: 'Filtering data...',
  group_aggregate: 'Aggregating data...',
  sort: 'Sorting data...',
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export function getTransformPreflight(input: PreflightInput): PreflightResult {
  const { type, dataRowCount } = input
  const message = SPINNER_MESSAGES[type]

  // -- Pivot Wider uses streaming path above SPINNER_ROWS --
  // The streaming path has its own progress/cancel; we only gate
  // the small sync path here. The streaming path is always allowed
  // up to the existing TRANSFORM_MAX_ROWS (250K) handled in
  // isTransformBlocked().
  if (type === 'pivot_wider') {
    // Small pivot wider path (< SPINNER_ROWS) is always fast
    if (dataRowCount < SPINNER_ROWS) {
      return { allow: true, confirm: false, blockReason: null, showSpinner: false, spinnerMessage: message }
    }
    // Above SPINNER_ROWS the streaming path takes over — no gate needed here.
    // The streaming path handles its own spinner+progress+cancel.
    return { allow: true, confirm: false, blockReason: null, showSpinner: false, spinnerMessage: message }
  }

  // -- Pivot Longer: check projected output size --
  if (type === 'pivot_longer') {
    const pivotCols = input.pivotColumnCount ?? 1
    const projectedRows = dataRowCount * pivotCols
    if (projectedRows > PIVOT_LONGER_OUTPUT_CAP) {
      return {
        allow: false,
        confirm: false,
        blockReason:
          `Pivot would produce ~${projectedRows.toLocaleString()} rows ` +
          `(${dataRowCount.toLocaleString()} rows x ${pivotCols} columns), ` +
          `exceeding the ${PIVOT_LONGER_OUTPUT_CAP.toLocaleString()}-row limit for this operation.`,
        showSpinner: false,
        spinnerMessage: message,
      }
    }
  }

  // -- Sort uses a separate hard-block constant --
  if (type === 'sort') {
    if (dataRowCount >= SORT_HARD_BLOCK_ROWS) {
      return {
        allow: false,
        confirm: false,
        blockReason:
          `Client-side sort is limited to ${SORT_HARD_BLOCK_ROWS.toLocaleString()} rows. ` +
          `This dataset has ${dataRowCount.toLocaleString()} rows.`,
        showSpinner: false,
        spinnerMessage: message,
      }
    }
    if (dataRowCount >= CONFIRM_ROWS) {
      return { allow: true, confirm: true, blockReason: null, showSpinner: true, spinnerMessage: message }
    }
    if (dataRowCount >= SPINNER_ROWS) {
      return { allow: true, confirm: false, blockReason: null, showSpinner: true, spinnerMessage: message }
    }
    return { allow: true, confirm: false, blockReason: null, showSpinner: false, spinnerMessage: message }
  }

  // -- All other sync transforms: filter, group_aggregate, pivot_longer --
  if (dataRowCount >= HARD_BLOCK_ROWS) {
    return {
      allow: false,
      confirm: false,
      blockReason:
        `This operation is limited to ${HARD_BLOCK_ROWS.toLocaleString()} rows ` +
        `when run in the browser. Dataset has ${dataRowCount.toLocaleString()} rows.`,
      showSpinner: false,
      spinnerMessage: message,
    }
  }

  if (dataRowCount >= CONFIRM_ROWS) {
    return { allow: true, confirm: true, blockReason: null, showSpinner: true, spinnerMessage: message }
  }

  if (dataRowCount >= SPINNER_ROWS) {
    return { allow: true, confirm: false, blockReason: null, showSpinner: true, spinnerMessage: message }
  }

  return { allow: true, confirm: false, blockReason: null, showSpinner: false, spinnerMessage: message }
}
