/**
 * Bracket Utilities Module - Modular Exports
 *
 * Central export point for all bracket-related functionality.
 * Re-exports utilities from common.ts and adds extraction logic.
 */

// Extraction logic (newly modularized)
export { extractPostHocBrackets } from './extraction'

// Rendering utilities (already in common.ts - re-export for convenience)
export {
  createBracketShapes,
  formatBracketLabel,
  stackBrackets,
  repelBracketLayout,
} from '@/utils/plotBuilders/common'

// Types (re-export for convenience)
export type {
  SignificanceBracket,
  BracketSettings,
  BracketEffectMeta,
} from '@/utils/plotBuilders/types'

export {
  createDefaultBracketSettings,
  getBracketLabel,
} from '@/utils/plotBuilders/types'
