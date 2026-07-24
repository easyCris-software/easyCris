/**
 * Dose-Response Builder
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { createBaseLayout, createDefaultConfig, getColor } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

export const doseResponseBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { columns, options } = input

  const doseColumn =
    columns.find((c) => c.role === 'dose') ??
    columns.find((c) => c.role === 'x') ??
    columns.find((c) => c.inferredType === 'numeric')
  const responseColumn =
    columns.find((c) => c.role === 'response') ??
    columns.find((c) => c.role === 'y') ??
    columns.find((c) => c.inferredType === 'numeric' && c !== doseColumn)

  if (!doseColumn || !responseColumn) {
    return createPlaceholderOutputFromInput('doseresponse', input, options.title)
  }

  const xValues = doseColumn.values
  const yValues = responseColumn.values
  const len = Math.min(xValues.length, yValues.length)

  const points: Array<{ x: number; y: number }> = []
  for (let i = 0; i < len; i++) {
    const x = xValues[i]
    const y = yValues[i]
    if (typeof x !== 'number' || typeof y !== 'number') continue
    points.push({ x, y })
  }

  points.sort((a, b) => a.x - b.x)

  return {
    data: [
      {
        type: 'scatter',
        mode: 'markers+lines',
        x: points.map((p) => p.x),
        y: points.map((p) => p.y),
        name: responseColumn.columnName,
        marker: { color: getColor(0), size: 6 },
        line: { color: getColor(0) },
      },
    ],
    layout: {
      ...createBaseLayout({ title: options.title || 'Dose-Response', showLegend: false }),
      xaxis: {
        title: {
          text: doseColumn.columnName,
          font: { weight: 700 },
        },
        type: 'log',
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        title: {
          text: responseColumn.columnName,
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

export default doseResponseBuilder
