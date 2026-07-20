/**
 * Survival Curve Builder (Kaplan-Meier)
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { createBaseLayout, createDefaultConfig, getColor } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

export const survivalBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { testResult, options } = input

  const curves = testResult?.survivalCurves
  if (!curves || curves.length === 0) {
    return createPlaceholderOutputFromInput('survival', input, options.title)
  }

  const data: PlotBuilderOutput['data'] = []
  curves.forEach((curve, idx) => {
    data.push({
      type: 'scatter',
      mode: 'lines',
      x: curve.time,
      y: curve.survival,
      name: curve.group,
      line: { color: getColor(idx), shape: 'hv' },
    })
    stats[`${curve.group}_n`.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = curve.time.length
  })

  return {
    data,
    layout: {
      ...createBaseLayout({ title: options.title || 'Survival Curve', showLegend: true }),
      xaxis: {
        title: {
          text: 'Time',
          font: { weight: 700 },
        },
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        title: {
          text: 'Survival Probability',
          font: { weight: 700 },
        },
        range: [0, 1],
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

export default survivalBuilder
