import type { PlotSpec } from '@/store/plots-store'

export const resolvePlotDisplayTitle = (
  plot: PlotSpec | null | undefined
): string => {
  if (!plot) return ''
  const rawTitle = plot.title ?? ''
  const meta = (plot.plotlyLayout as { meta?: Record<string, unknown> } | undefined)?.meta
  const meansType = typeof meta?.meansType === 'string' ? meta.meansType : null
  if (plot.sourceType === 'test_result' && meansType === 'lsmean') {
    if (!rawTitle || rawTitle.toLowerCase() === 'cell means') {
      return 'Predicted Means (LS Means)'
    }
  }
  return rawTitle
}
