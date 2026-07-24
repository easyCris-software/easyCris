/**
 * Binary Categorical Encoding Helpers
 *
 * Shared utilities for detecting and handling binary categorical variable encoding
 * Used across mediation, moderation, and survival analysis dialogs.
 */

import type { ColumnClassification } from '@/lib/modules/core/types'

// ============================================================================
// Types
// ============================================================================

/**
 * Binary variable encoding (maps two categorical values to 0 and 1)
 */
export interface BinaryEncoding {
  eventValue: string      // Value to encode as 1 (e.g., "Treatment", "Dead", "Yes")
  censoredValue: string   // Value to encode as 0 (e.g., "Control", "Alive", "No")
  wasEncoded: boolean     // Whether encoding was applied
}

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Check if column is numeric binary (0/1, true/false, boolean)
 * Auto-detection: no encoding UI needed
 */
export function isNumericBinary(col: ColumnClassification): boolean {
  if (!col.isBinary || col.uniqueValueCount !== 2) return false

  return col.uniqueValues.every(v => {
    const str = String(v).toLowerCase().trim()
    return (
      str === '0' ||
      str === '1' ||
      str === 'false' ||
      str === 'true'
    )
  })
}

/**
 * Check if column needs manual encoding
 * Show encoding UI when this returns true
 */
export function needsManualEncoding(col: ColumnClassification): boolean {
  return col.isBinary && col.uniqueValueCount === 2 && !isNumericBinary(col)
}

/**
 * Check if column is valid binary column
 */
export function isBinaryColumn(col: ColumnClassification): boolean {
  return col.isBinary && col.uniqueValueCount === 2
}

/**
 * Auto-suggest encoding for a binary column
 * Returns alphabetically sorted values with last value as "event" (1)
 */
export function autoSuggestEncoding(col: ColumnClassification): BinaryEncoding | undefined {
  if (!isBinaryColumn(col)) return undefined

  const sorted = [...col.uniqueValues].map(String).sort()
  if (sorted.length < 2) return undefined

  return {
    eventValue: sorted[1]!,       // Alphabetically last = 1
    censoredValue: sorted[0]!,    // Alphabetically first = 0
    wasEncoded: true,
  }
}
