/**
 * Placeholder Plot Builder Output
 *
 * Shared helper for unimplemented plot types.
 */

import type { PlotType } from '@/config/plotRegistry'
import type { SamplingConfig, AggregationConfig } from '@/store/plots-store'
import type { PlotBuilderOutput } from './types'
import { createBaseLayout, createDefaultConfig, DEFAULT_COLORS } from './common'

type PlaceholderPolicy = {
  dataPolicy: 'raw' | 'sampled' | 'aggregated'
  samplingConfig: SamplingConfig | null
  aggregationConfig: AggregationConfig | null
}

export function createPlaceholderOutput(
  plotType: PlotType,
  title?: string,
  message?: string,
  policy?: PlaceholderPolicy
): PlotBuilderOutput {
  return {
    data: [
      {
        type: 'scatter',
        x: [0],
        y: [0],
        mode: 'markers',
        marker: { color: DEFAULT_COLORS[0], size: 20 },
        name: `${plotType} (placeholder)`,
      },
    ],
    layout: {
      ...createBaseLayout({ title: title ?? `${plotType} Plot` }),
      annotations: [
        {
          text: message ?? `${plotType} builder not yet implemented`,
          xref: 'paper',
          yref: 'paper',
          x: 0.5,
          y: 0.5,
          showarrow: false,
          font: { size: 16, color: '#666' },
        },
      ],
    },
    config: createDefaultConfig(),
    stats: {},
    dataPolicy: policy?.dataPolicy ?? 'raw',
    samplingConfig: policy?.samplingConfig ?? null,
    aggregationConfig: policy?.aggregationConfig ?? null,
  }
}

export function createPlaceholderOutputFromInput(
  plotType: PlotType,
  input: PlaceholderPolicy,
  title?: string,
  message?: string
): PlotBuilderOutput {
  return createPlaceholderOutput(plotType, title, message, {
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  })
}
