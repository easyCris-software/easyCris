import { describe, expect, it } from 'vitest'
import {
  buildCappedCartesianPreview,
  MAX_PREVIEW_ROWS,
  parseContinuousTimeValues,
} from './lmmDialogUtils'

describe('lmmDialogUtils', () => {
  it('computes exact subgroup count while returning only capped preview rows', () => {
    const levels = Array.from({ length: 1000 }, (_, i) => `L${i}`)
    const result = buildCappedCartesianPreview([levels, levels, levels], MAX_PREVIEW_ROWS)

    expect(result.totalCount).toBe(1_000_000_000)
    expect(result.rows).toHaveLength(MAX_PREVIEW_ROWS)
    expect(result.rows[0]).toEqual(['L0', 'L0', 'L0'])
    expect(result.rows[MAX_PREVIEW_ROWS - 1]).toEqual(['L0', 'L0', `L${MAX_PREVIEW_ROWS - 1}`])
  })

  it('parses numeric-time values strictly and reports invalid tokens', () => {
    const result = parseContinuousTimeValues('0, 2x, 4')

    expect(result.values).toEqual([0, 4])
    expect(result.invalidTokens).toEqual(['2x'])
  })

  it('deduplicates valid numeric-time values while preserving first occurrence order', () => {
    const result = parseContinuousTimeValues('0,2,2.0,4,2')

    expect(result.values).toEqual([0, 2, 4])
    expect(result.invalidTokens).toEqual([])
  })

  it('flags when subgroup combination count is capped at JS safe integer', () => {
    const sparse = new Array<string>(100_000)
    const result = buildCappedCartesianPreview(
      [sparse, sparse, sparse, sparse],
      MAX_PREVIEW_ROWS
    )

    expect(result.isTotalCountCapped).toBe(true)
    expect(result.totalCount).toBe(Number.MAX_SAFE_INTEGER)
    expect(result.rows).toHaveLength(MAX_PREVIEW_ROWS)
  })
})
