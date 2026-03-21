/**
 * Scheirer-Ray-Hare Grouped Bar Plot Builder
 *
 * Modular plot builder for Scheirer-Ray-Hare test (nonparametric two-way ANOVA).
 * Generates grouped bar plots with cell medians and significance brackets.
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Scheirer-Ray-Hare plot (44 metrics) validated against validation baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { Data, Layout, Config } from 'plotly.js'
import type { TestResult } from '@/store/results-store'
import type { GroupedBarOptions, CellSummary } from '../types'
import { extractPostHocBrackets } from '@/plots/common/brackets'
import {
  createBracketShapes,
  stackBrackets,
} from '@/utils/plotBuilders/common'

/**
 * Helper: Get result data from TestResult
 */
function getResultData(result: TestResult): Record<string, unknown> {
  const rawOutput = result.rawOutput
  if (rawOutput && typeof rawOutput === 'object') {
    const rawObject = rawOutput as Record<string, unknown>
    const nested = rawObject.results
    if (nested && typeof nested === 'object') {
      return nested as Record<string, unknown>
    }
  }
  return result as unknown as Record<string, unknown>
}

// Median and IQR are pre-calculated by Python backend in cell_summaries

/**
 * Extract factor names from result data
 */
function getFactorNames(resultData: Record<string, unknown>): string[] {
  const factorLabels = resultData.factor_labels as Record<string, unknown> | undefined
  if (factorLabels && typeof factorLabels === 'object') {
    return Object.keys(factorLabels)
  }
  return ['Factor A', 'Factor B']
}

/**
 * Build grouped bar plot for Scheirer-Ray-Hare test
 *
 * @param result Test result containing cell summaries
 * @param options Plot options (error bars, brackets, etc.)
 * @returns Plotly data and layout
 */
export function buildScheirerRayHareGroupedBar(
  result: TestResult,
  options: GroupedBarOptions = {}
): {
  data: Data[]
  layout: Partial<Layout>
  config: Partial<Config>
} {
  const resultData = getResultData(result)
  const summaries = (resultData.cell_summaries ?? []) as CellSummary[]
  const factorLabels = resultData.factor_labels as Record<string, string[]> | undefined

  const factorNames = getFactorNames(resultData)
  const factor1Name = factorNames[0] ?? 'Factor A'
  const factor2Name = factorNames[1] ?? 'Factor B'

  // Extract levels for each factor
  const factor2Labels = factorLabels?.[factor2Name] ?? []

  // Organize data by factor2 (groups)
  const groupedData = new Map<string, { x: string[]; y: number[]; error: number[] }>()

  for (const summary of summaries) {
    const factor1Value = String(summary[factor1Name] ?? '')
    const factor2Value = String(summary[factor2Name] ?? '')

    if (!factor1Value || !factor2Value) continue

    if (!groupedData.has(factor2Value)) {
      groupedData.set(factor2Value, { x: [], y: [], error: [] })
    }

    const group = groupedData.get(factor2Value)!
    group.x.push(factor1Value)
    group.y.push(summary.median ?? 0)

    // Error bars: IQR or none for nonparametric
    if (options.errorBarType === 'iqr') {
      group.error.push(summary.iqr ?? 0)
    } else {
      group.error.push(0)
    }
  }

  // Create Plotly traces (one per factor2 level)
  const traces: Data[] = []
  for (const factor2Value of factor2Labels) {
    const group = groupedData.get(String(factor2Value))
    if (!group) continue

    const trace: Data = {
      x: group.x,
      y: group.y,
      name: String(factor2Value),
      type: 'bar',
      error_y:
        options.errorBarType === 'iqr'
          ? {
              type: 'data',
              array: group.error,
              visible: true,
            }
          : undefined,
    }

    traces.push(trace)
  }

  // Base layout
  const layout: Partial<Layout> = {
    barmode: 'group',
    xaxis: {
      title: factor1Name,
    },
    yaxis: {
      title: 'Median',
    },
    title: options.title ?? 'Cell Medians',
    showlegend: true,
    legend: {
      title: { text: factor2Name },
    },
  }

  // Aggregate plot stats for E2E validation (match validation baselines)
  const stats: Record<string, number> = {}
  const factor1Labels = factorLabels?.[factor1Name] ?? Array.from(
    new Set(
      Array.from(groupedData.values()).flatMap((g) => g.x)
    )
  )

  stats.n_traces = factor2Labels.length
  stats.n_points_per_trace = factor1Labels.length
  stats.total_points = summaries.length

  const medians = summaries
    .map((s) => (typeof s.median === 'number' ? s.median : Number(s.median)))
    .filter((v): v is number => Number.isFinite(v))
  const means = summaries
    .map((s) => (typeof s.mean === 'number' ? s.mean : Number(s.mean)))
    .filter((v): v is number => Number.isFinite(v))
  const iqrs = summaries
    .map((s) => (typeof s.iqr === 'number' ? s.iqr : Number(s.iqr)))
    .filter((v): v is number => Number.isFinite(v))

  const medianOf = (arr: number[]) => {
    if (arr.length === 0) return undefined
    const sorted = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
  }

  if (medians.length > 0) {
    const overallMedian = medianOf(medians)
    stats.overall_median = overallMedian !== undefined ? overallMedian : medians[0]!
    stats.min_median = Math.min(...medians)
    stats.max_median = Math.max(...medians)
  }

  if (means.length > 0) {
    const meanTotal = means.reduce((s, v) => s + v, 0)
    stats.overall_mean = meanTotal / means.length
  }

  if (iqrs.length > 0) {
    const iqrTotal = iqrs.reduce((s, v) => s + v, 0)
    stats.mean_iqr = iqrTotal / iqrs.length
  }

  // Add significance brackets if settings provided
  if (options.bracketSettings) {
    const brackets = extractPostHocBrackets(result, options.bracketSettings)

    if (brackets.length > 0) {
      // Stack brackets to avoid overlaps
      const stackedBrackets = stackBrackets(brackets, options.bracketSettings)

      // Calculate y-axis range for bracket positioning
      const allY = traces.flatMap((trace) => (trace.y as number[]) ?? [])
      const yMax = Math.max(...allY, 0)
      const yMin = Math.min(...allY, 0)
      const yScale = yMax * 0.15

      // Generate bracket shapes
      const categoryMap = new Map<string, number>()
      const firstTraceX = traces[0]?.x as string[] | undefined
      firstTraceX?.forEach((cat: string, idx: number) => {
        categoryMap.set(String(cat), idx)
      })

      // Pass data range for stable direction determination (prevents flipping when dragging near zero)
      const shapes = createBracketShapes(
        stackedBrackets,
        options.bracketSettings,
        yMax,
        yScale,
        categoryMap,
        { yMin, yMax }
      )

      layout.shapes = shapes
    }
  }

  const config: Partial<Config> = {
    responsive: true,
    displayModeBar: true,
    modeBarButtonsToRemove: ['lasso2d', 'select2d'],
  }

  layout.meta = {
    ...(options as any).meta,
    stats,
    errorBarType: options.errorBarType,
  }

  return { data: traces, layout, config }
}
