/**
 * Line Plot Builder
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { calculateMeanSE, calculateErrorBar, createBaseLayout, createDefaultConfig, getColor, calculateAxisRange } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

export const linePlotBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number | string> = {}
  const { columns, options } = input
  const errorBarType = options.errorBarType ?? 'se'  // Default to SE
  stats.error_bar_type = errorBarType

  const xColumn = columns.find((c) => c.role === 'x') ?? columns.find((c) => c.inferredType === 'numeric')
  const yColumn = columns.find((c) => c.role === 'y') ?? columns.find((c) => c.inferredType === 'numeric' && c !== xColumn)
  const groupColumn =
    columns.find((c) => c.role === 'group' || c.role === 'color') ??
    columns.find((c) => c.inferredType === 'categorical')

  if (!xColumn || !yColumn) {
    return createPlaceholderOutputFromInput('line', input, options.title)
  }

  const xValues = xColumn.values
  const yValues = yColumn.values
  const groupValues = groupColumn ? groupColumn.values : []
  const len = Math.min(
    xValues.length,
    yValues.length,
    groupColumn ? groupValues.length : Infinity
  )

  // Collect valid numeric points for stats computation
  const validX: number[] = []
  const validY: number[] = []
  for (let i = 0; i < len; i++) {
    const xi = xValues[i]
    const yi = yValues[i]
    if (typeof xi === 'number' && Number.isFinite(xi) && typeof yi === 'number' && Number.isFinite(yi)) {
      validX.push(xi)
      validY.push(yi)
    }
  }

  if (groupColumn) {
    const groups = new Map<string, { order: number[]; buckets: Map<number, number[]> }>()
    for (let i = 0; i < len; i++) {
      const g = String(groupValues[i] ?? 'Unknown')
      const x = xValues[i]
      const y = yValues[i]
      if (typeof x !== 'number' || !Number.isFinite(x)) continue
      if (typeof y !== 'number' || !Number.isFinite(y)) continue
      let groupEntry = groups.get(g)
      if (!groupEntry) {
        groupEntry = { order: [], buckets: new Map() }
        groups.set(g, groupEntry)
      }
      if (!groupEntry.buckets.has(x)) {
        groupEntry.buckets.set(x, [])
        groupEntry.order.push(x)
      }
      groupEntry.buckets.get(x)!.push(y)
    }

    // Compute stats for grouped line plot (overall stats across all groups)
    if (validX.length > 0) {
      const xStats = calculateMeanSE(validX)
      const yStats = calculateMeanSE(validY)
      stats.n = validX.length
      stats.x_mean = xStats.mean
      stats.x_std = xStats.std
      stats.y_mean = yStats.mean
      stats.y_std = yStats.std
      stats.group_count = groups.size

      // Compute correlation if multiple points
      if (validX.length > 1) {
        const xMean = xStats.mean
        const yMean = yStats.mean
        let sumXY = 0
        let sumX2 = 0
        let sumY2 = 0
        for (let i = 0; i < validX.length; i++) {
          const xi = validX[i]
          const yi = validY[i]
          if (xi === undefined || yi === undefined) continue
          const dx = xi - xMean
          const dy = yi - yMean
          sumXY += dx * dy
          sumX2 += dx * dx
          sumY2 += dy * dy
        }
        const correlation = sumXY / Math.sqrt(sumX2 * sumY2)
        if (Number.isFinite(correlation)) {
          stats.correlation = correlation
        }
      }
    }

    const data: PlotBuilderOutput['data'] = []
    const allX: number[] = []
    const allYRange: number[] = []
    let colorIdx = 0
    for (const [group, series] of groups) {
      if (series.order.length === 0) continue
      const x: number[] = []
      const y: number[] = []
      const errors: number[] = []
      for (const xVal of series.order) {
        const values = series.buckets.get(xVal) ?? []
        const { mean } = calculateMeanSE(values)
        const error = calculateErrorBar(values, errorBarType)
        x.push(xVal)
        y.push(mean)
        errors.push(error)
        allX.push(xVal)
        allYRange.push(mean - error, mean + error)
      }
      data.push({
        type: 'scatter',
        mode: 'lines+markers',
        x,
        y,
        name: group,
        line: { color: getColor(colorIdx) },
        marker: { color: getColor(colorIdx), size: 6 },
        error_y: {
          type: 'data',
          array: errors,
          visible: true,
          color: '#333',
          thickness: 1.5,
          width: 4,
        },
      })
      colorIdx += 1
    }

    // Calculate smart axis ranges with standard expansion and zero clamping
    const [xMin, xMax] = calculateAxisRange(allX)
    const [yMin, yMax] = calculateAxisRange(allYRange)

    return {
      data,
      layout: {
        ...createBaseLayout({ title: options.title || 'Line Plot', showLegend: true }),
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

  const xBuckets = new Map<number, number[]>()
  const xOrder: number[] = []
  for (let i = 0; i < len; i++) {
    const xi = xValues[i]
    const yi = yValues[i]
    if (typeof xi !== 'number' || !Number.isFinite(xi)) continue
    if (typeof yi !== 'number' || !Number.isFinite(yi)) continue
    if (!xBuckets.has(xi)) {
      xBuckets.set(xi, [])
      xOrder.push(xi)
    }
    xBuckets.get(xi)!.push(yi)
  }

  const x: number[] = []
  const y: number[] = []
  const errors: number[] = []
  const yRangeValues: number[] = []
  for (const xi of xOrder) {
    const values = xBuckets.get(xi) ?? []
    const { mean } = calculateMeanSE(values)
    const error = calculateErrorBar(values, errorBarType)
    x.push(xi)
    y.push(mean)
    errors.push(error)
    yRangeValues.push(mean - error, mean + error)
  }

  // Compute stats for non-grouped line plot
  if (validX.length > 0) {
    const xStats = calculateMeanSE(validX)
    const yStats = calculateMeanSE(validY)
    stats.n = validX.length
    stats.x_mean = xStats.mean
    stats.x_std = xStats.std
    stats.y_mean = yStats.mean
    stats.y_std = yStats.std

    // Compute correlation if multiple points
    if (validX.length > 1) {
      const xMean = xStats.mean
      const yMean = yStats.mean
      let sumXY = 0
      let sumX2 = 0
      let sumY2 = 0
      for (let i = 0; i < validX.length; i++) {
        const xi = validX[i]
        const yi = validY[i]
        if (xi === undefined || yi === undefined) continue
        const dx = xi - xMean
        const dy = yi - yMean
        sumXY += dx * dy
        sumX2 += dx * dx
        sumY2 += dy * dy
      }
      const correlation = sumXY / Math.sqrt(sumX2 * sumY2)
      if (Number.isFinite(correlation)) {
        stats.correlation = correlation
      }
    }
  }

  // Calculate smart axis ranges with standard expansion and zero clamping
  const [xMin, xMax] = calculateAxisRange(x)
  const [yMin, yMax] = calculateAxisRange(yRangeValues.length > 0 ? yRangeValues : y)

  return {
    data: [
      {
        type: 'scatter',
        mode: 'lines+markers',
        x,
        y,
        name: yColumn.columnName,
        line: { color: getColor(0) },
        marker: { color: getColor(0), size: 6 },
        error_y: {
          type: 'data',
          array: errors,
          visible: true,
          color: '#333',
          thickness: 1.5,
          width: 4,
        },
      },
    ],
    layout: {
      ...createBaseLayout({ title: options.title || 'Line Plot', showLegend: false }),
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

export default linePlotBuilder
