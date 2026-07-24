export const TYPE_CLASSIFICATION_RULES = {
  numericRatioForNumeric: 0.95,
  numericRatioForCategorical: 0.5,
  mixedRatioForNumericFallback: 0.6,
  mixedRatioForPlotNumericFallback: 0.8,
  ordinalMinLevels: 3,
  ordinalMaxLevels: 10,
  ordinalMinValue: 1,
  ordinalMaxValue: 10,
} as const

export function parseStrictNumber(value: unknown): number | null {
  const str = typeof value === 'string' ? value.trim() : String(value ?? '').trim()
  if (str.length === 0) return null
  const parsed = Number(str)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

export function normalizeCategoryToken(value: string): string {
  return value.trim().toLowerCase()
}

export function isLikertInteger(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= TYPE_CLASSIFICATION_RULES.ordinalMinValue &&
    value <= TYPE_CLASSIFICATION_RULES.ordinalMaxValue
  )
}
