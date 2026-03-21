import { describe, expect, it } from 'vitest'
import {
  getBarOutlineEnabledFromWidth,
  getBarOutlineWidthState,
} from '@/lib/plots/barOutlineState'

describe('barOutlineState', () => {
  it('treats missing width as enabled by default', () => {
    expect(getBarOutlineWidthState(undefined)).toEqual({
      mode: 'missing',
      enabled: true,
    })
  })

  it('supports opting out of default-enabled behavior when width is missing', () => {
    expect(getBarOutlineWidthState(undefined, false)).toEqual({
      mode: 'missing',
      enabled: false,
    })
  })

  it('parses scalar values consistently', () => {
    expect(getBarOutlineWidthState(1)).toEqual({ mode: 'scalar', enabled: true, width: 1 })
    expect(getBarOutlineWidthState(0)).toEqual({ mode: 'scalar', enabled: false, width: 0 })
    expect(getBarOutlineWidthState(-2)).toEqual({ mode: 'scalar', enabled: false, width: -2 })
    expect(getBarOutlineWidthState('2')).toEqual({ mode: 'scalar', enabled: true, width: 2 })
  })

  it('falls back to missing mode for malformed scalar widths', () => {
    expect(getBarOutlineWidthState('')).toEqual({ mode: 'missing', enabled: true })
    expect(getBarOutlineWidthState('abc')).toEqual({ mode: 'missing', enabled: true })
    expect(getBarOutlineWidthState(Number.NaN)).toEqual({ mode: 'missing', enabled: true })
  })

  it('normalizes array widths and detects enabled state from any positive entry', () => {
    expect(getBarOutlineWidthState([0, 1, 0])).toEqual({
      mode: 'array',
      enabled: true,
      widths: [0, 1, 0],
    })
    expect(getBarOutlineWidthState(['1', 'bad', Number.NaN, -1])).toEqual({
      mode: 'array',
      enabled: true,
      widths: [1, 0, 0, -1],
    })
    expect(getBarOutlineWidthState([0, -1, 'bad'])).toEqual({
      mode: 'array',
      enabled: false,
      widths: [0, -1, 0],
    })
  })

  it('exposes boolean helper for UI toggle decisions', () => {
    expect(getBarOutlineEnabledFromWidth([0, 0])).toBe(false)
    expect(getBarOutlineEnabledFromWidth([0, 1])).toBe(true)
    expect(getBarOutlineEnabledFromWidth(undefined)).toBe(true)
    expect(getBarOutlineEnabledFromWidth(undefined, false)).toBe(false)
  })
})
