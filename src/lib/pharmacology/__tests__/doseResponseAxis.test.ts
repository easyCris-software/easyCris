import { describe, expect, it } from 'vitest'
import {
  DOSE_RESPONSE_LOG_DTICK,
  getDoseInterpolationGuideStart,
  getNextAxisRevisionToken,
  isDoseResponseAxisCorrupted,
  sanitizeDoseResponseXAxis,
  shouldRejectDoseInterpolationByStabilityCap,
  stabilizeDoseResponseXAxisForInterpolation,
} from '../doseResponseAxis'

describe('doseResponseAxis utils', () => {
  it('sanitizes corrupted x-axis config to canonical log axis defaults', () => {
    const sanitized = sanitizeDoseResponseXAxis({
      type: 'category',
      range: [0, 1],
      tickmode: 'array',
      tickvals: [1, 2],
      ticktext: ['a', 'b'],
      dtick: 2,
      minor: { showgrid: true, ticks: 'outside' },
      categoryorder: 'array',
      categoryarray: ['a', 'b'],
    })

    expect(sanitized.type).toBe('log')
    expect(sanitized.autorange).toBe(true)
    expect(sanitized.tickmode).toBe('auto')
    expect(sanitized.dtick).toBeUndefined()
    expect(sanitized.nticks).toBeDefined()
    expect(sanitized.range).toBeUndefined()
    expect((sanitized as Record<string, unknown>).tickvals).toBeUndefined()
    expect((sanitized as Record<string, unknown>).ticktext).toBeUndefined()
    expect((sanitized as Record<string, unknown>).categoryarray).toBeUndefined()
    expect((sanitized as Record<string, unknown>).categoryorder).toBeUndefined()
    expect((sanitized.minor as Record<string, unknown>)?.showgrid).toBe(false)
    expect((sanitized.minor as Record<string, unknown>)?.ticks).toBe('')
  })

  it('detects axis corruption for non-log/category/tick-array residue configs', () => {
    expect(isDoseResponseAxisCorrupted({ type: 'log', dtick: 1, tickmode: 'linear' })).toBe(false)
    expect(isDoseResponseAxisCorrupted({ type: 'log', tickmode: 'array' })).toBe(true)
    expect(isDoseResponseAxisCorrupted({ type: 'log', tickvals: [1, 2] })).toBe(true)
    expect(isDoseResponseAxisCorrupted({ type: 'log', ticktext: ['1', '2'] })).toBe(true)
    expect(isDoseResponseAxisCorrupted({ type: 'log', categoryorder: 'array' })).toBe(true)
    expect(isDoseResponseAxisCorrupted({ type: 'linear' })).toBe(true)
    expect(isDoseResponseAxisCorrupted(undefined)).toBe(true)
  })

  it('stabilizes healthy axes while preserving user range and tick settings', () => {
    const stableDefault = stabilizeDoseResponseXAxisForInterpolation({
      type: 'log',
      range: [-3, 2],
      tickmode: 'auto',
    })
    expect(stableDefault.type).toBe('log')
    expect(stableDefault.tickmode).toBe('auto')
    expect(stableDefault.dtick).toBeUndefined()
    expect(stableDefault.range).toEqual([-3, 2])

    const stableCustom = stabilizeDoseResponseXAxisForInterpolation({
      type: 'log',
      tickmode: 'linear',
      dtick: 2,
    })
    expect(stableCustom.tickmode).toBe('linear')
    expect(stableCustom.dtick).toBe(2)
  })

  it('falls back to full sanitize when axis cannot be trusted', () => {
    const stabilized = stabilizeDoseResponseXAxisForInterpolation({
      type: 'log',
      tickmode: 'array',
      tickvals: [0.1, 1, 10],
      range: [-3, 2],
    })

    expect(stabilized.type).toBe('log')
    expect(stabilized.autorange).toBe(true)
    expect(stabilized.range).toBeUndefined()
    expect((stabilized as Record<string, unknown>).tickvals).toBeUndefined()
  })

  it('uses deterministic recovery range when observed dose range is available', () => {
    const sanitized = sanitizeDoseResponseXAxis(
      { type: 'category', tickmode: 'array', tickvals: [1, 2] },
      { observedDoseRange: [1.34, 12.54] }
    )

    expect(sanitized.type).toBe('log')
    expect(sanitized.autorange).toBe(false)
    expect(sanitized.tickmode).toBe('linear')
    expect(sanitized.dtick).toBe(DOSE_RESPONSE_LOG_DTICK)
    expect(Array.isArray(sanitized.range)).toBe(true)
    expect((sanitized.range as [number, number])[1]).toBeGreaterThan(
      (sanitized.range as [number, number])[0]
    )
  })

  it('uses auto ticks for wide recovery spans', () => {
    const sanitized = sanitizeDoseResponseXAxis(
      { type: 'category', tickmode: 'array', tickvals: [1, 2] },
      { observedDoseRange: [1e-3, 1e4] }
    )

    expect(sanitized.autorange).toBe(false)
    expect(sanitized.tickmode).toBe('auto')
    expect(sanitized.dtick).toBeUndefined()
    expect(sanitized.nticks).toBeDefined()
  })

  it('increments axis revision token only from current finite values', () => {
    expect(getNextAxisRevisionToken({})).toBe(1)
    expect(getNextAxisRevisionToken({ axisRevisionToken: 4 })).toBe(5)
  })

  it('applies extrapolation cap guardrail only when enabled', () => {
    const observedDoseRange: [number, number] = [0.001, 100]

    expect(
      shouldRejectDoseInterpolationByStabilityCap({
        xValue: 50,
        allowExtrapolation: true,
        observedDoseRange,
      })
    ).toBe(false)

    expect(
      shouldRejectDoseInterpolationByStabilityCap({
        xValue: 1e9,
        allowExtrapolation: true,
        observedDoseRange,
      })
    ).toBe(true)

    expect(
      shouldRejectDoseInterpolationByStabilityCap({
        xValue: 1e9,
        allowExtrapolation: false,
        observedDoseRange,
      })
    ).toBe(false)
  })

  it('computes bounded guide line start for interpolation overlays', () => {
    const start = getDoseInterpolationGuideStart({
      xValue: 50,
      observedDoseRange: [0.001, 100],
      xAxis: { type: 'log', range: [-3, 2] },
    })
    expect(start).toBeCloseTo(0.001, 12)

    const tinyX = getDoseInterpolationGuideStart({
      xValue: 0.0002,
      observedDoseRange: [0.001, 100],
      xAxis: { type: 'log', range: [-3, 2] },
    })
    expect(tinyX).toBeLessThanOrEqual(0.0002)
  })
})
