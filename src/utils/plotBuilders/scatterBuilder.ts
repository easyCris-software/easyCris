/**
 * Scatter Plot Builder
 *
 * - Requires two numeric columns (X, Y)
 * - Optional categorical column for color grouping
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { calculateMeanSE, createBaseLayout, createDefaultConfig, getColor, calculateAxisRange } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

export const scatterBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { columns, options } = input

  const xColumn =
    columns.find((c) => c.role === 'x' || c.role === 'dose') ??
    columns.find((c) => c.inferredType === 'numeric')
  const yColumn =
    columns.find((c) => c.role === 'y' || c.role === 'response') ??
    columns.find((c) => c.inferredType === 'numeric' && c !== xColumn)

  if (!xColumn || !yColumn) {
    return createPlaceholderOutputFromInput('scatter', input, options.title)
  }

  const groupColumn =
    columns.find((c) => c.role === 'color' || c.role === 'group') ??
    columns.find((c) => c.inferredType === 'categorical')

  const maxLen = Math.min(
    xColumn.values.length,
    yColumn.values.length,
    groupColumn ? groupColumn.values.length : Number.POSITIVE_INFINITY
  )
  const x: number[] = []
  const y: number[] = []
  const groupedData = groupColumn
    ? new Map<string, { x: number[]; y: number[] }>()
    : null

  for (let i = 0; i < maxLen; i++) {
    const xv = xColumn.values[i]
    const yv = yColumn.values[i]
    if (typeof xv !== 'number' || !Number.isFinite(xv)) continue
    if (typeof yv !== 'number' || !Number.isFinite(yv)) continue
    x.push(xv)
    y.push(yv)
    if (groupedData) {
      const rawGroup = groupColumn?.values[i]
      const groupName = rawGroup === null || rawGroup === undefined
        ? 'Unknown'
        : String(rawGroup)
      if (!groupedData.has(groupName)) {
        groupedData.set(groupName, { x: [], y: [] })
      }
      groupedData.get(groupName)!.x.push(xv)
      groupedData.get(groupName)!.y.push(yv)
    }
  }

  const minLen = Math.min(x.length, y.length)
  if (minLen === 0) {
    return createPlaceholderOutputFromInput('scatter', input, options.title)
  }

  const xStats = calculateMeanSE(x)
  const yStats = calculateMeanSE(y)
  stats.x_mean = xStats.mean
  stats.x_std = xStats.std
  stats.y_mean = yStats.mean
  stats.y_std = yStats.std
  stats.n = minLen

  if (minLen > 1) {
    const xMean = xStats.mean
    const yMean = yStats.mean
    let sumXY = 0
    let sumX2 = 0
    let sumY2 = 0
    for (let i = 0; i < minLen; i++) {
      const xi = x[i] ?? 0
      const yi = y[i] ?? 0
      const dx = xi - xMean
      const dy = yi - yMean
      sumXY += dx * dy
      sumX2 += dx * dx
      sumY2 += dy * dy
    }
    const denom = Math.sqrt(sumX2 * sumY2)
    if (denom > 0) {
      const r = sumXY / denom
      stats.r = r
      stats.r_squared = r * r
      stats.correlation = r
    }
  }

  const data: PlotBuilderOutput['data'] = []

  if (groupedData) {
    let colorIdx = 0
    for (const [groupName, groupData] of groupedData) {
      data.push({
        type: 'scatter',
        mode: 'markers',
        x: groupData.x,
        y: groupData.y,
        name: groupName,
        marker: { color: getColor(colorIdx), size: 8 },
      })
      colorIdx += 1
    }
  } else {
    data.push({
      type: 'scatter',
      mode: 'markers',
      x,
      y,
      name: 'Data',
      marker: { color: getColor(0), size: 8 },
    })
  }

  // Calculate smart axis ranges with standard expansion and zero clamping
  const [xMin, xMax] = calculateAxisRange(x)
  const [yMin, yMax] = calculateAxisRange(y)

  return {
    data,
    layout: {
      ...createBaseLayout({
        title: options.title || 'Scatter Plot',
        showLegend: !!groupColumn,
      }),
      xaxis: {
        title: {
          text: xColumn.columnName,
          font: { weight: 700 },
        },
        range: [xMin, xMax],
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
        range: [yMin, yMax],
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

export default scatterBuilder
