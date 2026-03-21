/**
 * Matrix Heatmap Helper
 *
 * Shared helper for building matrix heatmap plots (synergy, correlation, etc.)
 * with diverging color scales and optional symmetric bounds.
 */

import type { Data, Layout } from 'plotly.js'
import { createBaseLayout } from './common'

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface MatrixHeatmapOptions {
  /** 2D matrix of values (z-axis) */
  matrix: number[][]

  /** X-axis labels/values */
  xLabels: (string | number)[]

  /** Y-axis labels/values */
  yLabels: (string | number)[]

  /** Plot title */
  title: string

  /** X-axis title */
  xAxisTitle: string

  /** Y-axis title */
  yAxisTitle: string

  /** Colorbar title */
  colorbarTitle: string

  /** Use symmetric color scale around zero (default: true) */
  symmetricScale?: boolean

  /** Custom color scale (default: blue-white-red diverging) */
  colorscale?: Array<[number, string]>

  /** Show cell text values (default: true) */
  showText?: boolean

  /** Text decimal places (default: 2) */
  textDecimals?: number

  /** Use log scale for X-axis (default: false) */
  xLogScale?: boolean

  /** Use log scale for Y-axis (default: false) */
  yLogScale?: boolean

  /** Custom tick values for X-axis (for log scale) */
  xTickVals?: number[]

  /** Custom tick text for X-axis (for log scale) */
  xTickText?: string[]

  /** Custom tick values for Y-axis (for log scale) */
  yTickVals?: number[]

  /** Custom tick text for Y-axis (for log scale) */
  yTickText?: string[]

  /** Custom hover template */
  hovertemplate?: string

  /** Additional customdata for hover (2D array matching matrix shape) */
  customdata?: unknown[][]
}

export interface MatrixHeatmapOutput {
  data: Data[]
  layout: Partial<Layout>
  stats: Record<string, number>
}

// =============================================================================
// MAIN HELPER FUNCTION
// =============================================================================

/**
 * Build a matrix heatmap plot with diverging color scale
 */
export function buildMatrixHeatmap(options: MatrixHeatmapOptions): MatrixHeatmapOutput {
  const {
    matrix,
    xLabels,
    yLabels,
    title,
    xAxisTitle,
    yAxisTitle,
    colorbarTitle,
    symmetricScale = true,
    colorscale = [
      [0, 'rgb(0,0,255)'],        // Blue = negative
      [0.5, 'rgb(255,255,255)'],  // White = neutral
      [1, 'rgb(255,0,0)'],        // Red = positive
    ],
    showText = true,
    textDecimals = 2,
    xLogScale = false,
    yLogScale = false,
    xTickVals,
    xTickText,
    yTickVals,
    yTickText,
    hovertemplate,
    customdata,
  } = options

  const stats: Record<string, number> = {}

  const toNumeric = (value: unknown): number => {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value)
      return Number.isFinite(parsed) ? parsed : NaN
    }
    return NaN
  }

  const normalizedMatrix = matrix.map((row) => row.map((value) => toNumeric(value)))

  const isNumericLabel = (value: string | number): boolean => {
    if (typeof value === 'number') return Number.isFinite(value)
    const trimmed = value.trim()
    if (trimmed === '') return false
    const parsed = Number.parseFloat(trimmed)
    return Number.isFinite(parsed) && String(parsed) === String(Number(trimmed))
  }

  const xIsNumeric = xLabels.every((label) => isNumericLabel(label))
  const yIsNumeric = yLabels.every((label) => isNumericLabel(label))

  // Calculate matrix statistics
  const flatValues = normalizedMatrix.flat().filter((value) => Number.isFinite(value))
  const minValue = flatValues.length > 0 ? Math.min(...flatValues) : 0
  const maxValue = flatValues.length > 0 ? Math.max(...flatValues) : 0
  const meanValue = flatValues.length > 0
    ? flatValues.reduce((sum, val) => sum + val, 0) / flatValues.length
    : 0

  // Store stats for E2E validation
  stats.heatmap_min = minValue
  stats.heatmap_max = maxValue
  stats.heatmap_mean = meanValue
  stats.heatmap_n_rows = normalizedMatrix.length
  stats.heatmap_n_cols = normalizedMatrix[0]?.length ?? 0
  stats.heatmap_total_points = stats.heatmap_n_rows * stats.heatmap_n_cols

  // Calculate symmetric bounds if requested
  let zmin: number
  let zmax: number
  let zmid: number

  if (symmetricScale) {
    const maxAbs = Math.max(Math.abs(minValue), Math.abs(maxValue), 1e-6)
    zmin = -maxAbs
    zmax = maxAbs
    zmid = 0
    stats.heatmap_zmin = zmin
    stats.heatmap_zmax = zmax
  } else {
    zmin = minValue
    zmax = maxValue
    zmid = (minValue + maxValue) / 2
    stats.heatmap_zmin = zmin
    stats.heatmap_zmax = zmax
  }

  // Format cell text values
  const textValues = showText
    ? normalizedMatrix.map((row) =>
        row.map((val) => (Number.isFinite(val) ? val.toFixed(textDecimals) : '')),
      )
    : undefined

  // Default hover template if not provided
  const defaultHoverTemplate =
    `${xAxisTitle}: %{x}<br>${yAxisTitle}: %{y}<br>Value: %{z:.${textDecimals}f}<extra></extra>`

  // Create heatmap plot data
  const colorbarX = 1.02
  const colorbarLen = 0.88
  const colorbarPad = 6
  const colorbarTitleX = 1.04

  const data: Data[] = [
    {
      type: 'heatmap',
      z: normalizedMatrix,
      x: xLabels,
      y: yLabels,
      colorscale,
      zmin,
      zmax,
      zmid,
      colorbar: {
        title: { text: '' },
        tickformat: `.${textDecimals}f`,
        x: colorbarX,
        xanchor: 'left',
        xpad: colorbarPad,
        len: colorbarLen,
      },
      text: textValues,
      texttemplate: showText ? '%{text}' : undefined,
      textfont: showText
        ? {
            size: 10,
            color: '#000000',
          }
        : undefined,
      customdata,
      hovertemplate: hovertemplate ?? defaultHoverTemplate,
    },
  ]

  // Axis font matching dose-response and synergy plots
  const axisFont = {
    family: 'Inter, sans-serif',
    size: 12,
    color: '#111827',
    weight: 700,
  }

  // Create base layout
  const baseLayout = createBaseLayout({ title, showLegend: false })
  const existingAnnotations =
    (baseLayout as { annotations?: Layout['annotations'] }).annotations ?? []

  // Add colorbar title as annotation
  const colorbarTitleAnnotation: Layout['annotations'] = [
    {
      xref: 'paper',
      yref: 'paper',
      x: colorbarTitleX,
      y: 1.0,
      xanchor: 'left',
      yanchor: 'bottom',
      text: colorbarTitle,
      showarrow: false,
      font: axisFont,
    },
  ]

  // Build layout with axes
  const layout: Partial<Layout> = {
    ...baseLayout,
    meta: {
      ...(baseLayout.meta ?? {}),
      plotType: 'matrix_heatmap',
    },
    annotations: [...existingAnnotations, ...colorbarTitleAnnotation],
    xaxis: {
      title: {
        text: xAxisTitle,
        font: axisFont,
        standoff: 15,
      },
      type: xIsNumeric ? (xLogScale ? 'log' : 'linear') : 'category',
      exponentformat: 'none',
      tickmode: xTickVals && xTickText ? 'array' : 'auto',
      tickvals: xTickVals,
      ticktext: xTickText,
      automargin: true,
      showgrid: true,
      showline: true,
      linecolor: '#111827',
      linewidth: 4,
      tickwidth: 4,
      ticklen: 6,
      tickfont: axisFont,
      ticklabelshift: 1,
      zeroline: false,
    },
    yaxis: {
      title: {
        text: yAxisTitle,
        font: axisFont,
      },
      type: yIsNumeric ? (yLogScale ? 'log' : 'linear') : 'category',
      exponentformat: 'none',
      tickmode: yTickVals && yTickText ? 'array' : 'auto',
      tickvals: yTickVals,
      ticktext: yTickText,
      automargin: true,
      showgrid: true,
      showline: true,
      linecolor: '#111827',
      linewidth: 4,
      tickwidth: 4,
      ticklen: 6,
      tickfont: axisFont,
      ticklabelshift: 1,
      zeroline: false,
    },
    margin: {
      ...(baseLayout.margin ?? {}),
      r: 240,
    },
  }

  return {
    data,
    layout,
    stats,
  }
}
