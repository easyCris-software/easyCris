/**
 * Bar Plot Builder
 *
 * - If X (categorical) and Y (numeric) are present, shows mean + SE per group.
 * - If only X is present, shows counts per category.
 * - If only Y is present (test-result fallback), shows single bar with mean + SE.
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Used by: t-tests, one-sample, one-way ANOVA. Validated against validation baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { calculateMeanSE, calculateErrorBar, createBaseLayout, createDefaultConfig, getColor, createBracketShapes, stackBrackets, calculateBarPlotRange, repelBracketLayout, DEFAULT_COLORS } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

function sanitizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function summarize(values: number[]) {
  if (values.length === 0) {
    return null
  }
  const { mean, std, n } = calculateMeanSE(values)
  const sum = values.reduce((acc, v) => acc + v, 0)
  return { mean, std, n, sum }
}

export const barPlotBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number | string> = {}
  const { columns, options } = input
  const errorBarType = options.errorBarType ?? 'se'  // Default to SE
  const bargap = options.bargap ?? 0.6  // Default gap between groups (higher = narrower bars)
  const bargroupgap = options.bargroupgap ?? 0.15  // Default gap within groups
  const splitTraces = options.splitTraces === true  // Optional: one trace per category
  stats.error_bar_type = errorBarType

  const xColumn =
    columns.find((c) => c.role === 'x' || c.role === 'group') ??
    columns.find((c) => c.inferredType === 'categorical')

  const yColumn =
    columns.find((c) => c.role === 'y' || c.role === 'response') ??
    columns.find((c) => c.inferredType === 'numeric')
  const errorColumn = columns.find((c) => c.role === 'error')

  if (input.source === 'user_derived' && !xColumn) {
    return createPlaceholderOutputFromInput('bar', input, options.title)
  }

  if (!xColumn && !yColumn) {
    return createPlaceholderOutputFromInput('bar', input, options.title)
  }

  if (input.dataPolicy === 'aggregated' && xColumn && yColumn) {
    const categories = xColumn.values.map((value) => String(value))
    const values = yColumn.values.map((value) => (typeof value === 'number' ? value : 0))
    const errors = errorColumn
      ? errorColumn.values.map((value) => (typeof value === 'number' ? value : 0))
      : []

    categories.forEach((category, index) => {
      stats[`${sanitizeKey(category)}_mean`] = values[index] ?? 0
      if (errors.length > index) {
        stats[`${sanitizeKey(category)}_se`] = errors[index] ?? 0
      }
    })
    const summary = summarize(values)
    if (summary) {
      stats.n = summary.n
      stats.value_sum = summary.sum
      stats.value_mean = summary.mean
      stats.value_std = summary.std
      stats.category_count = categories.length
    }

    // Calculate range including error bars
    const rangeValues: number[] = []
    values.forEach((value, index) => {
      const error = errors.length > index ? errors[index] : 0
      if (typeof error === 'number' && error > 0) {
        rangeValues.push(value - error, value + error)
      } else {
        rangeValues.push(value)
      }
    })
    const [yMin, yMax] = calculateBarPlotRange(rangeValues)

    // Position x-axis at y=0 for negative data (scientific correctness)
    const xAxisSide = (yMax <= 0 && yMin < 0) ? 'top' : 'bottom'

    const barWidth = categories.length <= 1 ? 0.3 : undefined
    const palette = options.colorPalette ?? DEFAULT_COLORS

    if (splitTraces && categories.length > 0) {
      const dataTraces: PlotBuilderOutput['data'] = categories.map((category, index) => ({
        type: 'bar',
        x: [category],
        y: [values[index] ?? 0],
        marker: {
          color: getColor(index, palette),
          line: { color: '#000000', width: 1 },
        },
        ...(barWidth ? { width: barWidth } : {}),
        error_y:
          errors.length && typeof errors[index] === 'number'
            ? {
                type: 'data',
                array: [errors[index] ?? 0],
                visible: true,
                color: '#000000',
                thickness: 1.5,
                width: 4,
              }
            : undefined,
        name: category,
        showlegend: true,
      }))

      return {
        data: dataTraces,
        layout: {
          ...createBaseLayout({ title: options.title || 'Bar Chart', showLegend: true }),
          meta: {
            errorBarType,
          },
          xaxis: {
            title: {
              text: xColumn.columnName,
              font: { weight: 700 },
              standoff: 15,
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
              text: yColumn.columnName,
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
          bargap,
          bargroupgap,
        },
        config: createDefaultConfig(),
        stats,
        dataPolicy: input.dataPolicy,
        samplingConfig: input.samplingConfig,
        aggregationConfig: input.aggregationConfig,
      }
    }

    return {
      data: [
        {
          type: 'bar',
          x: categories,
          y: values,
          marker: {
            color: categories.map((_c, i) => getColor(i, palette)),
            line: { color: categories.map(() => '#000000'), width: 1 },
          },
          ...(barWidth ? { width: barWidth } : {}),
          error_y: errors.length
            ? {
                type: 'data',
                array: errors,
                visible: true,
                color: '#000000',
                thickness: 1.5,
                width: 4,
              }
            : undefined,
          name: yColumn.columnName,
        },
      ],
      layout: {
        ...createBaseLayout({ title: options.title || 'Bar Chart', showLegend: false }),
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
          autorange: false,
          linewidth: 4,
          tickfont: { weight: 700 },
          tickwidth: 4,
          ticklen: 6,
          ticklabelshift: 1,
        },
        bargap,
        bargroupgap,
      },
      config: createDefaultConfig(),
      stats,
      dataPolicy: input.dataPolicy,
      samplingConfig: input.samplingConfig,
      aggregationConfig: input.aggregationConfig,
    }
  }

  if (!xColumn && yColumn) {
    const numericValues = yColumn.values.filter((v): v is number => typeof v === 'number')
    const { mean, std, se, n } = calculateMeanSE(numericValues)
    const error = calculateErrorBar(numericValues, errorBarType)
    stats.mean = mean
    stats.std = std
    stats.se = se
    stats.n = n

    // Extract overlay options
    const overlayPoints = options.overlayPoints ?? false
    const pointJitterX = options.pointJitterX ?? 0.05
    const pointSize = options.pointSize ?? 8

    // Calculate range including error bar and overlay points
    const rangeValues = [mean - error, mean + error]
    if (overlayPoints) {
      rangeValues.push(...numericValues)
    }
    const [yMin, yMax] = calculateBarPlotRange(rangeValues)

    // Position x-axis at y=0 for negative data (scientific correctness)
    const xAxisSide = (yMax <= 0 && yMin < 0) ? 'top' : 'bottom'

    const palette = options.colorPalette ?? DEFAULT_COLORS
    const barColor = getColor(0, palette)

    const baseX = 0
    const data: PlotBuilderOutput['data'] = [
      {
        type: 'bar',
        x: [baseX],
        y: [mean],
        marker: {
          color: barColor,
          line: { color: '#000000', width: 1 },
        },
        width: 0.3,
        error_y: {
          type: 'data',
          array: [error],
          visible: true,
          color: '#000000',
          thickness: 1.5,
          width: 4,
        },
        name: yColumn.columnName,
        showlegend: false,
      },
    ]

    // Add overlaid scatter points if enabled
    if (overlayPoints) {
      const xScatter: number[] = []
      const yScatter: number[] = []
      for (let i = 0; i < numericValues.length; i++) {
        // Small random jitter on x-axis for visibility
        const jitter = (Math.random() - 0.5) * pointJitterX * 2
        const value = numericValues[i]
        if (value === undefined) continue
        xScatter.push(baseX + jitter)
        yScatter.push(value)
      }

      data.push({
        type: 'scatter',
        mode: 'markers',
        x: xScatter,
        y: yScatter,
        name: 'Data Points',
        marker: {
          color: barColor,
          size: pointSize,
          opacity: 0.6,
        },
        showlegend: false,
        hovertemplate: `Value: %{y:.3f}<extra></extra>`,
      })
    }

    const xRangeHalf = Math.max(0.5, pointJitterX * 4)
    return {
      data,
      layout: {
        ...createBaseLayout({ title: options.title || 'Bar Plot', showLegend: false }),
        meta: {
          errorBarType,
          overlayPoints,
          pointJitterX,
          pointSize,
        },
        xaxis: {
          tickmode: 'array',
          tickvals: [baseX],
          ticktext: [yColumn.columnName],
          range: [-xRangeHalf, xRangeHalf],
          side: xAxisSide,
        },
        yaxis: {
          title: {
            text: yColumn.columnName,
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

  if (xColumn && !yColumn) {
    const counts = new Map<string, number>()
    xColumn.values.forEach((value) => {
      const key = String(value)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    })

    const categories = Array.from(counts.keys())
    const values = categories.map((c) => counts.get(c) ?? 0)

    categories.forEach((category, index) => {
      stats[`${sanitizeKey(category)}_count`] = values[index] ?? 0
    })
    const summary = summarize(values)
    if (summary) {
      stats.n = values.reduce((acc, v) => acc + v, 0)
      stats.value_sum = summary.sum
      stats.value_mean = summary.mean
      stats.value_std = summary.std
      stats.category_count = categories.length
    }

    // Calculate range for count data
    const [yMin, yMax] = calculateBarPlotRange(values)

    // Position x-axis at y=0 for negative data (scientific correctness)
    const xAxisSide = (yMax <= 0 && yMin < 0) ? 'top' : 'bottom'

    const palette = options.colorPalette ?? DEFAULT_COLORS
    return {
      data: [
        {
          type: 'bar',
          x: categories,
          y: values,
          marker: {
            color: categories.map((_c, i) => getColor(i, palette)),
            line: { color: categories.map(() => '#000000'), width: 1 },
          },
          name: xColumn.columnName,
        },
      ],
      layout: {
        ...createBaseLayout({ title: options.title || 'Bar Plot', showLegend: false }),
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
          tickfont: { weight: 700 },
          tickwidth: 4,
          ticklen: 6,
          ticklabelshift: 1,
        },
        yaxis: {
          title: 'Count',
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

  const xCol = xColumn
  const yCol = yColumn
  if (!xCol || !yCol) {
    return createPlaceholderOutputFromInput('bar', input, options.title)
  }

  // X + Y -> mean + SE
  const grouped: Map<string, number[]> = new Map()
  const xValues = xCol.values
  const yValues = yCol.values
  const len = Math.min(xValues.length, yValues.length)
  const rawValues: number[] = []

  for (let i = 0; i < len; i++) {
    const category = String(xValues[i])
    const value = yValues[i]
    if (typeof value !== 'number') continue
    rawValues.push(value)
    if (!grouped.has(category)) grouped.set(category, [])
    grouped.get(category)!.push(value)
  }

  const categories: string[] = []
  const means: number[] = []
  const errors: number[] = []

  let colorIdx = 0
  for (const [category, values] of grouped) {
    const { mean, std, se, n } = calculateMeanSE(values)
    const error = calculateErrorBar(values, errorBarType)
    categories.push(category)
    means.push(mean)
    errors.push(error)
    stats[`${sanitizeKey(category)}_mean`] = mean
    stats[`${sanitizeKey(category)}_std`] = std
    stats[`${sanitizeKey(category)}_se`] = se
    stats[`${sanitizeKey(category)}_n`] = n
    colorIdx += 1
  }
  const summary = summarize(rawValues)
  if (summary) {
    stats.n = summary.n
    stats.value_sum = summary.sum
    stats.value_mean = summary.mean
    stats.value_std = summary.std
    stats.category_count = categories.length
  }

  // Calculate range including error bars
  const rangeValues: number[] = []
  means.forEach((mean, index) => {
    const error = errors[index] ?? 0
    rangeValues.push(mean - error, mean + error)
  })
  const [yMin, yMax] = calculateBarPlotRange(rangeValues)

  // Position x-axis at y=0 for negative data (scientific correctness)
  const xAxisSide = (yMax <= 0 && yMin < 0) ? 'top' : 'bottom'

  const palette = options.colorPalette ?? DEFAULT_COLORS

  // Build base layout
  let layout: Partial<import('plotly.js').Layout> = {
    ...createBaseLayout({ title: options.title || 'Group Comparison', showLegend: false }),
    meta: {
      errorBarType,
    },
    xaxis: {
      title: {
        text: xCol.columnName,
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
      title: yCol.columnName,
      range: [yMin, yMax],
      autorange: false,
      linewidth: 4,
      tickfont: { weight: 700 },
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
    },
    bargap,  // Gap between category groups (higher = narrower bars)
    bargroupgap,  // Gap within groups (small gap between bars in same category)
  }
  const config = createDefaultConfig()

  // Add significance brackets if provided
  // Note: brackets array must be passed via PlotBuilderInput.options.brackets
  // This is populated by buildBarPlotFromResult when extracting post-hoc data
  const brackets = options.brackets as import('./types').SignificanceBracket[] | undefined
  const bracketSettings = options.bracketSettings
  if (brackets && bracketSettings && brackets.length > 0) {
    const categoryOrder = new Map(categories.map((category, index) => [String(category), index]))
    const stackedBrackets = stackBrackets(brackets, bracketSettings, categoryOrder)
    const adjustedBrackets = repelBracketLayout(stackedBrackets, bracketSettings, yMin, yMax)
    // Use the already-calculated data range for bracket positioning
    const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
    const maxHeight = Math.max(0, ...adjustedBrackets.map((bracket) => bracket.height))
    const bracketTop =
      yMax > 0
        ? yScale * (1 + bracketSettings.offsetY + maxHeight + bracketSettings.heightStep + 0.04)
        : yMax + yScale * (bracketSettings.offsetY + maxHeight + bracketSettings.heightStep + 0.04)
    const bracketPad = yScale * 0.08
    const allowTopPadding = xAxisSide !== 'top'
    // Generate shapes with embedded labels (labels move with brackets when dragged)
    // Pass data range for stable direction determination (prevents flipping when dragging near zero)
    const shapes = createBracketShapes(adjustedBrackets, bracketSettings, yMax, yScale, categoryOrder, { yMin, yMax })
    const baseYAxis = layout.yaxis ?? {}
    const existingRange = Array.isArray(baseYAxis.range) ? baseYAxis.range : null

    // Detect data type for axis locking behavior
    const isNegativeOnly = yMax <= 0 && yMin < 0
    const isPositiveOnly = yMin >= 0 && yMax > 0

    // Lock baseline at zero so bars stay glued; only expand away from zero
    const rangeMinBase = Math.min(yMin, 0)
    const rangeMaxBase = Math.max(yMax, 0)

    // For negative-only data: lock upper bound at 0, expand downward only
    // For positive-only data: lock lower bound at 0, expand upward only
    // For mixed data: allow expansion in both directions
    let rangeMin: number
    let rangeMax: number

    if (isNegativeOnly) {
      // Negative-only data: lock rangeMax at 0, expand rangeMin downward for brackets
      rangeMax = 0
      rangeMin = allowTopPadding
        ? Math.min(rangeMinBase, bracketTop - bracketPad)
        : rangeMinBase
    } else if (isPositiveOnly) {
      // Positive-only data: lock rangeMin at 0, expand rangeMax upward for brackets
      rangeMin = 0
      rangeMax = allowTopPadding
        ? Math.max(rangeMaxBase, bracketTop + bracketPad)
        : rangeMaxBase
    } else {
      // Mixed data: allow expansion in both directions (original behavior)
      rangeMin = typeof existingRange?.[0] === 'number' ? existingRange[0] : rangeMinBase
      rangeMax = typeof existingRange?.[1] === 'number'
        ? allowTopPadding
          ? Math.max(existingRange[1], bracketTop + bracketPad, rangeMaxBase)
          : existingRange[1]
        : allowTopPadding
          ? Math.max(rangeMaxBase, bracketTop + bracketPad)
          : rangeMaxBase
    }

    layout = {
      ...layout,
      yaxis: {
        ...baseYAxis,
        range: [rangeMin, rangeMax],
      },
      shapes: shapes,
    }
    config.displayModeBar = true
    config.modeBarButtonsToAdd = ['eraseshape']
    config.edits = {
      shapePosition: true,
      annotationPosition: true,
    }
  }

  return {
    data: [
      {
        type: 'bar',
        x: categories,
        y: means,
        marker: {
          color: categories.map((_c, i) => getColor(i, palette)),
          line: { color: categories.map(() => '#000000'), width: 1 },
        },
        error_y: {
          type: 'data',
          array: errors,
          visible: true,
          color: '#000000',
          thickness: 1.5,
          width: 4,
        },
        name: yCol.columnName,
      },
    ],
    layout,
    config,
    stats,
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  }
}

export default barPlotBuilder
