/**
 * Interaction Plot Builder
 *
 * For factorial designs: mean response across Factor A levels, split by Factor B.
 * Non-parallel lines indicate an interaction is present.
 *
 * Features:
 * - Lines + markers (one line per series level)
 * - Error bars (SE default, user-toggleable)
 * - legendgroup for synchronized toggling across facets
 * - NO significance brackets (keeps plot clean)
 * - Interaction detection (lines_parallel stat for E2E)
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Used by: Two-Way ANOVA, Multifactorial ANOVA. Validated against validation baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { calculateMeanSE, calculateErrorBar, createBaseLayout, createDefaultConfig, getColor } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

/**
 * Detect if lines are approximately parallel (interaction absent)
 */
function detectParallelLines(
  seriesData: Map<string, number[]>,
  threshold: number = 0.3
): boolean {
  if (seriesData.size < 2) return true

  const slopes: number[] = []
  for (const yValues of seriesData.values()) {
    if (yValues.length < 2) continue
    const slope = (yValues[yValues.length - 1] ?? 0) - (yValues[0] ?? 0)
    slopes.push(slope)
  }

  if (slopes.length < 2) return true

  const maxSlope = Math.max(...slopes.map(Math.abs))
  if (maxSlope === 0) return true

  for (let i = 0; i < slopes.length - 1; i++) {
    for (let j = i + 1; j < slopes.length; j++) {
      const diff = Math.abs((slopes[i] ?? 0) - (slopes[j] ?? 0))
      if (diff / maxSlope > threshold) return false
    }
  }
  return true
}

export const interactionPlotBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { columns, options } = input
  const errorBarType = options.errorBarType ?? 'se'

  const fallbackCategorical = columns.find((c) => c.inferredType === 'categorical')
  const factorA =
    columns.find((c) => c.role === 'x') ?? columns.find((c) => c.inferredType === 'categorical') ?? fallbackCategorical
  const factorB =
    columns.find((c) => c.role === 'group' || c.role === 'color') ??
    columns.find((c) => c.inferredType === 'categorical' && c !== factorA) ??
    fallbackCategorical
  const yColumn =
    columns.find((c) => c.role === 'y' || c.role === 'response') ??
    columns.find((c) => c.inferredType === 'numeric')

  if (!factorA || !factorB || !yColumn) {
    return createPlaceholderOutputFromInput('interaction', input, options.title)
  }
  const factorAName = factorA.columnName ?? 'Factor A'

  if (input.dataPolicy === 'aggregated') {
    const aValues = factorA!.values ?? []
    const bValues = factorB!.values ?? []
    const yValues = yColumn.values ?? []
    const errorColumn = columns.find((c) => c.role === 'error')
    const errorValues = errorColumn?.values ?? []
    const len = Math.min(aValues.length, bValues.length, yValues.length)

    const aLevels = new Set<string>()
    const bLevels = new Set<string>()
    const buckets: Record<string, Record<string, number>> = {}
    const errorBuckets: Record<string, Record<string, number>> = {}

    for (let i = 0; i < len; i++) {
      const a = String(aValues[i])
      const b = String(bValues[i])
      const y = yValues[i]
      if (typeof y !== 'number') continue
      const errValueRaw = errorValues[i]
      const errValue = typeof errValueRaw === 'number' ? errValueRaw : Number(errValueRaw)
      aLevels.add(a)
      bLevels.add(b)
      if (!buckets[b]) buckets[b] = {}
      buckets[b]![a] = y
      if (Number.isFinite(errValue)) {
        if (!errorBuckets[b]) errorBuckets[b] = {}
        errorBuckets[b]![a] = errValue
      }
    }

    const aList = Array.from(aLevels)
    const bList = Array.from(bLevels)
    const data: PlotBuilderOutput['data'] = []

    bList.forEach((b, bIdx) => {
      const means: number[] = []
      const errorBars: number[] = []
      aList.forEach((a) => {
        const value = buckets[b]?.[a] ?? 0
        means.push(value)
        const errValue = errorBuckets[b]?.[a] ?? 0
        errorBars.push(errValue)
        const statKey = `${b}_${a}_mean`.toLowerCase().replace(/[^a-z0-9]+/g, '_')
        stats[statKey] = value
      })
      const trace: any = {
        type: 'scatter',
        mode: 'lines+markers',
        x: aList,
        y: means,
        name: b,
        legendgroup: b,
        line: { color: getColor(bIdx) },
        marker: { color: getColor(bIdx), size: 6 },
      }
      if (errorBarType !== 'none') {
        trace.error_y = {
          type: 'data',
          array: errorBars,
          visible: true,
          color: getColor(bIdx),
          thickness: 1.5,
          width: 8,
        }
      }
      data.push(trace)
    })

    // E2E validation stats
    stats['series_count'] = bList.length
    stats['category_count'] = aList.length
    stats['error_bar_type'] = errorBarType === 'none' ? 0 : errorBarType === 'se' ? 1 : errorBarType === 'sd' ? 2 : errorBarType === 'ci' ? 3 : 4

    return {
      data,
      layout: {
        ...createBaseLayout({ title: options.title || 'Interaction Plot', showLegend: true }),
        xaxis: {
          title: {
            text: factorA.columnName,
            font: { weight: 700 },
          },
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
        },
      },
      config: createDefaultConfig(),
      stats,
      dataPolicy: input.dataPolicy,
      samplingConfig: input.samplingConfig,
      aggregationConfig: input.aggregationConfig,
    }
  }

  const aValues = factorA.values
  const bValues = factorB.values
  const yValues = yColumn.values
  const len = Math.min(aValues.length, bValues.length, yValues.length)

  const aLevels = new Set<string>()
  const bLevels = new Set<string>()
  const buckets: Record<string, Record<string, number[]>> = {}

  for (let i = 0; i < len; i++) {
    const a = String(aValues[i])
    const b = String(bValues[i])
    const y = yValues[i]
    if (typeof y !== 'number') continue
    aLevels.add(a)
    bLevels.add(b)
    if (!buckets[b]) buckets[b] = {}
    if (!buckets[b]![a]) buckets[b]![a] = []
    buckets[b]![a]!.push(y)
  }

  const aList = Array.from(aLevels)
  const bList = Array.from(bLevels)
  const data: PlotBuilderOutput['data'] = []

  // Track means for interaction detection
  const seriesMeans = new Map<string, number[]>()

  bList.forEach((b, bIdx) => {
    const means: number[] = []
    const errorBars: number[] = []

    aList.forEach((a) => {
      const values = buckets[b]?.[a] ?? []
      const { mean, se } = calculateMeanSE(values)
      means.push(mean)

      // Calculate error bar
      const errorBar = calculateErrorBar(values, errorBarType)
      errorBars.push(errorBar)

      // Store stats for E2E validation
      const statKey = `${b}_${a}`.toLowerCase().replace(/[^a-z0-9]+/g, '_')
      stats[`${statKey}_mean`] = mean
      stats[`${statKey}_se`] = se
      stats[`${statKey}_n`] = values.length
    })

    seriesMeans.set(b, means)

    const trace: any = {
      type: 'scatter',
      mode: 'lines+markers',
      x: aList,
      y: means,
      name: b,
      legendgroup: b,
      line: { color: getColor(bIdx) },
      marker: { color: getColor(bIdx), size: 6 },
    }

    // Add error bars if not 'none'
    if (errorBarType !== 'none') {
      trace.error_y = {
        type: 'data',
        array: errorBars,
        visible: true,
        color: getColor(bIdx),
        thickness: 1.5,
        width: 8,
      }
    }

    data.push(trace)
  })

  // Detect interaction (non-parallel lines)
  const linesParallel = detectParallelLines(seriesMeans)

  // E2E validation stats
  stats['series_count'] = bList.length
  stats['category_count'] = aList.length
  stats['error_bar_type'] = errorBarType === 'none' ? 0 : errorBarType === 'se' ? 1 : errorBarType === 'sd' ? 2 : errorBarType === 'ci' ? 3 : 4
  stats['lines_parallel'] = linesParallel ? 1 : 0
  stats['interaction_detected'] = linesParallel ? 0 : 1

  return {
    data,
    layout: {
      ...createBaseLayout({ title: options.title || 'Interaction Plot', showLegend: true }),
      xaxis: {
        title: {
          text: factorAName,
          font: { weight: 700 },
        },
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
      },
      meta: { ...(options as any).meta, stats },
    },
    config: createDefaultConfig(),
    stats,
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  }
}

export default interactionPlotBuilder
