export const MAX_BATCH_INTERPOLATION_VALUES = 20

export interface ParsedBatchInterpolationInput {
  values: number[]
  invalidTokenCount: number
  truncatedValueCount: number
  totalTokenCount: number
}

export function parseBatchInterpolationInput(raw: string): ParsedBatchInterpolationInput {
  const tokens = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)

  const values: number[] = []
  let invalidTokenCount = 0
  for (const token of tokens) {
    const parsed = Number(token)
    if (Number.isFinite(parsed)) {
      values.push(parsed)
    } else {
      invalidTokenCount += 1
    }
  }

  const truncatedValueCount = Math.max(0, values.length - MAX_BATCH_INTERPOLATION_VALUES)

  return {
    values: values.slice(0, MAX_BATCH_INTERPOLATION_VALUES),
    invalidTokenCount,
    truncatedValueCount,
    totalTokenCount: tokens.length,
  }
}
