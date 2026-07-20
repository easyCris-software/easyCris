import { describe, expect, it } from 'vitest'
import { buildMainEffectContrastSummary } from '../contrastSummary'

describe('buildMainEffectContrastSummary', () => {
  it('returns one contrast for a two-level factor', () => {
    const result = buildMainEffectContrastSummary({
      referenceLevel: 'vehicle',
      testLevel: 'RETA',
      levels: ['vehicle', 'RETA'],
    })

    expect(result.count).toBe(1)
    expect(result.summary).toBe('RETA vs vehicle')
  })

  it('returns all non-reference contrasts for multi-level factors', () => {
    const result = buildMainEffectContrastSummary({
      referenceLevel: 'vehicle',
      testLevel: 'RETA',
      levels: ['vehicle', 'RETA', 'RETA_wd'],
    })

    expect(result.count).toBe(2)
    expect(result.summary).toBe('RETA vs vehicle, RETA_wd vs vehicle (2 contrasts)')
  })

  it('returns no-valid summary when no non-reference level exists', () => {
    const result = buildMainEffectContrastSummary({
      referenceLevel: 'vehicle',
      testLevel: 'vehicle',
      levels: ['vehicle'],
    })

    expect(result.count).toBe(0)
    expect(result.summary).toBe('No valid contrast yet')
  })

  it('keeps selected test visible when levels are stale and de-duplicates values', () => {
    const result = buildMainEffectContrastSummary({
      referenceLevel: 'vehicle',
      testLevel: 'RETA_wd',
      levels: ['vehicle', 'RETA', 'RETA', 'RETA_wd', ' '],
    })

    expect(result.count).toBe(2)
    expect(result.summary).toBe('RETA_wd vs vehicle, RETA vs vehicle (2 contrasts)')
  })
})

