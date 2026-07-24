/**
 * Stacked Bar Chart Builder
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { createBaseLayout, createDefaultConfig, getColor, calculateBarPlotRange } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

export const stackedBarBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { columns, options } = input

  const xColumn = columns.find((c) => c.role === 'x') ?? columns.find((c) => c.inferredType === 'categorical')
  const stackColumn =
    columns.find((c) => c.role === 'color' || c.role === 'group') ??
    columns.find((c) => c.inferredType === 'categorical' && c !== xColumn)
  const yColumn =
    columns.find((c) => c.role === 'y') ??
    columns.find((c) => c.inferredType === 'numeric')

  if (!xColumn) {
    return createPlaceholderOutputFromInput('stacked_bar', input, options.title)
  }

  if (input.dataPolicy === 'aggregated') {
    const xValues = xColumn.values
    const sValues = stackColumn ? stackColumn.values : Array(xValues.length).fill('All')
    const yValues = yColumn?.values ?? []
    const len = Math.min(xValues.length, sValues.length, yValues.length || xValues.length)

    const xCategories = new Set<string>()
    const stackCategories = new Set<string>()
    const bucket: Record<string, Record<string, number>> = {}

    for (let i = 0; i < len; i++) {
      const xKey = String(xValues[i])
      const sKey = String(sValues[i])
      const y = yColumn ? yValues[i] : 1
      if (yColumn && typeof y !== 'number') continue

      xCategories.add(xKey)
      stackCategories.add(sKey)
      if (!bucket[sKey]) bucket[sKey] = {}
      bucket[sKey]![xKey] = (bucket[sKey]![xKey] ?? 0) + (yColumn ? (y as number) : 1)
    }

    const xList = Array.from(xCategories)
    const stackList = Array.from(stackCategories)
    const summaryValues: number[] = []

    const data: PlotBuilderOutput['data'] = []
    stackList.forEach((stackKey, idx) => {
      const values = xList.map((xKey) => bucket[stackKey]?.[xKey] ?? 0)
      data.push({
        type: 'bar',
        x: xList,
        y: values,
        name: stackKey,
        marker: {
          color: getColor(idx),
          line: { color: '#000000', width: 1 },
        },
      })
      values.forEach((val, j) => {
        summaryValues.push(val)
        stats[`${stackKey}_${xList[j]}_value`.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = val
      })
    })
    if (summaryValues.length > 0) {
      const total = summaryValues.reduce((acc, v) => acc + v, 0)
      stats.n = summaryValues.length
      stats.value_sum = total
      stats.value_mean = total / summaryValues.length
      stats.category_count = xList.length
      stats.group_count = stackList.length
    }

    // Calculate range from stacked totals (track positive and negative stacks separately)
    const rangeValues: number[] = []
    xList.forEach((xKey) => {
      let posSum = 0
      let negSum = 0
      stackList.forEach((stackKey) => {
        const v = bucket[stackKey]?.[xKey] ?? 0
        if (v >= 0) posSum += v
        else negSum += v
      })
      rangeValues.push(posSum, negSum)
    })
    const [yMin, yMax] = calculateBarPlotRange(rangeValues)

    // Position x-axis at y=0 for negative data (scientific correctness)
    const xAxisSide = (yMax <= 0 && yMin < 0) ? 'top' : 'bottom'

    return {
      data,
      layout: {
        ...createBaseLayout({ title: options.title || 'Stacked Bar Chart', showLegend: true }),
        barmode: 'stack',
        bargap: 0.6,
        bargroupgap: 0.15,
        xaxis: {
          title: {
            text: xColumn.columnName,
            font: { weight: 700 },
            standoff: 15,  // Distance between axis and title (works for both top and bottom)
          },
          side: xAxisSide,
          linewidth: 4,
          tickfont: { weight: 700 },
          tickwidth: 4,
          ticklen: 6,
          ticklabelshift: 1,
        },
        yaxis: {
          title: {
            text: yColumn ? yColumn.columnName : 'Count',
            font: { weight: 700 },
          },
          range: [yMin, yMax],
          autorange: false,
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

  const xValues = xColumn.values
  const sValues = stackColumn ? stackColumn.values : Array(xValues.length).fill('All')
  const yValues = yColumn?.values ?? []
  const len = Math.min(xValues.length, sValues.length, yValues.length || xValues.length)

  const xCategories = new Set<string>()
  const stackCategories = new Set<string>()
  const bucket: Record<string, Record<string, number>> = {}

  for (let i = 0; i < len; i++) {
    const xKey = String(xValues[i])
    const sKey = String(sValues[i])
    const y = yColumn ? yValues[i] : 1
    if (yColumn && typeof y !== 'number') continue

    xCategories.add(xKey)
    stackCategories.add(sKey)
    if (!bucket[sKey]) bucket[sKey] = {}
    bucket[sKey]![xKey] = (bucket[sKey]![xKey] ?? 0) + (yColumn ? (y as number) : 1)
  }

  const xList = Array.from(xCategories)
  const stackList = Array.from(stackCategories)
  const summaryValues: number[] = []

  const data: PlotBuilderOutput['data'] = []
  stackList.forEach((stackKey, idx) => {
    const values = xList.map((xKey) => bucket[stackKey]?.[xKey] ?? 0)
    data.push({
      type: 'bar',
      x: xList,
      y: values,
      name: stackKey,
      marker: {
        color: getColor(idx),
        line: { color: '#000000', width: 1 },
      },
    })
    values.forEach((val, j) => {
      summaryValues.push(val)
      stats[`${stackKey}_${xList[j]}_value`.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = val
    })
  })
  if (summaryValues.length > 0) {
    const total = summaryValues.reduce((acc, v) => acc + v, 0)
    stats.n = summaryValues.length
    stats.value_sum = total
    stats.value_mean = total / summaryValues.length
    stats.category_count = xList.length
    stats.group_count = stackList.length
  }

  // Calculate range from stacked totals (track positive and negative stacks separately)
  const rangeValues: number[] = []
  xList.forEach((xKey) => {
    let posSum = 0
    let negSum = 0
    stackList.forEach((stackKey) => {
      const v = bucket[stackKey]?.[xKey] ?? 0
      if (v >= 0) posSum += v
      else negSum += v
    })
    rangeValues.push(posSum, negSum)
  })
  const [yMin, yMax] = calculateBarPlotRange(rangeValues)

  // Position x-axis at y=0 for negative data (scientific correctness)
  const xAxisSide = (yMax <= 0 && yMin < 0) ? 'top' : 'bottom'

  return {
    data,
    layout: {
      ...createBaseLayout({ title: options.title || 'Stacked Bar Chart', showLegend: true }),
      barmode: 'stack',
      bargap: 0.6,
      bargroupgap: 0.15,
      xaxis: {
        title: {
          text: xColumn.columnName,
          font: { weight: 700 },
          standoff: 15,  // Distance between axis and title (works for both top and bottom)
        },
        side: xAxisSide,
        linewidth: 4,
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        title: {
          text: yColumn ? yColumn.columnName : 'Count',
          font: { weight: 700 },
        },
        range: [yMin, yMax],
        autorange: false,
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

export default stackedBarBuilder
