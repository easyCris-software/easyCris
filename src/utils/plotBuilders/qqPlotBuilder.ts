/**
 * Q-Q Plot Builder
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { calculateMeanSE, createBaseLayout, createDefaultConfig, getColor } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

function normInv(p: number): number {
  // Acklam's approximation for inverse normal CDF
  if (p <= 0 || p >= 1) return NaN

  const a = [
    -39.69683028665376,
    220.9460984245205,
    -275.9285104469687,
    138.3577518672690,
    -30.66479806614716,
    2.506628277459239,
  ] as const
  const b = [
    -54.47609879822406,
    161.5858368580409,
    -155.6989798598866,
    66.80131188771972,
    -13.28068155288572,
  ] as const
  const c = [
    -0.007784894002430293,
    -0.3223964580411365,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ] as const
  const d = [
    0.007784695709041462,
    0.3224671290700398,
    2.445134137142996,
    3.754408661907416,
  ] as const

  const [a0, a1, a2, a3, a4, a5] = a
  const [b0, b1, b2, b3, b4] = b
  const [c0, c1, c2, c3, c4, c5] = c
  const [d0, d1, d2, d3] = d

  const plow = 0.02425
  const phigh = 1 - plow
  let q: number
  let r: number

  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    )
  }

  if (phigh < p) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    )
  }

  q = p - 0.5
  r = q * q
  return (
    (((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  )
}

export const qqPlotBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { columns, options } = input

  const numericColumn =
    columns.find((c) => c.role === 'y') ??
    columns.find((c) => c.inferredType === 'numeric')

  if (!numericColumn) {
    return createPlaceholderOutputFromInput('qq', input, options.title)
  }

  const values = numericColumn.values.filter((v): v is number => typeof v === 'number')
  if (values.length < 2) {
    return createPlaceholderOutputFromInput('qq', input, options.title, 'Not enough data for Q-Q plot')
  }

  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const theoretical: number[] = []
  const sample: number[] = []

  for (let i = 0; i < n; i++) {
    const p = (i + 0.5) / n
    theoretical.push(normInv(p))
    sample.push(sorted[i] ?? 0)
  }

  const { mean, std } = calculateMeanSE(sorted)
  stats.mean = mean
  stats.std = std
  stats.n = n

  // Reference line: y = mean + std * x (theoretical quantile)
  // This is the standard Q-Q line used by R's qqline()
  const xMin = theoretical[0] ?? -2
  const xMax = theoretical[n - 1] ?? 2

  return {
    data: [
      {
        type: 'scatter',
        mode: 'markers',
        x: theoretical,
        y: sample,
        name: 'Observed',
        marker: { color: getColor(0), size: 6 },
      },
      {
        type: 'scatter',
        mode: 'lines',
        x: [xMin, xMax],
        y: [mean + std * xMin, mean + std * xMax],
        name: 'Reference',
        line: { color: '#666', dash: 'dash' },
      },
    ],
    layout: {
      ...createBaseLayout({ title: options.title || 'Q-Q Plot', showLegend: false }),
      xaxis: {
        title: {
          text: 'Theoretical Quantiles',
          font: { weight: 700 },
        },
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        title: {
          text: 'Sample Quantiles',
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

export default qqPlotBuilder
