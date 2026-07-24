/**
 * Residual Plot Builder
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { createBaseLayout, createDefaultConfig, getColor } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

export const residualBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { columns, options } = input

  const xColumn = columns.find((c) => c.role === 'x') ?? columns.find((c) => c.inferredType === 'numeric')
  const yColumn = columns.find((c) => c.role === 'y') ?? columns.find((c) => c.inferredType === 'numeric' && c !== xColumn)

  if (!xColumn || !yColumn) {
    return createPlaceholderOutputFromInput('residual', input, options.title)
  }

  const xValues = xColumn.values
  const yValues = yColumn.values
  const len = Math.min(xValues.length, yValues.length)

  const x: number[] = []
  const y: number[] = []
  for (let i = 0; i < len; i++) {
    const xi = xValues[i]
    const yi = yValues[i]
    if (typeof xi !== 'number' || typeof yi !== 'number') continue
    x.push(xi)
    y.push(yi)
  }

  return {
    data: [
      {
        type: 'scatter',
        mode: 'markers',
        x,
        y,
        name: 'Residuals',
        marker: { color: getColor(0), size: 8 },
      },
    ],
    layout: {
      ...createBaseLayout({ title: options.title || 'Residual Plot', showLegend: false }),
      xaxis: {
        title: {
          text: xColumn.columnName,
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
        zeroline: false,
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      shapes: [
        {
          type: 'line',
          xref: 'paper',
          x0: 0,
          x1: 1,
          y0: 0,
          y1: 0,
          line: {
            color: '#9ca3af',
            width: 2,
            dash: 'dash',
          },
        },
      ],
    },
    config: createDefaultConfig(),
    stats,
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  }
}

export default residualBuilder
