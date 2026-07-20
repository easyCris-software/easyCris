/**
 * Schema key utility — shared between SpreadsheetView and tests.
 *
 * Produces a stable string fingerprint of the column ID set so ViewState
 * cache entries can be invalidated when the dataset schema changes.
 *
 * Format: "<column-count>:<djb2-style hash>"
 * A separator byte (124 = '|') is mixed in after each ID to prevent
 * collisions between ("ab","c") and ("a","bc").
 */
export function computeSchemaKey(columnIds: string[]): string {
  const ids = [...columnIds].sort()
  let hash = 0
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) | 0
    }
    hash = (hash * 31 + 124) | 0
  }
  return `${ids.length}:${hash}`
}
