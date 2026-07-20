/**
 * Pie Chart Builder
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { createBaseLayout, createDefaultConfig, getColor } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

export const pieChartBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { columns, options } = input

  const labelColumn =
    columns.find((c) => c.role === 'color' || c.role === 'x' || c.role === 'group') ??
    columns.find((c) => c.inferredType === 'categorical')
  const valueColumn =
    columns.find((c) => c.role === 'theta' || c.role === 'y') ??
    columns.find((c) => c.inferredType === 'numeric')

  if (!labelColumn) {
    return createPlaceholderOutputFromInput('pie', input, options.title)
  }

  if (input.dataPolicy === 'aggregated' && valueColumn) {
    const labels = labelColumn.values.map((v) => String(v))
    const values = valueColumn.values.map((v) => (typeof v === 'number' ? v : 0))
    labels.forEach((label, idx) => {
      stats[`${label}_value`.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = values[idx] ?? 0
    })
    if (values.length > 0) {
      const total = values.reduce((acc, v) => acc + v, 0)
      stats.n = values.length
      stats.value_sum = total
      stats.value_mean = total / values.length
      stats.category_count = labels.length
      stats.n_slices = labels.length
    }

    return {
      data: [
        {
          type: 'pie',
          labels,
          values,
          marker: {
            colors: labels.map((_l, i) => getColor(i))
          },
          textposition: 'auto',
          textinfo: 'label+percent',  // Show category labels and percentages on slices
          hoverinfo: 'label+percent+value',
          hovertemplate: '<b>%{label}</b><br>Value: %{value}<br>Percent: %{percent}<extra></extra>',
        },
      ],
      layout: {
        ...createBaseLayout({ title: options.title || 'Pie Chart', showLegend: true }),
        showlegend: true,  // Explicitly enable legend
        legend: {
          orientation: 'v',  // Vertical legend
          yanchor: 'middle',
          y: 0.5,
          xanchor: 'left',
          x: 1.05,  // Position legend to the right of the chart
          font: { size: 12, weight: 700 },
        },
      },
      config: createDefaultConfig(),
      stats,
      dataPolicy: input.dataPolicy,
      samplingConfig: input.samplingConfig,
      aggregationConfig: input.aggregationConfig,
    }
  }

  const rawLabels = labelColumn.values.map((v) => String(v))
  const labels: string[] = []
  const values: number[] = []

  if (valueColumn) {
    // Aggregate values by label (sum values for each category)
    const aggregated = new Map<string, number>()
    const rawValues = valueColumn.values
    for (let i = 0; i < rawLabels.length && i < rawValues.length; i++) {
      const label = rawLabels[i] ?? ''
      const val = rawValues[i]
      const numVal = typeof val === 'number' ? val : 0
      aggregated.set(label, (aggregated.get(label) ?? 0) + numVal)
    }
    for (const [label, sum] of aggregated) {
      labels.push(label)
      values.push(sum)
      stats[`${label}_sum`.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = sum
    }
  } else {
    // Count occurrences when no value column
    const counts = new Map<string, number>()
    rawLabels.forEach((label) => counts.set(label, (counts.get(label) ?? 0) + 1))
    for (const [label, count] of counts) {
      labels.push(label)
      values.push(count)
      stats[`${label}_count`.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = count
    }
  }
  if (values.length > 0) {
    const total = values.reduce((acc, v) => acc + v, 0)
    stats.n = values.length
    stats.value_sum = total
    stats.value_mean = total / values.length
    stats.category_count = labels.length
    stats.n_slices = labels.length
  }

  return {
    data: [
      {
        type: 'pie',
        labels,
        values,
        marker: {
          colors: labels.map((_l, i) => getColor(i))
        },
        textposition: 'auto',
        textinfo: 'label+percent',  // Show category labels and percentages on slices
        hoverinfo: 'label+percent+value',
        hovertemplate: '<b>%{label}</b><br>Value: %{value}<br>Percent: %{percent}<extra></extra>',
      },
    ],
    layout: {
      ...createBaseLayout({ title: options.title || 'Pie Chart', showLegend: true }),
      showlegend: true,  // Explicitly enable legend
      legend: {
        orientation: 'v',  // Vertical legend
        yanchor: 'middle',
        y: 0.5,
        xanchor: 'left',
        x: 1.05,  // Position legend to the right of the chart
        font: { size: 12, weight: 700 },
      },
    },
    config: createDefaultConfig(),
    stats,
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  }
}

export default pieChartBuilder
