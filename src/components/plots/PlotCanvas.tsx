/**
 * PlotCanvas Component - Center zone with constrained plot and zoom controls
 *
 * Features:
 * - Custom toolbar (Fullscreen, Download) - Plotly modebar is disabled
 * - Scale slider (20%-240%) with Phosphor icons
 * - White space / centered layout
 * - E2E data attributes preserved (FULL payload)
 * - uirevision for zoom state preservation
 * - ResizeObserver for panel resizes
 * - Fullscreen mode with centered, maximized plot
 * - Inline text editing: Double-click to edit title, axis labels, legend text
 */

import { useMemo, useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { CSSProperties } from 'react'
import {
  ArrowsOut,
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
  ArrowCounterClockwise,
  Image as ImageIcon,
  FileCode,
  FileDoc,
} from '@phosphor-icons/react'
import { Download } from 'lucide-react'

import PlotlyLazy from '@/components/plotly/PlotlyLazy'
import type { Layout, Config, Data } from 'plotly.js'
import type { PlotLayoutMeta } from '@/utils/plotBuilders/types'
import { cn } from '@/lib/utils'
import { usePlotsStore } from '@/store/plots-store'
import { getPlotTemplate } from '@/config/plotRegistry'
import { extractTrendlineStats, stripTrendlineStats } from '@/utils/plotStats'
import { applyAutoBarOutlines, getEffectiveShowLegend } from '@/utils/plotDisplayDefaults'
import {
  SYSTEM_ANNOTATION_NAME_SET,
  getSystemAnnotationTextHints,
  mergeAnnotationsByIdentity,
  normalizeSystemAnnotationIdentity,
  type SystemAnnotationName,
} from '@/lib/plots/annotationPersistence'
import {
  hasExplicitAnnotationClearIntent,
  retainAnnotationsAfterClearIntent,
  shouldApplyFullAnnotationPayload,
} from '@/lib/plots/plotRelayoutPolicy'
import { Button } from '@/components/ui/button'
import { resolvePlotDisplayTitle } from './plotTitle'
import { isLmmEditSignificanceEligible } from './lmmBracketEligibility'
import { Slider } from '@/components/ui/slider'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { usePlotActions } from '@/hooks/usePlotActions'
import {
  getCachedKaleidoCapabilities,
  getKaleidoCapabilities,
  type KaleidoCapabilities,
} from '@/services/plotExportService'

// ============================================================================
// Constants
// ============================================================================

const SCALE_MIN = 0.2
const SCALE_MAX = 2.4
const SCALE_STEP = 0.1
const BASE_WIDTH = 700   // Increased from 700 for more white space
const BASE_HEIGHT = 500  // Increased from 500 for more white space
const PLOT_AREA_PADDING = 24
const PLOT_CONTENT_SCALE = 0.7
const PLOT_CONTENT_DOMAIN: [number, number] = [
  (1 - PLOT_CONTENT_SCALE) / 2,
  1 - (1 - PLOT_CONTENT_SCALE) / 2,
]
const COLORBAR_MARGIN_RIGHT = 240

const AXIS_LINE_WIDTH = 4
const AXIS_TICK_WIDTH = 1
const AXIS_TICKLABEL_STANDOFF = 2
const AXIS_TICKLABEL_MID_SHIFT = 0.35
const SIGNIFICANCE_BRACKET_PREFIX = 'sig_bracket_'
const CUSTOM_MARKUP_PREFIX = 'custom_markup_'
const SHAPE_COORD_EPSILON = 1e-6

type SystemAnnotationPosition = {
  x?: number
  y?: number
  xanchor?: 'left' | 'center' | 'right'
  yanchor?: 'top' | 'middle' | 'bottom'
  textangle?: number
}

type DrawCoordinateMode = 'auto' | 'data' | 'paper'
type AxisAutoSpec = {
  range: [number, number] | null
  domain: [number, number]
  type?: string
}

// Font stack from bundled fonts
const FONT_FAMILY = 'Lato, "Source Sans 3", "Liberation Sans", system-ui, sans-serif'

const toDataAttributeKey = (key: string): string | null => {
  const normalized = key
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized ? `data-${normalized}` : null
}

// ============================================================================
// Types
// ============================================================================

export interface PlotCanvasProps {
  /** Current scale factor (0.2 - 2.4) */
  scale: number
  /** Callback when scale changes */
  onScaleChange: (scale: number) => void
  /** CSS class name */
  className?: string
}

// ============================================================================
// Component
// ============================================================================

export function PlotCanvas({ scale, onScaleChange, className }: PlotCanvasProps) {
  // Store state
  const { activePlot, activePlotStats, updatePlot } = usePlotsStore(
    useShallow((state) => {
      const currentPlot = state.getActivePlot()
      return {
        activePlot: currentPlot,
        activePlotStats: currentPlot ? state.getPlotStats(currentPlot.id) : undefined,
        updatePlot: state.updatePlot,
      }
    })
  )
  const plotAreaRef = useRef<HTMLDivElement | null>(null)
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 })
  const [drawModePromptVisible, setDrawModePromptVisible] = useState(false)
  const [kaleidoCapabilities, setKaleidoCapabilities] = useState<KaleidoCapabilities | null>(
    () => getCachedKaleidoCapabilities()
  )

  const plot = activePlot
  const displayTitle = useMemo(() => resolvePlotDisplayTitle(plot), [plot])
  const renderedData = useMemo<Data[]>(() => {
    const baseData = Array.isArray(plot?.plotlyData) ? (plot!.plotlyData as Data[]) : []
    return applyAutoBarOutlines(baseData).data
  }, [plot?.plotlyData])
  const renderedAnnotationsRef = useRef<Array<Partial<Layout['annotations']>>>([])
  const graphDivPlotIdRef = useRef<string | null>(null)
  const previousPlotIdRef = useRef<string | null>(null)
  const legendAnnotationIndexRef = useRef<number | null>(null)
  const trendlineStatsIndexRef = useRef<number | null>(null)
  const ic50LabelIndexRef = useRef<number | null>(null)
  const lastEditedBracketRef = useRef<string | null>(null)
  const lastEditedBracketIndexRef = useRef<number | null>(null)
  const lastEditedCustomShapeRef = useRef<string | null>(null)
  const lastEditedCustomShapeIndexRef = useRef<number | null>(null)
  const graphDivRef = useRef<HTMLElement | null>(null)
  // I2: snapshot of current plot's layout shapes, kept in sync by a dedicated useEffect.
  // Cursor event handlers read from this ref so they never call getActivePlot() at event-time,
  // avoiding transition windows where the store's active plot has already switched.
  const plotShapesRef = useRef<unknown[]>([])

  const computedStats = useMemo(() => {
    const baseStats = activePlotStats ?? {}
    const trimmed = stripTrendlineStats(baseStats)
    const trendlineStats = extractTrendlineStats(plot?.plotlyData as Data[] | undefined)
    return { ...trimmed, ...trendlineStats }
  }, [activePlotStats, plot?.plotlyData])

  useEffect(() => {
    let cancelled = false
    void getKaleidoCapabilities()
      .then((capabilities) => {
        if (!cancelled) {
          setKaleidoCapabilities(capabilities)
        }
      })
      .catch(() => {
        // Capability probe failures are handled in the export layer.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refreshKaleidoCapabilities = useCallback(() => {
    void getKaleidoCapabilities(true, true)
      .then((capabilities) => {
        setKaleidoCapabilities(capabilities)
      })
      .catch(() => {
        // Keep previous capability state when probe fails.
      })
  }, [])

  const tiffExportUnavailableReason =
    kaleidoCapabilities && !kaleidoCapabilities.tiff.supported
      ? kaleidoCapabilities.tiff.reason ?? 'TIFF export unavailable'
      : null
  const pdfExportUnavailableReason =
    kaleidoCapabilities && !kaleidoCapabilities.pdf.supported
      ? kaleidoCapabilities.pdf.reason ?? 'PDF export unavailable'
      : null

  const getNextEditRevisionToken = (meta: PlotLayoutMeta): number => {
    const current =
      typeof meta.editRevisionToken === 'number' && Number.isFinite(meta.editRevisionToken)
        ? meta.editRevisionToken
        : 0
    return current + 1
  }

  const normalizeCoordinateMode = (meta: PlotLayoutMeta): DrawCoordinateMode => {
    const mode = meta.shapeCoordinateMode
    return mode === 'data' || mode === 'paper' || mode === 'auto' ? mode : 'paper'
  }

  const parseDomain = (
    axis: Partial<Layout['xaxis']> | Partial<Layout['yaxis']> | undefined,
    fallback: [number, number]
  ): [number, number] => {
    const domain = Array.isArray(axis?.domain) ? axis?.domain : null
    if (!domain || domain.length < 2) return fallback
    const start = Number(domain[0])
    const end = Number(domain[1])
    if (!Number.isFinite(start) || !Number.isFinite(end)) return fallback
    return [start, end]
  }

  const parseRange = (
    axis: Partial<Layout['xaxis']> | Partial<Layout['yaxis']> | undefined
  ): [number, number] | null => {
    const range = Array.isArray(axis?.range) ? axis?.range : null
    if (!range || range.length < 2) return null
    const start = Number(range[0])
    const end = Number(range[1])
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
    return [start, end]
  }

  const resolveAxisSpecs = (layout: Partial<Layout>): { x: AxisAutoSpec; y: AxisAutoSpec } => {
    const liveLayout = (graphDivRef.current as { layout?: Partial<Layout> } | null)?.layout ?? {}
    const sourceXAxis = {
      ...((layout.xaxis ?? {}) as Partial<Layout['xaxis']>),
      ...((liveLayout.xaxis ?? {}) as Partial<Layout['xaxis']>),
    }
    const sourceYAxis = {
      ...((layout.yaxis ?? {}) as Partial<Layout['yaxis']>),
      ...((liveLayout.yaxis ?? {}) as Partial<Layout['yaxis']>),
    }
    const xDomain = parseDomain(sourceXAxis, PLOT_CONTENT_DOMAIN)
    const yDomain = parseDomain(sourceYAxis, PLOT_CONTENT_DOMAIN)
    return {
      x: {
        range: parseRange(sourceXAxis),
        domain: xDomain,
        type: sourceXAxis.type,
      },
      y: {
        range: parseRange(sourceYAxis),
        domain: yDomain,
        type: sourceYAxis.type,
      },
    }
  }

  const convertAxisValueForAuto = (
    value: unknown,
    fromRef: 'paper' | 'data',
    toRef: 'paper' | 'data',
    spec: AxisAutoSpec
  ): unknown => {
    if (fromRef === toRef) return value
    const numeric = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(numeric)) return value
    const [domainStart, domainEnd] = spec.domain
    const domainSpan = domainEnd - domainStart
    if (!Number.isFinite(domainSpan) || Math.abs(domainSpan) < 1e-12) return value

    const range = spec.range
    if (!range) return value
    const [rangeStart, rangeEnd] = range
    const rangeSpan = rangeEnd - rangeStart
    if (!Number.isFinite(rangeSpan) || Math.abs(rangeSpan) < 1e-12) return value

    if (toRef === 'paper') {
      if (spec.type === 'log') {
        if (numeric <= 0) return value
        const logValue = Math.log10(numeric)
        const fraction = (logValue - rangeStart) / rangeSpan
        return domainStart + domainSpan * fraction
      }
      const fraction = (numeric - rangeStart) / rangeSpan
      return domainStart + domainSpan * fraction
    }

    const fraction = (numeric - domainStart) / domainSpan
    if (spec.type === 'log') {
      const logValue = rangeStart + rangeSpan * fraction
      return Math.pow(10, logValue)
    }
    return rangeStart + rangeSpan * fraction
  }

  const axisOutsidePaperDomain = (values: unknown[], domain: [number, number]): boolean => {
    const [d0, d1] = domain
    const min = Math.min(d0, d1)
    const max = Math.max(d0, d1)
    return values.some((value) => {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(numeric)) return false
      return numeric < min - SHAPE_COORD_EPSILON || numeric > max + SHAPE_COORD_EPSILON
    })
  }

  const axisOutsideDataRange = (
    values: unknown[],
    range: [number, number] | null,
    axisType?: string
  ): boolean => {
    // Category/date axes do not support stable numeric comparisons in this path.
    // In Auto mode we treat them as out-of-range and switch that axis to paper.
    if (axisType === 'category' || axisType === 'date') return true
    if (!range) return false
    const min = Math.min(range[0], range[1])
    const max = Math.max(range[0], range[1])
    return values.some((value) => {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(numeric)) return false
      let comparable = numeric
      if (axisType === 'log') {
        if (numeric <= 0) return true
        comparable = Math.log10(numeric)
      }
      return comparable < min - SHAPE_COORD_EPSILON || comparable > max + SHAPE_COORD_EPSILON
    })
  }

  const isCustomMarkupShape = (shape: Record<string, unknown> | undefined): boolean => {
    if (!shape) return false
    const name = typeof shape.name === 'string' ? shape.name : ''
    if (name.startsWith(CUSTOM_MARKUP_PREFIX)) return true
    const meta = shape.meta
    return (
      typeof meta === 'object' &&
      meta !== null &&
      (meta as { customMarkup?: boolean }).customMarkup === true
    )
  }

  const applyCoordinateModeToShape = (
    shape: Record<string, unknown>,
    mode: DrawCoordinateMode,
    specs: { x: AxisAutoSpec; y: AxisAutoSpec }
  ): Record<string, unknown> => {
    if ((shape.type as string | undefined) === 'path') {
      if (mode === 'data') return { ...shape, xref: 'x', yref: 'y' }
      if (mode === 'paper') return { ...shape, xref: 'paper', yref: 'paper' }
      return shape
    }
    const x0 = shape.x0
    const x1 = shape.x1
    const y0 = shape.y0
    const y1 = shape.y1
    const currentXref = shape.xref === 'paper' ? 'paper' : 'data'
    const currentYref = shape.yref === 'paper' ? 'paper' : 'data'
    let targetXref: 'paper' | 'data' = currentXref
    let targetYref: 'paper' | 'data' = currentYref

    if (mode === 'data') {
      targetXref = 'data'
      targetYref = 'data'
    } else if (mode === 'paper') {
      targetXref = 'paper'
      targetYref = 'paper'
    } else {
      if (!specs.x.range && !specs.y.range) {
        // Explicit Auto fallback when axis ranges are not available yet.
        // Keep deterministic behavior rather than silently inheriting stale refs.
        targetXref = 'data'
        targetYref = 'data'
      } else {
        const xValues = [x0, x1]
        const yValues = [y0, y1]
        const xOutside =
          currentXref === 'paper'
            ? axisOutsidePaperDomain(xValues, specs.x.domain)
            : axisOutsideDataRange(xValues, specs.x.range, specs.x.type)
        const yOutside =
          currentYref === 'paper'
            ? axisOutsidePaperDomain(yValues, specs.y.domain)
            : axisOutsideDataRange(yValues, specs.y.range, specs.y.type)
        targetXref = xOutside ? 'paper' : 'data'
        targetYref = yOutside ? 'paper' : 'data'
      }
    }

    let nextShape = shape
    if (targetXref !== currentXref) {
      nextShape = {
        ...nextShape,
        x0: convertAxisValueForAuto(x0, currentXref, targetXref, specs.x),
        x1: convertAxisValueForAuto(x1, currentXref, targetXref, specs.x),
      }
    }
    if (targetYref !== currentYref) {
      nextShape = {
        ...nextShape,
        y0: convertAxisValueForAuto(y0, currentYref, targetYref, specs.y),
        y1: convertAxisValueForAuto(y1, currentYref, targetYref, specs.y),
      }
    }

    return {
      ...nextShape,
      xref: targetXref === 'paper' ? 'paper' : 'x',
      yref: targetYref === 'paper' ? 'paper' : 'y',
    }
  }

  const deriveSystemAnnotationPositions = (
    currentMeta: PlotLayoutMeta,
    annotations: Array<Record<string, unknown>>
  ): PlotLayoutMeta => {
    const currentPositions =
      typeof currentMeta.systemAnnotationPositions === 'object' &&
      currentMeta.systemAnnotationPositions !== null
        ? (currentMeta.systemAnnotationPositions as Partial<
            Record<SystemAnnotationName, Record<string, unknown>>
          >)
        : {}
    const positionKeys: Array<keyof SystemAnnotationPosition> = [
      'x',
      'y',
      'xanchor',
      'yanchor',
      'textangle',
    ]
    let changed = false
    const nextPositions: Partial<Record<SystemAnnotationName, Record<string, unknown>>> = {
      ...currentPositions,
    }

    ;(['_title_', '_xaxis_title_', '_yaxis_title_', '_legend_'] as SystemAnnotationName[]).forEach(
      (systemName) => {
        const annotation = annotations.find((entry) => entry?.name === systemName)
        if (!annotation) return
        const existingPosition =
          typeof nextPositions[systemName] === 'object' && nextPositions[systemName] !== null
            ? (nextPositions[systemName] as Record<string, unknown>)
            : {}
        const nextPosition = { ...existingPosition }

        positionKeys.forEach((key) => {
          const value = annotation[key]
          if (value === undefined) return
          if (nextPosition[key] === value) return
          nextPosition[key] = value
          changed = true
        })

        if (Object.keys(nextPosition).length > 0) {
          nextPositions[systemName] = nextPosition
        }
      }
    )

    if (!changed) return currentMeta
    return {
      ...currentMeta,
      systemAnnotationPositions: nextPositions,
    }
  }

  const persistLiveAnnotationSnapshot = useCallback(
    (targetPlotId: string, reason: 'switch' | 'unmount') => {
      const graphDiv = graphDivRef.current as { layout?: Partial<Layout> } | null
      if (!graphDiv) return
      if (graphDivPlotIdRef.current !== targetPlotId) return
      const liveAnnotations = graphDiv.layout?.annotations
      if (!Array.isArray(liveAnnotations) || liveAnnotations.length === 0) return

      const storeState = usePlotsStore.getState()
      const targetPlot = storeState.getPlot(targetPlotId)
      if (!targetPlot) return

      const currentLayout = (targetPlot.plotlyLayout as Partial<Layout>) ?? {}
      const currentAnnotations = Array.isArray(currentLayout.annotations) ? currentLayout.annotations : []
      const systemAnnotationHints = getSystemAnnotationTextHints(
        currentLayout,
        resolvePlotDisplayTitle(targetPlot) || targetPlot.title || ''
      )
      const mergedAnnotations = mergeAnnotationsByIdentity({
        current: currentAnnotations as unknown[],
        incoming: liveAnnotations as unknown[],
        rendered: renderedAnnotationsRef.current as unknown[],
      })
      const normalizedAnnotations = normalizeSystemAnnotationIdentity(
        mergedAnnotations,
        systemAnnotationHints
      ).annotations
      const currentMeta = ((currentLayout.meta ?? {}) as PlotLayoutMeta) ?? {}
      const nextMeta = deriveSystemAnnotationPositions(
        {
          ...currentMeta,
          editRevisionToken: getNextEditRevisionToken(currentMeta),
        },
        normalizedAnnotations as Array<Record<string, unknown>>
      )

      if (import.meta.env.DEV) {
        const debugRelayout =
          typeof window !== 'undefined' &&
          (window as unknown as { __EASYCRIS_DEBUG_RELAYOUT__?: boolean })
            .__EASYCRIS_DEBUG_RELAYOUT__ === true
        if (debugRelayout) {
          console.debug('[PlotCanvas] persisted live annotations snapshot', {
            reason,
            plotId: targetPlotId,
            annotationCount: normalizedAnnotations.length,
          })
        }
      }

      updatePlot(targetPlotId, {
        plotlyLayout: {
          ...currentLayout,
          annotations: normalizedAnnotations as unknown as Layout['annotations'],
          meta: nextMeta,
        },
      })
    },
    [updatePlot]
  )

  useEffect(() => {
    if (!plot || plot.sourceType !== 'test_result') return
    if (!displayTitle || displayTitle === plot.title) return
    const rawTitle = (plot.title ?? '').toLowerCase()
    if (rawTitle && rawTitle !== 'cell means') return
    const currentLayout = (plot.plotlyLayout as Partial<Layout>) ?? {}
    const baseTitle = typeof currentLayout.title === 'object' ? currentLayout.title : {}
    updatePlot(plot.id, {
      title: displayTitle,
      plotlyLayout: {
        ...currentLayout,
        title: {
          ...baseTitle,
          text: displayTitle,
        },
      },
    })
  }, [displayTitle, plot, updatePlot])

  // Lightweight plot-level stats for E2E plot validation (keeps data-plot-stats useful)
  const computedPlotStats = useMemo(() => {
    const stats: Record<string, number> = {}
    const traces = Array.isArray(plot?.plotlyData) ? (plot!.plotlyData as Data[]) : []

    const meta = (plot?.plotlyLayout as { meta?: Record<string, unknown> } | undefined)?.meta ?? {}
    const metaStats =
      meta && typeof meta === 'object' && 'stats' in meta && typeof meta.stats === 'object'
        ? (meta.stats as Record<string, unknown>)
        : null
    const bracketCatalog =
      meta && typeof meta === 'object' && 'bracketCatalog' in meta
        ? (meta.bracketCatalog as { seriesLevels?: unknown; xLevels?: unknown })
        : null

    const finiteY: number[] = []
    const errorValues: number[] = []
    const perTraceFiniteCounts: number[] = []
    traces.forEach((trace) => {
      const y = Array.isArray(trace.y) ? trace.y : []
      let traceFiniteCount = 0
      y.forEach((val: unknown) => {
        const num = typeof val === 'number' ? val : Number(val)
        if (Number.isFinite(num)) {
          finiteY.push(num)
          traceFiniteCount += 1
        }
      })
      const errArray =
        trace.error_y && typeof trace.error_y === 'object'
          ? (trace.error_y as { array?: unknown[] }).array
          : undefined
      if (Array.isArray(errArray)) {
        errArray.forEach((val: unknown) => {
          const num = typeof val === 'number' ? val : Number(val)
          if (Number.isFinite(num)) errorValues.push(num)
        })
      }
      perTraceFiniteCounts.push(traceFiniteCount)
    })

    const nTraces = traces.length
    const nPointsPerTraceRaw =
      perTraceFiniteCounts.length > 0 ? Math.max(...perTraceFiniteCounts) : 0
    const totalPoints = finiteY.length
    if (nTraces > 0) stats.n_traces = nTraces
    if (totalPoints > 0) stats.total_points = totalPoints

    // Facet-aware hints (used by multifactorial plots)
    if (metaStats && typeof metaStats === 'object') {
      if (typeof metaStats.facet_count === 'number') {
        stats.n_facets = metaStats.facet_count
      }
    }

    const getNumber = (key: string): number | undefined => {
      const value = metaStats?.[key]
      return typeof value === 'number' && Number.isFinite(value) ? (value as number) : undefined
    }

    // Apply builder-provided stats first (align with validation baselines)
    const metaCounts = [
      ['n_facets', 'n_facets'],
      ['n_traces', 'n_traces'],
      ['n_traces_per_facet', 'n_traces_per_facet'],
      ['n_points_per_trace', 'n_points_per_trace'],
      ['total_points', 'total_points'],
    ] as const
    metaCounts.forEach(([key, target]) => {
      const val = getNumber(key)
      if (val !== undefined) (stats as any)[target] = val
    })

    const metaMeans = [
      ['overall_mean', 'overall_mean'],
      ['mean_se', 'mean_se'],
      ['min_mean', 'min_mean'],
      ['max_mean', 'max_mean'],
    ] as const
    metaMeans.forEach(([key, target]) => {
      const val = getNumber(key)
      if (val !== undefined) (stats as any)[target] = val
    })

    if (metaStats && typeof metaStats === 'object') {
      Object.entries(metaStats).forEach(([key, value]) => {
        if (typeof value === 'number' && Number.isFinite(value) && !(key in stats)) {
          stats[key] = value
        }
      })
    }

    if (plot?.testType === 'scheirer_ray_hare') {
      const metaMedians = [
        ['overall_median', 'overall_median'],
        ['min_median', 'min_median'],
        ['max_median', 'max_median'],
        ['mean_iqr', 'mean_iqr'],
      ] as const
      metaMedians.forEach(([key, target]) => {
        const val = getNumber(key)
        if (val !== undefined) (stats as any)[target] = val
      })
    }

    // If we know facets, derive counts per facet to align with validation baselines
    // Prefer bracketCatalog counts (builder metadata) for plot metrics
    const seriesLevels =
      bracketCatalog && Array.isArray(bracketCatalog.seriesLevels)
        ? (bracketCatalog.seriesLevels as unknown[]).length
        : null
    const xLevels =
      bracketCatalog && Array.isArray(bracketCatalog.xLevels)
        ? (bracketCatalog.xLevels as unknown[]).length
        : null

    if (!stats.n_traces_per_facet && seriesLevels && seriesLevels > 0) {
      stats.n_traces_per_facet = seriesLevels
    }
    if (!stats.n_traces && stats.n_traces_per_facet) {
      stats.n_traces = stats.n_traces_per_facet * (stats.n_facets ?? 1)
    }

    if (!stats.n_points_per_trace) {
      if (xLevels && xLevels > 0) {
        stats.n_points_per_trace = xLevels
      } else if (stats.n_facets && stats.n_facets > 0 && nPointsPerTraceRaw > 0) {
        // Flattened faceted bars: divide by facet count
        stats.n_points_per_trace = Math.max(1, Math.round(nPointsPerTraceRaw / stats.n_facets))
      } else if (nPointsPerTraceRaw > 0) {
        stats.n_points_per_trace = nPointsPerTraceRaw
      }
    }

    if (
      (!stats.total_points || stats.total_points <= 0) &&
      stats.n_facets &&
      stats.n_facets > 0 &&
      stats.n_traces_per_facet &&
      stats.n_points_per_trace
    ) {
      stats.total_points = stats.n_facets * stats.n_traces_per_facet * stats.n_points_per_trace
    }

    // Fallback computations when meta is absent or partial
    if (!stats.overall_mean && finiteY.length > 0) {
      const mean = finiteY.reduce((s, v) => s + v, 0) / finiteY.length
      stats.overall_mean = mean
      stats.min_mean = Math.min(...finiteY)
      stats.max_mean = Math.max(...finiteY)
    }

    if (!stats.mean_se && errorValues.length > 0 && plot?.testType !== 'scheirer_ray_hare') {
      const meanError = errorValues.reduce((s, v) => s + v, 0) / errorValues.length
      stats.mean_se = meanError
    }

    if (plot?.testType === 'scheirer_ray_hare') {
      if (!stats.min_median && finiteY.length > 0) {
        stats.min_median = Math.min(...finiteY)
        stats.max_median = Math.max(...finiteY)
      }

      if (!stats.overall_median && finiteY.length > 0) {
        const sorted = [...finiteY].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        stats.overall_median =
          sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
      }

      if (!stats.mean_iqr && errorValues.length > 0) {
        // Our bar error uses IQR/2; double it to match validation baseline
        const meanError = errorValues.reduce((s, v) => s + v, 0) / errorValues.length
        stats.mean_iqr = meanError * 2
      }

      const errorBarType = typeof meta.errorBarType === 'string' ? meta.errorBarType : null
      Object.keys(stats).forEach((key) => {
        if (key.endsWith('_mean')) {
          const medianKey = key.replace(/_mean$/, '_median')
          if (!(medianKey in stats)) {
            stats[medianKey] = stats[key]!
          }
        }

        if (errorBarType === 'iqr' && key.endsWith('_se')) {
          const iqrKey = key.replace(/_se$/, '_iqr')
          if (!(iqrKey in stats)) {
            stats[iqrKey] = stats[key]! * 2
          }
        }
      })
    }

    const missingRocStats =
      !('roc_points' in stats) ||
      !('auc' in stats) ||
      !('fpr_min' in stats) ||
      !('fpr_max' in stats) ||
      !('tpr_min' in stats) ||
      !('tpr_max' in stats)
    if (missingRocStats) {
      const rocTrace = traces.find((trace) => {
        const name = typeof trace.name === 'string' ? trace.name.toLowerCase() : ''
        return name.includes('roc') && !name.includes('random')
      })
      const xRaw = Array.isArray(rocTrace?.x) ? rocTrace?.x : []
      const yRaw = Array.isArray(rocTrace?.y) ? rocTrace?.y : []
      const pairs = xRaw
        .map((x: unknown, idx: number) => ({
          x: typeof x === 'number' ? x : Number(x),
          y: typeof yRaw[idx] === 'number' ? yRaw[idx] : Number(yRaw[idx]),
        }))
        .filter((pair: { x: number; y: number }) => Number.isFinite(pair.x) && Number.isFinite(pair.y))

      if (pairs.length > 0) {
        const sorted = [...pairs].sort((a, b) => a.x - b.x)
        const xVals = sorted.map((pair) => pair.x)
        const yVals = sorted.map((pair) => pair.y)
        if (!('roc_points' in stats)) stats.roc_points = sorted.length
        if (!('fpr_min' in stats)) stats.fpr_min = Math.min(...xVals)
        if (!('fpr_max' in stats)) stats.fpr_max = Math.max(...xVals)
        if (!('tpr_min' in stats)) stats.tpr_min = Math.min(...yVals)
        if (!('tpr_max' in stats)) stats.tpr_max = Math.max(...yVals)
        if (!('auc' in stats) && sorted.length > 1) {
          let auc = 0
          for (let i = 1; i < sorted.length; i += 1) {
            const dx = sorted[i]!.x - sorted[i - 1]!.x
            const avgY = (sorted[i]!.y + sorted[i - 1]!.y) / 2
            auc += dx * avgY
          }
          if (Number.isFinite(auc)) stats.auc = auc
        }
      }
    }

    return stats
  }, [plot?.plotlyData, plot?.plotlyLayout, plot?.testType])

  const template = plot ? getPlotTemplate(plot.type) : undefined

  // Computed dimensions based on scale
  const scaledWidth = Math.round(BASE_WIDTH * scale)
  const scaledHeight = Math.round(BASE_HEIGHT * scale)
  const fitScale =
    availableSize.width > 0 && availableSize.height > 0
      ? Math.min(1, availableSize.width / scaledWidth, availableSize.height / scaledHeight)
      : 1
  const canvasWidth = scale <= 1 ? Math.round(scaledWidth * fitScale) : scaledWidth
  const canvasHeight = scale <= 1 ? Math.round(scaledHeight * fitScale) : scaledHeight

  // Shared action handlers
  const {
    plotContainerRef,
    handleFullscreen,
    handleExport,
  } = usePlotActions(plot, canvasWidth, canvasHeight)

  const resolveBracketEffectId = (shapeName: string, meta: PlotLayoutMeta): string | null => {
    const effectShapes = meta.bracketEffectShapes ?? {}
    for (const [effectId, shapeNames] of Object.entries(effectShapes)) {
      if (shapeNames.includes(shapeName)) {
        return effectId
      }
    }
    return null
  }

  useEffect(() => {
    const plotArea = plotAreaRef.current
    if (!plotArea) return

    const updateSize = () => {
      const rect = plotArea.getBoundingClientRect()
      const width = Math.max(0, rect.width - PLOT_AREA_PADDING * 2)
      const height = Math.max(0, rect.height - PLOT_AREA_PADDING * 2)
      setAvailableSize({ width, height })
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(plotArea)
    return () => observer.disconnect()
  }, [])

  const stripPlotlyHtml = (value: string) =>
    value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()

  const containerStyle = useMemo(() => {
    const baseLayout = (plot?.plotlyLayout as Partial<Layout>) ?? {}
    const baseFont = (baseLayout.font ?? {}) as Partial<Layout['font']>
    const baseXAxis = (baseLayout.xaxis ?? {}) as Partial<Layout['xaxis']>
    const baseYAxis = (baseLayout.yaxis ?? {}) as Partial<Layout['yaxis']>
    const baseLegend = (baseLayout.legend ?? {}) as Partial<Layout['legend']>
    const defaultWeight = baseFont.weight ?? 700
    const xTickWeight =
      (typeof baseXAxis.tickfont === 'object' && baseXAxis.tickfont
        ? (baseXAxis.tickfont as Partial<Layout['font']>).weight
        : undefined) ?? defaultWeight
    const yTickWeight =
      (typeof baseYAxis.tickfont === 'object' && baseYAxis.tickfont
        ? (baseYAxis.tickfont as Partial<Layout['font']>).weight
        : undefined) ?? defaultWeight
    const legendWeight =
      (typeof baseLegend.font === 'object' && baseLegend.font
        ? (baseLegend.font as Partial<Layout['font']>).weight
        : undefined) ?? defaultWeight

    return {
      width: canvasWidth,
      height: canvasHeight,
      maxWidth: '100%',
      maxHeight: '100%',
      ['--plotly-modebar-offset' as any]: displayTitle || plot?.title ? '6px' : '4px',
      ['--plotly-font-weight' as any]: String(defaultWeight),
      ['--plotly-x-tick-weight' as any]: String(xTickWeight),
      ['--plotly-y-tick-weight' as any]: String(yTickWeight),
      ['--plotly-legend-weight' as any]: String(legendWeight),
      ['--plotly-annotation-weight' as any]: String(defaultWeight),
    } as CSSProperties
  }, [canvasHeight, canvasWidth, displayTitle, plot?.plotlyLayout, plot?.title])

  // Layout with all critical settings. The visible canvas uses a stable layout so it is not contaminated by
  // the user's current zoom/window size.
  const buildPlotLayout = useCallback((
    canvasWidth: number,
    canvasHeight: number,
    options: { ignoreStoredSystemAnnotationPositions?: boolean; minimumYAxisTitleX?: number } = {}
  ): Partial<Layout> => {
    if (!plot) return {}
    const plotWidth = Math.max(1, Math.round(canvasWidth * PLOT_CONTENT_SCALE))
    const plotHeight = Math.max(1, Math.round(canvasHeight * PLOT_CONTENT_SCALE))
    const isCompact = plotWidth < 720 || plotHeight < 420
    const baseLayout = (plot.plotlyLayout as Partial<Layout>) ?? {}
    const layoutMeta = (baseLayout.meta ?? {}) as PlotLayoutMeta
    const allowShapeDrawing = Boolean(layoutMeta.activeShapeTool)
    const axisRevisionToken =
      typeof layoutMeta.axisRevisionToken === 'number' && Number.isFinite(layoutMeta.axisRevisionToken)
        ? layoutMeta.axisRevisionToken
        : 0
    const editRevisionToken =
      typeof layoutMeta.editRevisionToken === 'number' && Number.isFinite(layoutMeta.editRevisionToken)
        ? layoutMeta.editRevisionToken
        : 0
    const baseXAxis = (baseLayout.xaxis ?? {}) as Partial<Layout['xaxis']>
    const baseYAxis = (baseLayout.yaxis ?? {}) as Partial<Layout['yaxis']>
    const baseFont = (baseLayout.font ?? {}) as Partial<Layout['font']>
    const baseTitle = typeof baseLayout.title === 'object' ? baseLayout.title : {}
    const baseTitleFont = (baseTitle.font ?? {}) as Partial<Layout['title']['font']>
    const baseLegend = (baseLayout.legend ?? {}) as Partial<Layout['legend']>
    const baseAnnotations = Array.isArray(baseLayout.annotations)
      ? baseLayout.annotations
      : []
    const baseData = renderedData
    const hasColorbar = baseData.some((trace) => {
      if (!trace || typeof trace !== 'object') return false
      const colorbar = (trace as { colorbar?: unknown }).colorbar
      return typeof colorbar === 'object' && colorbar !== null
    })
    const resolvedFont = {
      family: baseFont.family ?? FONT_FAMILY,
      size: baseFont.size ?? 12,
      color: baseFont.color ?? '#374151',
      weight: baseFont.weight ?? 700,
    }
    const resolvedTitleFont = {
      size: baseTitleFont.size ?? Math.round(resolvedFont.size * 1.2),
      family: baseTitleFont.family ?? resolvedFont.family,
      color: baseTitleFont.color ?? resolvedFont.color,
      weight: baseTitleFont.weight ?? resolvedFont.weight,
    }
    const baseXAxisTitleFont =
      typeof baseXAxis.title === 'object' && baseXAxis.title?.font
        ? baseXAxis.title.font
        : {}
    const baseYAxisTitleFont =
      typeof baseYAxis.title === 'object' && baseYAxis.title?.font
        ? baseYAxis.title.font
        : {}
    const resolvedXAxisTitleFont = {
      size: baseXAxisTitleFont.size ?? resolvedFont.size,
      family: baseXAxisTitleFont.family ?? resolvedFont.family,
      color: baseXAxisTitleFont.color ?? resolvedFont.color,
      weight: baseXAxisTitleFont.weight ?? resolvedFont.weight,
    }
    const resolvedYAxisTitleFont = {
      size: baseYAxisTitleFont.size ?? resolvedFont.size,
      family: baseYAxisTitleFont.family ?? resolvedFont.family,
      color: baseYAxisTitleFont.color ?? resolvedFont.color,
      weight: baseYAxisTitleFont.weight ?? resolvedFont.weight,
    }
    const baseXAxisTickFont =
      typeof baseXAxis.tickfont === 'object' && baseXAxis.tickfont
        ? baseXAxis.tickfont
        : {}
    const baseYAxisTickFont =
      typeof baseYAxis.tickfont === 'object' && baseYAxis.tickfont
        ? baseYAxis.tickfont
        : {}
    const resolvedXAxisTickFont = {
      ...(baseXAxisTickFont as Partial<Layout['font']>),
      size: (baseXAxisTickFont as Partial<Layout['font']>).size ?? Math.max(9, Math.round(resolvedFont.size * 0.9)),
      family: (baseXAxisTickFont as Partial<Layout['font']>).family ?? resolvedFont.family,
      color: (baseXAxisTickFont as Partial<Layout['font']>).color ?? resolvedFont.color,
      weight: (baseXAxisTickFont as Partial<Layout['font']>).weight ?? resolvedFont.weight,
    }
    const resolvedYAxisTickFont = {
      ...(baseYAxisTickFont as Partial<Layout['font']>),
      size: (baseYAxisTickFont as Partial<Layout['font']>).size ?? Math.max(9, Math.round(resolvedFont.size * 0.9)),
      family: (baseYAxisTickFont as Partial<Layout['font']>).family ?? resolvedFont.family,
      color: (baseYAxisTickFont as Partial<Layout['font']>).color ?? resolvedFont.color,
      weight: (baseYAxisTickFont as Partial<Layout['font']>).weight ?? resolvedFont.weight,
    }
    const yTickLabelOutside =
      !(baseYAxis.ticklabelposition ?? '').includes('inside')
    const rawTickLabelShift =
      baseYAxis.ticklabelshift ??
      (yTickLabelOutside
        ? (resolvedYAxisTickFont.size ?? 12) * AXIS_TICKLABEL_MID_SHIFT
        : undefined)
    const yTickLabelShift =
      rawTickLabelShift !== undefined && Number.isFinite(rawTickLabelShift)
        ? Math.round(rawTickLabelShift)
        : undefined
    const baseLegendFont = (baseLegend.font ?? {}) as Partial<Layout['font']>
    const legendScale = Math.min(
      1,
      Math.max(0.75, Math.min(canvasWidth / BASE_WIDTH, canvasHeight / BASE_HEIGHT))
    )
    const resolvedLegendFont = {
      size:
        baseLegendFont.size ??
        Math.max(9, Math.round(resolvedFont.size * 0.9 * legendScale)),
      family: baseLegendFont.family ?? resolvedFont.family,
      color: baseLegendFont.color ?? resolvedFont.color,
      weight: (baseLegendFont as Partial<Layout['font']>).weight ?? resolvedFont.weight,
    }
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
    const titlePadTop = plot.title ? (isCompact ? 22 : 10) : 0
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
    const gridUserSet = Boolean(
      (baseLayout as { meta?: { gridUserSet?: boolean } }).meta?.gridUserSet
    )
    const legendDecision = getEffectiveShowLegend(baseLayout, baseData)
    const showLegend = legendDecision.showLegend
    const legendX =
      typeof baseLegend.x === 'number' ? baseLegend.x : 1.02
    const legendY =
      typeof baseLegend.y === 'number' ? baseLegend.y : 1
    const legendYAnchor = baseLegend.yanchor ?? 'top'
    const legendOrientation = baseLegend.orientation ?? 'v'
    const shouldPadLegend =
      showLegend &&
      legendOrientation === 'v' &&
      legendYAnchor === 'top' &&
      legendY >= 0.99 &&
      legendX >= 0.99
    const adjustedLegend = shouldPadLegend
      ? { ...baseLegend, y: isCompact ? 0.9 : 0.96 }
      : baseLegend
    const supportsTrendlineStats =
      baseData.length > 0 &&
      ['scatter', 'scattergl'].includes((baseData[0] as any)?.type ?? 'scatter') &&
      String((baseData[0] as any)?.mode ?? '').includes('markers')
    const trendlineTrace = baseData.find((trace) => {
      const t = trace as any
      if (t?.meta?.trendline === true) return true
      if (typeof t?.name !== 'string') return false
      return t.name === 'Trendline' || t.name.startsWith('Trendline ')
    }) as any
    const trendlineMeta = trendlineTrace?.meta as
      | { equation?: string; r_squared?: number }
      | undefined
    const trendlineTextParts: string[] = []
    if (supportsTrendlineStats && trendlineMeta?.equation) {
      // Format polynomial powers with superscripts (x^2 â†’ x<sup>2</sup>, x^3 â†’ x<sup>3</sup>, etc.)
      const formattedEquation = String(trendlineMeta.equation).replace(
        /\^(\d+)/g,
        '<sup>$1</sup>'
      )
      trendlineTextParts.push(formattedEquation)
    }
    if (
      supportsTrendlineStats &&
      typeof trendlineMeta?.r_squared === 'number' &&
      Number.isFinite(trendlineMeta.r_squared)
    ) {
      // Use proper superscript for RÂ²
      trendlineTextParts.push(`R<sup>2</sup> = ${trendlineMeta.r_squared.toFixed(4)}`)
    }
    const baseShapes = Array.isArray(baseLayout.shapes) ? baseLayout.shapes : []
    const labeledBracketNames = new Set(
      baseShapes
        .filter((shape) => {
          if (typeof shape !== 'object' || shape === null) return false
          const entry = shape as { name?: unknown; label?: { text?: string } }
          return (
            typeof entry.name === 'string' &&
            entry.name.startsWith(SIGNIFICANCE_BRACKET_PREFIX) &&
            typeof entry.label?.text === 'string' &&
            entry.label.text.length > 0
          )
        })
        .map((shape) => (shape as { name?: string }).name!)
    )
    const hasSignificanceBrackets = baseShapes.some((shape) => {
      if (typeof shape !== 'object' || shape === null) return false
      const entry = shape as { name?: unknown }
      return typeof entry.name === 'string' && entry.name.startsWith(SIGNIFICANCE_BRACKET_PREFIX)
    })

    const systemAnnotationHints = getSystemAnnotationTextHints(baseLayout, displayTitle || plot.title || '')
    const normalizedAnnotationsResult = normalizeSystemAnnotationIdentity(
      baseAnnotations,
      systemAnnotationHints
    )
    const normalizedBaseAnnotations = normalizedAnnotationsResult.annotations
    const systemAnnotationPositions =
      typeof layoutMeta.systemAnnotationPositions === 'object' &&
      layoutMeta.systemAnnotationPositions !== null
        ? (layoutMeta.systemAnnotationPositions as Partial<
            Record<SystemAnnotationName, SystemAnnotationPosition>
          >)
        : {}

    // Filter out auto-generated annotations (we'll recreate them)
    const annotations = normalizedBaseAnnotations.filter((annotation) => {
      if (typeof annotation !== 'object' || annotation === null) return true
      const name = (annotation as { name?: string }).name
      if (labeledBracketNames.size > 0 && name && labeledBracketNames.has(name)) {
        return false
      }
      return !['trendline_stats', '_title_', '_xaxis_title_', '_yaxis_title_', '_legend_'].includes(name ?? '')
    })

    // Add trendline stats annotation
    if (trendlineTextParts.length > 0) {
      annotations.push({
        name: 'trendline_stats',
        text: trendlineTextParts.join('<br>'),
        xref: 'paper',
        yref: 'paper',
        x: 0.99,
        y: 0.02,
        xanchor: 'right',
        yanchor: 'bottom',
        align: 'right',
        showarrow: false,
        bgcolor: 'rgba(255, 255, 255, 0.75)',
        bordercolor: '#000000',
        borderpad: 4,
        borderwidth: 1,
        font: {
          size: Math.max(9, Math.round(resolvedFont.size * 0.9)),
          color: '#374151',
          weight: resolvedFont.weight,
        },
        editable: false,
      })
    }

    // =========================================================================
    // ANNOTATION-BASED TITLES (draggable text boxes)
    // These replace native titles for display but metadata is preserved
    // =========================================================================

    // Get stored annotation positions (if user has dragged them before)
    const useStoredSystemAnnotationPositions = !options.ignoreStoredSystemAnnotationPositions
    const storedTitleAnnotation = useStoredSystemAnnotationPositions
      ? normalizedBaseAnnotations.find(
          (a) => typeof a === 'object' && (a as { name?: string }).name === '_title_'
        ) as SystemAnnotationPosition | undefined
      : undefined
    const storedXAxisAnnotation = useStoredSystemAnnotationPositions
      ? normalizedBaseAnnotations.find(
          (a) => typeof a === 'object' && (a as { name?: string }).name === '_xaxis_title_'
        ) as SystemAnnotationPosition | undefined
      : undefined
    const storedYAxisAnnotation = useStoredSystemAnnotationPositions
      ? normalizedBaseAnnotations.find(
          (a) => typeof a === 'object' && (a as { name?: string }).name === '_yaxis_title_'
        ) as SystemAnnotationPosition | undefined
      : undefined
    const titlePosition = storedTitleAnnotation ?? (useStoredSystemAnnotationPositions ? systemAnnotationPositions._title_ : undefined)
    const xAxisTitlePosition = storedXAxisAnnotation ?? (useStoredSystemAnnotationPositions ? systemAnnotationPositions._xaxis_title_ : undefined)
    const yAxisTitlePosition = storedYAxisAnnotation ?? (useStoredSystemAnnotationPositions ? systemAnnotationPositions._yaxis_title_ : undefined)

    const escapeHtml = (value: string) =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

    // Build legend lines early so we can size the right margin
    const patternLegendSymbols: Record<string, string> = {
      '/': '&#9639;',
      '\\': '&#9640;',
      'x': '&#9641;',
      '-': '&#9636;',
      '|': '&#9637;',
      '+': '&#9638;',
      '.': '&#9635;',
    }
    const patternLegendSymbolFontFamily = "'Noto Sans Symbols2', Inter, sans-serif"
    const defaultLegendColors = [
      '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
      '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
    ]
    const legendLines: string[] = []
    const lineLegendSymbols: Record<string, string> = {
      solid: '&#8212;&#8212;&#8212;',
      dash: '&#45;&#45;&#45;',
      dot: '&#183;&#183;&#183;',
      dashdot: '&#8212;&#183;&#8212;',
    }
    const isNearWhite = (value: string): boolean => {
      const normalized = value.trim().toLowerCase()
      if (normalized === 'white') return true
      if (normalized.startsWith('#')) {
        const hex = normalized.slice(1)
        const expanded =
          hex.length === 3
            ? hex.split('').map((ch) => ch + ch).join('')
            : hex.length === 6
              ? hex
              : hex.length === 8
                ? hex.slice(0, 6)
                : ''
        if (expanded.length === 6) {
          const r = parseInt(expanded.slice(0, 2), 16)
          const g = parseInt(expanded.slice(2, 4), 16)
          const b = parseInt(expanded.slice(4, 6), 16)
          return [r, g, b].every((channel) => channel >= 250)
        }
      }
      if (normalized.startsWith('rgb')) {
        const matches = normalized.match(/\d+(\.\d+)?/g) ?? []
        const r = Number(matches[0])
        const g = Number(matches[1])
        const b = Number(matches[2])
        if ([r, g, b].every((channel) => Number.isFinite(channel))) {
          return [r, g, b].every((channel) => channel >= 250)
        }
      }
      return false
    }
    const buildLegendLine = (
      legendLinesArr: string[],
      symbolHtml: string,
      symbolColor: string,
      name: string,
      symbolKind: 'square' | 'circle' | 'line' = 'circle',
      symbolFontFamily?: string
    ) => {
      let resolvedSymbol = symbolHtml
      let resolvedColor = symbolColor
      if (isNearWhite(symbolColor)) {
        resolvedColor = '#000000'
        if (symbolKind === 'square') {
          resolvedSymbol = '&#9633;'
        } else if (symbolKind === 'circle') {
          resolvedSymbol = '&#9675;'
        }
      }
      const symbolFontStyle = symbolFontFamily ? `font-family:${symbolFontFamily};` : ''
      legendLinesArr.push(
        `<span style="${symbolFontStyle}color:${escapeHtml(resolvedColor)}">${resolvedSymbol}</span> ${name}`
      )
    }
    if (showLegend) {
      baseData.forEach((trace, index) => {
        const t = trace as Record<string, unknown>
        if (t.showlegend === false) return
        const meta = t.meta as Record<string, unknown> | undefined
        if (meta?.trendline === true) return

        const nameRaw = typeof t.name === 'string' ? t.name : `Trace ${index + 1}`
        const name = escapeHtml(nameRaw)
        let color = defaultLegendColors[index % defaultLegendColors.length] ?? '#1f77b4'

        const marker = typeof t.marker === 'object' && t.marker !== null ? (t.marker as Record<string, unknown>) : undefined
        let patternSymbol: string | undefined
        let patternSymbolColor: string | undefined
        let lineDash: string | undefined
        const isLineTrace =
          (t.type as string) === 'scatter' &&
          typeof t.mode === 'string' &&
          t.mode.includes('lines')
        const line = typeof t.line === 'object' && t.line !== null
          ? (t.line as Record<string, unknown>)
          : undefined
        if (line && typeof line.dash === 'string') {
          lineDash = line.dash
        }

        if (marker) {
          if (typeof marker.color === 'string') {
            color = marker.color
          } else if (Array.isArray(marker.color) && typeof marker.color[0] === 'string') {
            color = marker.color[0]
          } else if (Array.isArray(marker.colors) && typeof marker.colors[0] === 'string') {
            color = marker.colors[0]
          }

          if (typeof marker.pattern === 'object' && marker.pattern !== null) {
            const pattern = marker.pattern as Record<string, unknown>
            const shape =
              typeof pattern.shape === 'string'
                ? pattern.shape
                : Array.isArray(pattern.shape) && typeof pattern.shape[0] === 'string'
                  ? pattern.shape[0]
                  : undefined
            if (shape && shape !== 'solid' && shape !== '') {
              patternSymbol = patternLegendSymbols[shape] ?? '&#9632;'
              const patternBg =
                typeof pattern.bgcolor === 'string'
                  ? pattern.bgcolor
                  : Array.isArray(pattern.bgcolor) && typeof pattern.bgcolor[0] === 'string'
                    ? pattern.bgcolor[0]
                    : undefined
              const patternFg =
                typeof pattern.fgcolor === 'string'
                  ? pattern.fgcolor
                  : Array.isArray(pattern.fgcolor) && typeof pattern.fgcolor[0] === 'string'
                    ? pattern.fgcolor[0]
                    : undefined
              if (patternBg && !isNearWhite(patternBg)) {
                patternSymbolColor = patternBg
              } else if (patternFg) {
                patternSymbolColor = patternFg
              } else if (patternBg) {
                patternSymbolColor = patternBg
              }
            }
          }
        }
        if (line && typeof line.color === 'string' && isLineTrace) {
          color = line.color
        } else if (line && Array.isArray(line.color) && typeof line.color[0] === 'string' && isLineTrace) {
          color = line.color[0]
        }

        if ((t.type as string) === 'pie') {
          const labels = Array.isArray(t.labels) ? t.labels : []
          const markerColors = marker && Array.isArray(marker.colors)
            ? (marker.colors as string[])
            : []
          const sliceCount = Math.max(labels.length, markerColors.length, 1)
          for (let sliceIdx = 0; sliceIdx < sliceCount; sliceIdx += 1) {
            const rawLabel = labels[sliceIdx] ?? ''
            const sliceName = escapeHtml(String(rawLabel || `Slice ${sliceIdx + 1}`))
            const sliceColor =
              markerColors[sliceIdx] ??
              (typeof marker?.color === 'string' ? marker.color : color)
            buildLegendLine(legendLines, '&#9679;', sliceColor ?? color, sliceName, 'circle')
          }
          return
        }

        if ((t.type as string) === 'bar' && marker && Array.isArray(marker.color) && Array.isArray(t.x)) {
          const barTraceCount = baseData.filter((traceItem) => (traceItem as any).type === 'bar').length
          const barColors = marker.color as string[]
          const barLabels = t.x as Array<string | number>
          if (barTraceCount === 1 && barColors.length === barLabels.length) {
            barLabels.forEach((label, labelIndex) => {
              const barLabel = escapeHtml(String(label ?? `Category ${labelIndex + 1}`))
              const barColor = barColors[labelIndex] ?? color
              buildLegendLine(legendLines, '&#9632;', barColor, barLabel, 'square')
            })
            return
          }
        }

        const lineSymbol = isLineTrace
          ? (lineLegendSymbols[lineDash ?? 'solid'] ?? lineLegendSymbols.solid)
          : undefined
        const isBarTrace = (t.type as string) === 'bar'
        const legendSymbol = lineSymbol ?? patternSymbol ?? (isBarTrace ? '&#9632;' : '&#9679;')
        const legendSymbolColor = patternSymbol
          ? (
            patternSymbolColor && !isNearWhite(patternSymbolColor)
              ? patternSymbolColor
              : !isNearWhite(color)
                ? color
                : '#000000'
          )
          : color
        const legendSymbolKind = lineSymbol
          ? 'line'
          : patternSymbol || (t.type as string) === 'bar'
            ? 'square'
            : 'circle'
        buildLegendLine(
          legendLines,
          legendSymbol,
          legendSymbolColor,
          name,
          legendSymbolKind,
          patternSymbol ? patternLegendSymbolFontFamily : undefined
        )
      })
    }

    const legendMaxChars = legendLines.reduce(
      (max, line) => Math.max(max, line.replace(/<[^>]*>/g, '').length),
      0
    )
    const legendCharWidth = Math.max(5, Math.round((resolvedLegendFont.size ?? 11) * 0.58))
    const legendPadding = Math.max(18, Math.round(legendCharWidth * 2.2))
    const legendMaxWidth = Math.max(140, Math.round(canvasWidth * 0.45))
    const legendMinWidth = Math.min(120, Math.round(canvasWidth * 0.25))
    const computedLegendWidth =
      legendLines.length > 0
        ? Math.min(
            legendMaxWidth,
            Math.max(legendMinWidth, legendMaxChars * legendCharWidth + legendPadding)
          )
        : 0
    const legendAnnotationWidth = computedLegendWidth
    const bracketTopPadding = hasSignificanceBrackets ? 40 : 0

    const baseMargin = {
      l: 80, // Extra space for Y-axis title annotation
      r: 40, // Base space for legend gutter
      t: plot.title ? (isCompact ? 80 : 60) : 40,
      b: 70, // Extra space for X-axis title annotation
      ...(baseLayout.margin ?? {}),
    }
    const marginRightBase = typeof baseMargin.r === 'number' ? baseMargin.r : 0
    const marginRight = Math.max(
      marginRightBase,
      legendAnnotationWidth,
      hasColorbar ? COLORBAR_MARGIN_RIGHT : 0
    )
    const marginTopBase = typeof baseMargin.t === 'number' ? baseMargin.t : 0
    const marginTop = marginTopBase + bracketTopPadding
    const plotAreaTop = PLOT_CONTENT_DOMAIN[1]
    const plotAreaBottom = PLOT_CONTENT_DOMAIN[0]
    const plotAreaLeft = PLOT_CONTENT_DOMAIN[0]
    const plotAreaRight = PLOT_CONTENT_DOMAIN[1]
    const titleOffset = isCompact ? 0.025 : 0.02
    const axisOffset = isCompact ? 0.055 : 0.045
    const titleYref =
      typeof baseTitle.yref === 'string' && baseTitle.yref ? baseTitle.yref : 'container'
    const titleAutomargin = baseTitle.automargin ?? false
    const rawTitleY =
      typeof baseTitle.y === 'number' && Number.isFinite(baseTitle.y) ? baseTitle.y : undefined
    const clamp01 = (value: number) => Math.min(1, Math.max(0, value))
    let resolvedTitleY = plotAreaTop + titleOffset
    if (rawTitleY !== undefined) {
      resolvedTitleY =
        titleAutomargin && titleYref === 'paper'
          ? rawTitleY === 0
            ? 0
            : 1
          : clamp01(rawTitleY)
    }
    const xAxisTitleStandoff =
      typeof xAxisTitle?.standoff === 'number' && Number.isFinite(xAxisTitle.standoff)
        ? xAxisTitle.standoff
        : 0
    const yAxisTitleStandoff =
      typeof yAxisTitle?.standoff === 'number' && Number.isFinite(yAxisTitle.standoff)
        ? yAxisTitle.standoff
        : 0
    const xAxisStandoffOffset = plotHeight > 0 ? xAxisTitleStandoff / plotHeight : 0
    const yAxisStandoffOffset = plotWidth > 0 ? yAxisTitleStandoff / plotWidth : 0
    const extraTitleLift =
      plot?.testType === 'multifactorial_anova'
        ? (isCompact ? 0.04 : 0.06)
        : 0
    const defaultTitleY = resolvedTitleY + extraTitleLift
    const defaultTitleYAnchor =
      typeof baseTitle.yanchor === 'string' && baseTitle.yanchor !== 'auto'
        ? baseTitle.yanchor
        : titleAutomargin && titleYref === 'paper'
          ? resolvedTitleY === 0
            ? 'top'
            : 'bottom'
          : 'bottom'
    const defaultXAxisY = plotAreaBottom - axisOffset - xAxisStandoffOffset
    const defaultYAxisX = Math.max(
      plotAreaLeft - axisOffset - yAxisStandoffOffset,
      options.minimumYAxisTitleX ?? Number.NEGATIVE_INFINITY
    )
    const hasGrid = Boolean((baseLayout as { grid?: unknown }).grid)
    const margin = {
      ...baseMargin,
      r: marginRight,
      t: marginTop,
      autoexpand: hasSignificanceBrackets || legendAnnotationWidth > 0,
    }

    // Main title annotation (top center, draggable)
    const cleanPlotTitle = stripPlotlyHtml(displayTitle || plot.title || '')
    if (cleanPlotTitle) {
      annotations.push({
        name: '_title_',
        text: cleanPlotTitle,
        xref: 'paper',
        yref: 'paper',
        x: titlePosition?.x ?? 0.5,
        y: titlePosition?.y ?? defaultTitleY,
        xanchor: (titlePosition?.xanchor as 'left' | 'center' | 'right') ?? 'center',
        yanchor:
          (titlePosition?.yanchor as 'top' | 'middle' | 'bottom') ??
          (defaultTitleYAnchor as 'top' | 'middle' | 'bottom'),
        showarrow: false,
        ax: 0,
        ay: 0,
        font: resolvedTitleFont,
        bgcolor: 'rgba(255,255,255,0)',
        borderpad: 4,
      })
    }

    // X-axis title annotation (bottom center, draggable)
    const xAxisTitleText = stripPlotlyHtml(String(xAxisTitle?.text ?? ''))
    if (xAxisTitleText) {
      annotations.push({
        name: '_xaxis_title_',
        text: xAxisTitleText,
        xref: 'paper',
        yref: 'paper',
        x: xAxisTitlePosition?.x ?? 0.5,
        y: xAxisTitlePosition?.y ?? defaultXAxisY,
        xanchor: (xAxisTitlePosition?.xanchor as 'left' | 'center' | 'right') ?? 'center',
        yanchor: (xAxisTitlePosition?.yanchor as 'top' | 'middle' | 'bottom') ?? 'top',
        showarrow: false,
        ax: 0,
        ay: 0,
        font: resolvedXAxisTitleFont,
        bgcolor: 'rgba(255,255,255,0)',
        borderpad: 4,
      })
    }

    // Y-axis title annotation (left center, rotated, draggable)
    const yAxisTitleText = stripPlotlyHtml(String(yAxisTitle?.text ?? ''))
    if (yAxisTitleText) {
      annotations.push({
        name: '_yaxis_title_',
        text: yAxisTitleText,
        xref: 'paper',
        yref: 'paper',
        x: yAxisTitlePosition?.x ?? defaultYAxisX,
        y: yAxisTitlePosition?.y ?? 0.5,
        xanchor: (yAxisTitlePosition?.xanchor as 'left' | 'center' | 'right') ?? 'right',
        yanchor: (yAxisTitlePosition?.yanchor as 'top' | 'middle' | 'bottom') ?? 'middle',
        textangle: yAxisTitlePosition?.textangle ?? -90,
        showarrow: false,
        ax: 0,
        ay: 0,
        font: resolvedYAxisTitleFont,
        bgcolor: 'rgba(255,255,255,0)',
        borderpad: 4,
      })
    }

    // =========================================================================
    // ANNOTATION-BASED LEGEND (draggable, exportable)
    // =========================================================================
    const storedLegendAnnotation = useStoredSystemAnnotationPositions
      ? normalizedBaseAnnotations.find(
          (a) => typeof a === 'object' && (a as { name?: string }).name === '_legend_'
        ) as SystemAnnotationPosition | undefined
      : undefined
    const legendPosition = storedLegendAnnotation ?? (useStoredSystemAnnotationPositions ? systemAnnotationPositions._legend_ : undefined)
    // Add legend annotation if there are items and legend is enabled
    if (showLegend && legendLines.length > 0) {
      annotations.push({
        name: '_legend_',
        text: legendLines.join('<br>'),
        xref: 'paper',
        yref: 'paper',
        x: legendPosition?.x ?? plotAreaRight + 0.01,
        y: legendPosition?.y ?? plotAreaTop,
        xanchor: (legendPosition?.xanchor as 'left' | 'center' | 'right') ?? 'left',
        yanchor: (legendPosition?.yanchor as 'top' | 'middle' | 'bottom') ?? 'top',
        showarrow: false,
        ax: 0,
        ay: 0,
        font: resolvedLegendFont,
        bgcolor: 'rgba(255, 255, 255, 0.9)',
        bordercolor: '#d1d5db',
        borderpad: 6,
        borderwidth: 1,
        align: 'left',
        ...(legendAnnotationWidth ? { width: legendAnnotationWidth } : {}),
        editable: false,
      })
    }

    const annotationOverrideNames = new Set([
      '_title_',
      '_xaxis_title_',
      '_yaxis_title_',
      '_legend_',
    ])
    const hasAnnotationOverrides =
      Object.keys(annotationFontOverrides).length > 0 || annotationTextAngle !== undefined
    const resolvedAnnotations = hasAnnotationOverrides
      ? annotations.map((annotation) => {
          if (typeof annotation !== 'object' || annotation === null) return annotation
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
      : annotations

    const shapes = baseShapes.length ? baseShapes : undefined

    const boxViolinTraces = baseData.filter((trace) => {
      const t = trace as { type?: string }
      return t.type === 'box' || t.type === 'violin'
    }) as Array<{ type?: string; x?: unknown[]; y?: unknown[]; name?: unknown; orientation?: string }>
    const usesHorizontalBoxViolin = boxViolinTraces.some((trace) => trace.orientation === 'h')
    const boxViolinCategories = new Set<string>()
    boxViolinTraces.forEach((trace) => {
      const axisValues = usesHorizontalBoxViolin ? trace.y : trace.x
      if (Array.isArray(axisValues) && axisValues.length > 0) {
        axisValues.forEach((value) => {
          if (value !== null && value !== undefined && value !== '') {
            boxViolinCategories.add(String(value))
          }
        })
      } else if (typeof trace.name === 'string' && trace.name.trim()) {
        boxViolinCategories.add(trace.name)
      }
    })
    const singleBoxViolinCategory =
      boxViolinTraces.length > 0 && Math.max(1, boxViolinCategories.size) === 1
    const shouldFixBoxViolinAxis =
      singleBoxViolinCategory &&
      (usesHorizontalBoxViolin
        ? !(Array.isArray(baseYAxis.range) && baseYAxis.range.length === 2) && baseYAxis.autorange !== false
        : !(Array.isArray(baseXAxis.range) && baseXAxis.range.length === 2) && baseXAxis.autorange !== false)
    const boxViolinAxisRange = shouldFixBoxViolinAxis ? [-0.5, 0.5] : undefined

    return {
      ...baseLayout,
      ...(shapes ? { shapes } : {}),
      width: canvasWidth,
      height: canvasHeight,
      autosize: false,
      // CRITICAL: Preserve zoom state across re-renders
      uirevision: `${plot.id}:${axisRevisionToken}`,
      // Preserve editable annotation state on Plotly-managed edits.
      editrevision: `${plot.id}:${editRevisionToken}`,
      margin,
      // SUPPRESS native title - using annotation instead
      title: {
        ...baseTitle,
        text: '', // Hidden - annotation displays the title
        font: resolvedTitleFont,
        pad: {
          ...(typeof baseTitle.pad === 'object' ? baseTitle.pad : {}),
          t: titlePadTop,
        },
      },
      font: resolvedFont,
      // Hide native Plotly legend - using annotation-based legend instead
      showlegend: false,
      legend: adjustedLegend,
      annotations: resolvedAnnotations,
      // White backgrounds for proper export
      paper_bgcolor: 'white',
      plot_bgcolor: 'white',
      // Respect hovermode from layout (e.g. 'x unified' for trajectory, false in edit mode).
      // Fall back to 'x unified' when no value is set (most plot types).
      hovermode: baseLayout.hovermode ?? 'x unified',
      xaxis: {
        ...baseXAxis,
        ...(baseXAxis.domain || hasGrid ? {} : { domain: PLOT_CONTENT_DOMAIN }),
        ...(shouldFixBoxViolinAxis && !usesHorizontalBoxViolin
          ? { range: boxViolinAxisRange, autorange: false }
          : {}),
        // Manuscript-style defaults: axes on, grid off
        showgrid: gridUserSet ? (baseXAxis.showgrid ?? false) : false,
        zeroline: baseXAxis.zeroline ?? false,
        showline: baseXAxis.showline ?? true,
        linecolor: baseXAxis.linecolor ?? '#111827',
        linewidth: Math.max(Number(baseXAxis.linewidth) || 0, AXIS_LINE_WIDTH),
        automargin: baseXAxis.automargin ?? true,
        fixedrange: allowShapeDrawing ? false : baseXAxis.fixedrange ?? true,
        ticklabelposition: baseXAxis.ticklabelposition ?? 'outside',
        ticklabelstandoff: baseXAxis.ticklabelstandoff ?? AXIS_TICKLABEL_STANDOFF,
        ticks: baseXAxis.ticks ?? 'outside',
        ticklen: baseXAxis.ticklen ?? 4,
        tickwidth: baseXAxis.tickwidth ?? AXIS_TICK_WIDTH,
        tickcolor: baseXAxis.tickcolor ?? '#111827',
        tickfont: resolvedXAxisTickFont,
        // SUPPRESS native axis title - using annotation instead
        title: { text: '' },
        // Spikelines defaults (modebar toggle works)
        showspikes: baseXAxis.showspikes ?? true,
        spikemode: baseXAxis.spikemode ?? 'across',
        spikethickness: baseXAxis.spikethickness ?? 1,
        spikecolor: baseXAxis.spikecolor ?? '#888',
      },
      yaxis: {
        ...baseYAxis,
        ...(baseYAxis.domain || hasGrid ? {} : { domain: PLOT_CONTENT_DOMAIN }),
        ...(shouldFixBoxViolinAxis && usesHorizontalBoxViolin
          ? { range: boxViolinAxisRange, autorange: false }
          : {}),
        // Manuscript-style defaults: axes on, grid off
        showgrid: gridUserSet ? (baseYAxis.showgrid ?? false) : false,
        zeroline: baseYAxis.zeroline ?? false,
        showline: baseYAxis.showline ?? true,
        linecolor: baseYAxis.linecolor ?? '#111827',
        linewidth: Math.max(Number(baseYAxis.linewidth) || 0, AXIS_LINE_WIDTH),
        automargin: baseYAxis.automargin ?? true,
        fixedrange: allowShapeDrawing ? false : baseYAxis.fixedrange ?? true,
        ticklabelposition: baseYAxis.ticklabelposition ?? 'outside',
        ticklabelstandoff: baseYAxis.ticklabelstandoff ?? AXIS_TICKLABEL_STANDOFF,
        ...(yTickLabelShift !== undefined ? { ticklabelshift: yTickLabelShift } : {}),
        ticks: baseYAxis.ticks ?? 'outside',
        ticklen: baseYAxis.ticklen ?? 4,
        tickwidth: baseYAxis.tickwidth ?? AXIS_TICK_WIDTH,
        tickcolor: baseYAxis.tickcolor ?? '#111827',
        tickfont: resolvedYAxisTickFont,
        // SUPPRESS native axis title - using annotation instead
        title: { text: '' },
        // Spikelines defaults (modebar toggle works)
        showspikes: baseYAxis.showspikes ?? true,
        spikemode: baseYAxis.spikemode ?? 'across',
        spikethickness: baseYAxis.spikethickness ?? 1,
        spikecolor: baseYAxis.spikecolor ?? '#888',
      },
    }
  }, [displayTitle, plot, renderedData])

  const finalLayout = useMemo<Partial<Layout>>(
    () => buildPlotLayout(canvasWidth, canvasHeight),
    [buildPlotLayout, canvasHeight, canvasWidth]
  )

  useLayoutEffect(() => {
    renderedAnnotationsRef.current = Array.isArray(finalLayout.annotations)
      ? (finalLayout.annotations as Array<Partial<Layout['annotations']>>)
      : []

    const legendIndex = renderedAnnotationsRef.current.findIndex(
      (annotation) =>
        typeof annotation === 'object' &&
        annotation !== null &&
        (annotation as { name?: string }).name === '_legend_'
    )
    legendAnnotationIndexRef.current = legendIndex >= 0 ? legendIndex : null

    const trendlineIndex = renderedAnnotationsRef.current.findIndex(
      (annotation) =>
        typeof annotation === 'object' &&
        annotation !== null &&
        (annotation as { name?: string }).name === 'trendline_stats'
    )
    trendlineStatsIndexRef.current = trendlineIndex >= 0 ? trendlineIndex : null

    const ic50LabelIndex = renderedAnnotationsRef.current.findIndex(
      (annotation) =>
        typeof annotation === 'object' &&
        annotation !== null &&
        (annotation as { name?: string }).name === 'ic50_label'
    )
    ic50LabelIndexRef.current = ic50LabelIndex >= 0 ? ic50LabelIndex : null
  }, [finalLayout.annotations])

  useEffect(() => {
    if (!plot?.id) return
    graphDivPlotIdRef.current = plot.id
    const graphDiv = graphDivRef.current as { __easycrisPlotId?: string } | null
    if (graphDiv) {
      graphDiv.__easycrisPlotId = plot.id
    }
  }, [plot?.id])

  useEffect(() => {
    const previousPlotId = previousPlotIdRef.current
    if (previousPlotId && plot?.id && previousPlotId !== plot.id) {
      persistLiveAnnotationSnapshot(previousPlotId, 'switch')
    }
    previousPlotIdRef.current = plot?.id ?? null

    return () => {
      if (plot?.id) {
        persistLiveAnnotationSnapshot(plot.id, 'unmount')
      }
    }
  }, [plot?.id, persistLiveAnnotationSnapshot])

  useEffect(() => {
    lastEditedBracketRef.current = null
    lastEditedBracketIndexRef.current = null
  }, [plot?.id])

    useEffect(() => {
      const containerEl = plotContainerRef.current
      if (!containerEl || !plot) return
    const renderedAnnotations = renderedAnnotationsRef.current
    if (renderedAnnotations.length === 0) return

    const applyAnnotationWeights = () => {
      const annotationEls = containerEl.querySelectorAll('.annotation')
      annotationEls.forEach((annotationEl) => {
        const indexAttr = annotationEl.getAttribute('data-index')
        if (!indexAttr) return
        const index = Number(indexAttr)
        if (!Number.isFinite(index)) return
        const annotation = renderedAnnotations[index] as
          | { font?: { weight?: number } }
          | undefined
        const weight = annotation?.font?.weight
        if (!weight) return
        const textEl = annotationEl.querySelector('text')
        if (!textEl) return
        textEl.setAttribute('font-weight', String(weight))
        ;(textEl as SVGTextElement).style.fontWeight = String(weight)
      })
    }

    const frameId = requestAnimationFrame(applyAnnotationWeights)
    return () => cancelAnimationFrame(frameId)
  }, [finalLayout.annotations])

  // Block edit mode on legend and trendline equation annotations
  // Plotly uses CLICK (not dblclick) to trigger edit mode - see svg_text_utils.js line 1013
  // We intercept click in capture phase before Plotly's d3 handler fires
  // Drag still works because it uses mousedown/mousemove (not click)
  // Fix Y-axis "0" label alignment (post-render SVG manipulation)
  useEffect(() => {
    const containerEl = plotContainerRef.current
    if (!containerEl) return

    // Find Y-axis "0" tick label and align it with axis line
    const yAxisTickLabels = containerEl.querySelectorAll('.ytick text')
    yAxisTickLabels.forEach((label) => {
      if (label.textContent?.trim() === '0') {
        // Get the axis line position
        const axisLine = containerEl.querySelector('.yaxis .axisline')
        if (axisLine) {
          const axisRect = axisLine.getBoundingClientRect()
          const labelRect = label.getBoundingClientRect()

          // Calculate vertical adjustment to align label baseline with axis
          const offset = labelRect.bottom - axisRect.bottom
          if (Math.abs(offset) > 0.5) {
            const currentY = parseFloat(label.getAttribute('y') || '0')
            label.setAttribute('y', String(currentY - offset))
          }
        }
      }
    })
  }, [finalLayout, plot?.plotlyData])

  useEffect(() => {
    const containerEl = plotContainerRef.current
    if (!containerEl) return

    const handleClick = (event: MouseEvent) => {
      const legendIndex = legendAnnotationIndexRef.current
      const trendlineIndex = trendlineStatsIndexRef.current
      const ic50Index = ic50LabelIndexRef.current
      if (legendIndex === null && trendlineIndex === null && ic50Index === null) return

      const target = event.target as Element | null
      if (!target) return

      // Find the annotation element containing the click target
      const annotationEl = target.closest?.('.annotation') as HTMLElement | null
      if (!annotationEl) return

      const dataIndexAttr = annotationEl.getAttribute('data-index')
      if (dataIndexAttr === null) return

      const dataIndex = Number(dataIndexAttr)
      if (!Number.isFinite(dataIndex)) return

      // Check if this is a non-editable annotation
      if (dataIndex === legendIndex || dataIndex === trendlineIndex || dataIndex === ic50Index) {
        // Prevent Plotly's click handler from firing (which triggers edit mode)
        event.stopImmediatePropagation()
        // Don't preventDefault - that would break drag functionality
      }
    }

    // Use capture phase to fire before Plotly's d3 event handlers
    containerEl.addEventListener('click', handleClick, true)
    return () => {
      containerEl.removeEventListener('click', handleClick, true)
    }
  }, [plot?.id])

  useEffect(() => {
    const containerEl = plotContainerRef.current
    if (!containerEl) return
    if (!plot) return

    const parsePathPoints = (path: string) => {
      const matches = path.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)
      if (!matches || matches.length < 8) return null
      const nums = matches.slice(0, 8).map((value) => Number(value))
      if (nums.some((value) => !Number.isFinite(value))) return null
      const yBottom = nums[1] ?? 0
      const yTop = nums[3] ?? 0
      return {
        yBottom: Math.min(yBottom, nums[5] ?? yBottom, nums[7] ?? yBottom),
        yTop: Math.max(yTop, nums[5] ?? yTop, nums[7] ?? yTop),
      }
    }

    const handleShapeMouseDown = (event: MouseEvent) => {
      if (!plot) return
      const target = event.target as Element | null
      if (!target) return
      const shapeEl = target.closest?.('.shapelayer [data-index]') as HTMLElement | null
      if (!shapeEl) return
      const indexAttr = shapeEl.getAttribute('data-index')
      if (!indexAttr) return
      const index = Number(indexAttr)
      if (!Number.isFinite(index)) return
      const plotLayout = (plot.plotlyLayout ?? {}) as { shapes?: unknown[] }
      const shapes = Array.isArray(plotLayout.shapes) ? plotLayout.shapes : []
      const shape = shapes[index] as { name?: string; path?: string; type?: string } | undefined
      if (!shape) return
      const shapeName = typeof shape?.name === 'string' ? shape.name : null
      const shapeMeta = (shape as { meta?: { customMarkup?: boolean } } | undefined)?.meta
      const isCustom = Boolean(
        (shapeMeta && shapeMeta.customMarkup) ||
          (shapeName && shapeName.startsWith(CUSTOM_MARKUP_PREFIX))
      )
      if (!shapeName || !shapeName.startsWith(SIGNIFICANCE_BRACKET_PREFIX)) {
        if (isCustom) {
          lastEditedCustomShapeRef.current = shapeName
          lastEditedCustomShapeIndexRef.current = index
        }
        return
      }
      lastEditedBracketRef.current = shapeName
      lastEditedBracketIndexRef.current = index

      const currentLayout = (plot.plotlyLayout as Partial<Layout>) ?? {}
      const baseYAxis = (currentLayout.yaxis ?? {}) as Partial<Layout['yaxis']>
      const baseXAxis = (currentLayout.xaxis ?? {}) as Partial<Layout['xaxis']>
      const existingRange = Array.isArray(baseYAxis.range) ? baseYAxis.range : null
      if (
        existingRange &&
        typeof existingRange[0] === 'number' &&
        typeof existingRange[1] === 'number'
      ) {
        const parsed = shape.type === 'path' && shape.path ? parsePathPoints(shape.path) : null
        const yRange = existingRange[1] - existingRange[0]
        const pad = Math.max(1, Math.abs(yRange) * 0.08)
        const allowTop = baseXAxis.side !== 'top'
        const allowBottom = baseXAxis.side === 'top'
        let nextMin = existingRange[0]
        let nextMax = existingRange[1]
        if (parsed) {
          // More lenient threshold: expand when bracket approaches top (within 2*pad)
          if (allowTop && parsed.yTop > existingRange[1] - pad * 2) {
            nextMax = Math.max(existingRange[1], parsed.yTop + pad)
          }
          if (allowBottom && parsed.yBottom < existingRange[0] + pad * 2) {
            nextMin = Math.min(existingRange[0], parsed.yBottom - pad)
          }
        }
        if (nextMin !== existingRange[0] || nextMax !== existingRange[1]) {
          updatePlot(plot.id, {
            plotlyLayout: {
              ...currentLayout,
              yaxis: {
                ...baseYAxis,
                range: [nextMin, nextMax],
                autorange: false,
              },
            },
          })
        }
      }
    }

    containerEl.addEventListener('mousedown', handleShapeMouseDown, true)
    return () => {
      containerEl.removeEventListener('mousedown', handleShapeMouseDown, true)
    }
  }, [plot, updatePlot])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const activeElement = document.activeElement as HTMLElement | null
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          activeElement.isContentEditable)
      ) {
        return
      }
      if (!plot) return

      const bracketName = lastEditedBracketRef.current
      const bracketIndex = lastEditedBracketIndexRef.current

      const currentLayout = (plot.plotlyLayout as Partial<Layout>) ?? {}
      const currentShapes = Array.isArray(currentLayout.shapes) ? [...currentLayout.shapes] : []
      const currentAnnotations = Array.isArray(currentLayout.annotations)
        ? [...currentLayout.annotations]
        : []

      let targetName: string | null = null
      if (typeof bracketIndex === 'number') {
        const target = currentShapes[bracketIndex] as { name?: string } | undefined
        if (target?.name?.startsWith(SIGNIFICANCE_BRACKET_PREFIX)) {
          targetName = target.name
        }
      } else if (bracketName && bracketName.startsWith(SIGNIFICANCE_BRACKET_PREFIX)) {
        targetName = bracketName
      }

      if (targetName) {
        const nextShapes = currentShapes.map((shape) => {
          if (typeof shape !== 'object' || shape === null) return shape
          if ((shape as { name?: string }).name === targetName) {
            return { ...shape, visible: false }
          }
          return shape
        })

        const nextAnnotations = currentAnnotations.map((annotation) => {
          if (typeof annotation !== 'object' || annotation === null) return annotation
          if ((annotation as { name?: string }).name === targetName) {
            return { ...annotation, visible: false }
          }
          return annotation
        })

        const currentMeta = ((currentLayout.meta ?? {}) as PlotLayoutMeta) ?? {}
        const effectId = resolveBracketEffectId(targetName, currentMeta)
        const nextMeta = effectId
          ? {
              ...currentMeta,
              bracketVisibility: {
                ...(currentMeta.bracketVisibility ?? {}),
                [effectId]: false,
              },
            }
          : currentMeta

        updatePlot(plot.id, {
          plotlyLayout: {
            ...currentLayout,
            shapes: nextShapes,
            annotations: nextAnnotations,
            meta: nextMeta,
          },
        })
        lastEditedBracketRef.current = null
        lastEditedBracketIndexRef.current = null
        event.preventDefault()
        return
      }

      const customIndex = lastEditedCustomShapeIndexRef.current
      const customName = lastEditedCustomShapeRef.current
      let customTargetIndex: number | null = null
      if (typeof customIndex === 'number') {
        const target = currentShapes[customIndex] as { name?: string; meta?: { customMarkup?: boolean } } | undefined
        if (
          target &&
          (target.meta?.customMarkup ||
            (typeof target.name === 'string' && target.name.startsWith(CUSTOM_MARKUP_PREFIX)))
        ) {
          customTargetIndex = customIndex
        }
      }
      if (customTargetIndex === null && customName) {
        const fallbackIndex = currentShapes.findIndex(
          (shape) => (shape as { name?: string }).name === customName
        )
        if (fallbackIndex >= 0) customTargetIndex = fallbackIndex
      }

      if (customTargetIndex === null) return

      const nextShapes = currentShapes.filter((_, index) => index !== customTargetIndex)
      updatePlot(plot.id, {
        plotlyLayout: {
          ...currentLayout,
          shapes: nextShapes,
        },
      })
      lastEditedCustomShapeRef.current = null
      lastEditedCustomShapeIndexRef.current = null
      event.preventDefault()
      return
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [plot, updatePlot])

  // Plotly config - modebar is disabled, annotations still editable
  const plotLayoutMeta = useMemo(() => {
    const layout = plot?.plotlyLayout as Partial<Layout> | undefined
    return (layout?.meta ?? {}) as PlotLayoutMeta
  }, [plot?.plotlyLayout])

  const finalConfig = useMemo<Partial<Config>>(() => {
    const baseConfig = (plot?.plotlyConfig as Partial<Config>) ?? {}
    const allowShapeEditing = Boolean(
      baseConfig.edits?.shapePosition ||
        plotLayoutMeta.customMarkupEnabled ||
        plotLayoutMeta.activeShapeTool
    )

    return {
      ...baseConfig,
      responsive: false,
      displayModeBar: false,
      displaylogo: false,
      staticPlot: baseConfig.staticPlot ?? false,
      modeBarButtonsToRemove: [],
      toImageButtonOptions: {
        ...(baseConfig.toImageButtonOptions ?? {}),
        format: 'png',
        filename: `${plot?.title || 'easycris-plot'}-${Date.now()}`,
        height: 600,
        width: 800,
        scale: 2,
      },
      // Enable inline text editing and annotation dragging
      editable: true,
      edits: {
        // TEXT EDITING - allowed
        titleText: false, // Disabled - using annotation for title
        axisTitleText: false, // Disabled - using annotations for axis titles
        legendText: true, // Edit legend entries (trace names)
        annotationText: true, // Edit annotation text (includes our title annotations)
        colorbarTitleText: plot?.plotlyConfig?.edits?.colorbarTitleText ?? false, // Honor per-plot config
        // ANNOTATION POSITION - enabled for draggable titles
        annotationPosition: true, // Allow dragging title/axis annotations
        annotationTail: false, // No arrow tails
        // OTHER POSITIONS - locked
        legendPosition: false,
        shapePosition: allowShapeEditing,
        colorbarPosition: false,
        colorbarTitlePosition: false,
      },
    }
  }, [plot?.plotlyConfig, plot?.title, plotLayoutMeta])

  // I2: keep plotShapesRef in sync with this plot's layout shapes.
  // Runs on every layout change so event handlers always see a fresh snapshot
  // without going through getActivePlot() (which can return wrong data during transitions).
  useEffect(() => {
    const plotLayout = (plot?.plotlyLayout ?? {}) as { shapes?: unknown[] }
    plotShapesRef.current = Array.isArray(plotLayout.shapes) ? plotLayout.shapes : []
  }, [plot?.plotlyLayout])

  // C1: compute eligibility outside the effect so it appears in deps.
  // Without this, switching plot.id while editSignificanceMode stays true
  // would keep a stale editMode=true in the closed-over variable.
  const lmmEditEligible = useMemo(
    () => isLmmEditSignificanceEligible(plot, plotLayoutMeta),
    [plot, plotLayoutMeta],
  )

  // ns-resize cursor: when Edit Significance mode is ON and the pointer enters a
  // sig_bracket_* shape, show â†• to signal the shape is draggable.
  // Mirrors handleShapeMouseDown: Plotly sets data-index (not data-name) on shape elements;
  // resolve name by looking up the index in the plotShapesRef snapshot.
  useEffect(() => {
    const containerEl = plotContainerRef.current
    if (!containerEl) return
    // Gate cursor on LMM eligibility â€” non-LMM plots must never show ns-resize
    const editMode = plotLayoutMeta.editSignificanceMode === true && lmmEditEligible

    const resolveBracketName = (target: Element | null): string | null => {
      const shapeEl = target?.closest?.('.shapelayer [data-index]') as HTMLElement | null
      if (!shapeEl) return null
      const index = Number(shapeEl.getAttribute('data-index'))
      if (!Number.isFinite(index)) return null
      // I2: read from ref snapshot â€” immune to store transition windows
      const shapes = plotShapesRef.current
      const shape = shapes[index] as { name?: string } | undefined
      const name = typeof shape?.name === 'string' ? shape.name : ''
      return name.startsWith('sig_bracket_') ? name : null
    }

    const handleMouseOver = (e: MouseEvent) => {
      if (!editMode) return
      if (resolveBracketName(e.target as Element | null)) {
        containerEl.style.cursor = 'ns-resize'
      }
    }

    const handleMouseOut = (e: MouseEvent) => {
      if (!editMode) return
      if (resolveBracketName(e.target as Element | null)) {
        containerEl.style.cursor = ''
      }
    }

    containerEl.addEventListener('mouseover', handleMouseOver)
    containerEl.addEventListener('mouseout', handleMouseOut)
    return () => {
      containerEl.removeEventListener('mouseover', handleMouseOver)
      containerEl.removeEventListener('mouseout', handleMouseOut)
      containerEl.style.cursor = ''
    }
  }, [lmmEditEligible, plot?.id, plotLayoutMeta.editSignificanceMode, plotContainerRef])

  const activeShapeTool =
    typeof plotLayoutMeta.activeShapeTool === 'string' ? plotLayoutMeta.activeShapeTool : null
  const drawModeLabel =
    activeShapeTool === 'path'
      ? 'Freeform'
      : activeShapeTool
        ? activeShapeTool.charAt(0).toUpperCase() + activeShapeTool.slice(1)
        : null
  const drawAreaRect = useMemo(() => {
    const xAxis = (finalLayout.xaxis ?? {}) as Partial<Layout['xaxis']>
    const yAxis = (finalLayout.yaxis ?? {}) as Partial<Layout['yaxis']>
    const xDomain = parseDomain(xAxis, PLOT_CONTENT_DOMAIN)
    const yDomain = parseDomain(yAxis, PLOT_CONTENT_DOMAIN)
    const left = Math.min(xDomain[0], xDomain[1])
    const right = Math.max(xDomain[0], xDomain[1])
    const bottom = Math.min(yDomain[0], yDomain[1])
    const top = Math.max(yDomain[0], yDomain[1])
    return {
      left: `${left * 100}%`,
      width: `${Math.max(0, (right - left) * 100)}%`,
      top: `${(1 - top) * 100}%`,
      height: `${Math.max(0, (top - bottom) * 100)}%`,
    } as CSSProperties
  }, [finalLayout.xaxis, finalLayout.yaxis])

  useEffect(() => {
    if (activeShapeTool) {
      setDrawModePromptVisible(true)
      return
    }
    setDrawModePromptVisible(false)
  }, [activeShapeTool])

  // Handle panel resizes with ResizeObserver
  useEffect(() => {
    const container = plotContainerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      const plotEl = container.querySelector('.js-plotly-plot')
      if (plotEl) {
        import('plotly.js/dist/plotly.min.js').then((PlotlyModule) => {
          const Plotly = (PlotlyModule as { default?: any }).default ?? PlotlyModule
          Plotly.Plots?.resize?.(plotEl as HTMLElement)
        })
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [plotContainerRef, plot])

  // Scale handlers
  const handleScaleUp = () => onScaleChange(Math.min(SCALE_MAX, scale + SCALE_STEP))
  const handleScaleDown = () => onScaleChange(Math.max(SCALE_MIN, scale - SCALE_STEP))
  const handleScaleReset = () => onScaleChange(1)
  const handleSliderChange = (value: number[]) => {
    if (value[0] !== undefined) onScaleChange(value[0])
  }

  // Handle text edits and position changes from Plotly
  // ANNOTATION-BASED TITLES: Sync annotation edits back to stored title fields
  const handleRelayout = useCallback(
    (event: Partial<Layout>) => {
      if (!plot) return
      const plotId = plot.id
      const storeState = usePlotsStore.getState()
      const latestPlot = storeState.getPlot(plotId)
      if (!latestPlot) return
      const latestDisplayTitle = resolvePlotDisplayTitle(latestPlot)

      const updates: { title?: string; plotlyLayout?: Partial<Layout> } = {}
      const layoutUpdates: Partial<Layout> = {}
      let hasChanges = false
      const relayoutData = event as Record<string, unknown>
      const debugRelayout =
        import.meta.env.DEV &&
        typeof window !== 'undefined' &&
        (window as unknown as { __EASYCRIS_DEBUG_RELAYOUT__?: boolean })
          .__EASYCRIS_DEBUG_RELAYOUT__ === true
      if (debugRelayout) {
        console.debug('[PlotCanvas] relayout payload', {
          plotId,
          activePlotId: storeState.activePlotId,
          keys: Object.keys(relayoutData),
          hasAnnotationsArray: Array.isArray((event as { annotations?: unknown }).annotations),
        })
      }
      const currentLayout = (latestPlot.plotlyLayout as Partial<Layout>) ?? {}
      let currentAnnotations = Array.isArray(currentLayout.annotations)
        ? [...currentLayout.annotations]
        : []
      const currentShapes = Array.isArray(currentLayout.shapes)
        ? [...currentLayout.shapes]
        : []
      const renderedAnnotations = renderedAnnotationsRef.current
      const systemAnnotationHints = getSystemAnnotationTextHints(
        currentLayout,
        latestDisplayTitle || latestPlot.title || ''
      )
      const normalizedCurrentResult = normalizeSystemAnnotationIdentity(
        currentAnnotations,
        systemAnnotationHints
      )
      if (normalizedCurrentResult.changed) {
        currentAnnotations = normalizedCurrentResult.annotations
      }

      // Patterns to ignore (axis range changes)
      const axisRangePatterns = [
        /^(x|y)axis\.range(\[|$)/,
        /^(x|y)axis\.autorange$/,
        /^(x|y)axis\.domain$/,
        /^(x|y)axis\.scaleanchor$/,
        /^(x|y)axis\.scaleratio$/,
      ]
      const nonDraggableAnnotationNames = new Set([
        '_legend_',
        'trendline_stats',
        'dose_interp_label',
      ])
      const nonDraggableAnnotationRoles = new Set(['bracket-label'])
      const bracketNamePrefix = SIGNIFICANCE_BRACKET_PREFIX
      const customMarkupPrefix = 'custom_markup_'
      const systemAnnotationPositionKeys = new Set([
        'x',
        'y',
        'xanchor',
        'yanchor',
        'textangle',
      ])

      const getAnnotationIdentity = (annotation?: unknown) => {
        if (typeof annotation !== 'object' || annotation === null) {
          return { name: undefined, role: undefined }
        }
        const name =
          typeof (annotation as { name?: unknown }).name === 'string'
            ? ((annotation as { name?: string }).name as string)
            : undefined
        const meta = (annotation as { meta?: unknown }).meta
        const role =
          typeof meta === 'object' &&
          meta !== null &&
          typeof (meta as { role?: unknown }).role === 'string'
            ? ((meta as { role?: string }).role as string)
            : undefined
        return { name, role }
      }

      const isCustomMarkupAnnotation = (annotation?: unknown) => {
        if (typeof annotation !== 'object' || annotation === null) return false
        const name =
          typeof (annotation as { name?: unknown }).name === 'string'
            ? ((annotation as { name?: string }).name as string)
            : ''
        if (name && name.startsWith(customMarkupPrefix)) return true
        const meta = (annotation as { meta?: unknown }).meta
        if (typeof meta === 'object' && meta !== null) {
          return (meta as { customMarkup?: boolean }).customMarkup === true
        }
        return false
      }

      const isNonDraggableAnnotation = (annotation?: unknown) => {
        const identity = getAnnotationIdentity(annotation)
        if (identity.name) {
          if (nonDraggableAnnotationNames.has(identity.name)) return true
          if (identity.name.startsWith(bracketNamePrefix)) return true
        }
        if (identity.role && nonDraggableAnnotationRoles.has(identity.role)) return true
        return false
      }

      const resolveAnnotationTarget = (index: number) => {
        const renderedEntry = renderedAnnotations[index] as
          | { name?: string; meta?: { role?: string } }
          | undefined
        const renderedIdentity = getAnnotationIdentity(renderedEntry)
        if (!renderedIdentity.name && !renderedIdentity.role) {
          const storedEntry = currentAnnotations[index]
          const storedIdentity = getAnnotationIdentity(storedEntry)
          return {
            index,
            name: storedIdentity.name ?? renderedIdentity.name,
            role: storedIdentity.role ?? renderedIdentity.role,
          }
        }

        const storedIndex = currentAnnotations.findIndex((annotation) => {
          const identity = getAnnotationIdentity(annotation)
          if (renderedIdentity.name) {
            return identity.name === renderedIdentity.name
          }
          if (renderedIdentity.role) {
            return identity.role === renderedIdentity.role
          }
          return false
        })
        if (storedIndex >= 0) {
          return { index: storedIndex, name: renderedIdentity.name, role: renderedIdentity.role }
        }

        if (!isNonDraggableAnnotation(renderedEntry) && renderedEntry) {
          currentAnnotations.push({ ...renderedEntry, showarrow: false, ax: 0, ay: 0 })
          return {
            index: currentAnnotations.length - 1,
            name: renderedIdentity.name,
            role: renderedIdentity.role,
          }
        }

        return { index, name: renderedIdentity.name, role: renderedIdentity.role }
      }

      const parsePathPoints = (path: string) => {
        const matches = path.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)
        if (!matches || matches.length < 8) return null
        const nums = matches.slice(0, 8).map((value) => Number(value))
        if (nums.some((value) => !Number.isFinite(value))) return null
        const xLeft = nums[0] ?? 0
        const yTipLeft = nums[1] ?? 0
        const yBaseLeft = nums[3] ?? 0
        const xRight = nums[4] ?? 0
        const yBaseRight = nums[5] ?? yBaseLeft
        const yTipRight = nums[7] ?? yTipLeft
        const yBase = (yBaseLeft + yBaseRight) / 2
        const yMin = Math.min(yTipLeft, yTipRight, yBase)
        const yMax = Math.max(yTipLeft, yTipRight, yBase)
        return {
          xLeft,
          xRight,
          yTipLeft,
          yTipRight,
          yBase,
          yMin,
          yMax,
        }
      }

      const lockBracketPathX = (existingPath: string, nextPath: string) => {
        const existing = parsePathPoints(existingPath)
        const next = parsePathPoints(nextPath)
        if (!existing || !next) return nextPath
        return `M ${existing.xLeft},${next.yTipLeft} L ${existing.xLeft},${next.yBase} L ${existing.xRight},${next.yBase} L ${existing.xRight},${next.yTipRight}`
      }


      const getBracketYBounds = (shapes: Array<Record<string, unknown>>) => {
        let min = Number.POSITIVE_INFINITY
        let max = Number.NEGATIVE_INFINITY
        shapes.forEach((shape) => {
          if (typeof shape.name !== 'string' || !shape.name.startsWith(bracketNamePrefix)) return
          if (shape.type !== 'path' || typeof shape.path !== 'string') return
          const parsed = parsePathPoints(shape.path)
          if (!parsed) return
          min = Math.min(min, parsed.yMin)
          max = Math.max(max, parsed.yMax)
        })
        if (!Number.isFinite(min) || !Number.isFinite(max)) return null
        return { min, max }
      }

      const collectAxisBounds = (axisKey: 'x' | 'y') => {
        const axis = (currentLayout[`${axisKey}axis`] ?? {}) as Partial<Layout['xaxis']>
        const axisRange = Array.isArray(axis.range) ? axis.range : null
        if (axisRange && typeof axisRange[0] === 'number' && typeof axisRange[1] === 'number') {
          return { min: axisRange[0], max: axisRange[1] }
        }
        const values: Array<string | number> = []
        if (latestPlot.plotlyData) {
          for (const trace of latestPlot.plotlyData as Data[]) {
            const raw = (trace as Record<string, unknown>)[axisKey]
            if (Array.isArray(raw)) {
              raw.forEach((value) => {
                if (typeof value === 'number' || typeof value === 'string') {
                  values.push(value)
                }
              })
            }
          }
        }
        const numeric = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        if (numeric.length > 0) {
          return { min: Math.min(...numeric), max: Math.max(...numeric) }
        }
        const categorical = values.filter((value): value is string => typeof value === 'string')
        if (categorical.length > 0) {
          const unique = Array.from(new Set(categorical))
          return { min: -0.5, max: Math.max(0, unique.length - 1) + 0.5 }
        }
        return null
      }

      const collectNumericDataBounds = (axisKey: 'x' | 'y') => {
        const values: number[] = []
        if (latestPlot.plotlyData) {
          for (const trace of latestPlot.plotlyData as Data[]) {
            const raw = (trace as Record<string, unknown>)[axisKey]
            if (Array.isArray(raw)) {
              raw.forEach((value) => {
                if (typeof value === 'number' && Number.isFinite(value)) {
                  values.push(value)
                }
              })
            }
          }
        }
        if (values.length === 0) return null
        return { min: Math.min(...values), max: Math.max(...values) }
      }

      const clampToBounds = (min: number, max: number, bounds: { min: number; max: number } | null) => {
        if (!bounds) return 0
        let shift = 0
        if (min < bounds.min) {
          shift = bounds.min - min
        }
        if (max + shift > bounds.max) {
          shift = bounds.max - max
        }
        return shift
      }

      const syncBracketLabels = (
        shapes: Array<Record<string, unknown>>,
        annotations: Array<Record<string, unknown>>,
        options?: { clampY?: boolean }
      ) => {
        const xBounds = collectAxisBounds('x')
        const yBounds = collectAxisBounds('y')
        const yRange =
          yBounds && Number.isFinite(yBounds.max - yBounds.min)
            ? yBounds.max - yBounds.min
            : 0
        const clampY = options?.clampY !== false
        const yBoundsInset =
          clampY && yBounds && yRange > 0
            ? {
                min: yBounds.min + yRange * 0.01,
                max: yBounds.max - yRange * 0.08,
              }
            : yBounds

        let changed = false
        shapes.forEach((shape, shapeIndex) => {
          if (typeof shape.name !== 'string' || !shape.name.startsWith(bracketNamePrefix)) return
          if (shape.type !== 'path' || typeof shape.path !== 'string') return
          const parsed = parsePathPoints(shape.path)
          if (!parsed) return

          const dx =
            typeof shape.name === 'string' && shape.name.startsWith(bracketNamePrefix)
              ? 0
              : clampToBounds(parsed.xLeft, parsed.xRight, xBounds)
          const dy = clampY ? clampToBounds(parsed.yMin, parsed.yMax, yBoundsInset) : 0
          const nextLeft = parsed.xLeft + dx
          const nextRight = parsed.xRight + dx
          const nextBase = parsed.yBase + dy
          const nextTipLeft = parsed.yTipLeft + dy
          const nextTipRight = parsed.yTipRight + dy
          const nextPath = `M ${nextLeft},${nextTipLeft} L ${nextLeft},${nextBase} L ${nextRight},${nextBase} L ${nextRight},${nextTipRight}`
          if (nextPath !== shape.path) {
            shapes[shapeIndex] = { ...shape, path: nextPath }
            changed = true
          }

          const annotationIndex = annotations.findIndex(
            (annotation) => annotation?.name === shape.name
          )
          if (annotationIndex >= 0) {
            const offset = yRange > 0 ? yRange * 0.02 : Math.max(1, Math.abs(nextBase)) * 0.02
            const xMid = (nextLeft + nextRight) / 2
            let labelX = xMid
            const tipsMax = Math.max(nextTipLeft, nextTipRight)
            const tipsMin = Math.min(nextTipLeft, nextTipRight)
            const baseIsTop = nextBase >= tipsMax
            const baseIsBottom = nextBase <= tipsMin
            let labelY = nextBase + (baseIsTop ? offset : baseIsBottom ? -offset : offset)
            if (xBounds) {
              labelX = Math.min(xBounds.max, Math.max(xBounds.min, labelX))
            }
            if (clampY && yBounds) {
              labelY = Math.min(yBounds.max, Math.max(yBounds.min, labelY))
            }
            const annotation = annotations[annotationIndex] ?? {}
            if (annotation.x !== labelX || annotation.y !== labelY) {
              annotations[annotationIndex] = {
                ...annotation,
                x: labelX,
                y: labelY,
              }
              changed = true
            }
          }
        })

        return changed
      }

      // Collect annotation edits (text and position)
      const annotationTextEdits: Array<{ index: number; text: string }> = []
      const annotationPositionEdits: Array<{
        index: number
        key: string
        value: unknown
      }> = []
      const shapePositionEdits: Array<{
        index: number
        key: string
        value: unknown
      }> = []

      for (const [key, value] of Object.entries(relayoutData)) {
        // Skip axis range changes
        if (axisRangePatterns.some((pattern) => pattern.test(key))) {
          continue
        }

        // Annotation text edit
        const textMatch = key.match(/^annotations\[(\d+)\]\.text$/)
        if (textMatch && typeof value === 'string') {
          annotationTextEdits.push({ index: Number(textMatch[1]), text: value })
          continue
        }

        // Annotation position edit (x, y, xanchor, yanchor, textangle)
        const posMatch = key.match(
          /^annotations\[(\d+)\]\.(x|y|xanchor|yanchor|textangle)$/
        )
        if (posMatch && posMatch[2]) {
          annotationPositionEdits.push({
            index: Number(posMatch[1]),
            key: posMatch[2],
            value,
          })
          continue
        }

        const shapeMatch = key.match(
          /^shapes\[(\d+)\]\.(x0|x1|y0|y1|x0shift|x1shift|y0shift|y1shift|path|xref|yref)$/
        )
        if (shapeMatch && shapeMatch[2]) {
          shapePositionEdits.push({
            index: Number(shapeMatch[1]),
            key: shapeMatch[2],
            value,
          })
        }
      }

      // Process annotation text edits - sync to stored title fields
      annotationTextEdits.forEach(({ index, text }) => {
        const target = resolveAnnotationTarget(index)
        // Skip non-editable annotations (legend and trendline equation)
        if (target.name === '_legend_' || target.name === 'trendline_stats') return
        const existing = currentAnnotations[target.index] as
          | { name?: string; text?: string }
          | undefined
        if (!existing) return
        const isCustom = isCustomMarkupAnnotation(existing)
        const shouldStrip =
          target.name === '_title_' ||
          target.name === '_xaxis_title_' ||
          target.name === '_yaxis_title_'
        const normalizedText = shouldStrip ? stripPlotlyHtml(text) : text

        // Update the annotation text
        if (existing.text !== normalizedText) {
          if (isCustom) {
            currentAnnotations[target.index] = {
              ...(existing as Record<string, unknown>),
              text: normalizedText,
            }
          } else {
            const { ax: _ax, ay: _ay, ...rest } = existing as Record<string, unknown>
            currentAnnotations[target.index] = {
              ...rest,
              text: normalizedText,
              showarrow: false,
              ax: 0,
              ay: 0,
            }
          }
          hasChanges = true

          // Sync to stored title fields based on annotation name
          if (target.name === '_title_') {
            // Main title annotation -> update plot.title
            updates.title = normalizedText
            const currentTitle = currentLayout.title
            const baseTitle =
              typeof currentTitle === 'object'
                ? currentTitle
                : currentTitle
                  ? { text: currentTitle }
                  : {}
            layoutUpdates.title = { ...baseTitle, text: normalizedText }
          } else if (target.name === '_xaxis_title_') {
            // X-axis title annotation -> update layout.xaxis.title.text
            const currentXAxis = (currentLayout.xaxis ?? {}) as Partial<Layout['xaxis']>
            const existingXTitle =
              typeof currentXAxis.title === 'object' ? currentXAxis.title : {}
            layoutUpdates.xaxis = {
              ...(layoutUpdates.xaxis ?? currentXAxis),
              title: { ...existingXTitle, text: normalizedText },
            }
          } else if (target.name === '_yaxis_title_') {
            // Y-axis title annotation -> update layout.yaxis.title.text
            const currentYAxis = (currentLayout.yaxis ?? {}) as Partial<Layout['yaxis']>
            const existingYTitle =
              typeof currentYAxis.title === 'object' ? currentYAxis.title : {}
            layoutUpdates.yaxis = {
              ...(layoutUpdates.yaxis ?? currentYAxis),
              title: { ...existingYTitle, text: normalizedText },
            }
          }
        }
      })

      // Process annotation position edits
      annotationPositionEdits.forEach(({ index, key, value }) => {
        const target = resolveAnnotationTarget(index)
        const targetAnnotation =
          (currentAnnotations[target.index] as Record<string, unknown> | undefined) ?? {
            ...(target.name ? { name: target.name } : {}),
            ...(target.role ? { meta: { role: target.role } } : {}),
          }
        if (isNonDraggableAnnotation(targetAnnotation)) return
        const existing =
          (currentAnnotations[target.index] as Record<string, unknown> | undefined) ?? {}
        const isCustom = isCustomMarkupAnnotation(existing)
        if (existing[key] !== value) {
          if (isCustom) {
            currentAnnotations[target.index] = {
              ...existing,
              [key]: value,
            }
          } else {
            const { ax: _ax, ay: _ay, ...rest } = existing
            currentAnnotations[target.index] = {
              ...rest,
              [key]: value,
              showarrow: false,
              ax: 0,
              ay: 0,
            }
          }
          if (
            typeof target.name === 'string' &&
            SYSTEM_ANNOTATION_NAME_SET.has(target.name) &&
            systemAnnotationPositionKeys.has(key)
          ) {
            const systemName = target.name as SystemAnnotationName
            const currentMeta = ((layoutUpdates.meta ?? currentLayout.meta ?? {}) as PlotLayoutMeta) ?? {}
            const currentPositions =
              typeof currentMeta.systemAnnotationPositions === 'object' &&
              currentMeta.systemAnnotationPositions !== null
                ? (currentMeta.systemAnnotationPositions as Partial<
                    Record<SystemAnnotationName, Record<string, unknown>>
                  >)
                : ({} as Partial<Record<SystemAnnotationName, Record<string, unknown>>>)
            const existingPosition =
              typeof currentPositions[systemName] === 'object' &&
              currentPositions[systemName] !== null
                ? (currentPositions[systemName] as Record<string, unknown>)
                : {}

            layoutUpdates.meta = {
              ...currentMeta,
              systemAnnotationPositions: {
                ...currentPositions,
                [systemName]: {
                  ...existingPosition,
                  [key]: value,
                },
              },
            }
          }
          hasChanges = true
        }
      })

      if (annotationPositionEdits.length > 0) {
        const ic50Annotation = currentAnnotations.find(
          (annotation) => annotation && (annotation as { name?: string }).name === 'ic50_label'
        ) as Record<string, unknown> | undefined
        const ic50ShapeIndex = currentShapes.findIndex(
          (shape) => shape && (shape as { name?: string }).name === 'ic50_label_box'
        )
        if (ic50Annotation && ic50ShapeIndex >= 0) {
          const labelX = Number(ic50Annotation.x)
          const labelY = Number(ic50Annotation.y)
          if (Number.isFinite(labelX) && Number.isFinite(labelY)) {
            const boxWidth = 0.18
            const boxHeight = 0.05
            const nextShape = {
              ...(currentShapes[ic50ShapeIndex] as Record<string, unknown>),
              x0: labelX - boxWidth / 2,
              x1: labelX + boxWidth / 2,
              y0: labelY - boxHeight / 2,
              y1: labelY + boxHeight / 2,
            }
            currentShapes[ic50ShapeIndex] = nextShape
            hasChanges = true
            layoutUpdates.shapes = currentShapes
          }
        }
      }

      // If annotations changed, update them
      if (annotationTextEdits.length > 0 || annotationPositionEdits.length > 0) {
        layoutUpdates.annotations = currentAnnotations
      }

      if (shapePositionEdits.length > 0) {
        const nextShapes = [...currentShapes]
        const editsByIndex = new Map<number, Record<string, unknown>>()
        shapePositionEdits.forEach(({ index, key, value }) => {
          if (index < 0) return
          const existing = editsByIndex.get(index) ?? {}
          existing[key] = value
          editsByIndex.set(index, existing)
        })

        const currentMeta = ((layoutUpdates.meta ?? currentLayout.meta ?? {}) as PlotLayoutMeta) ?? {}
        const activeShapeTool =
          typeof currentMeta.activeShapeTool === 'string' ? currentMeta.activeShapeTool : null
        const coordinateMode = normalizeCoordinateMode(currentMeta)
        const axisSpecs = resolveAxisSpecs(currentLayout)
        const newShapeDefaults =
          (currentLayout.newshape as Record<string, unknown> | undefined) ?? {}
        let createdCustomMarkupId: string | null = null

        editsByIndex.forEach((edits, index) => {
          if (!nextShapes[index]) {
            const hasPath = typeof edits.path === 'string'
            const inferredType = hasPath
              ? 'path'
              : activeShapeTool === 'rect' || activeShapeTool === 'circle' || activeShapeTool === 'line'
                ? activeShapeTool
                : activeShapeTool === 'path'
                  ? 'path'
                  : 'line'
            const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            const name = `custom_markup_${id}`
            const base: Record<string, unknown> = {
              type: inferredType,
              xref: 'x',
              yref: 'y',
              ...(newShapeDefaults.line ? { line: newShapeDefaults.line } : {}),
              ...(newShapeDefaults.fillcolor ? { fillcolor: newShapeDefaults.fillcolor } : {}),
              ...(newShapeDefaults.opacity !== undefined
                ? { opacity: newShapeDefaults.opacity }
                : {}),
              meta: { customMarkup: true, id },
              name,
            }
            // Plotly can emit shape creation as keyed relayout entries (`shapes[i].*`).
            // Coordinate normalization is required in this path.
            const createdShape = applyCoordinateModeToShape(
              { ...base, ...edits },
              coordinateMode,
              axisSpecs
            )
            nextShapes[index] = createdShape
            hasChanges = true
            lastEditedCustomShapeRef.current = name
            lastEditedCustomShapeIndexRef.current = index
            createdCustomMarkupId = id
            return
          }

          const existing = (nextShapes[index] as Record<string, unknown> | undefined) ?? {}
          const shapeName = typeof existing.name === 'string' ? existing.name : null
          const isCustom =
            (shapeName && shapeName.startsWith(CUSTOM_MARKUP_PREFIX)) ||
            (typeof existing.meta === 'object' &&
              existing.meta !== null &&
              (existing.meta as { customMarkup?: boolean }).customMarkup === true)
          let didChange = false

          Object.entries(edits).forEach(([key, value]) => {
            let nextValue = value
            if (shapeName && shapeName.startsWith(bracketNamePrefix)) {
              if (key === 'path' && typeof existing.path === 'string' && typeof value === 'string') {
                nextValue = lockBracketPathX(existing.path, value)
              } else if (
                key === 'x0' ||
                key === 'x1' ||
                key === 'x0shift' ||
                key === 'x1shift'
              ) {
                return
              }
            }

            if (existing[key] !== nextValue) {
              existing[key] = nextValue
              didChange = true
            }
          })

          let nextShape = { ...nextShapes[index], ...existing } as Record<string, unknown>
          if (isCustom) {
            nextShape = applyCoordinateModeToShape(nextShape, coordinateMode, axisSpecs)
          }
          const autoModeChanged =
            nextShape.xref !== (nextShapes[index] as Record<string, unknown> | undefined)?.xref ||
            nextShape.yref !== (nextShapes[index] as Record<string, unknown> | undefined)?.yref ||
            nextShape.x0 !== (nextShapes[index] as Record<string, unknown> | undefined)?.x0 ||
            nextShape.x1 !== (nextShapes[index] as Record<string, unknown> | undefined)?.x1 ||
            nextShape.y0 !== (nextShapes[index] as Record<string, unknown> | undefined)?.y0 ||
            nextShape.y1 !== (nextShapes[index] as Record<string, unknown> | undefined)?.y1

          if (didChange || autoModeChanged) {
            nextShapes[index] = nextShape
            if (shapeName && shapeName.startsWith(bracketNamePrefix)) {
              lastEditedBracketRef.current = shapeName
              lastEditedBracketIndexRef.current = index
            }
            if (isCustom) {
              lastEditedCustomShapeRef.current = shapeName
              lastEditedCustomShapeIndexRef.current = index
            }
            hasChanges = true
          }
        })

        if (activeShapeTool) {
          setDrawModePromptVisible(false)
        }

        const baseAnnotations = Array.isArray(layoutUpdates.annotations)
          ? (layoutUpdates.annotations as Array<Record<string, unknown>>)
          : currentAnnotations
        const nextAnnotations = [...baseAnnotations]
        if (syncBracketLabels(nextShapes, nextAnnotations, { clampY: false })) {
          layoutUpdates.annotations = nextAnnotations
        }
        layoutUpdates.shapes = nextShapes
        if (activeShapeTool || createdCustomMarkupId) {
          const existingMeta = ((layoutUpdates.meta ?? currentMeta) as PlotLayoutMeta) ?? {}
          layoutUpdates.meta = {
            ...existingMeta,
            customMarkupEnabled: true,
            shapeCoordinateMode: normalizeCoordinateMode(existingMeta),
            // Auto-exit draw mode after first successful shape creation.
            activeShapeTool: createdCustomMarkupId ? null : existingMeta.activeShapeTool,
            ...(createdCustomMarkupId
              ? { lastCreatedCustomMarkupId: createdCustomMarkupId }
              : {}),
          }
        }
        const bracketBounds = getBracketYBounds(nextShapes)
        const baseYAxis = (layoutUpdates.yaxis ?? currentLayout.yaxis ?? {}) as Partial<Layout['yaxis']>
        const existingRange = Array.isArray(baseYAxis.range) ? baseYAxis.range : null
        if (
          bracketBounds &&
          existingRange &&
          typeof existingRange[0] === 'number' &&
          typeof existingRange[1] === 'number'
        ) {
          const dataYBounds = collectNumericDataBounds('y')
          const zeroAnchoredPlotTypes = new Set([
            'bar',
            'grouped_bar',
            'faceted_grouped_bar',
            'stacked_bar',
          ])
          const shouldAnchorZero = Boolean(latestPlot && zeroAnchoredPlotTypes.has(latestPlot.type))
          const hasDataBounds =
            shouldAnchorZero &&
            dataYBounds &&
            Number.isFinite(dataYBounds.min) &&
            Number.isFinite(dataYBounds.max)
          const allZero =
            hasDataBounds && dataYBounds!.min === 0 && dataYBounds!.max === 0
          let allNegative = hasDataBounds && !allZero && dataYBounds!.max <= 0
          let allPositive = hasDataBounds && !allZero && dataYBounds!.min >= 0
          if (!hasDataBounds && shouldAnchorZero && existingRange) {
            const nearZero = (value: number) => Math.abs(value) < 1e-9
            if (nearZero(existingRange[1]) && existingRange[0] < 0) {
              allNegative = true
            } else if (nearZero(existingRange[0]) && existingRange[1] > 0) {
              allPositive = true
            }
          }
          const yRange = existingRange[1] - existingRange[0]
          const relayoutPlotHeight = Math.max(1, Math.round(canvasHeight * PLOT_CONTENT_SCALE))
          const extraRatio =
            relayoutPlotHeight > 0
              ? Math.max(0.08, (canvasHeight - relayoutPlotHeight) / relayoutPlotHeight)
              : 0.08
          const pad = Math.max(1, Math.abs(yRange) * extraRatio)
          // More lenient threshold: expand when bracket approaches boundary (within full pad)
          const nearTop = bracketBounds.max >= existingRange[1] - pad * 2
          const nearBottom = bracketBounds.min <= existingRange[0] + pad * 2
          let nextMin =
            nearBottom
              ? Math.min(existingRange[0] - pad, bracketBounds.min - pad)
              : existingRange[0]
          let nextMax =
            nearTop
              ? Math.max(existingRange[1] + pad, bracketBounds.max + pad)
              : existingRange[1]

          if (allNegative) {
            nextMax = 0
            nextMin = Math.min(nextMin, 0)
          } else if (allPositive) {
            nextMin = 0
            nextMax = Math.max(nextMax, 0)
          }
          if (nextMin !== existingRange[0] || nextMax !== existingRange[1]) {
            layoutUpdates.yaxis = {
              ...baseYAxis,
              range: [nextMin, nextMax],
              autorange: false,
            }
          }
        }
      }

      const explicitAnnotationClearIntent = hasExplicitAnnotationClearIntent(relayoutData)
      const shouldApplyAnnotationsFromPayload = shouldApplyFullAnnotationPayload(relayoutData)

      // Handle full annotations array update
      if (event.annotations && !layoutUpdates.annotations) {
        const incomingAnnotations = Array.isArray(event.annotations) ? event.annotations : []
        if (incomingAnnotations.length === 0) {
          if (explicitAnnotationClearIntent) {
            const retainedAnnotations = retainAnnotationsAfterClearIntent(
              currentAnnotations as unknown[]
            )
            if (retainedAnnotations.length !== currentAnnotations.length) {
              layoutUpdates.annotations = retainedAnnotations as unknown as Layout['annotations']
              hasChanges = true
            }
          }
        } else if (shouldApplyAnnotationsFromPayload) {
          const mergedAnnotations = mergeAnnotationsByIdentity({
            current: currentAnnotations as unknown[],
            incoming: incomingAnnotations as unknown[],
            rendered: renderedAnnotations as unknown[],
          })
          const normalizedMergedAnnotations = normalizeSystemAnnotationIdentity(
            mergedAnnotations,
            systemAnnotationHints
          ).annotations
          layoutUpdates.annotations = normalizedMergedAnnotations as unknown as Layout['annotations']
          hasChanges = true
        }
      }

      // Sync title fields from the annotation snapshot only when this relayout pass
      // accepted/produced `layoutUpdates.annotations`. This avoids reading transient
      // raw payload arrays that were intentionally ignored by relayout policy.
      const annotationsSnapshot = Array.isArray(layoutUpdates.annotations)
        ? (layoutUpdates.annotations as Array<Record<string, unknown>>)
        : null
      if (annotationsSnapshot) {
        const findAnnotationText = (name: string) => {
          const entry = annotationsSnapshot.find(
            (annotation) => (annotation as { name?: string }).name === name
          ) as { text?: string } | undefined
          return typeof entry?.text === 'string' ? stripPlotlyHtml(entry.text) : null
        }

        if (updates.title === undefined) {
          const titleText = findAnnotationText('_title_')
          if (titleText !== null) {
            updates.title = titleText
          }
        }

        const xTitleText = findAnnotationText('_xaxis_title_')
        if (xTitleText !== null && !layoutUpdates.xaxis) {
          const currentXAxis = (currentLayout.xaxis ?? {}) as Partial<Layout['xaxis']>
          const existingXTitle =
            typeof currentXAxis.title === 'object' ? currentXAxis.title : {}
          layoutUpdates.xaxis = {
            ...(layoutUpdates.xaxis ?? currentXAxis),
            title: { ...existingXTitle, text: xTitleText },
          }
        }

        const yTitleText = findAnnotationText('_yaxis_title_')
        if (yTitleText !== null && !layoutUpdates.yaxis) {
          const currentYAxis = (currentLayout.yaxis ?? {}) as Partial<Layout['yaxis']>
          const existingYTitle =
            typeof currentYAxis.title === 'object' ? currentYAxis.title : {}
          layoutUpdates.yaxis = {
            ...(layoutUpdates.yaxis ?? currentYAxis),
            title: { ...existingYTitle, text: yTitleText },
          }
        }
      }

      if (Array.isArray(event.shapes) && !layoutUpdates.shapes) {
        const incomingShapes = event.shapes.filter(
          (shape): shape is Record<string, unknown> =>
            typeof shape === 'object' && shape !== null
        )
        const currentMeta = ((layoutUpdates.meta ?? currentLayout.meta ?? {}) as PlotLayoutMeta) ?? {}
        const activeShapeTool =
          typeof currentMeta.activeShapeTool === 'string' ? currentMeta.activeShapeTool : null
        const coordinateMode = normalizeCoordinateMode(currentMeta)
        const axisSpecs = resolveAxisSpecs(currentLayout)
        let createdCustomMarkupId: string | null = null
        const nextShapes = incomingShapes.map((shape, index) => {
          const existing = currentShapes[index] as Record<string, unknown> | undefined
          let merged = existing ? { ...existing, ...shape } : { ...shape }
          if (!existing && activeShapeTool) {
            const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            const name = `custom_markup_${id}`
            const meta = (merged.meta as Record<string, unknown> | undefined) ?? {}
            merged.meta = { ...meta, customMarkup: true, id }
            if (typeof merged.name !== 'string') {
              merged.name = name
            }
            createdCustomMarkupId = id
          }
          if (isCustomMarkupShape(merged)) {
            // Plotly can emit full `event.shapes` payloads (without keyed `shapes[i].*` edits).
            // We normalize coordinate mode in this path as well.
            merged = applyCoordinateModeToShape(merged, coordinateMode, axisSpecs)
          }
          return merged
        })
        const eventShapeNames = new Set<string>()
        nextShapes.forEach((shape) => {
          if (shape && typeof shape.name === 'string') {
            eventShapeNames.add(shape.name)
          }
        })
        const removedBracketNames: string[] = []
        currentShapes.forEach((shape) => {
          const name = (shape as { name?: string }).name
          if (!name || !name.startsWith(bracketNamePrefix)) return
          if (!eventShapeNames.has(name)) {
            removedBracketNames.push(name)
          }
        })
        if (removedBracketNames.length > 0) {
          removedBracketNames.forEach((name) => {
            const original = currentShapes.find(
              (shape) => (shape as { name?: string }).name === name
            )
            if (original) {
              nextShapes.push({ ...original, visible: false })
            }
          })
        }
        const baseAnnotations = Array.isArray(layoutUpdates.annotations)
          ? (layoutUpdates.annotations as Array<Record<string, unknown>>)
          : currentAnnotations
        const nextAnnotations = baseAnnotations.map((annotation) => {
          const name = (annotation as { name?: string }).name
          if (name && removedBracketNames.includes(name)) {
            return { ...annotation, visible: false }
          }
          return annotation
        })
        if (syncBracketLabels(nextShapes as Array<Record<string, unknown>>, nextAnnotations)) {
          layoutUpdates.annotations = nextAnnotations
        }
        layoutUpdates.shapes = nextShapes
        if (createdCustomMarkupId) {
          setDrawModePromptVisible(false)
        }
        if (activeShapeTool || createdCustomMarkupId) {
          const existingMeta = ((layoutUpdates.meta ?? currentMeta) as PlotLayoutMeta) ?? {}
          layoutUpdates.meta = {
            ...existingMeta,
            customMarkupEnabled: true,
            shapeCoordinateMode: normalizeCoordinateMode(existingMeta),
            // Auto-exit draw mode after first successful shape creation.
            activeShapeTool: createdCustomMarkupId ? null : existingMeta.activeShapeTool,
            ...(createdCustomMarkupId
              ? { lastCreatedCustomMarkupId: createdCustomMarkupId }
              : {}),
          }
        }
        if (removedBracketNames.length > 0) {
          const nextMeta = ((layoutUpdates.meta ?? currentLayout.meta ?? {}) as PlotLayoutMeta) ?? {}
          const nextVisibility = { ...(nextMeta.bracketVisibility ?? {}) }
          removedBracketNames.forEach((name) => {
            const effectId = resolveBracketEffectId(name, nextMeta)
            if (effectId) {
              nextVisibility[effectId] = false
            }
          })
          layoutUpdates.meta = {
            ...nextMeta,
            bracketVisibility: nextVisibility,
          }
        }
        hasChanges = true
      }

      if (Array.isArray(layoutUpdates.annotations)) {
        const currentMeta = ((layoutUpdates.meta ?? currentLayout.meta ?? {}) as PlotLayoutMeta) ?? {}
        layoutUpdates.meta = deriveSystemAnnotationPositions(
          currentMeta,
          layoutUpdates.annotations as Array<Record<string, unknown>>
        )
      }

      if (hasChanges) {
        const latestBeforeWrite = usePlotsStore.getState().getPlot(plotId)
        const latestLayout = (latestBeforeWrite?.plotlyLayout as Partial<Layout>) ?? currentLayout
        const currentMeta = ((layoutUpdates.meta ?? latestLayout.meta ?? {}) as PlotLayoutMeta) ?? {}
        layoutUpdates.meta = {
          ...currentMeta,
          editRevisionToken: getNextEditRevisionToken(currentMeta),
        }
        updates.plotlyLayout = { ...latestLayout, ...layoutUpdates }
        updatePlot(plotId, updates)
      }
    },
    [plot, updatePlot, canvasHeight]
  )

  // Handle legend text edits (trace names)
  const handleRestyle = useCallback(
    (data: Partial<Data>[], traceIndices: number | number[]) => {
      if (!plot) return

      if (!data[0]) return

      const indices = Array.isArray(traceIndices) ? traceIndices : [traceIndices]
      const plotlyData = [...(plot.plotlyData as Data[])]
      let hasChanges = false

      indices.forEach((idx, i) => {
        const updateEntry = (data[i] ?? data[0]) as Record<string, unknown> | undefined
        if (!updateEntry || !plotlyData[idx]) return

        const newName = updateEntry.name
        const colorbarTitleText =
          updateEntry['colorbar.title.text'] ??
          updateEntry['colorbar.title'] ??
          (typeof updateEntry.colorbar === 'object'
            ? (updateEntry.colorbar as { title?: { text?: string } }).title?.text
            : undefined)

        const trace = plotlyData[idx] as Data & {
          name?: string
          colorbar?: { title?: { text?: string } | string }
        }
        let updatedTrace = trace

        if (typeof newName === 'string' && trace.name !== newName) {
          updatedTrace = { ...updatedTrace, name: newName }
        }

        if (typeof colorbarTitleText === 'string') {
          const existingColorbar = (updatedTrace.colorbar ?? {}) as {
            title?: { text?: string } | string
          }
          const existingTitle =
            typeof existingColorbar.title === 'object'
              ? existingColorbar.title
              : { text: existingColorbar.title }
          if (existingTitle?.text !== colorbarTitleText) {
            updatedTrace = {
              ...updatedTrace,
              colorbar: {
                ...existingColorbar,
                title: { ...(existingTitle ?? {}), text: colorbarTitleText },
              },
            }
          }
        }

        if (updatedTrace !== trace) {
          plotlyData[idx] = updatedTrace
          hasChanges = true
        }
      })

      if (hasChanges) {
        updatePlot(plot.id, { plotlyData })
      }
    },
    [plot, updatePlot]
  )

  // Auto-reposition title for multifactorial ANOVA plots
  const handleInitialized = useCallback(
    (figure: { data: Data[]; layout: Partial<Layout> }, graphDiv: HTMLElement) => {
      if (!plot) return
      graphDivRef.current = graphDiv
      graphDivPlotIdRef.current = plot.id
      ;(graphDiv as { __easycrisPlotId?: string }).__easycrisPlotId = plot.id

      // Only handle multifactorial ANOVA plots (3+ factors)
      const testType = plot.testType
      if (testType !== 'multifactorial_anova') return

      const layoutTitle = typeof figure.layout.title === 'object' ? figure.layout.title : {}
      const explicitTitleY = typeof layoutTitle.y === 'number' && Number.isFinite(layoutTitle.y)
      const titleAutomargin = layoutTitle.automargin === true
      // If the layout already provides an explicit title position (or automargin is disabled),
      // honor it and skip post-render repositioning.
      if (explicitTitleY || !titleAutomargin) return

      // Find the _title_ annotation and facet annotations
      const annotations = Array.isArray(figure.layout.annotations) ? figure.layout.annotations : []
      const titleIndex = annotations.findIndex(
        (a) => typeof a === 'object' && a !== null && (a as { name?: string }).name === '_title_'
      )
      if (titleIndex === -1) return

      // Find facet annotations (Catalyst=A, Catalyst=B, etc.)
      const facetAnnotations = annotations.filter((a) => {
        if (typeof a !== 'object' || a === null) return false
        const text = (a as { text?: string }).text
        if (typeof text !== 'string') return false
        // Facet annotations contain "=" (e.g., "Catalyst=A")
        return text.includes('=') && (a as { name?: string }).name !== '_title_'
      })

      if (facetAnnotations.length === 0) return

      // Get the highest y position among facet annotations
      const facetMaxY = Math.max(
        ...facetAnnotations.map((a) => {
          const y = (a as { y?: number }).y
          return typeof y === 'number' ? y : 0
        })
      )

      // Position title 8% above the highest facet annotation
      const newTitleY = facetMaxY + 0.08

      // Use Plotly.relayout to move the title
      const Plotly = (window as any).Plotly
      if (!Plotly) return

      Plotly.relayout(graphDiv, {
        [`annotations[${titleIndex}].y`]: newTitleY,
      }).catch((err: Error) => {
        console.warn('Failed to reposition title:', err)
      })
    },
    [plot]
  )
  // Empty state
  if (!plot) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center h-full',
          'bg-gradient-to-b from-zinc-50 to-white dark:from-zinc-900 dark:to-zinc-950',
          className
        )}
      >
        <div className="w-24 h-24 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mb-4">
          <svg
            className="w-12 h-12 text-zinc-300 dark:text-zinc-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 15l4-4 4 4 6-6 4 4" />
          </svg>
        </div>
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
          No Plot Selected
        </p>
        <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
          Select from gallery or create new
        </p>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex flex-col h-full min-w-0 bg-[#f8f9fa] dark:bg-zinc-900',
        className
      )}
    >
      {/* Top Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate max-w-[250px]">
            {stripPlotlyHtml(plot.title || 'Untitled')}
          </h3>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-50 dark:bg-cyan-950 text-cyan-700 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-800">
            {template?.displayName || plot.type}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleFullscreen}>
                <ArrowsOut className="h-4 w-4" weight="bold" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fullscreen</TooltipContent>
          </Tooltip>

          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) return
              if (tiffExportUnavailableReason || pdfExportUnavailableReason) {
                refreshKaleidoCapabilities()
              }
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                data-testid="plot-download-button"
                aria-label="Download plot"
              >
                <Download className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="z-[1200]">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ImageIcon className="h-4 w-4 mr-2" weight="bold" />
                  Export as PNG
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onClick={() => handleExport('png')}>
                    Screen (96 DPI)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport('png', { dpi: 300 })}>
                    300 DPI
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExport('png', { dpi: 600 })}>
                    600 DPI
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onClick={() => handleExport('jpg')}>
                <ImageIcon className="h-4 w-4 mr-2" weight="bold" />
                Export as JPG
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('webp')}>
                <ImageIcon className="h-4 w-4 mr-2" weight="bold" />
                Export as WEBP
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={Boolean(tiffExportUnavailableReason)}>
                  <ImageIcon className="h-4 w-4 mr-2" weight="bold" />
                  Export as TIFF{tiffExportUnavailableReason ? ' (Unavailable)' : ''}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    onClick={() => handleExport('tiff', { dpi: 96 })}
                    disabled={Boolean(tiffExportUnavailableReason)}
                    title={tiffExportUnavailableReason ?? undefined}
                  >
                    Screen (96 DPI)
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExport('tiff', { dpi: 300 })}
                    disabled={Boolean(tiffExportUnavailableReason)}
                    title={tiffExportUnavailableReason ?? undefined}
                  >
                    300 DPI
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleExport('tiff', { dpi: 600 })}
                    disabled={Boolean(tiffExportUnavailableReason)}
                    title={tiffExportUnavailableReason ?? undefined}
                  >
                    600 DPI
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onClick={() => handleExport('svg')}>
                <FileCode className="h-4 w-4 mr-2" weight="bold" />
                Export as SVG
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleExport('pdf')}
                disabled={Boolean(pdfExportUnavailableReason)}
                title={pdfExportUnavailableReason ?? undefined}
              >
                <FileDoc className="h-4 w-4 mr-2" weight="bold" />
                Export as PDF{pdfExportUnavailableReason ? ' (Unavailable)' : ''}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('html')}>
                <FileDoc className="h-4 w-4 mr-2" weight="bold" />
                Export as HTML
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('json')}>
                <FileCode className="h-4 w-4 mr-2" weight="bold" />
                Export as JSON
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Plot Area with White Space */}
      <div
        ref={plotAreaRef}
        className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6"
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={plotContainerRef}
              className="relative overflow-hidden bg-white dark:bg-zinc-950 rounded-lg shadow-sm border border-zinc-200 dark:border-zinc-800"
              style={containerStyle}
              data-testid="plot-container"
            >
              <PlotlyLazy
                data={renderedData}
                layout={finalLayout}
                config={finalConfig}
                style={{ width: '100%', height: '100%' }}
                onInitialized={handleInitialized}
                onRelayout={handleRelayout}
                onRestyle={handleRestyle as any}
              />

              {drawModeLabel && drawModePromptVisible && (
                <div
                  className="pointer-events-none absolute z-[9] rounded-md border border-dashed border-amber-300/70 bg-amber-100/25 dark:border-amber-700/60 dark:bg-amber-900/15"
                  style={drawAreaRect}
                  aria-hidden="true"
                />
              )}

              {drawModeLabel && drawModePromptVisible && (
                <div
                  className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-full bg-amber-50/90 dark:bg-amber-950/80 text-amber-700 dark:text-amber-200 border border-amber-200 dark:border-amber-800 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide shadow-sm"
                  role="status"
                  aria-live="polite"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" aria-hidden="true" />
                  Draw Mode: {drawModeLabel}
                </div>
              )}

              {/* Hidden stats node for E2E - FULL PAYLOAD */}
              <div
                data-plot-stats
                data-plot-type={
                  plot.type === 'faceted_grouped_bar'
                    ? 'grouped_bar'
                    : typeof (plot.plotlyLayout as { meta?: Record<string, unknown> } | undefined)?.meta?.plotType === 'string'
                      ? String((plot.plotlyLayout as { meta?: Record<string, unknown> } | undefined)?.meta?.plotType)
                      : plot.type
                }
                data-plot-id={plot.id}
                data-source-type={plot.sourceType}
                data-test-type={plot.testType ?? ''}
                data-data-policy={plot.dataPolicy}
                style={{ display: 'none' }}
                {...Object.fromEntries(
                  Object.entries({ ...computedPlotStats, ...computedStats })
                    .map(([key, value]) => {
                      const attrKey = toDataAttributeKey(key)
                      return attrKey ? [attrKey, String(value)] : null
                    })
                    .filter((entry): entry is [string, string] => Boolean(entry))
                )}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <ImageIcon className="h-4 w-4 mr-2" weight="bold" />
                Export as PNG
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onClick={() => handleExport('png')}>
                  Screen (96 DPI)
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleExport('png', { dpi: 300 })}>
                  300 DPI
                </ContextMenuItem>
                <ContextMenuItem onClick={() => handleExport('png', { dpi: 600 })}>
                  600 DPI
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={Boolean(tiffExportUnavailableReason)}>
                <ImageIcon className="h-4 w-4 mr-2" weight="bold" />
                Export as TIFF{tiffExportUnavailableReason ? ' (Unavailable)' : ''}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem
                  onClick={() => handleExport('tiff', { dpi: 96 })}
                  disabled={Boolean(tiffExportUnavailableReason)}
                >
                  Screen (96 DPI)
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => handleExport('tiff', { dpi: 300 })}
                  disabled={Boolean(tiffExportUnavailableReason)}
                >
                  300 DPI
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => handleExport('tiff', { dpi: 600 })}
                  disabled={Boolean(tiffExportUnavailableReason)}
                >
                  600 DPI
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem onClick={() => handleExport('svg')}>
              <FileCode className="h-4 w-4 mr-2" weight="bold" />
              Export as SVG
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => handleExport('pdf')}
              disabled={Boolean(pdfExportUnavailableReason)}
            >
              <FileDoc className="h-4 w-4 mr-2" weight="bold" />
              Export as PDF{pdfExportUnavailableReason ? ' (Unavailable)' : ''}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      {/* Bottom Controls: Scale */}
      <div className="flex items-center justify-center gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        {/* Scale Controls */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={handleScaleDown}
              disabled={scale <= SCALE_MIN}
            >
              <MagnifyingGlassMinus className="h-4 w-4" weight="bold" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Scale Down</TooltipContent>
        </Tooltip>

        <div className="w-36 flex items-center gap-2">
          <Slider
            value={[scale]}
            min={SCALE_MIN}
            max={SCALE_MAX}
            step={SCALE_STEP}
            onValueChange={handleSliderChange}
            className="flex-1"
          />
          <span className="text-xs font-mono text-zinc-500 w-10 text-right">
            {Math.round(scale * 100)}%
          </span>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={handleScaleUp}
              disabled={scale >= SCALE_MAX}
            >
              <MagnifyingGlassPlus className="h-4 w-4" weight="bold" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Scale Up</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleScaleReset}
            >
              <ArrowCounterClockwise className="h-4 w-4" weight="bold" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset Scale (100%)</TooltipContent>
        </Tooltip>
      </div>

      {/* Footer Metadata */}
      <div className="px-4 py-1.5 border-t border-zinc-200 dark:border-zinc-800 text-[10px] font-mono text-zinc-400 flex items-center gap-4">
        <span>
          Source:{' '}
          <span
            className={
              plot.sourceType === 'test_result' ? 'text-cyan-600' : 'text-emerald-600'
            }
          >
            {plot.sourceType === 'test_result'
              ? plot.testType?.replace(/_/g, ' ')
              : 'User derived'}
          </span>
        </span>
        <span>Policy: {plot.dataPolicy}</span>
        <span>Created: {new Date(plot.createdAt).toLocaleDateString()}</span>
      </div>
    </div>
  )
}

export default PlotCanvas





