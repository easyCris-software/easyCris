/**
 * Grouped Bar Chart Builder
 *
 * Requires:
 * - X (categorical)
 * - Group (categorical)
 * - Y (numeric)
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Used by: Kruskal-Wallis, Scheirer-Ray-Hare. Validated against validation baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { calculateMeanSE, calculateErrorBar, createBaseLayout, createDefaultConfig, getColor, calculateBarPlotRange, calculateQuartiles } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

function sanitizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export const groupedBarBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number | string> = {}
  const { columns, options } = input
  const errorBarType = options.errorBarType ?? 'se'  // Default to SE
  stats.error_bar_type = errorBarType

  const xColumn = columns.find((c) => c.role === 'x') ?? columns.find((c) => c.inferredType === 'categorical')
  const groupColumn =
    columns.find((c) => c.role === 'group' || c.role === 'color') ??
    columns.find((c) => c.inferredType === 'categorical' && c !== xColumn)
  const yColumn =
    columns.find((c) => c.role === 'y' || c.role === 'response') ??
    columns.find((c) => c.inferredType === 'numeric')
  const errorColumn = columns.find((c) => c.role === 'error')

  if (!xColumn || !groupColumn || !yColumn) {
    return createPlaceholderOutputFromInput('grouped_bar', input, options.title)
  }

  if (input.dataPolicy === 'aggregated') {
    const xValues = xColumn.values
    const gValues = groupColumn.values
    const yValues = yColumn.values
    const eValues = errorColumn?.values ?? []
    const len = Math.min(xValues.length, gValues.length, yValues.length)

    const groupKeys = new Set<string>()
    const xKeys = new Set<string>()
    const buckets: Record<string, Record<string, number>> = {}
    const errorBuckets: Record<string, Record<string, number>> = {}

    for (let i = 0; i < len; i++) {
      const xKey = String(xValues[i])
      const gKey = String(gValues[i])
      const y = yValues[i]
      if (typeof y !== 'number') continue

      groupKeys.add(gKey)
      xKeys.add(xKey)
      if (!buckets[gKey]) buckets[gKey] = {}
      buckets[gKey]![xKey] = y

      const e = eValues[i]
      if (typeof e === 'number') {
        if (!errorBuckets[gKey]) errorBuckets[gKey] = {}
        errorBuckets[gKey]![xKey] = e
      }
    }

    const xCategories = Array.from(xKeys)
    const groups = Array.from(groupKeys)
    const summaryValues: number[] = []
    const rangeValues: number[] = []

    const data: PlotBuilderOutput['data'] = []
    groups.forEach((group, groupIdx) => {
      const means: number[] = []
      const errors: number[] = []
      xCategories.forEach((xCat) => {
        const value = buckets[group]?.[xCat] ?? 0
        means.push(value)
        summaryValues.push(value)
        const err = errorBuckets[group]?.[xCat]
        const safeErr = typeof err === 'number' ? err : 0
        errors.push(safeErr)
        const prefix = `${sanitizeKey(group)}_${sanitizeKey(xCat)}`
        stats[`${prefix}_mean`] = value
        if (typeof err === 'number') {
          stats[`${prefix}_se`] = err
        }
        // Collect range values including error bars
        rangeValues.push(value - safeErr, value + safeErr)
      })

      data.push({
        type: 'bar',
        x: xCategories,
        y: means,
        name: group,
        marker: {
          color: getColor(groupIdx),
          line: { color: '#000000', width: 1 },
        },
        error_y: errors.some((v) => v > 0)
          ? {
              type: 'data',
              array: errors,
              visible: true,
              color: '#000000',
              thickness: 1.5,
              width: 4,
            }
          : undefined,
      })
    })
    if (summaryValues.length > 0) {
      const total = summaryValues.reduce((acc, v) => acc + v, 0)
      stats.n = summaryValues.length
      stats.value_sum = total
      stats.value_mean = total / summaryValues.length
      stats.category_count = xCategories.length
      stats.group_count = groups.length

      // Aggregate plot stats (for E2E validation)
      stats.n_traces = groups.length  // Number of series (factor2 levels)
      stats.n_points_per_trace = xCategories.length  // Points per series (factor1 levels)
      stats.total_points = summaryValues.length  // Total combinations
      stats.overall_mean = stats.value_mean  // Overall mean
      stats.min_mean = Math.min(...summaryValues)  // Min mean value
      stats.max_mean = Math.max(...summaryValues)  // Max mean value

      // Calculate mean of SE values (if error bars present)
      const allErrors: number[] = []
      Object.values(errorBuckets).forEach((bucket) => {
        Object.values(bucket).forEach((err) => {
          if (typeof err === 'number') {
            allErrors.push(err)
          }
        })
      })
      if (allErrors.length > 0) {
        const seTotal = allErrors.reduce((acc, v) => acc + v, 0)
        stats.mean_se = seTotal / allErrors.length
      }
    }

    const [yMin, yMax] = calculateBarPlotRange(rangeValues)

    // Position x-axis at y=0 for negative data (scientific correctness)
    const xAxisSide = (yMax <= 0 && yMin < 0) ? 'top' : 'bottom'

    return {
      data,
      layout: {
        ...createBaseLayout({ title: options.title || 'Grouped Bar Chart', showLegend: true }),
        barmode: 'group',
        bargap: 0.6,  // Gap between category groups (higher = narrower bars, matches z6.png)
        bargroupgap: 0.15,  // Gap within groups (small gap between bars in same category)
        meta: {
          errorBarType,
        },
        xaxis: {
          title: {
            text: xColumn.columnName,
            font: { weight: 700 },
            standoff: 15,  // Distance between axis and title (works for both top and bottom)
          },
          side: xAxisSide,
          linewidth: 4,
          tickwidth: 4,
          ticklen: 6,
          tickfont: {
            weight: 700,
          },
        },
        yaxis: {
          title: {
            text: yColumn.columnName,
            font: { weight: 700 },
          },
          range: [yMin, yMax],
          autorange: false,
        linewidth: 4,
          tickwidth: 4,
          ticklen: 6,
          ticklabelshift: 1,
          tickfont: {
            weight: 700,
          },
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
  const gValues = groupColumn.values
  const yValues = yColumn.values
  const len = Math.min(xValues.length, gValues.length, yValues.length)

  const groupKeys = new Set<string>()
  const xKeys = new Set<string>()
  const buckets: Record<string, Record<string, number[]>> = {}

  for (let i = 0; i < len; i++) {
    const xKey = String(xValues[i])
    const gKey = String(gValues[i])
    const y = yValues[i]
    if (typeof y !== 'number') continue

    groupKeys.add(gKey)
    xKeys.add(xKey)
    if (!buckets[gKey]) buckets[gKey] = {}
    if (!buckets[gKey]![xKey]) buckets[gKey]![xKey] = []
    buckets[gKey]![xKey]!.push(y)
  }

  const xCategories = Array.from(xKeys)
  const groups = Array.from(groupKeys)
  const summaryValues: number[] = []
  const rangeValues: number[] = []

  const data: PlotBuilderOutput['data'] = []
  groups.forEach((group, groupIdx) => {
    const summaries: number[] = []
    const errors: number[] = []
    xCategories.forEach((xCat) => {
      const values = buckets[group]?.[xCat] ?? []
      let summary = 0
      let error = 0

      if (errorBarType === 'iqr') {
        const { median, iqr } = calculateQuartiles(values)
        summary = median
        error = iqr / 2 // symmetric half-IQR
      } else {
        const { mean, se, n } = calculateMeanSE(values)
        summary = mean
        error = calculateErrorBar(values, errorBarType)
        const prefix = `${sanitizeKey(group)}_${sanitizeKey(xCat)}`
        stats[`${prefix}_mean`] = mean
        stats[`${prefix}_se`] = se
        stats[`${prefix}_n`] = n
      }

      summaries.push(summary)
      summaryValues.push(summary)
      errors.push(error)
      const prefix = `${sanitizeKey(group)}_${sanitizeKey(xCat)}`
      if (errorBarType === 'iqr') {
        stats[`${prefix}_median`] = summary
        stats[`${prefix}_iqr`] = error * 2
      }
      // Collect range values including error bars
      rangeValues.push(summary - error, summary + error)
    })

    data.push({
      type: 'bar',
      x: xCategories,
      y: summaries,
      name: group,
      marker: {
        color: getColor(groupIdx),
        line: { color: '#000000', width: 1 },
      },
      error_y:
        errorBarType === 'none'
          ? undefined
          : {
              type: 'data',
              array: errors,
              visible: true,
              color: '#000000',
              thickness: 1.5,
              width: 4,
            },
    })
  })
  if (summaryValues.length > 0) {
    const total = summaryValues.reduce((acc, v) => acc + v, 0)
    stats.n = summaryValues.length
    stats.value_sum = total
    stats.value_mean = total / summaryValues.length
    stats.category_count = xCategories.length
    stats.group_count = groups.length
  }

  const [yMin, yMax] = calculateBarPlotRange(rangeValues)

  // Position x-axis at y=0 for negative data (scientific correctness)
  const xAxisSide = (yMax <= 0 && yMin < 0) ? 'top' : 'bottom'

  return {
    data,
    layout: {
      ...createBaseLayout({ title: options.title || 'Grouped Bar Chart', showLegend: true }),
      barmode: 'group',
      bargap: 0.6,
      bargroupgap: 0.15,
      meta: {
        errorBarType,
      },
      xaxis: {
        title: {
          text: xColumn.columnName,
          font: { weight: 700 },
          standoff: 15,  // Distance between axis and title (works for both top and bottom)
        },
        side: xAxisSide,
        linewidth: 4,
        tickwidth: 4,
        ticklen: 6,
        tickfont: {
          weight: 700,
        },
      },
      yaxis: {
        title: {
          text: yColumn.columnName,
          font: { weight: 700 },
        },
        range: [yMin, yMax],
        autorange: false,
        linewidth: 4,
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
        tickfont: {
          weight: 700,
        },
      },
    },
    config: createDefaultConfig(),
    stats,
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  }
}

export default groupedBarBuilder
