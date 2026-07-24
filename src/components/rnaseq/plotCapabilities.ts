import type { Layout } from 'plotly.js'
import type { RNAseqPlotType } from '@/types/rnaseq'

export type AxisPolicy = 'none' | 'labels' | 'full'

export type PlotCapabilities = {
  axis: { x: AxisPolicy; y: AxisPolicy }
  allowErrorBars: boolean
  allowShapes: boolean
  allowDataTab: boolean
  allowBrackets: boolean
}

export const DEFAULT_RNASEQ_PLOT_CAPS: PlotCapabilities = {
  axis: { x: 'full', y: 'full' },
  allowErrorBars: false,
  allowShapes: false,
  allowDataTab: false,
  allowBrackets: false,
}

export const RNASEQ_PLOT_CAPS: Record<RNAseqPlotType, PlotCapabilities> = {
  volcano: {
    axis: { x: 'full', y: 'full' },
    allowErrorBars: false,
    allowShapes: true,
    allowDataTab: true,
    allowBrackets: false,
  },
  ma_plot: {
    axis: { x: 'full', y: 'full' },
    allowErrorBars: false,
    allowShapes: true,
    allowDataTab: true,
    allowBrackets: false,
  },
  pca_biplot: {
    axis: { x: 'full', y: 'full' },
    allowErrorBars: false,
    allowShapes: false,
    allowDataTab: true,
    allowBrackets: false,
  },
  deg_bar: {
    axis: { x: 'labels', y: 'full' },
    allowErrorBars: false,
    allowShapes: false,
    allowDataTab: true,
    allowBrackets: false,
  },
  heatmap: {
    axis: { x: 'none', y: 'none' },
    allowErrorBars: false,
    allowShapes: false,
    allowDataTab: true,
    allowBrackets: false,
  },
}

const FONT_FAMILY = 'Lato, "Source Sans 3", "Liberation Sans", system-ui, sans-serif'

export const applyAxisPolicy = (
  layout: Partial<Layout>,
  caps: PlotCapabilities
): Partial<Layout> => {
  const applyPolicy = (
    axis: Partial<Layout['xaxis']> | Partial<Layout['yaxis']> | undefined,
    policy: AxisPolicy
  ) => {
    const next = { ...(axis ?? {}) }
    if (policy === 'none') {
      next.visible = false
      next.showticklabels = false
      next.showgrid = false
      next.title = undefined
    } else if (policy === 'labels') {
      next.visible = true
      next.showticklabels = true
      next.showgrid = false
      next.title = undefined
    } else {
      next.visible = true
      next.showticklabels = true
      if (next.showgrid === undefined) {
        next.showgrid = true
      }
    }
    return next
  }

  return {
    ...layout,
    xaxis: applyPolicy(layout.xaxis, caps.axis.x),
    yaxis: applyPolicy(layout.yaxis, caps.axis.y),
  }
}

export const applyRNAseqLayoutDefaults = (layout: Partial<Layout>): Partial<Layout> => ({
  ...layout,
  autosize: true,
  dragmode: false,
  paper_bgcolor: 'transparent',
  plot_bgcolor: 'white',
  font: {
    family: FONT_FAMILY,
    size: 12,
    ...(layout.font ?? {}),
  },
  margin: {
    t: 70,
    b: 60,
    l: 60,
    r: 40,
    ...(layout.margin ?? {}),
  },
})
