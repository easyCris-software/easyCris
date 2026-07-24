/**
 * Group 5 descriptive/distribution plot generators.
 */

import type { Data } from 'plotly.js'
import type { PlotType } from '@/config/plotRegistry'
import type { TestResult } from '@/store/results-store'
import type { PlotBuilderInput, PlotBuilderOutput } from '@/utils/plotBuilders'
import { DEFAULT_COLORS, calculateMeanSE, calculateQuartiles, getPlotBuilder } from '@/utils/plotBuilders'
import { buildSingleColumnSeries, getResultData } from '@/services/plotResult/common/payload'
import { toNumber } from '@/services/plotResult/common/normalize'

type SingleColumnSeries = { yValues: number[]; yLabel: string }

type SingleColumnPlotOptions = {
  title: string
  showDensityCurve?: boolean
  showJitter?: boolean
  errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
  showMeanLine?: boolean
  pointJitterX?: number
  pointSize?: number
}

function buildSingleColumnPlot(
  result: TestResult,
  plotType: PlotType,
  options: SingleColumnPlotOptions
): PlotBuilderOutput | null {
  const series = buildSingleColumnSeries(result)
  if (!series) return null
  const numericValues = series.yValues.filter((value) => Number.isFinite(value))

  const valueRole = plotType === 'histogram' ? 'x' : 'y'
  const columns: PlotBuilderInput['columns'] = [
    {
      role: valueRole,
      columnId: 'value',
      columnName: series.yLabel,
      values: series.yValues,
      inferredType: 'numeric',
    },
  ]

  const builder = getPlotBuilder(plotType)
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: options.title,
      showLegend: false,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      showDensityCurve: options.showDensityCurve,
      showJitter: options.showJitter,
      errorBarType: options.errorBarType,
      showMeanLine: options.showMeanLine,
      pointJitterX: options.pointJitterX,
      pointSize: options.pointSize,
    },
  })
  if (plotType === 'box' || plotType === 'violin') {
    const { mean, std, n } = calculateMeanSE(numericValues)
    const quartiles = calculateQuartiles(numericValues)
    const isViolin = plotType === 'violin'
    return {
      ...output,
      stats: {
        ...output.stats,
        ...(typeof output.stats.n === 'number' ? {} : { n }),
        ...(typeof output.stats.value_mean === 'number' ? {} : { value_mean: mean }),
        ...(typeof output.stats.value_std === 'number' ? {} : { value_std: std }),
        group_count: typeof output.stats.group_count === 'number' ? output.stats.group_count : 1,
        ...(isViolin
          ? {
              median: quartiles.median,
              q1: quartiles.q1,
              q3: quartiles.q3,
              min: quartiles.min,
              max: quartiles.max,
            }
          : {}),
      },
    }
  }
  return output
}

function extractIndexArray(values: unknown): number[] {
  if (!Array.isArray(values)) return []
  return values
    .map((value) => toNumber(value))
    .filter((value): value is number => value !== null && Number.isFinite(value))
}

function collectOutlierIndices(result: TestResult, seriesLength: number): number[] {
  const raw = getResultData(result)
  const outliers = raw.outliers as Record<string, unknown> | undefined
  const indices = new Set<number>()

  const collectFrom = (value: unknown) => {
    extractIndexArray(value).forEach((idx) => {
      const zeroBased = Math.trunc(idx) - 1
      if (zeroBased >= 0 && zeroBased < seriesLength) {
        indices.add(zeroBased)
      }
    })
  }

  if (outliers && typeof outliers === 'object') {
    const iqr = outliers.iqr as Record<string, unknown> | undefined
    const zscore = outliers.zscore as Record<string, unknown> | undefined
    const modified = outliers.modified_zscore as Record<string, unknown> | undefined
    collectFrom(iqr?.indices)
    collectFrom(zscore?.indices)
    collectFrom(modified?.indices)
  }

  const grubbsIndex = toNumber(raw.grubbs_suspect_index)
  if (grubbsIndex !== null && Number.isFinite(grubbsIndex)) {
    const zeroBased = Math.trunc(grubbsIndex) - 1
    if (zeroBased >= 0 && zeroBased < seriesLength) {
      indices.add(zeroBased)
    }
  }

  return Array.from(indices).sort((a, b) => a - b)
}

function appendOutlierTrace(
  output: PlotBuilderOutput,
  trace: Data,
  outlierCount: number
): PlotBuilderOutput {
  const data = [...output.data, trace]
  const stats: Record<string, number | string> = {
    ...output.stats,
    outlier_count: outlierCount,
    n_traces: data.length,
  }

  return {
    ...output,
    data,
    stats,
  }
}

function ensureValueStats(
  output: PlotBuilderOutput,
  values: number[]
): PlotBuilderOutput {
  const stats: Record<string, number | string> = { ...output.stats }
  const { mean, std, n } = calculateMeanSE(values)

  if (typeof stats.value_mean !== 'number') {
    stats.value_mean = typeof stats.mean === 'number' ? stats.mean : mean
  }
  if (typeof stats.value_std !== 'number') {
    stats.value_std = typeof stats.std === 'number' ? stats.std : std
  }
  if (typeof stats.n !== 'number') {
    stats.n = n
  }

  return {
    ...output,
    stats,
  }
}

function applyOutlierOverlayToBox(
  output: PlotBuilderOutput,
  series: SingleColumnSeries,
  outlierValues: number[]
): PlotBuilderOutput {
  const baseTrace = output.data[0] as { name?: unknown; x?: unknown[] } | undefined
  const baseNameFromTrace =
    Array.isArray(baseTrace?.x) && baseTrace?.x.length > 0 ? String(baseTrace?.x[0]) : null
  const baseName =
    baseNameFromTrace ??
    (typeof baseTrace?.name === 'string' ? String(baseTrace?.name) : series.yLabel)
  const trace: Data = {
    type: 'scatter',
    mode: 'markers',
    x: outlierValues.map(() => baseName),
    y: outlierValues,
    name: 'Outliers',
    marker: {
      color: '#ef4444',
      size: 8,
      symbol: 'circle-open',
      line: { color: '#b91c1c', width: 1 },
    },
    showlegend: false,
    hovertemplate: 'Outlier: %{y:.3f}<extra></extra>',
  }

  return appendOutlierTrace(output, trace, outlierValues.length)
}

function applyOutlierOverlayToColumnScatter(
  output: PlotBuilderOutput,
  outlierIndices: number[],
  allValues: number[]
): PlotBuilderOutput {
  // Get the base scatter trace
  const baseTrace = output.data[0] as {
    x?: number[]
    y?: number[]
    marker?: { color?: string; size?: number; opacity?: number }
  } | undefined

  if (!baseTrace || !Array.isArray(baseTrace.x) || !Array.isArray(baseTrace.y)) {
    return output
  }

  // Separate normal and outlier points based on their y-values matching outlier values
  const normalX: number[] = []
  const normalY: number[] = []
  const outlierX: number[] = []
  const outlierY: number[] = []

  // Map outlier values for comparison
  const outlierValues = new Set(outlierIndices.map((idx) => allValues[idx]))

  for (let i = 0; i < baseTrace.y.length; i++) {
    const x = baseTrace.x[i]
    const y = baseTrace.y[i]
    if (x === undefined || y === undefined) continue

    if (outlierValues.has(y)) {
      outlierX.push(x)
      outlierY.push(y)
      outlierValues.delete(y) // Remove to handle duplicates correctly
    } else {
      normalX.push(x)
      normalY.push(y)
    }
  }

  // Modify the base trace to only show normal points
  const normalTrace: Data = {
    ...baseTrace,
    x: normalX,
    y: normalY,
    name: 'Normal',
    marker: {
      color: '#3b82f6', // Blue
      size: baseTrace.marker?.size ?? 8,
      opacity: 0.7,
    },
    showlegend: true,
    hovertemplate: 'Value: %{y:.3f}<extra></extra>',
  }

  // Create outlier trace with filled red circles at their actual positions
  const outlierTrace: Data = {
    type: 'scatter',
    mode: 'markers',
    x: outlierX,
    y: outlierY,
    name: 'Outlier',
    marker: {
      color: '#ef4444', // Red filled
      size: (baseTrace.marker?.size ?? 8) + 2,
    },
    showlegend: true,
    hovertemplate: 'Outlier: %{y:.3f}<extra></extra>',
  }

  // Add mean line (like R)
  const mean = allValues.reduce((a, b) => a + b, 0) / allValues.length
  const meanLineTrace: Data = {
    type: 'scatter',
    mode: 'lines',
    x: [-0.5, 0.5],
    y: [mean, mean],
    name: 'Mean',
    line: {
      color: '#16a34a', // Green
      width: 2,
      dash: 'dash',
    },
    showlegend: false,
    hovertemplate: `Mean: ${mean.toFixed(3)}<extra></extra>`,
  }

  // Replace data with new traces
  const data = [normalTrace, outlierTrace, meanLineTrace]
  const stats: Record<string, number | string> = {
    ...output.stats,
    outlier_count: outlierY.length,
    n_traces: data.length,
  }

  return {
    ...output,
    data,
    layout: {
      ...output.layout,
      showlegend: true,
      legend: {
        x: 1,
        y: 1,
        xanchor: 'right' as const,
        yanchor: 'top' as const,
      },
    },
    stats,
  }
}

export function buildNormalityQQPlot(result: TestResult): PlotBuilderOutput | null {
  return buildSingleColumnPlot(result, 'qq', {
    title: 'Q-Q Plot',
  })
}

export function buildNormalityHistogramPlot(result: TestResult): PlotBuilderOutput | null {
  return buildSingleColumnPlot(result, 'histogram', {
    title: 'Histogram (Density)',
    showDensityCurve: true,
  })
}

export function buildDescriptiveHistogramPlot(result: TestResult): PlotBuilderOutput | null {
  return buildSingleColumnPlot(result, 'histogram', {
    title: 'Histogram (Density)',
    showDensityCurve: true,
  })
}

export function buildDescriptiveBoxPlot(result: TestResult): PlotBuilderOutput | null {
  return buildSingleColumnPlot(result, 'box', {
    title: 'Box Plot',
  })
}

export function buildDescriptiveViolinPlot(result: TestResult): PlotBuilderOutput | null {
  return buildSingleColumnPlot(result, 'violin', {
    title: 'Violin Plot',
  })
}

export function buildOutlierBoxPlot(result: TestResult): PlotBuilderOutput | null {
  const series = buildSingleColumnSeries(result)
  if (!series) return null

  const baseOutput = buildSingleColumnPlot(result, 'box', {
    title: 'Box Plot (Outliers)',
  })
  if (!baseOutput) return null

  const outlierIndices = collectOutlierIndices(result, series.yValues.length)
  if (outlierIndices.length === 0) {
    return {
      ...baseOutput,
      stats: {
        ...baseOutput.stats,
        outlier_count: 0,
      },
    }
  }

  const outlierValues = outlierIndices
    .map((idx) => series.yValues[idx])
    .filter((value): value is number => Number.isFinite(value))

  if (outlierValues.length === 0) {
    return {
      ...baseOutput,
      stats: {
        ...baseOutput.stats,
        outlier_count: 0,
      },
    }
  }

  return applyOutlierOverlayToBox(baseOutput, series, outlierValues)
}

export function buildOutlierScatterPlot(result: TestResult): PlotBuilderOutput | null {
  const series = buildSingleColumnSeries(result)
  if (!series) return null

  const baseOutput = buildSingleColumnPlot(result, 'column_scatter', {
    title: 'Outlier Scatter',
    errorBarType: 'none',
    showMeanLine: false,
    pointJitterX: 0.15,
    pointSize: 6,
  })
  if (!baseOutput) return null
  const withValueStats = ensureValueStats(baseOutput, series.yValues)

  const outlierIndices = collectOutlierIndices(result, series.yValues.length)
  if (outlierIndices.length === 0) {
    return {
      ...withValueStats,
      stats: {
        ...withValueStats.stats,
        outlier_count: 0,
      },
    }
  }

  // Pass outlier indices and all values to properly separate normal/outlier points
  return applyOutlierOverlayToColumnScatter(withValueStats, outlierIndices, series.yValues)
}
