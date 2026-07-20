import { describe, expect, it } from 'vitest'
import {
  MAX_BATCH_INTERPOLATION_VALUES,
  parseBatchInterpolationInput,
} from '../doseResponseInterpolationBatch'

describe('doseResponseInterpolationBatch', () => {
  it('parses comma, whitespace, and newline-separated values', () => {
    const parsed = parseBatchInterpolationInput('1,2  3\n4')
    expect(parsed.values).toEqual([1, 2, 3, 4])
    expect(parsed.invalidTokenCount).toBe(0)
    expect(parsed.truncatedValueCount).toBe(0)
    expect(parsed.totalTokenCount).toBe(4)
  })

  it('counts invalid tokens', () => {
    const parsed = parseBatchInterpolationInput('1,foo,2,bar')
    expect(parsed.values).toEqual([1, 2])
    expect(parsed.invalidTokenCount).toBe(2)
    expect(parsed.totalTokenCount).toBe(4)
  })

  it('caps parsed values to max batch size', () => {
    const raw = Array.from({ length: MAX_BATCH_INTERPOLATION_VALUES + 4 }, (_, idx) => String(idx + 1)).join(',')
    const parsed = parseBatchInterpolationInput(raw)
    expect(parsed.values).toHaveLength(MAX_BATCH_INTERPOLATION_VALUES)
    expect(parsed.truncatedValueCount).toBe(4)
  })
})
