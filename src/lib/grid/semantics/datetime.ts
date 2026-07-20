import type { GridValueSemantics } from './types'
import { MISSING_SENTINELS } from './sharedMissing'

/**
 * Safe format matchers — only formats with unambiguous timezone context.
 * Space-separated datetimes and ISO without Z/offset are rejected (local-time
 * interpretation would shift values in non-UTC environments).
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

function safeParse(trimmed: string): number | null {
  if (DATE_ONLY.test(trimmed)) {
    const parts = trimmed.split('-')
    const y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2])
    const ts = Date.UTC(y, m - 1, d)
    return isNaN(ts) ? null : ts
  }
  if (ISO_WITH_TZ.test(trimmed)) {
    const ts = Date.parse(trimmed)
    return isNaN(ts) ? null : ts
  }
  return null
}

function parseTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    return safeParse(trimmed)
  }
  return null
}

function isMissingDatetime(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === '') return true
    if (MISSING_SENTINELS.has(t)) return true
  }
  return parseTimestamp(value) === null
}

export const datetimeSemantics: GridValueSemantics = {
  empty: null,

  parse(raw: string): unknown {
    const trimmed = raw.trim()
    if (trimmed === '') return null
    const ts = safeParse(trimmed)
    return ts !== null ? ts : raw  // preserve raw for ambiguous/invalid formats
  },

  format(value: unknown): string {
    if (value === null || value === undefined) return ''
    const ts = parseTimestamp(value)
    if (ts === null) return String(value)
    const iso = new Date(ts).toISOString()
    // Return YYYY-MM-DD for midnight UTC dates, full ISO otherwise
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
  },

  sortKey(value: unknown): number {
    const ts = parseTimestamp(value)
    return ts !== null ? ts : Infinity
  },

  isMissing: isMissingDatetime,

  isValid(value: unknown): boolean {
    if (value === null || value === undefined) return false
    return parseTimestamp(value) !== null
  },
}
