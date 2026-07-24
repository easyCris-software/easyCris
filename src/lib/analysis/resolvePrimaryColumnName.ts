/**
 * Resolves the primary column (outcome/dependent variable) name for table
 * and plot label use.
 *
 * Precedence order (highest to lowest):
 *   1. payloadMetadata.variable_name  — explicit per-test metadata
 *   2. payloadData.value_name         — payload-provided value label
 *   3. payloadData.dependent_name     — explicit dependent variable label
 *   4. payloadData.value_column       — fallback payload value column label
 *   5. selectedColumnName             — selectedColumns[0].columnName fallback
 *   6. 'response'                     — hardcoded last resort
 *
 * selectedColumns[0] is intentionally ranked AFTER payload metadata so
 * explicit backend/module labels win regardless of column selection order.
 */
export function resolvePrimaryColumnName(
  payloadMetadata: Record<string, unknown>,
  payloadData: Record<string, unknown>,
  selectedColumnName: string | undefined
): string {
  const candidates: Array<unknown> = [
    payloadMetadata['variable_name'],
    payloadData['value_name'],
    payloadData['dependent_name'],
    payloadData['value_column'],
    selectedColumnName,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }
  return 'response'
}
