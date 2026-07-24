/**
 * Bracket Helpers
 * 
 * Utilities for significance bracket handling
 */

import type { BracketSettings } from '@/utils/plotBuilders/types'
import { getBracketLabel } from '@/utils/plotBuilders/types'

/**
 * Check if a bracket should be displayed based on p-value and settings
 */
export function isBracketSignificant(pValue: number, settings: BracketSettings): boolean {
  return Boolean(getBracketLabel(pValue, { ...settings, showNs: false }))
}
