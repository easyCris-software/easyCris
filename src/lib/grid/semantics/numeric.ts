import type { GridValueSemantics } from './types'
import { MISSING_SENTINELS } from './sharedMissing'

function isMissingRaw(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'number') return !Number.isFinite(value)
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()
    return trimmed === '' || MISSING_SENTINELS.has(trimmed)
  }
  return false
}

export const numericSemantics: GridValueSemantics = {
  empty: null,

  parse(raw: string): unknown {
    const trimmed = raw.trim()
    if (trimmed === '') return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : raw
  },

  format(value: unknown): string {
    if (isMissingRaw(value)) return ''
    // Deferred: delegate to formatNumber() when display/export wiring starts.
    return String(value)
  },

  sortKey(value: unknown): number {
    if (isMissingRaw(value)) return Infinity
    const n = Number(value)
    return Number.isFinite(n) ? n : Infinity
  },

  isMissing: isMissingRaw,

  isValid(value: unknown): boolean {
    if (value === null || value === undefined) return false
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed === '') return false
      return Number.isFinite(Number(trimmed))
    }
    return false
  },
}
