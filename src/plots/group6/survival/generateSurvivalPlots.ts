/**
 * Group 6 survival plot generators.
 */

import type { Data, Layout } from 'plotly.js'
import type { TestResult } from '@/store/results-store'
import type { PlotBuilderInput } from '@/utils/plotBuilders'
import type { PlotBuilderOutput } from '@/utils/plotBuilders/types'
import { forestPlotBuilder } from '@/utils/plotBuilders'
import { applyAlpha, createBaseLayout, createDefaultConfig, DEFAULT_COLORS, getColor } from '@/utils/plotBuilders/common'
import { getResultData } from '@/services/plotResult/common/payload'
import { toNumber } from '@/services/plotResult/common/normalize'

type StepSeries = {
  label: string
  time: number[]
  value: number[]
  ciLower?: Array<number | null>
  ciUpper?: Array<number | null>
  eventCounts?: number[] // For filtering to event-time rows in stats
}

type SmoothedHazardSeries = {
  label: string
  time: number[]
  hazard: number[]
  ciLower?: Array<number | null>
  ciUpper?: Array<number | null>
  bandwidth?: number
}

type HazardIncrementSeries = {
  label: string
  time: number[]
  hazard: number[]
}

type HazardIncrementStats = {
  nPoints: number
  maxTime: number
  maxHazard: number
}

function buildAxisFont() {
  return { family: 'Inter, sans-serif', size: 12, color: '#111827', weight: 700 }
}

const MIN_POSITIVE_RATIO = 0.001

function buildLogRatioRange(
  estimates: number[],
  ciLowers: number[],
  ciUppers: number[]
): [number, number] {
  const positiveValues = [...estimates, ...ciLowers, ...ciUppers, 1].filter(
    (value) => Number.isFinite(value) && value > 0
  )
  const safeMin = Math.max(MIN_POSITIVE_RATIO, Math.min(...positiveValues))
  const safeMax = Math.max(safeMin * 1.01, Math.max(...positiveValues))
  const logMin = Math.log10(safeMin)
  const logMax = Math.log10(safeMax)
  const pad = Math.max(0.15, (logMax - logMin) * 0.08)
  return [logMin - pad, logMax + pad]
}

function derivePositiveHazardRatio(param: Record<string, unknown>): number | null {
  const hazardRatio = toNumber(param.hazard_ratio)
  if (hazardRatio !== null && hazardRatio > 0) return hazardRatio

  const coef = toNumber(param.estimate)
  if (coef === null) return null
  const derived = Math.exp(coef)
  return Number.isFinite(derived) && derived > 0 ? derived : null
}

function buildSurvivalLayout(
  title: string,
  yTitle: string,
  yRange?: [number, number]
): Partial<Layout> {
  const axisFont = buildAxisFont()
  return {
    ...createBaseLayout({ title, showLegend: true }),
    xaxis: {
      title: { text: 'Time', font: axisFont },
      tickfont: axisFont,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
    },
    yaxis: {
      title: { text: yTitle, font: axisFont },
      ...(yRange ? { range: yRange } : {}),
      tickfont: axisFont,
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
    },
  }
}

function extractSeriesFromTable(
  rows: unknown,
  valueKey: string,
  ciLowerKey?: string,
  ciUpperKey?: string
): Omit<StepSeries, 'label'> | null {
  if (!Array.isArray(rows)) return null
  const time: number[] = []
  const value: number[] = []
  const ciLower: Array<number | null> = []
  const ciUpper: Array<number | null> = []
  const eventCounts: number[] = []

  rows.forEach((row) => {
    if (!row || typeof row !== 'object') return
    const record = row as Record<string, unknown>
    const t = toNumber(record.time)
    const v = toNumber(record[valueKey])
    if (t === null || v === null) return
    time.push(t)
    value.push(v)
    if (ciLowerKey && ciUpperKey) {
      ciLower.push(toNumber(record[ciLowerKey]))
      ciUpper.push(toNumber(record[ciUpperKey]))
    }
    // Extract event count for filtering to event-time rows in stats
    const events = toNumber(record.events)
    eventCounts.push(events ?? 0)
  })

  if (time.length === 0) return null
  return {
    time,
    value,
    ...(ciLowerKey && ciUpperKey ? { ciLower, ciUpper } : {}),
    eventCounts,
  }
}

function collectKmSeries(raw: Record<string, unknown>): StepSeries[] {
  const strata = raw.strata as Array<Record<string, unknown>> | undefined
  if (Array.isArray(strata) && strata.length > 0) {
    return strata
      .map((entry) => {
        const series = extractSeriesFromTable(entry.life_table, 'survival', 'ci_lower_95', 'ci_upper_95')
        if (!series) return null
        const label = String(entry.display_label ?? entry.stratum ?? 'Group')
        return { label, ...series }
      })
      .filter((series): series is StepSeries => Boolean(series))
  }

  const series = extractSeriesFromTable(raw.life_table, 'survival', 'ci_lower_95', 'ci_upper_95')
  return series ? [{ label: 'Overall', ...series }] : []
}

function collectNaSeries(raw: Record<string, unknown>): StepSeries[] {
  const strata = raw.strata as Array<Record<string, unknown>> | undefined
  if (Array.isArray(strata) && strata.length > 0) {
    return strata
      .map((entry) => {
        const series = extractSeriesFromTable(entry.hazard_table, 'cumulative_hazard', 'ci_lower_95', 'ci_upper_95')
        if (!series) return null
        const label = String(entry.display_label ?? entry.stratum ?? 'Group')
        return { label, ...series }
      })
      .filter((series): series is StepSeries => Boolean(series))
  }

  const series = extractSeriesFromTable(raw.hazard_table, 'cumulative_hazard', 'ci_lower_95', 'ci_upper_95')
  return series ? [{ label: 'Overall', ...series }] : []
}

function collectAdjustedSurvivalSeries(raw: Record<string, unknown>): StepSeries[] {
  const curves = raw.adjusted_survival_curves as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(curves)) return []

  return curves
    .map((curve) => {
      const timeValues = Array.isArray(curve.time) ? curve.time.map((v) => toNumber(v)) : []
      const survivalValues = Array.isArray(curve.survival) ? curve.survival.map((v) => toNumber(v)) : []
      const time: number[] = []
      const value: number[] = []
      const len = Math.min(timeValues.length, survivalValues.length)
      for (let i = 0; i < len; i++) {
        const t = timeValues[i]
        const s = survivalValues[i]
        if (t == null || s == null) continue
        time.push(t)
        value.push(s)
      }
      if (time.length === 0) return null
      return {
        label: String(curve.label ?? 'Adjusted'),
        time,
        value,
      }
    })
    .filter((series): series is StepSeries => Boolean(series))
}

function collectSmoothedHazardSeries(raw: Record<string, unknown>): SmoothedHazardSeries[] {
  const strata = raw.strata as Array<Record<string, unknown>> | undefined
  if (Array.isArray(strata) && strata.length > 0) {
    return strata
      .map((entry) => {
        const series = entry.smoothed_hazard as Record<string, unknown> | undefined
        if (!series) return null
        return normalizeSmoothedHazard(series, String(entry.display_label ?? entry.stratum ?? 'Group'))
      })
      .filter((series): series is SmoothedHazardSeries => Boolean(series))
  }

  const series = raw.smoothed_hazard as Record<string, unknown> | undefined
  const normalized = series ? normalizeSmoothedHazard(series, 'Overall') : null
  return normalized ? [normalized] : []
}

function normalizeSmoothedHazard(series: Record<string, unknown>, label: string): SmoothedHazardSeries | null {
  const timeValues = Array.isArray(series.time) ? series.time.map((v) => toNumber(v)) : []
  const hazardValues = Array.isArray(series.hazard) ? series.hazard.map((v) => toNumber(v)) : []
  const ciLowerValues = Array.isArray(series.ci_lower_95) ? series.ci_lower_95.map((v) => toNumber(v)) : []
  const ciUpperValues = Array.isArray(series.ci_upper_95) ? series.ci_upper_95.map((v) => toNumber(v)) : []
  const time: number[] = []
  const hazard: number[] = []
  const ciLower: Array<number | null> = []
  const ciUpper: Array<number | null> = []

  const len = Math.min(timeValues.length, hazardValues.length)
  for (let i = 0; i < len; i++) {
    const t = timeValues[i]
    const h = hazardValues[i]
    if (t == null || h == null) continue
    time.push(t)
    hazard.push(h)
    if (ciLowerValues.length > i) ciLower.push(ciLowerValues[i] ?? null)
    if (ciUpperValues.length > i) ciUpper.push(ciUpperValues[i] ?? null)
  }

  if (time.length === 0) return null
  return {
    label,
    time,
    hazard,
    ciLower: ciLower.length ? ciLower : undefined,
    ciUpper: ciUpper.length ? ciUpper : undefined,
    bandwidth: toNumber(series.bandwidth) ?? undefined,
  }
}

function extractHazardIncrementSeries(
  rows: unknown,
  label: string
): HazardIncrementSeries | null {
  if (!Array.isArray(rows)) return null
  const entries = rows
    .map((row) => {
      if (!row || typeof row !== 'object') return null
      const record = row as Record<string, unknown>
      const time = toNumber(record.time)
      const events = toNumber(record.events)
      const cumhaz = toNumber(record.cumulative_hazard)
      if (time == null || cumhaz == null) return null
      return { time, events: events ?? 0, cumhaz }
    })
    .filter((row): row is { time: number; events: number; cumhaz: number } => Boolean(row))
    .sort((a, b) => a.time - b.time)

  if (entries.length === 0) return null

  const time: number[] = []
  const hazard: number[] = []
  let prevCumHaz: number | null = null

  entries.forEach((row) => {
    if (row.events <= 0) return
    const increment = prevCumHaz === null ? row.cumhaz : row.cumhaz - prevCumHaz
    prevCumHaz = row.cumhaz
    if (!Number.isFinite(increment)) return
    time.push(row.time)
    hazard.push(increment)
  })

  if (time.length === 0) return null
  return { label, time, hazard }
}

function collectHazardIncrementSeries(raw: Record<string, unknown>): HazardIncrementSeries[] {
  const strata = raw.strata as Array<Record<string, unknown>> | undefined
  if (Array.isArray(strata) && strata.length > 0) {
    return strata
      .map((entry) => {
        const label = String(entry.display_label ?? entry.stratum ?? 'Group')
        return extractHazardIncrementSeries(entry.hazard_table, label)
      })
      .filter((series): series is HazardIncrementSeries => Boolean(series))
  }

  const series = extractHazardIncrementSeries(raw.hazard_table, 'Overall')
  return series ? [series] : []
}

function computeHazardIncrementStats(raw: Record<string, unknown>): HazardIncrementStats | null {
  const tables: Array<Array<Record<string, unknown>>> = []
  const strata = raw.strata as Array<Record<string, unknown>> | undefined

  if (Array.isArray(strata) && strata.length > 0) {
    strata.forEach((entry) => {
      if (Array.isArray(entry.hazard_table)) {
        tables.push(entry.hazard_table as Array<Record<string, unknown>>)
      }
    })
  } else if (Array.isArray(raw.hazard_table)) {
    tables.push(raw.hazard_table as Array<Record<string, unknown>>)
  }

  if (tables.length === 0) return null

  let nPoints = 0
  let maxTime = 0
  let maxHazard = Number.NEGATIVE_INFINITY

  tables.forEach((table) => {
    const rows = table
      .map((row) => {
        const time = toNumber((row as Record<string, unknown>).time)
        const events = toNumber((row as Record<string, unknown>).events)
        const cumhaz = toNumber((row as Record<string, unknown>).cumulative_hazard)
        if (time == null || cumhaz == null) return null
        return { time, events: events ?? 0, cumhaz }
      })
      .filter((row): row is { time: number; events: number; cumhaz: number } => Boolean(row))
      .sort((a, b) => a.time - b.time)

    if (rows.length === 0) return

    let prevCumHaz: number | null = null
    rows.forEach((row) => {
      if (row.events <= 0) return
      const increment = prevCumHaz === null ? row.cumhaz : row.cumhaz - prevCumHaz
      prevCumHaz = row.cumhaz
      nPoints += 1
      if (row.time > maxTime) maxTime = row.time
      if (Number.isFinite(increment)) {
        maxHazard = Math.max(maxHazard, increment)
      }
    })
  })

  if (nPoints === 0) return null
  return {
    nPoints,
    maxTime,
    maxHazard: Number.isFinite(maxHazard) ? maxHazard : 0,
  }
}

function buildStepCurveOutput(
  curves: StepSeries[],
  title: string,
  yTitle: string,
  yRange?: [number, number]
): PlotBuilderOutput | null {
  if (curves.length === 0) return null

  const data: Data[] = []
  const ciLabel = '95% CI'
  let hasCI = false
  let totalPoints = 0
  let maxTime = 0
  let minValue = Number.POSITIVE_INFINITY
  let maxValue = Number.NEGATIVE_INFINITY

  curves.forEach((curve, idx) => {
    const color = getColor(idx)
    const ciLower = curve.ciLower
    const ciUpper = curve.ciUpper
    if (ciLower && ciUpper && ciLower.length === curve.time.length && ciUpper.length === curve.time.length) {
      hasCI = true
      data.push({
        type: 'scatter',
        mode: 'lines',
        x: curve.time,
        y: ciLower,
        name: `${curve.label} ${ciLabel} (lower)`,
        legendgroup: `${curve.label}-ci`,
        line: { color: applyAlpha(color, 0.15), width: 0, shape: 'hv' },
        hoverinfo: 'skip',
        showlegend: false,
        visible: true,
        meta: { role: 'confidence_band_lower' },
      })
      data.push({
        type: 'scatter',
        mode: 'lines',
        x: curve.time,
        y: ciUpper,
        line: { color: applyAlpha(color, 0.15), width: 0, shape: 'hv' },
        fill: 'tonexty',
        fillcolor: applyAlpha(color, 0.15),
        hoverinfo: 'skip',
        showlegend: true,
        visible: true,
        name: `${curve.label} ${ciLabel}`,
        legendgroup: `${curve.label}-ci`,
        meta: { role: 'confidence_band_upper' },
      })
    }

    data.push({
      type: 'scatter',
      mode: 'lines',
      x: curve.time,
      y: curve.value,
      name: curve.label,
      line: { color, width: 2, shape: 'hv' },
      hovertemplate: 'Time: %{x:.3f}<br>Value: %{y:.3f}<extra></extra>',
    })

    // Stats: use event-time rows when available; otherwise fallback to all points.
    const events = curve.eventCounts ?? []
    const hasEvents = events.length > 0 && events.some((count) => count > 0)
    const pointCount = hasEvents ? curve.time.filter((_, i) => (events[i] ?? 0) > 0).length : curve.time.length

    totalPoints += pointCount
    curve.time.forEach((t, i) => {
      if (hasEvents && (events[i] ?? 0) <= 0) return
      if (Number.isFinite(t) && t > maxTime) maxTime = t
    })
    curve.value.forEach((v, i) => {
      if (hasEvents && (events[i] ?? 0) <= 0) return
      if (Number.isFinite(v)) {
        minValue = Math.min(minValue, v)
        maxValue = Math.max(maxValue, v)
      }
    })
  })

  const stats: Record<string, number | string> = {
    n_curves: curves.length,
    n_points: totalPoints,
    max_time: maxTime,
    min_value: Number.isFinite(minValue) ? minValue : 0,
    max_value: Number.isFinite(maxValue) ? maxValue : 0,
  }

  const layout = buildSurvivalLayout(title, yTitle, yRange)
  const meta = (layout.meta as Record<string, unknown> | undefined) ?? {}
  const nextLayout = hasCI
    ? {
        ...layout,
        meta: {
          ...meta,
          confidenceBandLabel: ciLabel,
          showConfidenceBand: true,
        },
      }
    : layout

  return {
    data,
    layout: nextLayout,
    config: createDefaultConfig(),
    stats,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }
}

export function buildKaplanMeierPlot(result: TestResult): PlotBuilderOutput | null {
  const raw = getResultData(result)
  const curves = collectKmSeries(raw)
  return buildStepCurveOutput(curves, 'Kaplan-Meier Survival Curve', 'Survival Probability', [0, 1])
}

export function buildCoxAdjustedSurvivalPlot(result: TestResult): PlotBuilderOutput | null {
  const raw = getResultData(result)
  const curves = collectAdjustedSurvivalSeries(raw)
  return buildStepCurveOutput(curves, 'Adjusted Survival Curves', 'Survival Probability', [0, 1])
}

export function buildNelsonAalenCumulativeHazardPlot(result: TestResult): PlotBuilderOutput | null {
  const raw = getResultData(result)
  const curves = collectNaSeries(raw)
  return buildStepCurveOutput(curves, 'Cumulative Hazard Curve', 'Cumulative Hazard')
}

export function buildNelsonAalenSmoothedHazardPlot(result: TestResult): PlotBuilderOutput | null {
  const raw = getResultData(result)
  const incrementCurves = collectHazardIncrementSeries(raw)
  if (incrementCurves.length > 0) {
    const data: Data[] = []
    let totalPoints = 0
    let maxTime = 0
    let maxHazard = Number.NEGATIVE_INFINITY

    incrementCurves.forEach((curve, idx) => {
      const color = getColor(idx)
      data.push({
        type: 'scatter',
        mode: 'lines+markers',
        x: curve.time,
        y: curve.hazard,
        name: curve.label,
        line: { color, width: 2 },
        marker: { color, size: 6 },
        hovertemplate: 'Time: %{x:.3f}<br>Hazard: %{y:.3f}<extra></extra>',
      })

      totalPoints += curve.time.length
      curve.time.forEach((t) => {
        if (Number.isFinite(t) && t > maxTime) maxTime = t
      })
      curve.hazard.forEach((h) => {
        if (Number.isFinite(h)) maxHazard = Math.max(maxHazard, h)
      })
    })

    const stats: Record<string, number | string> = {
      n_curves: incrementCurves.length,
      n_points: totalPoints,
      max_time: maxTime,
      max_hazard: Number.isFinite(maxHazard) ? maxHazard : 0,
    }

    return {
      data,
      layout: buildSurvivalLayout('Hazard Rate (Nelson-Aalen Increments)', 'Hazard Rate'),
      config: createDefaultConfig(),
      stats,
      dataPolicy: 'raw',
      samplingConfig: null,
      aggregationConfig: null,
    }
  }

  const curves = collectSmoothedHazardSeries(raw)
  if (curves.length === 0) return null

  const data: Data[] = []
  const ciLabel = '95% CI'
  let hasCI = false
  let totalPoints = 0
  let maxTime = 0
  let maxHazard = Number.NEGATIVE_INFINITY
  let bandwidth = 0

  curves.forEach((curve, idx) => {
    const color = getColor(idx)
    if (
      curve.ciLower &&
      curve.ciUpper &&
      curve.ciLower.length === curve.time.length &&
      curve.ciUpper.length === curve.time.length
    ) {
      hasCI = true
      data.push({
        type: 'scatter',
        mode: 'lines',
        x: curve.time,
        y: curve.ciLower,
        name: `${curve.label} ${ciLabel} (lower)`,
        legendgroup: `${curve.label}-ci`,
        line: { color: applyAlpha(color, 0.15), width: 0, shape: 'hv' },
        hoverinfo: 'skip',
        showlegend: false,
        visible: true,
        meta: { role: 'confidence_band_lower' },
      })
      data.push({
        type: 'scatter',
        mode: 'lines',
        x: curve.time,
        y: curve.ciUpper,
        line: { color: applyAlpha(color, 0.15), width: 0, shape: 'hv' },
        fill: 'tonexty',
        fillcolor: applyAlpha(color, 0.15),
        hoverinfo: 'skip',
        showlegend: true,
        visible: true,
        name: `${curve.label} ${ciLabel}`,
        legendgroup: `${curve.label}-ci`,
        meta: { role: 'confidence_band_upper' },
      })
    }

    data.push({
      type: 'scatter',
      mode: 'lines',
      x: curve.time,
      y: curve.hazard,
      name: curve.label,
      line: { color, width: 2 },
      hovertemplate: 'Time: %{x:.3f}<br>Hazard: %{y:.3f}<extra></extra>',
    })

    totalPoints += curve.time.length
    curve.time.forEach((t) => {
      if (Number.isFinite(t) && t > maxTime) maxTime = t
    })
    curve.hazard.forEach((h) => {
      if (Number.isFinite(h)) maxHazard = Math.max(maxHazard, h)
    })
    if (Number.isFinite(curve.bandwidth ?? NaN)) {
      bandwidth = curve.bandwidth ?? bandwidth
    }
  })

  const incrementStats = computeHazardIncrementStats(raw)

  const stats: Record<string, number | string> = {
    n_curves: curves.length,
    n_points: incrementStats?.nPoints ?? totalPoints,
    max_time: incrementStats?.maxTime ?? maxTime,
    max_hazard: incrementStats?.maxHazard ?? (Number.isFinite(maxHazard) ? maxHazard : 0),
    bandwidth,
  }

  const layout = buildSurvivalLayout('Smoothed Hazard Rate', 'Hazard Rate')
  const meta = (layout.meta as Record<string, unknown> | undefined) ?? {}
  const nextLayout = hasCI
    ? {
        ...layout,
        meta: {
          ...meta,
          confidenceBandLabel: ciLabel,
          showConfidenceBand: true,
        },
      }
    : layout

  return {
    data,
    layout: nextLayout,
    config: createDefaultConfig(),
    stats,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }
}

export function buildCoxForestPlot(result: TestResult): PlotBuilderOutput | null {
  const raw = getResultData(result)
  const params = raw.parameter_estimates as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(params) || params.length === 0) return null

  const predictorCoeffs = params.filter((param) => {
    const name = String(param.parameter ?? param.term ?? '').toLowerCase()
    return name !== 'const' && name !== 'intercept' && name !== '(intercept)'
  })
  if (predictorCoeffs.length === 0) return null

  const coefficients = predictorCoeffs.map((param) => {
    const hazardRatio = derivePositiveHazardRatio(param)
    const ciLower = toNumber(param.hr_ci_lower_95)
    const ciUpper = toNumber(param.hr_ci_upper_95)
    const hasFinitePositiveCi = ciLower !== null && ciLower > 0 && ciUpper !== null && ciUpper > 0

    return {
      name: String(param.parameter ?? param.term ?? 'Unknown'),
      estimate: Math.max(MIN_POSITIVE_RATIO, hazardRatio ?? 1),
      stdError: hasFinitePositiveCi ? (toNumber(param.std_error) ?? 0) : 0,
      pValue: toNumber(param.p_value) ?? 1,
      confidenceInterval: hasFinitePositiveCi ? ([ciLower, ciUpper] as [number, number]) : undefined,
      rawHazardRatio: hazardRatio,
    }
  })

  const input: PlotBuilderInput = {
    source: 'test_result',
    columns: [],
    testResult: { ...result, coefficients },
    options: {
      title: 'Hazard Ratio Forest Plot',
      showLegend: false,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }

  const output = forestPlotBuilder(input)
  const axisFont = buildAxisFont()
  const hrValues = coefficients.map((c) => c.rawHazardRatio ?? c.estimate).filter((v) => Number.isFinite(v))
  const ciLowers = coefficients
    .map((c) => (Array.isArray(c.confidenceInterval) ? c.confidenceInterval[0] : null))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const ciUppers = coefficients
    .map((c) => (Array.isArray(c.confidenceInterval) ? c.confidenceInterval[1] : null))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const xLogRange = buildLogRatioRange(hrValues, ciLowers, ciUppers)

  return {
    ...output,
    stats: {
      ...output.stats,
      n_coeffs: coefficients.length,
      hr_min: hrValues.length ? Math.min(...hrValues) : 1,
      hr_max: hrValues.length ? Math.max(...hrValues) : 1,
      ci_min: ciLowers.length ? Math.min(...ciLowers) : 1,
      ci_max: ciUppers.length ? Math.max(...ciUppers) : 1,
      x_log_range_min: xLogRange[0],
      x_log_range_max: xLogRange[1],
    },
    layout: {
      ...output.layout,
      xaxis: {
        ...(output.layout.xaxis ?? {}),
        title: { text: 'Hazard Ratio (95% CI)', font: axisFont },
        type: 'log',
        range: xLogRange,
        autorange: false,
        tickformat: '.4~g',
        tickfont: axisFont,
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        ...(output.layout.yaxis ?? {}),
        tickfont: axisFont,
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      shapes: [
        {
          type: 'line',
          x0: 1,
          x1: 1,
          y0: 0,
          y1: 1,
          yref: 'y domain',
          line: { color: '#9ca3af', width: 1, dash: 'dash' },
        },
      ],
    },
  }
}
