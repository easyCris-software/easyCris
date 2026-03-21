import type { AppError } from './types'

type PrimitiveContext = string | number | boolean
type UnknownRecord = Record<string, unknown>

const CODE_PATTERN = /^[A-Z]+(?:_[A-Z]+)*_[0-9]{3,}$/

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function sanitizeContext(input: unknown): Record<string, PrimitiveContext> | undefined {
  if (!isRecord(input)) return undefined

  const out: Record<string, PrimitiveContext> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }

  return Object.keys(out).length > 0 ? out : undefined
}

function fromRecord(candidate: UnknownRecord): AppError | null {
  const code = candidate.code
  const message = candidate.message

  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    return null
  }
  if (typeof message !== 'string' || !message.trim()) {
    return null
  }

  const detail =
    typeof candidate.detail === 'string'
      ? candidate.detail
      : typeof candidate.details === 'string'
        ? candidate.details
        : undefined

  const traceId =
    typeof candidate.traceId === 'string'
      ? candidate.traceId
      : typeof candidate.trace_id === 'string'
        ? candidate.trace_id
        : undefined

  const retryable =
    typeof candidate.retryable === 'boolean'
      ? candidate.retryable
      : undefined

  return {
    code,
    message,
    detail,
    traceId,
    retryable,
    context: sanitizeContext(candidate.context),
  }
}

function parseJsonCandidate(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Attempts to extract a structured backend AppError from unknown Tauri invoke errors.
 */
export function extractAppError(error: unknown): AppError | null {
  const queue: unknown[] = [error]
  const visited = new Set<unknown>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (current == null || visited.has(current)) continue
    visited.add(current)

    if (typeof current === 'string') {
      const parsed = parseJsonCandidate(current)
      if (parsed) queue.push(parsed)
      continue
    }

    if (current instanceof Error) {
      queue.push(current.message)
      continue
    }

    if (isRecord(current)) {
      const direct = fromRecord(current)
      if (direct) return direct

      if ('error' in current) queue.push(current.error)
      if ('cause' in current) queue.push(current.cause)
      if ('data' in current) queue.push(current.data)
      if ('details' in current) queue.push(current.details)
      if ('message' in current && typeof current.message === 'string') {
        queue.push(current.message)
      }
    }
  }

  return null
}

/**
 * Extract best-effort display message from unknown error.
 */
export function extractErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message.trim()) return error.message
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message
  }
  return fallback
}

type ToastAwareError = UnknownRecord & { __toastShown?: boolean }

export function markErrorToastShown(error: unknown): void {
  if (!isRecord(error)) return
  ;(error as ToastAwareError).__toastShown = true
}

export function wasErrorToastShown(error: unknown): boolean {
  return isRecord(error) && (error as ToastAwareError).__toastShown === true
}

