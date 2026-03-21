/**
 * Histogram Builder
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Used by: One-Sample T-Test (49 metrics). Validated against validation baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { calculateMeanSE, calculateQuartiles, createBaseLayout, createDefaultConfig, getColor } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

/**
 * Calculate bandwidth using R's bw.nrd0() rule
 * h = 0.9 * min(sd, IQR/1.34) * n^(-1/5)
 * This matches R's density() default bandwidth
 */
function calculateSilvermanBandwidth(values: number[]): number {
  const n = values.length
  if (n === 0) return 1.0

  // Calculate standard deviation
  const mean = values.reduce((sum, v) => sum + v, 0) / n
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n
  const std = Math.sqrt(variance)

  // Calculate IQR
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = sorted[Math.floor(n * 0.25)] ?? 0
  const q3 = sorted[Math.floor(n * 0.75)] ?? 0
  const iqr = q3 - q1

  // R's bw.nrd0: 0.9 * min(sd, IQR/1.34) * n^(-1/5)
  const bandwidth = 0.9 * Math.min(std, iqr / 1.34) * Math.pow(n, -0.2)
  return bandwidth > 0 ? bandwidth : 1.0
}

/**
 * Compute Gaussian KDE density at point x
 * density = sum(exp(-0.5 * ((x - xi)/h)^2)) / (n * h * sqrt(2π))
 */
function computeKDE(x: number, values: number[], bandwidth: number): number {
  const n = values.length
  const normFactor = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI))

  let sum = 0
  for (let i = 0; i < n; i++) {
    const val = values[i]
    if (typeof val !== 'number') continue
    const z = (x - val) / bandwidth
    sum += Math.exp(-0.5 * z * z)
  }

  return normFactor * sum
}

export const histogramBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { columns, options } = input

  const numericColumn =
    columns.find((c) => c.role === 'x') ??
    columns.find((c) => c.inferredType === 'numeric')

  if (!numericColumn) {
    return createPlaceholderOutputFromInput('histogram', input, options.title)
  }

  const values = numericColumn.values.filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v)
  )

  if (values.length === 0) {
    return createPlaceholderOutputFromInput('histogram', input, options.title)
  }
  const { mean, std, n } = calculateMeanSE(values)
  const quartiles = calculateQuartiles(values)
  const requestedBins = options.histogramBins
  const binCount = Math.max(
    1,
    Number.isFinite(requestedBins as number) ? Math.floor(requestedBins as number) : 30
  )

  // Standard histogram binning algorithm with boundary adjustment
  // Uses: width = range / (bins - 1) with boundary adjustment
  const dataRange = quartiles.max - quartiles.min
  let binWidth: number
  let boundary: number

  if (dataRange === 0) {
    // Zero range case - use fixed width
    binWidth = 0.1
    boundary = quartiles.min
  } else if (binCount === 1) {
    // Single bin case
    binWidth = dataRange
    boundary = quartiles.min
  } else {
    // Normal case: width = range / (bins - 1)
    binWidth = dataRange / (binCount - 1)
    boundary = quartiles.min - binWidth / 2

    // Alignment check: if x_range aligns with boundary, use bins instead of bins-1
    // Check: x_range[i] % width == boundary % width
    const minMod = quartiles.min % binWidth
    const maxMod = quartiles.max % binWidth
    const boundaryMod = boundary % binWidth

    if (Math.abs(minMod - boundaryMod) < 1e-10 || Math.abs(maxMod - boundaryMod) < 1e-10) {
      binWidth = dataRange / binCount
    }
  }

  // Calculate origin (left edge of leftmost bin)
  const shift = Math.floor((quartiles.min - boundary) / binWidth)
  const origin = boundary + shift * binWidth

  // Calculate max_x with small correction factor (prevents extra bin due to floating point)
  const maxX = quartiles.max + (1 - 1e-8) * binWidth

  // Bin start/end for Plotly
  const binStart = origin
  const binEnd = maxX

  const bargap = Math.min(0.05, 0.5 / binCount)
  const xLabel =
    numericColumn.columnName
      ? `${numericColumn.columnName.charAt(0).toUpperCase()}${numericColumn.columnName.slice(1)}`
      : numericColumn.columnName

  stats.mean = mean
  stats.std = std
  stats.median = quartiles.median
  stats.min = quartiles.min
  stats.max = quartiles.max
  stats.n = n
  stats.value_mean = mean
  stats.value_std = std
  stats.value_min = quartiles.min
  stats.value_max = quartiles.max
  stats.n_points = n
  stats.bin_count = binCount
  stats.n_bins = binCount
  stats.hist_bin_width = binWidth

  // Calculate max histogram bar height (needed for y-axis range when KDE is on)
  // When normalized to probability density: bar height = count / (n * binWidth)
  const binEdges: number[] = []
  for (let i = 0; i <= binCount; i++) {
    binEdges.push(binStart + i * binWidth)
  }

  const binCounts = new Array(binCount).fill(0)
  for (const value of values) {
    for (let i = 0; i < binCount; i++) {
      // Include right edge for last bin (prevents dropping max value)
      const rightEdgeInclusive = i === binCount - 1
      const inBin = rightEdgeInclusive
        ? value >= binEdges[i]! && value <= binEdges[i + 1]!
        : value >= binEdges[i]! && value < binEdges[i + 1]!

      if (inBin) {
        binCounts[i]++
        break
      }
    }
  }

  const maxCount = Math.max(...binCounts, 1)
  const maxBarHeight = maxCount / (n * binWidth)

  // Density curve toggle (default ON)
  const showDensityCurve = options.showDensityCurve ?? true
  const data: PlotBuilderOutput['data'] = []
  const renderDensityCurve = showDensityCurve && values.length > 1 && dataRange > 0

  // Add histogram trace (normalized to probability density when curve is shown)
  data.push({
    type: 'histogram',
    x: values,
    name: numericColumn.columnName,
    nbinsx: binCount,
    autobinx: false,
    xbins: {
      start: binStart,
      end: binEnd,
      size: binWidth,
    },
    marker: { color: getColor(0) },
    opacity: 0.75,
    histnorm: renderDensityCurve ? 'probability density' : undefined,
  })

  // Add KDE density curve if enabled
  if (renderDensityCurve) {
    const bandwidthRaw = calculateSilvermanBandwidth(values)
    const fallbackBandwidth = Math.max(1e-6, dataRange * 0.05)
    const bandwidth =
      Number.isFinite(bandwidthRaw) && bandwidthRaw > 0 ? bandwidthRaw : fallbackBandwidth
    // R's density() extends by ±3 bandwidths (not fixed % of range)
    const pad = bandwidth * 3
    const xMin = quartiles.min - pad
    const xMax = quartiles.max + pad

    // Use 512 points for smoother density curve
    const nPoints = 512
    const xDensity: number[] = []
    const yDensity: number[] = []

    for (let i = 0; i < nPoints; i++) {
      const t = nPoints > 1 ? i / (nPoints - 1) : 0
      const x = xMin + t * (xMax - xMin)
      const density = computeKDE(x, values, bandwidth)
      xDensity.push(x)
      yDensity.push(density)
    }

    // Calculate density stats
    const maxDensity = Math.max(...yDensity)
    const meanDensity = yDensity.reduce((sum, d) => sum + d, 0) / yDensity.length

    // Add density curve as scatter trace
    data.push({
      type: 'scatter',
      mode: 'lines',
      x: xDensity,
      y: yDensity,
      name: 'Density',
      line: {
        color: '#000000',
        width: 2.5,
      },
      hovertemplate: 'x: %{x:.3f}<br>Density: %{y:.4f}<extra></extra>',
    })

    // Add KDE stats for E2E validation
    stats.kde_bandwidth = bandwidth
    stats.kde_points = nPoints
    stats.kde_max_density = maxDensity
    stats.kde_mean_density = meanDensity
    stats.n_traces = 2 // histogram + density curve
  } else {
    stats.n_traces = 1 // histogram only
  }

  // Calculate y-axis range (anchor bars at zero when KDE is on)
  let yMax: number | undefined
  if (renderDensityCurve) {
    const maxKDEHeight = stats.kde_max_density ?? 0
    yMax = Math.max(maxBarHeight, maxKDEHeight) * 1.1 // 10% padding
  }

  const yAxisLabel = renderDensityCurve ? 'Density' : 'Frequency'

  return {
    data,
    layout: {
      ...createBaseLayout({ title: options.title || 'Histogram', showLegend: renderDensityCurve }),
      xaxis: {
        title: {
          text: xLabel,
          font: { weight: 700 },
        },
        linewidth: 4,
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        title: {
          text: yAxisLabel,
          font: { weight: 700 },
        },
        autorange: renderDensityCurve ? false : true,
        range: renderDensityCurve && yMax !== undefined ? [0, yMax] : undefined,
        linewidth: 4,
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      bargap,
    },
    config: createDefaultConfig(),
    stats,
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  }
}

export default histogramBuilder
