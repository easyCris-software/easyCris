/**
 * Box Plot Builder
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Used by: t-tests, one-way ANOVA, Kruskal-Wallis, Scheirer-Ray-Hare.
 * Validated against validation baseline. Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { applyAlpha, calculateMeanSE, calculateQuartiles, createBaseLayout, createDefaultConfig, getColor } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

function sanitizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export const boxPlotBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { columns, options } = input

  // Extract jitter settings (defaults: off, jitter=0.3, pointpos=-1.8)
  const showJitter = options.showJitter ?? false
  const jitterAmount = options.jitterAmount ?? 0.3
  const pointPosition = options.pointPosition ?? -1.8
  const resolveBoxWidth = (groupCount: number) => {
    if (typeof options.boxWidth === 'number') return options.boxWidth
    return groupCount <= 1 ? 0.12 : 0.2
  }

  const getPaddedRange = (values: number[], padRatio: number = 0.05): [number, number] | null => {
    if (values.length === 0) return null
    const min = Math.min(...values)
    const max = Math.max(...values)
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    const span = max - min
    const pad = span > 0 ? span * padRatio : Math.max(1, Math.abs(min || max) * padRatio)
    // Increase bottom padding to prevent box from touching x-axis
    const bottomPad = pad * 1.5  // 50% more padding on bottom
    return [min - bottomPad, max + pad]
  }
  const resolvePadRatio = (groupCount: number) => (groupCount <= 1 ? 0.5 : 0.05)

  const yColumn =
    columns.find((c) => c.role === 'y' || c.role === 'response') ??
    columns.find((c) => c.inferredType === 'numeric')
  const q1Column = columns.find((c) => c.role === 'q1')
  const medianColumn = columns.find((c) => c.role === 'median')
  const q3Column = columns.find((c) => c.role === 'q3')
  const minColumn = columns.find((c) => c.role === 'min')
  const maxColumn = columns.find((c) => c.role === 'max')

  if (!yColumn) {
    return createPlaceholderOutputFromInput('box', input, options.title)
  }

  const groupColumn =
    columns.find((c) => c.role === 'group' || c.role === 'x') ??
    columns.find((c) => c.role === 'color') ??
    columns.find((c) => c.inferredType === 'categorical')
  const colorColumn = columns.find((c) => c.role === 'color')

  if (
    input.dataPolicy === 'aggregated' &&
    q1Column &&
    medianColumn &&
    q3Column &&
    minColumn &&
    maxColumn
  ) {
    const groups = groupColumn ? groupColumn.values.map((v) => String(v)) : ['All']
    const len = Math.min(
      q1Column.values.length,
      medianColumn.values.length,
      q3Column.values.length,
      minColumn.values.length,
      maxColumn.values.length,
      groups.length
    )

    const data: PlotBuilderOutput['data'] = []
    const boxWidth = resolveBoxWidth(len)
    const rangeValues: number[] = []
    for (let i = 0; i < len; i++) {
      const label = groups[i] ?? 'All'
      const q1 = q1Column.values[i]
      const median = medianColumn.values[i]
      const q3 = q3Column.values[i]
      const min = minColumn.values[i]
      const max = maxColumn.values[i]
      if (
        typeof q1 !== 'number' ||
        typeof median !== 'number' ||
        typeof q3 !== 'number' ||
        typeof min !== 'number' ||
        typeof max !== 'number'
      ) {
        continue
      }

      rangeValues.push(min, max)
      stats[`${sanitizeKey(label)}_median`] = median
      stats[`${sanitizeKey(label)}_q1`] = q1
      stats[`${sanitizeKey(label)}_q3`] = q3
      stats[`${sanitizeKey(label)}_min`] = min
      stats[`${sanitizeKey(label)}_max`] = max

      const color = getColor(i, options.colorPalette)
      const fillColor = applyAlpha(color, 0.35)
      data.push({
        type: 'box',
        name: label,
        q1: [q1],
        median: [median],
        q3: [q3],
        lowerfence: [min],
        upperfence: [max],
        fillcolor: fillColor,
        marker: { color },
        line: { color },
        width: boxWidth,
        boxpoints: showJitter ? 'all' : false,
        jitter: showJitter ? jitterAmount : undefined,
        pointpos: showJitter ? pointPosition : undefined,
      })
    }
    if (yColumn?.values) {
      const allValues = yColumn.values.filter((v): v is number => typeof v === 'number')
      if (allValues.length > 0) {
        const { mean, std, n } = calculateMeanSE(allValues)
        stats.n = n
        stats.value_mean = mean
        stats.value_std = std
      }
      if (groupColumn) {
        stats.group_count = new Set(groups).size
      }
    }

    const paddedRange = getPaddedRange(rangeValues, resolvePadRatio(len))
    return {
      data,
      layout: {
        ...createBaseLayout({ title: options.title || 'Box Plot', showLegend: Boolean(groupColumn) }),
        yaxis: {
          title: {
            text: yColumn.columnName,
            font: { weight: 700 },
          },
          tickfont: { weight: 700 },
          tickwidth: 4,
          ticklen: 6,
          ticklabelshift: 1,
          ...(paddedRange ? { range: paddedRange, autorange: false } : {}),
        },
        xaxis: {
          ...(groupColumn
            ? {
                title: {
                  text: groupColumn.columnName,
                  font: { weight: 700 },
                },
              }
            : {}),
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

  if (!groupColumn) {
    const values = yColumn.values.filter((v): v is number => typeof v === 'number')
    const boxWidth = resolveBoxWidth(1)
    const paddedRange = getPaddedRange(values, resolvePadRatio(1))
    const q = calculateQuartiles(values)
    stats.median = q.median
    stats.q1 = q.q1
    stats.q3 = q.q3
    stats.min = q.min
    stats.max = q.max
    if (values.length > 0) {
      const { mean, std, n } = calculateMeanSE(values)
      stats.n = n
      stats.value_mean = mean
      stats.value_std = std
    }

    const color = getColor(0, options.colorPalette)
    const fillColor = applyAlpha(color, 0.35)
    return {
      data: [
        {
          type: 'box',
          y: values,
          name: yColumn.columnName,
          fillcolor: fillColor,
          marker: { color },
          line: { color },
          width: boxWidth,
          boxmean: 'sd',
          boxpoints: showJitter ? 'all' : false,
          jitter: showJitter ? jitterAmount : undefined,
          pointpos: showJitter ? pointPosition : undefined,
        },
      ],
      layout: {
        ...createBaseLayout({ title: options.title || 'Box Plot', showLegend: false }),
        xaxis: {
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
          tickfont: { weight: 700 },
          tickwidth: 4,
          ticklen: 6,
          ticklabelshift: 1,
          ...(paddedRange ? { range: paddedRange, autorange: false } : {}),
        },
      },
      config: createDefaultConfig(),
      stats,
      dataPolicy: input.dataPolicy,
      samplingConfig: input.samplingConfig,
      aggregationConfig: input.aggregationConfig,
    }
  }

  const groups = new Map<string, number[]>()
  const yValues = yColumn.values
  const gValues = groupColumn.values
  const cValues = colorColumn?.values
  const len = Math.min(yValues.length, gValues.length, cValues ? cValues.length : yValues.length)

  // If a color column is provided, create traces per color and use x to separate groups.
  if (colorColumn) {
    const colorBuckets = new Map<string, { x: string[]; y: number[] }>()
    const groupSet = new Set<string>()

    for (let i = 0; i < len; i++) {
      const g = String(gValues[i])
      const v = yValues[i]
      if (typeof v !== 'number') continue
      const colorVal = String(cValues?.[i] ?? 'Unspecified')
      groupSet.add(g)

      if (!colorBuckets.has(colorVal)) {
        colorBuckets.set(colorVal, { x: [], y: [] })
      }
      const bucket = colorBuckets.get(colorVal)!
      bucket.x.push(g)
      bucket.y.push(v)
    }

    const allValues = Array.from(colorBuckets.values()).flatMap((b) => b.y)
    if (allValues.length > 0) {
      const { mean, std, n } = calculateMeanSE(allValues)
      stats.n = n
      stats.value_mean = mean
      stats.value_std = std
    }
    stats.group_count = groupSet.size
    const paddedRange = getPaddedRange(allValues, resolvePadRatio(colorBuckets.size || 1))

    const data: PlotBuilderOutput['data'] = []
    const boxWidth = resolveBoxWidth(colorBuckets.size || 1)
    let colorIdx = 0
    for (const [colorVal, bucket] of colorBuckets) {
      const q = calculateQuartiles(bucket.y)
      stats[`${sanitizeKey(colorVal)}_median`] = q.median
      stats[`${sanitizeKey(colorVal)}_q1`] = q.q1
      stats[`${sanitizeKey(colorVal)}_q3`] = q.q3
      stats[`${sanitizeKey(colorVal)}_min`] = q.min
      stats[`${sanitizeKey(colorVal)}_max`] = q.max

      const color = getColor(colorIdx, options.colorPalette)
      const fillColor = applyAlpha(color, 0.35)
      data.push({
        type: 'box',
        x: bucket.x,
        y: bucket.y,
        name: colorVal,
        fillcolor: fillColor,
        marker: {
          color,
          opacity: showJitter ? 0.65 : 0.9,
        },
        line: { color, width: 1 },
        width: boxWidth,
        offsetgroup: colorVal,
        legendgroup: colorVal,
        boxmean: 'sd',
        boxpoints: showJitter ? 'all' : false,
        jitter: showJitter ? jitterAmount : undefined,
        pointpos: showJitter ? pointPosition : undefined,
      })
      colorIdx += 1
    }

    return {
      data,
      layout: {
        ...createBaseLayout({
          title: options.title || 'Box Plot',
          showLegend: true,
        }),
        boxmode: 'group',
        yaxis: {
          title: {
            text: yColumn.columnName,
            font: { weight: 700 },
          },
          tickfont: { weight: 700 },
          tickwidth: 4,
          ticklen: 6,
          ticklabelshift: 1,
          ...(paddedRange ? { range: paddedRange, autorange: false } : {}),
        },
        xaxis: {
          title: {
            text: groupColumn.columnName,
            font: { weight: 700 },
          },
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

  for (let i = 0; i < len; i++) {
    const g = String(gValues[i])
    const v = yValues[i]
    if (typeof v !== 'number') continue
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(v)
  }
  const allValues = Array.from(groups.values()).flat()
  if (allValues.length > 0) {
    const { mean, std, n } = calculateMeanSE(allValues)
    stats.n = n
    stats.value_mean = mean
    stats.value_std = std
  }
  stats.group_count = groups.size
  const paddedRange = getPaddedRange(allValues, resolvePadRatio(groups.size || 1))

  const data: PlotBuilderOutput['data'] = []
  const boxWidth = resolveBoxWidth(groups.size || 1)
  let colorIdx = 0
  for (const [group, values] of groups) {
    const q = calculateQuartiles(values)
    stats[`${sanitizeKey(group)}_median`] = q.median
    stats[`${sanitizeKey(group)}_q1`] = q.q1
    stats[`${sanitizeKey(group)}_q3`] = q.q3
    stats[`${sanitizeKey(group)}_min`] = q.min
    stats[`${sanitizeKey(group)}_max`] = q.max

    const color = getColor(colorIdx, options.colorPalette)
    const fillColor = applyAlpha(color, 0.35)
    data.push({
      type: 'box',
      y: values,
      name: group,
      fillcolor: fillColor,
      marker: { color, opacity: showJitter ? 0.8 : 0.95 },
      line: { color, width: 1 },
      width: boxWidth,
      boxmean: 'sd',
      boxpoints: showJitter ? 'all' : false,
      jitter: showJitter ? jitterAmount : undefined,
      pointpos: showJitter ? pointPosition : undefined,
    })
    colorIdx += 1
  }

  return {
    data,
    layout: {
      ...createBaseLayout({ title: options.title || 'Box Plot', showLegend: true }),
      yaxis: {
        title: {
          text: yColumn.columnName,
          font: { weight: 700 },
        },
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
        ...(paddedRange ? { range: paddedRange, autorange: false } : {}),
      },
      xaxis: {
        title: {
          text: groupColumn.columnName,
          font: { weight: 700 },
        },
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

export default boxPlotBuilder
