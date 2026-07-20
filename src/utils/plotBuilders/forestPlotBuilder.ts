/**
 * Forest Plot Builder
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { createBaseLayout, createDefaultConfig } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

export const forestPlotBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { testResult, options } = input

  const coeffs = testResult?.coefficients ?? []
  if (coeffs.length === 0) {
    return createPlaceholderOutputFromInput('forest', input, options.title)
  }

  const labels: string[] = []
  const estimates: number[] = []
  const errPlus: number[] = []
  const errMinus: number[] = []

  coeffs.forEach((coef) => {
    labels.push(coef.name)
    estimates.push(coef.estimate)
    const ci = coef.confidenceInterval
    if (ci && ci.length === 2) {
      errMinus.push(coef.estimate - ci[0])
      errPlus.push(ci[1] - coef.estimate)
    } else if (coef.stdError !== undefined) {
      const margin = 1.96 * coef.stdError
      errMinus.push(margin)
      errPlus.push(margin)
    } else {
      errMinus.push(0)
      errPlus.push(0)
    }
    stats[`${coef.name}_estimate`.toLowerCase().replace(/[^a-z0-9]+/g, '_')] = coef.estimate
  })

  const maxLabelLength = labels.reduce((max, label) => Math.max(max, label.length), 0)
  const leftMargin = Math.min(360, Math.max(100, Math.round(maxLabelLength * 7)))

  const baseLayout = createBaseLayout({ title: options.title || 'Forest Plot', showLegend: false })
  const baseMargin = baseLayout.margin ?? { t: 50, r: 50, b: 50, l: 60 }

  return {
    data: [
      {
        type: 'scatter',
        mode: 'markers',
        x: estimates,
        y: labels,
        marker: { color: '#2b6cb0', size: 8 },
        error_x: {
          type: 'data',
          array: errPlus,
          arrayminus: errMinus,
          visible: true,
          color: '#333',
          thickness: 1.2,
        },
      },
    ],
    layout: {
      ...baseLayout,
      margin: {
        ...baseMargin,
        l: Math.max(baseMargin.l ?? 60, leftMargin),
      },
      xaxis: {
        title: {
          text: 'Estimate',
          font: { weight: 700 },
        },
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        title: {
          text: '',
          font: { weight: 700 },
        },
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
        automargin: true,
      },
    },
    config: createDefaultConfig(),
    stats,
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  }
}

export default forestPlotBuilder
