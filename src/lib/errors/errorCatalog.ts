/**
 * Error Code Catalog
 *
 * Central registry of all application error codes.
 * Each code maps to a user-safe message and metadata.
 */

import type { ErrorDefinition } from './types'

/**
 * Error catalog organized by family
 */
export const ERROR_CATALOG: Record<string, ErrorDefinition> = {
  // ============================================================================
  // STATS Family - Statistical Analysis Input/Validation Errors (1xx)
  // ============================================================================

  STATS_101: {
    code: 'STATS_101',
    message: 'Test selection required',
    retryable: true,
  },

  STATS_102: {
    code: 'STATS_102',
    message: 'Invalid column selection for test',
    retryable: true,
  },

  STATS_103: {
    code: 'STATS_103',
    message: 'Numeric column required',
    retryable: true,
  },

  STATS_104: {
    code: 'STATS_104',
    message: 'Dataset is empty',
    retryable: false,
  },

  STATS_105: {
    code: 'STATS_105',
    message: 'Input validation failed',
    retryable: true,
  },

  STATS_106: {
    code: 'STATS_106',
    message: 'Configuration dialog unavailable',
    retryable: false,
  },

  STATS_107: {
    code: 'STATS_107',
    message: 'Selected columns not found',
    retryable: true,
  },

  STATS_108: {
    code: 'STATS_108',
    message: 'Column identifiers missing',
    retryable: false,
  },

  STATS_109: {
    code: 'STATS_109',
    message: 'Duplicate column identifiers detected',
    retryable: true,
  },

  STATS_110: {
    code: 'STATS_110',
    message: 'Logistic regression configuration incomplete',
    retryable: true,
  },

  STATS_111: {
    code: 'STATS_111',
    message: 'Cox regression requires covariates',
    retryable: true,
  },

  STATS_112: {
    code: 'STATS_112',
    message: 'Synergy mapping configuration invalid',
    retryable: true,
  },

  STATS_113: {
    code: 'STATS_113',
    message: 'Unsupported test type',
    retryable: false,
  },

  // ============================================================================
  // STATS_PY Family - Python Backend Execution Errors (3xx)
  // ============================================================================

  STATS_PY_325: {
    code: 'STATS_PY_325',
    message: 'Analysis backend unavailable',
    retryable: false,
    suggestion: 'Repair/reinstall application resources and retry',
  },

  STATS_PY_326: {
    code: 'STATS_PY_326',
    message: 'Analysis timed out',
    retryable: true,
    suggestion: 'Try with a smaller dataset or fewer columns',
  },

  STATS_PY_327: {
    code: 'STATS_PY_327',
    message: 'Analysis backend execution failed',
    retryable: true,
  },

  STATS_PY_328: {
    code: 'STATS_PY_328',
    message: 'Invalid response from analysis backend',
    retryable: true,
  },

  STATS_PY_329: {
    code: 'STATS_PY_329',
    message: 'Analysis backend reported failure',
    retryable: true,
  },

  STATS_PY_340: {
    code: 'STATS_PY_340',
    message: 'Dose-response data unsuitable / fit unstable',
    retryable: true,
    suggestion: 'Check dose-response suitability and retry with model-appropriate data',
  },

  STATS_PY_330: {
    code: 'STATS_PY_330',
    message: 'Failed to prepare analysis data',
    retryable: true,
  },

  // ============================================================================
  // RNASEQ Family - RNA-seq Module Errors (4xx)
  // ============================================================================

  RNASEQ_401: {
    code: 'RNASEQ_401',
    message: 'RNA-seq datasets incomplete',
    retryable: true,
    suggestion: 'Load both count matrix and metadata files',
  },

  RNASEQ_402: {
    code: 'RNASEQ_402',
    message: 'RNA-seq execution failed',
    retryable: true,
  },

  RNASEQ_403: {
    code: 'RNASEQ_403',
    message: 'RNA-seq export failed',
    retryable: true,
  },

  RNASEQ_404: {
    code: 'RNASEQ_404',
    message: 'RNA-seq plot export failed',
    retryable: true,
  },

  RNASEQ_405: {
    code: 'RNASEQ_405',
    message: 'RNA-seq backend unavailable',
    retryable: false,
    suggestion: 'Repair/reinstall runtime resources and retry',
  },

  RNASEQ_406: {
    code: 'RNASEQ_406',
    message: 'Unsupported RNA-seq request',
    retryable: false,
  },

  RNASEQ_407: {
    code: 'RNASEQ_407',
    message: 'RNA-seq cache operation failed',
    retryable: true,
  },

  // ============================================================================
  // IO Family - File & Data Operations (5xx)
  // ============================================================================

  IO_501: {
    code: 'IO_501',
    message: 'Invalid or inaccessible file path',
    retryable: true,
  },

  IO_502: {
    code: 'IO_502',
    message: 'Permission denied',
    retryable: false,
    suggestion: 'Check file permissions and try again',
  },

  IO_503: {
    code: 'IO_503',
    message: 'Sort operation failed',
    retryable: true,
  },

  IO_504: {
    code: 'IO_504',
    message: 'Data import failed',
    retryable: true,
  },

  IO_505: {
    code: 'IO_505',
    message: 'Project save failed',
    retryable: true,
  },

  IO_506: {
    code: 'IO_506',
    message: 'Project open failed',
    retryable: true,
  },

  IO_507: {
    code: 'IO_507',
    message: 'Recent project removal failed',
    retryable: true,
  },

  IO_508: {
    code: 'IO_508',
    message: 'Settings save failed',
    retryable: true,
  },

  // ============================================================================
  // EXPORT Family - Plot/Result Export Errors (6xx)
  // ============================================================================

  EXPORT_601: {
    code: 'EXPORT_601',
    message: 'Export format not supported',
    retryable: false,
  },

  EXPORT_602: {
    code: 'EXPORT_602',
    message: 'Plot export failed',
    retryable: true,
  },

  EXPORT_603: {
    code: 'EXPORT_603',
    message: 'Export library unavailable',
    retryable: false,
  },

  EXPORT_604: {
    code: 'EXPORT_604',
    message: 'Copy to clipboard failed',
    retryable: true,
  },

  EXPORT_605: {
    code: 'EXPORT_605',
    message: 'Results export failed',
    retryable: true,
  },

  // ============================================================================
  // FORMULA Family - Formula Engine Errors (7xx)
  // ============================================================================

  FORMULA_701: {
    code: 'FORMULA_701',
    message: 'Formula syntax error',
    retryable: true,
  },

  FORMULA_702: {
    code: 'FORMULA_702',
    message: 'Formula range too large',
    retryable: false,
    suggestion: 'Use a smaller range or full-column formula (e.g., SUM(A:A))',
  },

  FORMULA_703: {
    code: 'FORMULA_703',
    message: 'Formula execution failed',
    retryable: true,
  },

  FORMULA_704: {
    code: 'FORMULA_704',
    message: 'Formula computation timed out',
    retryable: true,
    suggestion: 'Try a smaller range or use a full-column formula',
  },

  // ============================================================================
  // PLOT Family - Plotting & Visualization Errors
  // ============================================================================

  PLOT_601: {
    code: 'PLOT_601',
    message: 'No plot data available',
    retryable: false,
  },

  PLOT_602: {
    code: 'PLOT_602',
    message: 'Plot data is invalid',
    retryable: false,
  },

  PLOT_603: {
    code: 'PLOT_603',
    message: 'Plot creation failed',
    retryable: true,
  },

  PLOT_604: {
    code: 'PLOT_604',
    message: 'Plot not initialized',
    retryable: true,
  },

  PLOT_605: {
    code: 'PLOT_605',
    message: 'Plot refresh failed',
    retryable: true,
  },

  PLOT_606: {
    code: 'PLOT_606',
    message: 'Fullscreen mode unavailable',
    retryable: false,
  },

  PLOT_607: {
    code: 'PLOT_607',
    message: 'Trendline computation failed',
    retryable: true,
  },

  // ============================================================================
  // APP Family - Application-Level Errors (9xx)
  // ============================================================================

  APP_900: {
    code: 'APP_900',
    message: 'Unexpected internal error',
    retryable: false,
    suggestion: 'Please restart the application',
  },

  APP_901: {
    code: 'APP_901',
    message: 'No active dataset',
    retryable: true,
  },

  APP_902: {
    code: 'APP_902',
    message: 'Dataset initialization failed',
    retryable: true,
  },

  APP_903: {
    code: 'APP_903',
    message: 'Transform operation failed',
    retryable: true,
  },

  APP_904: {
    code: 'APP_904',
    message: 'PowerPoint integration failed',
    retryable: true,
  },

  APP_905: {
    code: 'APP_905',
    message: 'Notification failed',
    retryable: false,
  },
}

/**
 * Get error definition by code
 */
export function getErrorDefinition(code: string): ErrorDefinition | undefined {
  return ERROR_CATALOG[code]
}

/**
 * Check if error code exists in catalog
 */
export function isValidErrorCode(code: string): boolean {
  return code in ERROR_CATALOG
}

export type ErrorCode = keyof typeof ERROR_CATALOG
