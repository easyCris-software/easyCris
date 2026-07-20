import type { GridValueSemantics } from './types'
import { BASE_MISSING_SENTINELS } from './sharedMissing'

// Text is looser than categorical — '-' and '.' are valid free-form text.
const MISSING_SENTINELS = BASE_MISSING_SENTINELS

function isMissingText(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    return t === '' || MISSING_SENTINELS.has(t)
  }
  return false
}

export const textSemantics: GridValueSemantics = {
  empty: null,

  parse(raw: string): unknown {
    const trimmed = raw.trim()
    return trimmed === '' ? null : trimmed
  },

  format(value: unknown): string {
    if (value === null || value === undefined) return ''
    return String(value)
  },

  sortKey(value: unknown): string {
    if (isMissingText(value)) return '\uFFFF'
    return String(value).toLowerCase()
  },

  isMissing: isMissingText,

  isValid(value: unknown): boolean {
    if (value === null || value === undefined) return false
    if (typeof value === 'string') return value.trim() !== ''
    return true
  },
}
