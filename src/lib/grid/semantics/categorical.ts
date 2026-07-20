import type { GridValueSemantics } from './types'
import { MISSING_SENTINELS } from './sharedMissing'

function isMissingCategorical(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    return t === '' || MISSING_SENTINELS.has(t)
  }
  return false
}

export const categoricalSemantics: GridValueSemantics = {
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
    if (isMissingCategorical(value)) return '\uFFFF'
    return String(value).toLowerCase()
  },

  isMissing: isMissingCategorical,

  isValid(value: unknown): boolean {
    if (value === null || value === undefined) return false
    if (typeof value === 'string') return value.trim() !== ''
    return true
  },
}
