import { describe, expect, it } from 'vitest'
import {
  evaluateDoseResponseValue,
  interpolateDoseResponse,
  invertDoseResponseValue,
  normalizeDoseResponseInterpolationModel,
} from '../doseResponseInterpolation'

describe('doseResponseInterpolation', () => {
  const context = {
    model: '4PL' as const,
    parameters: {
      bottom: 0,
      top: 100,
      ic50: 10,
      hill: 1.2,
    },
    observedDoseRange: [1, 100] as [number, number],
  }

  it('normalizes supported model tokens', () => {
    expect(normalizeDoseResponseInterpolationModel('dose_response_3pl')).toBe('3PL')
    expect(normalizeDoseResponseInterpolationModel('4pl_scaled')).toBe('4PL')
    expect(normalizeDoseResponseInterpolationModel('dose_response_5pl')).toBeNull()
  })

  it('evaluates forward interpolation for valid concentration', () => {
    const y = evaluateDoseResponseValue(context.parameters, 10)
    expect(y).not.toBeNull()
    expect(y as number).toBeCloseTo(50, 6)
  })

  it('solves inverse interpolation for valid response', () => {
    const x = invertDoseResponseValue(context.parameters, 50)
    expect(x).not.toBeNull()
    expect(x as number).toBeCloseTo(10, 6)
  })

  it('blocks forward extrapolation when disabled', () => {
    const result = interpolateDoseResponse(context, 'forward', 150, {
      allowExtrapolation: false,
    })
    expect(result.status).toBe('out_of_range')
    expect(result.value).toBeNull()
  })

  it('allows forward extrapolation when enabled', () => {
    const result = interpolateDoseResponse(context, 'forward', 150, {
      allowExtrapolation: true,
    })
    expect(result.status).toBe('ok')
    expect(result.value).not.toBeNull()
    expect(result.extrapolated).toBe(true)
  })

  it('rejects inverse interpolation on asymptote boundaries', () => {
    const low = interpolateDoseResponse(context, 'inverse', 0)
    const high = interpolateDoseResponse(context, 'inverse', 100)
    expect(low.status).toBe('out_of_range')
    expect(high.status).toBe('out_of_range')
  })

  it('supports negative hill values used by increasing curves', () => {
    const increasingContext = {
      ...context,
      parameters: {
        ...context.parameters,
        hill: -1.1,
      },
    }

    const result = interpolateDoseResponse(increasingContext, 'inverse', 75)
    expect(result.status).toBe('ok')
    expect(result.value).not.toBeNull()
    expect(result.extrapolated).toBe(false)
  })
})
