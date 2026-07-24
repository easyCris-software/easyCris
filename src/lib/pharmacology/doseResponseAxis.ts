import type { Layout } from 'plotly.js'
import type { PlotLayoutMeta } from '@/utils/plotBuilders/types'

export const DOSE_RESPONSE_LOG_DTICK = 1
export const DOSE_RESPONSE_LOG_NTICKS = 9
export const DOSE_INTERPOLATION_STABILITY_LOG_DECADES = 6
const DOSE_RESPONSE_RECOVERY_RANGE_PADDING_MULTIPLIER = 2
export const DOSE_INTERPOLATION_EXTRAPOLATION_CAP_MULTIPLIER = Math.pow(
  10,
  DOSE_INTERPOLATION_STABILITY_LOG_DECADES
)

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const toPositiveFiniteNumber = (value: unknown): number | null => {
  const parsed = toFiniteNumber(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

const buildDoseResponseRecoveryLogRange = ({
  observedDoseRange,
  anchorX,
}: {
  observedDoseRange?: [number, number] | null
  anchorX?: number | null
}): [number, number] | null => {
  const values: number[] = []
  const observedMin = toPositiveFiniteNumber(observedDoseRange?.[0] ?? null)
  const observedMax = toPositiveFiniteNumber(observedDoseRange?.[1] ?? null)
  if (observedMin !== null) values.push(observedMin)
  if (observedMax !== null) values.push(observedMax)
  if (typeof anchorX === 'number' && Number.isFinite(anchorX) && anchorX > 0) {
    values.push(anchorX)
  }
  if (values.length === 0) return null

  let minValue = Math.min(...values)
  let maxValue = Math.max(...values)
  if (minValue === maxValue) {
    minValue = minValue / 10
    maxValue = maxValue * 10
  }
  const paddedMin = Math.max(minValue / DOSE_RESPONSE_RECOVERY_RANGE_PADDING_MULTIPLIER, 1e-12)
  const paddedMax = maxValue * DOSE_RESPONSE_RECOVERY_RANGE_PADDING_MULTIPLIER
  if (!Number.isFinite(paddedMin) || !Number.isFinite(paddedMax) || paddedMin <= 0 || paddedMax <= paddedMin) {
    return null
  }

  const range: [number, number] = [Math.log10(paddedMin), Math.log10(paddedMax)]
  return Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0]
    ? range
    : null
}

export const sanitizeDoseResponseXAxis = (
  axis: Partial<Layout['xaxis']> | undefined,
  options?: {
    observedDoseRange?: [number, number] | null
    anchorX?: number | null
  }
): Partial<Layout['xaxis']> => {
  const next = { ...(axis ?? {}) } as Record<string, unknown>
  next.type = 'log'
  next.exponentformat = 'e'
  next.tickmode = 'linear'
  next.dtick = DOSE_RESPONSE_LOG_DTICK
  next.nticks = DOSE_RESPONSE_LOG_NTICKS
  next.minor = {
    ...(typeof next.minor === 'object' && next.minor !== null
      ? (next.minor as Record<string, unknown>)
      : {}),
    ticks: '',
    showgrid: false,
  }
  delete next.range
  delete next.nticks
  delete next.tickvals
  delete next.ticktext
  delete next.tick0
  delete next.tickformatstops
  delete next.categoryarray
  delete next.categoryorder
  delete next.rangebreaks

  const recoveryRange = buildDoseResponseRecoveryLogRange({
    observedDoseRange: options?.observedDoseRange,
    anchorX: options?.anchorX,
  })
  const recoveryDecades =
    recoveryRange && Number.isFinite(recoveryRange[0]) && Number.isFinite(recoveryRange[1])
      ? Math.abs((recoveryRange[1] ?? 0) - (recoveryRange[0] ?? 0))
      : null

  // Adaptive tick strategy for recovery:
  // - tighter spans keep decade ticks
  // - wider spans use auto ticks to avoid visual compression/noise
  if (recoveryDecades !== null && recoveryDecades <= 4) {
    next.tickmode = 'linear'
    next.dtick = DOSE_RESPONSE_LOG_DTICK
    delete next.nticks
  } else {
    next.tickmode = 'auto'
    next.nticks = DOSE_RESPONSE_LOG_NTICKS
    delete next.dtick
  }

  if (recoveryRange) {
    next.autorange = false
    next.range = recoveryRange
  } else {
    next.autorange = true
  }

  return next as Partial<Layout['xaxis']>
}

export const isDoseResponseAxisCorrupted = (
  axis: Partial<Layout['xaxis']> | undefined
): boolean => {
  if (!axis) return true
  const typed = axis as Record<string, unknown>
  const axisType = typeof typed.type === 'string' ? typed.type.toLowerCase() : ''
  if (axisType !== 'log') return true
  if (Array.isArray(typed.tickvals) || Array.isArray(typed.ticktext)) return true
  if (typed.tickmode === 'array') return true
  if (typed.categoryarray !== undefined || typed.categoryorder !== undefined) return true
  return false
}

export const stabilizeDoseResponseXAxisForInterpolation = (
  axis: Partial<Layout['xaxis']> | undefined
): Partial<Layout['xaxis']> => {
  if (isDoseResponseAxisCorrupted(axis)) {
    return sanitizeDoseResponseXAxis(axis)
  }

  const next = { ...(axis ?? {}) } as Record<string, unknown>
  next.type = 'log'
  next.exponentformat = typeof next.exponentformat === 'string' ? next.exponentformat : 'e'

  const hasCustomArrayTicks =
    next.tickmode === 'array' || Array.isArray(next.tickvals) || Array.isArray(next.ticktext)
  if (hasCustomArrayTicks) {
    return sanitizeDoseResponseXAxis(axis)
  }

  // Healthy axis: preserve current tick/range/zoom behavior.
  next.minor = {
    ...(typeof next.minor === 'object' && next.minor !== null
      ? (next.minor as Record<string, unknown>)
      : {}),
    ticks: '',
    showgrid: false,
  }
  return next as Partial<Layout['xaxis']>
}

export const getNextAxisRevisionToken = (meta: PlotLayoutMeta): number => {
  const current = meta.axisRevisionToken
  return typeof current === 'number' && Number.isFinite(current) ? current + 1 : 1
}

export const shouldRejectDoseInterpolationByStabilityCap = ({
  xValue,
  allowExtrapolation,
  observedDoseRange,
}: {
  xValue: number
  allowExtrapolation: boolean
  observedDoseRange: [number, number] | null | undefined
}): boolean => {
  if (!allowExtrapolation || !observedDoseRange) return false
  const observedMin = toPositiveFiniteNumber(observedDoseRange[0])
  const observedMax = toPositiveFiniteNumber(observedDoseRange[1])
  if (observedMin === null || observedMax === null) return false

  const stableMin = observedMin / DOSE_INTERPOLATION_EXTRAPOLATION_CAP_MULTIPLIER
  const stableMax = observedMax * DOSE_INTERPOLATION_EXTRAPOLATION_CAP_MULTIPLIER
  return xValue < stableMin || xValue > stableMax
}

export const getDoseInterpolationGuideStart = ({
  xValue,
  observedDoseRange,
  xAxis,
}: {
  xValue: number
  observedDoseRange: [number, number] | null | undefined
  xAxis: Partial<Layout['xaxis']> | undefined
}): number => {
  const visibleRange = Array.isArray(xAxis?.range) ? xAxis.range : null
  const visibleMinRaw = visibleRange?.[0]
  const visibleMaxRaw = visibleRange?.[1]
  const visibleMin = toFiniteNumber(visibleMinRaw)
  const visibleMax = toFiniteNumber(visibleMaxRaw)
  const axisType = typeof xAxis?.type === 'string' ? xAxis.type.toLowerCase() : ''

  let visibleDataMin: number | null = null
  if (visibleMin !== null && visibleMax !== null) {
    const low = Math.min(visibleMin, visibleMax)
    if (axisType === 'log') {
      const converted = Math.pow(10, low)
      visibleDataMin = Number.isFinite(converted) && converted > 0 ? converted : null
    } else {
      visibleDataMin = low > 0 ? low : null
    }
  }

  const observedMin = toPositiveFiniteNumber(observedDoseRange?.[0] ?? null)
  const ratioFloor = xValue / DOSE_INTERPOLATION_EXTRAPOLATION_CAP_MULTIPLIER
  const candidate = Math.max(
    observedMin ?? ratioFloor,
    visibleDataMin ?? ratioFloor,
    ratioFloor,
    1e-12
  )
  return Math.min(candidate, xValue)
}
