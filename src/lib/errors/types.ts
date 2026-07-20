/**
 * Error Handling Types
 *
 * Structured error model for easyCris local diagnostics.
 * No telemetry - all errors logged locally only.
 */

/**
 * Structured error envelope used throughout the application
 */
export interface AppError {
  /** Stable error code (e.g., STATS_PY_325, RNASEQ_401) */
  code: string

  /** User-safe short message shown in toast */
  message: string

  /** Technical detail for logs (not shown to user) */
  detail?: string

  /** Correlation ID for this error instance */
  traceId?: string

  /** Whether user can retry this operation */
  retryable?: boolean

  /** Additional context (sanitized - no PII/dataset values) */
  context?: Record<string, string | number | boolean>
}

/**
 * Error catalog entry definition
 */
export interface ErrorDefinition {
  /** Error code */
  code: string

  /** Default user-facing message */
  message: string

  /** Whether this error is retryable by default */
  retryable?: boolean

  /** Suggested user action (optional) */
  suggestion?: string
}

/**
 * Error category families
 */
export const ErrorCategory = {
  STATS: 'STATS',
  STATS_PY: 'STATS_PY',
  RNASEQ: 'RNASEQ',
  IO: 'IO',
  EXPORT: 'EXPORT',
  FORMULA: 'FORMULA',
  APP: 'APP',
  PLOT: 'PLOT',
} as const

export type ErrorCategoryType = typeof ErrorCategory[keyof typeof ErrorCategory]
