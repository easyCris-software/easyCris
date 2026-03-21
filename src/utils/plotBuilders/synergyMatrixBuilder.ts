/**
 * Synergy Matrix Builder (heatmap-style table)
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { createBaseLayout, createDefaultConfig } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

export const synergyMatrixBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { columns, options } = input

  const drug1 = columns.find((c) => c.role === 'drug1_conc')
  const drug2 = columns.find((c) => c.role === 'drug2_conc')
  const score = columns.find((c) => c.role === 'synergy_score')

  if (!drug1 || !drug2 || !score) {
    return createPlaceholderOutputFromInput('synergy_matrix', input, options.title)
  }

  const d1 = drug1.values
  const d2 = drug2.values
  const s = score.values
  const len = Math.min(d1.length, d2.length, s.length)

  const d1Levels = Array.from(new Set(d1.map((v) => String(v))))
  const d2Levels = Array.from(new Set(d2.map((v) => String(v))))

  const z: number[][] = d2Levels.map(() => d1Levels.map(() => NaN))

  for (let i = 0; i < len; i++) {
    const xIdx = d1Levels.indexOf(String(d1[i]))
    const yIdx = d2Levels.indexOf(String(d2[i]))
    const val = s[i]
    if (xIdx >= 0 && yIdx >= 0 && typeof val === 'number') {
      z[yIdx]![xIdx] = val
    }
  }

  return {
    data: [
      {
        type: 'heatmap',
        x: d1Levels,
        y: d2Levels,
        z,
        colorscale: 'Viridis',
        colorbar: { title: 'Synergy' },
      },
    ],
    layout: {
      ...createBaseLayout({ title: options.title || 'Synergy Matrix', showLegend: false }),
      xaxis: { title: drug1.columnName },
      yaxis: { title: drug2.columnName },
    },
    config: createDefaultConfig(),
    stats,
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  }
}

export default synergyMatrixBuilder
