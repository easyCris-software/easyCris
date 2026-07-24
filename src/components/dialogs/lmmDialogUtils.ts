export interface CappedCartesianPreviewResult {
  rows: string[][]
  totalCount: number
  isTotalCountCapped: boolean
}

export interface ContinuousTimeParseResult {
  values: number[]
  invalidTokens: string[]
}

export const MAX_PREVIEW_ROWS = 20

function multiplyCounts(values: number[]): { totalCount: number; isTotalCountCapped: boolean } {
  if (values.length === 0) return { totalCount: 0, isTotalCountCapped: false }

  let product = 1
  for (const value of values) {
    if (value <= 0) return { totalCount: 0, isTotalCountCapped: false }
    if (product >= Number.MAX_SAFE_INTEGER / value) {
      return { totalCount: Number.MAX_SAFE_INTEGER, isTotalCountCapped: true }
    }
    product *= value
  }
  return { totalCount: product, isTotalCountCapped: false }
}

export function buildCappedCartesianPreview(
  arrays: string[][],
  limit: number
): CappedCartesianPreviewResult {
  if (arrays.length === 0 || limit <= 0) {
    return { rows: [], totalCount: 0, isTotalCountCapped: false }
  }
  if (arrays.some(set => set.length === 0)) {
    return { rows: [], totalCount: 0, isTotalCountCapped: false }
  }

  const { totalCount, isTotalCountCapped } = multiplyCounts(arrays.map(set => set.length))

  let rows: string[][] = [[]]
  for (const set of arrays) {
    const nextRows: string[][] = []
    for (const combo of rows) {
      for (const item of set) {
        if (nextRows.length >= limit) break
        nextRows.push([...combo, item])
      }
      if (nextRows.length >= limit) break
    }
    rows = nextRows
    if (rows.length === 0) break
  }

  return {
    rows,
    totalCount,
    isTotalCountCapped,
  }
}

export function parseContinuousTimeValues(input: string): ContinuousTimeParseResult {
  const rawTokens = input
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)

  const invalidTokens: string[] = []
  const values: number[] = []
  const seen = new Set<number>()

  for (const token of rawTokens) {
    const numericValue = Number(token)
    if (!Number.isFinite(numericValue)) {
      invalidTokens.push(token)
      continue
    }
    if (seen.has(numericValue)) continue
    seen.add(numericValue)
    values.push(numericValue)
  }

  return { values, invalidTokens }
}
