/**
 * Error Toast Helper
 *
 * Standardized toast rendering for AppError instances.
 * Shows code suffix only for allowed backend/system codes.
 */

import { toast } from 'sonner'
import type { AppError } from './types'
import { getErrorDefinition } from './errorCatalog'

const TOAST_CODE_ALLOWLIST = new Set([
  'STATS_PY_325',
  'STATS_PY_326',
  'STATS_PY_327',
  'STATS_PY_328',
  'STATS_PY_329',
  'STATS_PY_330',
  'STATS_PY_340',
  'RNASEQ_402',
  'APP_900',
])

export interface ShowErrorToastOptions {
  /** Toast ID for deduplication */
  id?: string

  /** Toast duration in milliseconds */
  duration?: number

  /** Show suggestion if available */
  showSuggestion?: boolean
}

/**
 * RNASEQ_405 is shown with a code only when the backend marks it as runtime/backend unavailability.
 */
function shouldShowCodeInToast(error: AppError): boolean {
  if (TOAST_CODE_ALLOWLIST.has(error.code)) {
    return true
  }

  if (error.code === 'RNASEQ_405') {
    return error.context?.runtime_issue === true
  }

  return false
}

/**
 * Show structured error toast with stable error code
 *
 * @param error - Structured error object
 * @param options - Toast options
 *
 * @example
 * ```ts
 * showAppErrorToast({
 *   code: 'STATS_PY_327',
 *   message: 'Statistical computation failed',
 *   detail: 'Python backend returned non-zero exit code',
 *   traceId: 'abc-123',
 *   context: { testName: 't_test', datasetId: 'ds_001' }
 * })
 * ```
 */
export function showAppErrorToast(error: AppError, options: ShowErrorToastOptions = {}): void {
  const { id, duration, showSuggestion = false } = options

  const formattedMessage = shouldShowCodeInToast(error)
    ? `${error.message} (Code: ${error.code})`
    : error.message

  // Get error definition for suggestion
  const definition = getErrorDefinition(error.code)
  const suggestion = showSuggestion && definition?.suggestion ? definition.suggestion : undefined

  // Log with reduced detail in production; full detail in development only.
  if (import.meta.env.DEV) {
    console.error(`[${error.code}] ${error.message}`, {
      code: error.code,
      detail: error.detail,
      traceId: error.traceId,
      context: error.context,
    })
  } else {
    console.error(`[${error.code}] ${error.message}`, {
      code: error.code,
      traceId: error.traceId,
    })
  }

  // Show toast with optional description
  toast.error(formattedMessage, {
    id,
    duration,
    description: suggestion,
  })
}

/**
 * Create AppError from error code and optional detail
 *
 * @param code - Error code from catalog
 * @param detail - Optional technical detail for logs
 * @param context - Optional sanitized context
 *
 * @example
 * ```ts
 * const error = createAppError('STATS_PY_327', 'Non-zero exit code: 1', {
 *   testName: 't_test',
 *   exitCode: 1
 * })
 * showAppErrorToast(error)
 * ```
 */
export function createAppError(
  code: string,
  detail?: string,
  context?: Record<string, string | number | boolean>
): AppError {
  const definition = getErrorDefinition(code)

  if (!definition) {
    console.warn(`Unknown error code: ${code}. Using fallback message.`)
    return {
      code,
      message: 'An error occurred',
      detail,
      traceId: generateTraceId(),
      context,
      retryable: false,
    }
  }

  return {
    code: definition.code,
    message: definition.message,
    detail,
    traceId: generateTraceId(),
    retryable: definition.retryable,
    context,
  }
}

/**
 * Generate unique trace ID for error correlation
 */
export function generateTraceId(): string {
  // Simple timestamp-based ID (sufficient for local logging)
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 9)
  return `${timestamp}-${random}`
}
