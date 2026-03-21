import type { PlotType } from '@/config/plotRegistry'
import type { Layout } from 'plotly.js'

const AXIS_LINE_WIDTH = 2
const AXIS_OVERLAY_LINE_WIDTH = 4
const AXIS_TICK_WIDTH = 1
const AXIS_TITLE_STANDOFF_X = 10
const AXIS_TITLE_STANDOFF_Y = 14
const AXIS_TICKLABEL_STANDOFF = 2
const AXIS_TICKLABEL_MID_SHIFT = 0.35
const AXIS_OVERLAY_EXCLUDE_TYPES = new Set<PlotType>([
  'pie',
  'heatmap',
  'mosaic',
  'synergy_matrix',
])

export const shouldIncludeAxisOverlay = (plotType?: PlotType): boolean => {
  if (!plotType) return true
  return !AXIS_OVERLAY_EXCLUDE_TYPES.has(plotType)
}

export function applyAxisDefaultsForExport(
  layout: Partial<Layout>,
  options?: { includeAxisOverlay?: boolean }
): Partial<Layout> {
  const baseLayout = layout ?? {}
  const layoutMeta = (baseLayout.meta ?? {}) as {
    annotationFontFamily?: string
    annotationFontSize?: number
    annotationFontColor?: string
    annotationTextAngle?: number
  }
  const baseXAxis = (baseLayout.xaxis ?? {}) as Partial<Layout['xaxis']>
  const baseYAxis = (baseLayout.yaxis ?? {}) as Partial<Layout['yaxis']>
  const baseFont = (baseLayout.font ?? {}) as Partial<Layout['font']>
  const resolvedFont = {
    ...baseFont,
    weight: baseFont.weight ?? 700,
  }
  const baseYAxisTickFont =
    typeof baseYAxis.tickfont === 'object' && baseYAxis.tickfont
      ? baseYAxis.tickfont
      : {}
  const resolvedYAxisTickFontSize =
    (baseYAxisTickFont as Partial<Layout['font']>).size ??
    baseFont.size ??
    12
  const yTickLabelOutside =
    !(baseYAxis.ticklabelposition ?? '').includes('inside')
  const rawTickLabelShift =
    baseYAxis.ticklabelshift ??
    (yTickLabelOutside
      ? resolvedYAxisTickFontSize * AXIS_TICKLABEL_MID_SHIFT
      : undefined)
  const yTickLabelShift =
    rawTickLabelShift !== undefined && Number.isFinite(rawTickLabelShift)
      ? Math.round(rawTickLabelShift)
      : undefined
  const gridUserSet = Boolean(
    (baseLayout as { meta?: { gridUserSet?: boolean } }).meta?.gridUserSet
  )
  const xAxisTitle =
    typeof baseXAxis.title === 'object'
      ? baseXAxis.title
      : baseXAxis.title
        ? { text: baseXAxis.title }
        : undefined
  const yAxisTitle =
    typeof baseYAxis.title === 'object'
      ? baseYAxis.title
      : baseYAxis.title
        ? { text: baseYAxis.title }
        : undefined
  const baseShapes = Array.isArray(baseLayout.shapes) ? baseLayout.shapes : []
  const axisOverlayShapes: Array<Partial<Layout['shapes'][number]>> = []
  const xAxisSide = baseXAxis.side ?? 'bottom'
  const yAxisSide = baseYAxis.side ?? 'left'
  const xAxisLineY = xAxisSide === 'top' ? 1 : 0
  const yAxisLineX = yAxisSide === 'right' ? 1 : 0
  const showXAxisLine = baseXAxis.showline ?? true
  const showYAxisLine = baseYAxis.showline ?? true
  const shouldOverlayAxes = options?.includeAxisOverlay ?? true

  if (shouldOverlayAxes && showXAxisLine) {
    axisOverlayShapes.push({
      type: 'line',
      xref: 'paper',
      yref: 'paper',
      x0: 0,
      x1: 1,
      y0: xAxisLineY,
      y1: xAxisLineY,
      line: {
        color: baseXAxis.linecolor ?? '#111827',
        width: AXIS_OVERLAY_LINE_WIDTH,
      },
      layer: 'above',
    })
  }

  if (shouldOverlayAxes && showYAxisLine) {
    axisOverlayShapes.push({
      type: 'line',
      xref: 'paper',
      yref: 'paper',
      x0: yAxisLineX,
      x1: yAxisLineX,
      y0: 0,
      y1: 1,
      line: {
        color: baseYAxis.linecolor ?? '#111827',
        width: AXIS_OVERLAY_LINE_WIDTH,
      },
      layer: 'above',
    })
  }

  const shapes =
    baseShapes.length || axisOverlayShapes.length
      ? [...baseShapes, ...axisOverlayShapes]
      : undefined
  const annotationOverrideNames = new Set([
    '_title_',
    '_xaxis_title_',
    '_yaxis_title_',
    '_legend_',
  ])
  const annotationFontOverrides: Partial<Layout['font']> = {}
  if (typeof layoutMeta.annotationFontFamily === 'string' && layoutMeta.annotationFontFamily.trim()) {
    annotationFontOverrides.family = layoutMeta.annotationFontFamily
  }
  if (typeof layoutMeta.annotationFontSize === 'number' && Number.isFinite(layoutMeta.annotationFontSize)) {
    annotationFontOverrides.size = layoutMeta.annotationFontSize
  }
  if (typeof layoutMeta.annotationFontColor === 'string' && layoutMeta.annotationFontColor.trim()) {
    annotationFontOverrides.color = layoutMeta.annotationFontColor
  }
  const annotationTextAngle =
    typeof layoutMeta.annotationTextAngle === 'number' && Number.isFinite(layoutMeta.annotationTextAngle)
      ? layoutMeta.annotationTextAngle
      : undefined
  const baseAnnotations = Array.isArray(baseLayout.annotations) ? baseLayout.annotations : []
  const resolvedAnnotations =
    Object.keys(annotationFontOverrides).length > 0 || annotationTextAngle !== undefined
      ? baseAnnotations.map((annotation) => {
          if (!annotation || typeof annotation !== 'object') return annotation
          const name = (annotation as { name?: string }).name
          if (name && annotationOverrideNames.has(name)) return annotation
          const font = (annotation as { font?: Partial<Layout['font']> }).font ?? {}
          return {
            ...(annotation as Record<string, unknown>),
            font: {
              ...font,
              ...annotationFontOverrides,
            },
            ...(annotationTextAngle !== undefined ? { textangle: annotationTextAngle } : {}),
          } as Layout['annotations'][number]
        })
      : baseAnnotations

  return {
    ...baseLayout,
    font: resolvedFont,
    paper_bgcolor: baseLayout.paper_bgcolor ?? '#ffffff',
    plot_bgcolor: baseLayout.plot_bgcolor ?? '#ffffff',
    ...(resolvedAnnotations.length ? { annotations: resolvedAnnotations } : {}),
    ...(shapes ? { shapes } : {}),
    xaxis: {
      ...baseXAxis,
      showgrid: gridUserSet ? (baseXAxis.showgrid ?? false) : false,
      zeroline: baseXAxis.zeroline ?? false,
      showline: baseXAxis.showline ?? true,
      linecolor: baseXAxis.linecolor ?? '#111827',
      linewidth: baseXAxis.linewidth ?? AXIS_LINE_WIDTH,
      automargin: baseXAxis.automargin ?? true,
      ticklabelposition: baseXAxis.ticklabelposition ?? 'outside',
      ticklabelstandoff: baseXAxis.ticklabelstandoff ?? AXIS_TICKLABEL_STANDOFF,
      ticks: baseXAxis.ticks ?? 'outside',
      ticklen: baseXAxis.ticklen ?? 4,
      tickwidth: baseXAxis.tickwidth ?? AXIS_TICK_WIDTH,
      tickcolor: baseXAxis.tickcolor ?? '#111827',
      ...(xAxisTitle
        ? {
            title: {
              ...xAxisTitle,
              standoff: xAxisTitle.standoff ?? AXIS_TITLE_STANDOFF_X,
            },
          }
        : {}),
    },
    yaxis: {
      ...baseYAxis,
      showgrid: gridUserSet ? (baseYAxis.showgrid ?? false) : false,
      zeroline: baseYAxis.zeroline ?? false,
      showline: baseYAxis.showline ?? true,
      linecolor: baseYAxis.linecolor ?? '#111827',
      linewidth: baseYAxis.linewidth ?? AXIS_LINE_WIDTH,
      automargin: baseYAxis.automargin ?? true,
      ticklabelposition: baseYAxis.ticklabelposition ?? 'outside',
      ticklabelstandoff: baseYAxis.ticklabelstandoff ?? AXIS_TICKLABEL_STANDOFF,
      ...(yTickLabelShift !== undefined ? { ticklabelshift: yTickLabelShift } : {}),
      ticks: baseYAxis.ticks ?? 'outside',
      ticklen: baseYAxis.ticklen ?? 4,
      tickwidth: baseYAxis.tickwidth ?? AXIS_TICK_WIDTH,
      tickcolor: baseYAxis.tickcolor ?? '#111827',
      ...(yAxisTitle
        ? {
            title: {
              ...yAxisTitle,
              standoff: yAxisTitle.standoff ?? AXIS_TITLE_STANDOFF_Y,
            },
          }
        : {}),
    },
  }
}
