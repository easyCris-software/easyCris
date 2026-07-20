/**
 * Column Scatter Builder
 *
 * Displays individual data points in vertical column(s) with:
 * - Scatter points with optional horizontal jitter
 * - Horizontal mean line
 * - Error bars (SE, SD, or CI)
 * - Optional reference line (e.g., hypothetical mean for one-sample t-test)
 *
 * Use cases:
 * - One-sample t-test visualization
 * - Paired test differences
 * - Descriptive statistics
 * - Single-group or multi-group comparisons
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Used by: One-Sample T-Test (49 metrics). Validated against validation baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import {
  calculateMeanSE,
  calculate95CI,
  calculateErrorBar,
  calculateQuartiles,
  createBaseLayout,
  createDefaultConfig,
  getColor,
  DEFAULT_COLORS,
} from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

function sanitizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export const columnScatterBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number | string> = {}
  const { columns, options } = input

  // Extract options with defaults
  const showMeanLine = options.showMeanLine ?? true
  const errorBarType = options.errorBarType ?? 'se'
  const pointJitterX = options.pointJitterX ?? 0.05
  const pointSize = options.pointSize ?? 8
  stats.error_bar_type = errorBarType

  // Find numeric column (y-axis values)
  const yColumn =
    columns.find((c) => c.role === 'y' || c.role === 'response') ??
    columns.find((c) => c.inferredType === 'numeric')

  if (!yColumn) {
    return createPlaceholderOutputFromInput('column_scatter', input, options.title)
  }

  // Find optional grouping column
  const groupColumn =
    columns.find((c) => c.role === 'group' || c.role === 'x') ??
    columns.find((c) => c.inferredType === 'categorical')

  const data: PlotBuilderOutput['data'] = []
  const palette = options.colorPalette ?? DEFAULT_COLORS

  // Group data if grouping column exists
  const grouped: Map<string, number[]> = new Map()
  const len = Math.min(
    yColumn.values.length,
    groupColumn ? groupColumn.values.length : Number.POSITIVE_INFINITY
  )

  for (let i = 0; i < len; i++) {
    const value = yColumn.values[i]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue

    const groupName = groupColumn
      ? String(groupColumn.values[i])
      : 'Sample'
    if (!grouped.has(groupName)) {
      grouped.set(groupName, [])
    }
    grouped.get(groupName)!.push(value)
  }

  if (grouped.size === 0) {
    return createPlaceholderOutputFromInput('column_scatter', input, options.title)
  }

  // Collect all y values for range calculation
  const allYValues: number[] = []
  for (const values of grouped.values()) {
    allYValues.push(...values)
  }

  // Build traces for each group
  let groupIdx = 0
  const groupNames: string[] = []
  let totalPoints = 0

  for (const [groupName, values] of grouped) {
    groupNames.push(groupName)
    const { mean, std, se, n } = calculateMeanSE(values)
    const ci = calculate95CI(values)
    const error = calculateErrorBar(values, errorBarType)
    const quartiles = calculateQuartiles(values)

    totalPoints += n

    // Store group stats
    const key = sanitizeKey(groupName)
    stats[`${key}_mean`] = mean
    stats[`${key}_std`] = std
    stats[`${key}_se`] = se
    stats[`${key}_ci_lower`] = ci.lower
    stats[`${key}_ci_upper`] = ci.upper
    stats[`${key}_n`] = n
    stats[`${key}_median`] = quartiles.median
    stats[`${key}_q1`] = quartiles.q1
    stats[`${key}_q3`] = quartiles.q3
    stats[`${key}_iqr`] = quartiles.iqr
    stats[`${key}_min`] = quartiles.min
    stats[`${key}_max`] = quartiles.max

    const color = getColor(groupIdx, palette)
    const xPosition = groupIdx

    // Add scatter points with jitter
    const xScatter: number[] = []
    const yScatter: number[] = []
    for (let i = 0; i < values.length; i++) {
      // Small random jitter on x-axis for visibility
      const jitter = (Math.random() - 0.5) * pointJitterX * 2
      const value = values[i]
      if (value === undefined) continue
      xScatter.push(xPosition + jitter)
      yScatter.push(value)
    }

    data.push({
      type: 'scatter',
      mode: 'markers',
      x: xScatter,
      y: yScatter,
      name: groupName,
      marker: {
        color,
        size: pointSize,
        opacity: 0.6,
      },
      showlegend: grouped.size > 1,
      hovertemplate: `${groupName}<br>Value: %{y:.3f}<extra></extra>`,
    })

    // Add mean line (horizontal line at mean)
    if (showMeanLine) {
      data.push({
        type: 'scatter',
        mode: 'lines',
        x: [xPosition - 0.15, xPosition + 0.15],
        y: [mean, mean],
        name: `Mean (${groupName})`,
        line: {
          color,
          width: 3,
          dash: 'solid',
        },
        showlegend: false,
        hovertemplate: `Mean: %{y:.3f}<extra></extra>`,
      })
    }

    // Add error bars (vertical lines from mean)
    if (errorBarType !== 'none' && error > 0) {
      const errorLower = mean - error
      const errorUpper = mean + error

      // Error bar cap lines (horizontal)
      data.push({
        type: 'scatter',
        mode: 'lines',
        x: [xPosition - 0.05, xPosition + 0.05, null, xPosition, xPosition, null, xPosition - 0.05, xPosition + 0.05],
        y: [errorLower, errorLower, null, errorLower, errorUpper, null, errorUpper, errorUpper],
        name: `Error (${groupName})`,
        line: {
          color: '#333',
          width: 1.5,
        },
        showlegend: false,
        hoverinfo: 'skip',
      })

      stats[`${key}_error`] = error
    }

    groupIdx++
  }

  // Calculate y-axis range including error bars
  const yMin = Math.min(...allYValues)
  const yMax = Math.max(...allYValues)
  const yRange = yMax - yMin
  const yPad = yRange > 0 ? yRange * 0.1 : 1
  const yAxisMin = yMin - yPad
  const yAxisMax = yMax + yPad

  // Store overall stats for E2E validation
  stats.n_traces = grouped.size
  stats.total_points = totalPoints
  stats.group_count = grouped.size

  // For single-group, add validation baseline aliases and quartile stats
  if (grouped.size === 1) {
    const singleKey = sanitizeKey(groupNames[0] ?? 'sample')
    const meanValue = stats[`${singleKey}_mean`]
    const stdValue = stats[`${singleKey}_std`]
    const seValue = stats[`${singleKey}_se`]
    const ciLower = stats[`${singleKey}_ci_lower`]
    const ciUpper = stats[`${singleKey}_ci_upper`]
    const nValue = stats[`${singleKey}_n`]
    const medianValue = stats[`${singleKey}_median`]
    const q1Value = stats[`${singleKey}_q1`]
    const q3Value = stats[`${singleKey}_q3`]
    const iqrValue = stats[`${singleKey}_iqr`]
    const minValue = stats[`${singleKey}_min`]
    const maxValue = stats[`${singleKey}_max`]

    if (typeof meanValue === 'number') {
      stats.mean = meanValue
      stats.sample_mean = meanValue // validation baseline alias
    }
    if (typeof stdValue === 'number') {
      stats.std = stdValue
      stats.sample_std = stdValue // validation baseline alias
    }
    if (typeof seValue === 'number') {
      stats.se = seValue
      stats.sample_se = seValue // validation baseline alias
    }
    if (typeof ciLower === 'number') stats.ci_lower = ciLower
    if (typeof ciUpper === 'number') stats.ci_upper = ciUpper
    if (typeof nValue === 'number') stats.n = nValue
    if (typeof medianValue === 'number') stats.median = medianValue
    if (typeof q1Value === 'number') stats.q1 = q1Value
    if (typeof q3Value === 'number') stats.q3 = q3Value
    if (typeof iqrValue === 'number') stats.iqr = iqrValue
    if (typeof minValue === 'number') stats.min = minValue
    if (typeof maxValue === 'number') stats.max = maxValue
  }

  return {
    data,
    layout: {
      ...createBaseLayout({
        title: options.title || 'Column Scatter',
        showLegend: grouped.size > 1,
      }),
      meta: {
        errorBarType,
        showMeanLine,
        pointJitterX,
        pointSize,
      },
      xaxis: {
        title: {
          // Single group: blank (user can edit); multi-group: use grouping column name
          text: grouped.size === 1 ? '' : groupColumn?.columnName ?? yColumn.columnName,
          font: { weight: 700 },
        },
        tickmode: 'array',
        tickvals: Array.from({ length: grouped.size }, (_, i) => i),
        ticktext: groupNames,
        range: [-0.5, grouped.size - 0.5],
        linewidth: 4,
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
    yaxis: {
      title: {
        text: yColumn.columnName,
        font: { weight: 700 },
        },
        range: [yAxisMin, yAxisMax],
        linewidth: 4,
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
    },
    config: createDefaultConfig(),
    stats,
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  }
}

export default columnScatterBuilder
