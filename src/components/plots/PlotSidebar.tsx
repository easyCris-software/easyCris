/**
 * PlotSidebar Component - Right sidebar with tabbed settings
 *
 * Features:
 * - 3 tabs: Colors, Axes, Data
 * - Axes tab includes: Title, X/Y axis, Legend
 * - Trace color picker with immediate legend update
 * - Pattern support for bars (Plotly marker.pattern)
 * - Grid off by default
 * - Phosphor icons
 */

import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { debounce } from 'lodash'
import { useShallow } from 'zustand/react/shallow'
import type { Layout, Data } from 'plotly.js'
import { Axis3d, Table2, BracesIcon, Shapes } from 'lucide-react'
import { Palette, TrendUp } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { computeTrendline, type TrendlineStats } from '@/services/plotBackendService'
import { cn } from '@/lib/utils'
import { usePlotsStore } from '@/store/plots-store'
import { useResultsStore } from '@/store/results-store'
import { rebuildTestResultPlot } from '@/services/plotResultService'
import { normalizeTestId } from '@/services/plotResult/common/normalize'
import { createDefaultBracketSettings, getBracketLabel } from '@/utils/plotBuilders/types'
import { useAppStore } from '@/store/app-store'
import { getPlotTemplate } from '@/config/plotRegistry'
import { getEffectiveShowLegend } from '@/utils/plotDisplayDefaults'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { getPlotBuilder } from '@/utils/plotBuilders'
import { applyAlpha, DEFAULT_COLORS, formatBracketLabel } from '@/utils/plotBuilders/common'
import type { PlotLayoutMeta } from '@/utils/plotBuilders/types'
import {
  interpolateDoseResponse,
  normalizeDoseResponseInterpolationModel,
  type DoseResponseInterpolationContext,
  type DoseResponseInterpolationMode,
  type DoseResponseInterpolationStatus,
} from '@/lib/pharmacology/doseResponseInterpolation'
import {
  getDoseInterpolationGuideStart,
  getNextAxisRevisionToken,
  isDoseResponseAxisCorrupted,
  sanitizeDoseResponseXAxis,
  shouldRejectDoseInterpolationByStabilityCap,
  stabilizeDoseResponseXAxisForInterpolation,
} from '@/lib/pharmacology/doseResponseAxis'
import {
  MAX_BATCH_INTERPOLATION_VALUES,
  parseBatchInterpolationInput,
} from '@/lib/pharmacology/doseResponseInterpolationBatch'
import {
  applyColorToAllBarCategories,
  extractBarCategoryStyles,
  getBarCategoryLabels as getBarCategoryLabelsFromTrace,
  setBarCategoryColor,
  setBarCategoryFrame,
  setBarCategoryPattern,
  setBarCategoryPatternSize,
  setBarCategoryPatternSolidity,
  type BarPatternShape,
} from '@/lib/plots/barCategoryStyles'
import { getBarOutlineEnabledFromWidth } from '@/lib/plots/barOutlineState'
import { normalizeBarSplitTraces } from '@/lib/plots/barSplitTraceNormalization'
import {
  SYSTEM_ANNOTATION_NAME_SET,
  getSystemAnnotationTextHints,
  mergeAnnotationsByIdentity,
  normalizeSystemAnnotationIdentity,
} from '@/lib/plots/annotationPersistence'
import { resolvePlotDisplayTitle } from './plotTitle'
import { ShapesAnnotationsEditor } from './ShapesAnnotationsEditor'
import { useViewportMode } from '@/hooks/useViewportMode'
import exportService from '@/services/exportService'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'

// ============================================================================
// Types & Constants
// ============================================================================

export interface PlotSidebarProps {
  className?: string
}

const TRENDLINE_TYPES = ['linear', 'polynomial'] as const
type TrendlineType = (typeof TRENDLINE_TYPES)[number]

// Plotly pattern shapes for bar fills
const PATTERN_OPTIONS = [
  { value: 'solid', label: 'Solid' },
  { value: '/', label: 'Diagonal /' },
  { value: '\\', label: 'Diagonal \\' },
  { value: 'x', label: 'Cross-hatch' },
  { value: '+', label: 'Plus +' },
  { value: '-', label: 'Horizontal -' },
  { value: '|', label: 'Vertical |' },
  { value: '.', label: 'Dots' },
] as const

// Plotly line dash styles (for line/scatter traces)
const LINE_STYLE_OPTIONS = [
  { value: 'solid', label: 'Solid ━━━━━' },
  { value: 'dash', label: 'Dashed ╌   ╌   ╌' },
  { value: 'dot', label: 'Dotted ·   ·   ·' },
  { value: 'dashdot', label: 'Dash-Dot ╌ · ╌' },
] as const

const OUTLINE_FALLBACK = '#000000'
const INTERPOLATION_TRACE_ROLE = 'dose_interpolation_point'
const INTERPOLATION_SHAPE_NAMES = new Set([
  'dose_interp_vline',
  'dose_interp_hline',
])
const INTERPOLATION_ANNOTATION_NAME = 'dose_interp_label'
const INTERPOLATION_PANEL_SINGLE_ROW_MIN_WIDTH = 320

type InterpolationEntryMode = 'single' | 'batch'
type BatchInterpolationStatus =
  | DoseResponseInterpolationStatus
  | 'stability_guardrail'

interface BatchInterpolationResultRow {
  input: number
  output: number | null
  status: BatchInterpolationStatus
  extrapolated: boolean
  message: string
  mode: DoseResponseInterpolationMode
  x: number | null
  y: number | null
}

// Available plot fonts (loaded via fonts.css)
const PLOT_FONTS = [
  // Sans-Serif
  { value: 'Inter', label: 'Inter' },
  { value: 'Lato', label: 'Lato' },
  { value: 'Open Sans', label: 'Open Sans' },
  { value: 'Noto Sans', label: 'Noto Sans' },
  { value: 'PT Sans', label: 'PT Sans' },
  { value: 'Source Sans 3', label: 'Source Sans 3' },
  { value: 'Nunito Sans', label: 'Nunito Sans' },
  { value: 'Liberation Sans', label: 'Liberation Sans' },
  { value: 'Arimo', label: 'Arimo' },
  // Serif (Publications)
  { value: 'Tinos', label: 'Tinos' },
  { value: 'Roboto Slab', label: 'Roboto Slab' },
  // Monospace
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
] as const

const FONT_ALIASES: Record<string, string> = {
  Arial: 'Arimo',
  'Times New Roman': 'Tinos',
  'Source Sans Pro': 'Source Sans 3',
}

const resolveFontFamily = (font?: string) => {
  if (font && PLOT_FONTS.some((candidate) => candidate.value === font)) {
    return font
  }
  if (font && FONT_ALIASES[font]) {
    return FONT_ALIASES[font]
  }
  return 'Inter'
}

// Common font sizes for publications
const FONT_SIZES = [10, 11, 12, 14, 16, 18, 24, 36] as const

const QUICK_TRACE_COLORS = [
  ...DEFAULT_COLORS.slice(0, 5),
  '#000000',
  '#ffffff',
]

const parseColorToRgb = (color: string): { r: number; g: number; b: number } | null => {
  const normalized = color.trim().toLowerCase()
  if (normalized.startsWith('#')) {
    const hex = normalized.slice(1)
    if (hex.length === 3) {
      const c0 = hex[0] ?? '0'
      const c1 = hex[1] ?? '0'
      const c2 = hex[2] ?? '0'
      const r = parseInt(c0 + c0, 16)
      const g = parseInt(c1 + c1, 16)
      const b = parseInt(c2 + c2, 16)
      return { r, g, b }
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      return { r, g, b }
    }
    return null
  }

  const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/)
  if (rgbMatch && rgbMatch[1]) {
    const parts = rgbMatch[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length >= 3) {
      const r = Number(parts[0])
      const g = Number(parts[1])
      const b = Number(parts[2])
      if ([r, g, b].every((value) => Number.isFinite(value))) {
        return { r, g, b }
      }
    }
  }

  return null
}

const getPatternLineColor = (color: string): string => {
  const rgb = parseColorToRgb(color)
  if (!rgb) return '#ffffff'
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
  return luminance > 0.6 ? '#000000' : '#ffffff'
}

const formatColorForInput = (color?: string): string => {
  if (!color) return '#000000'
  const trimmed = color.trim()
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1)
    if (hex.length === 6) return `#${hex}`
    if (hex.length === 3) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    }
  }
  const rgb = parseColorToRgb(trimmed)
  if (!rgb) return '#000000'
  const value = ((rgb.r & 0xff) << 16) | ((rgb.g & 0xff) << 8) | (rgb.b & 0xff)
  return `#${value.toString(16).padStart(6, '0')}`
}

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

const formatDoseInterpolationValue = (value: number): string => {
  if (!Number.isFinite(value)) return 'NA'
  const abs = Math.abs(value)
  if (abs >= 10000 || (abs > 0 && abs < 0.0001)) {
    return value.toExponential(4)
  }
  return Number(value.toFixed(6)).toString()
}

const formatBatchInterpolationStatus = (status: BatchInterpolationStatus): string => {
  if (status === 'stability_guardrail') return 'guardrail'
  return status
}

const normalizeStoredInterpolationMode = (
  value: unknown
): DoseResponseInterpolationMode | null => {
  if (value === 'forward' || value === 'inverse') return value
  return null
}

const normalizeStoredBatchInterpolationStatus = (value: unknown): BatchInterpolationStatus => {
  if (value === 'stability_guardrail' || value === 'guardrail') {
    return 'stability_guardrail'
  }
  if (value === 'ok' || value === 'invalid_input' || value === 'out_of_range' || value === 'no_solution') {
    return value
  }
  return 'invalid_input'
}

const parseStoredBatchInterpolationResults = ({
  raw,
  fallbackMode,
}: {
  raw: unknown
  fallbackMode: DoseResponseInterpolationMode
}): BatchInterpolationResultRow[] => {
  if (typeof raw !== 'string' || raw.trim().length === 0) return []

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed
      .slice(0, MAX_BATCH_INTERPOLATION_VALUES)
      .flatMap((entry): BatchInterpolationResultRow[] => {
        if (!entry || typeof entry !== 'object') return []

        const input = toFiniteNumber((entry as { input?: unknown }).input)
        if (input === null) return []

        const output = toFiniteNumber((entry as { output?: unknown }).output)
        const mode =
          normalizeStoredInterpolationMode((entry as { mode?: unknown }).mode) ?? fallbackMode
        const status = normalizeStoredBatchInterpolationStatus(
          (entry as { status?: unknown }).status
        )
        const extrapolatedRaw = (entry as { extrapolated?: unknown }).extrapolated
        const extrapolated = extrapolatedRaw === true || extrapolatedRaw === 'true'
        const messageRaw = (entry as { message?: unknown }).message
        const message =
          typeof messageRaw === 'string' && messageRaw.trim().length > 0
            ? messageRaw
            : status === 'ok'
              ? 'Interpolation completed.'
              : 'Interpolation could not be computed.'

        if (output === null) {
          return [
            {
              input,
              output: null,
              status,
              extrapolated,
              message,
              mode,
              x: null,
              y: null,
            },
          ]
        }

        const derivedX = mode === 'forward' ? input : output
        const derivedY = mode === 'forward' ? output : input

        return [
          {
            input,
            output,
            status,
            extrapolated,
            message,
            mode,
            x: toFiniteNumber((entry as { x?: unknown }).x) ?? derivedX,
            y: toFiniteNumber((entry as { y?: unknown }).y) ?? derivedY,
          },
        ]
      })
  } catch {
    return []
  }
}

const getRowInterpolationLabel = ({
  input,
  output,
  mode,
}: {
  input: number
  output: number
  mode: DoseResponseInterpolationMode
}): string =>
  mode === 'forward'
    ? `y=${formatDoseInterpolationValue(output)} @ x=${formatDoseInterpolationValue(input)}`
    : `x=${formatDoseInterpolationValue(output)} @ y=${formatDoseInterpolationValue(input)}`

const getInterpolationPaperLabelPosition = (
  annotations: Partial<Layout['annotations']> | undefined
): { x: number; y: number } => {
  const fallback = { x: 0.86, y: 0.08 }
  if (!Array.isArray(annotations)) return fallback

  const ic50Label = annotations.find((annotation) => {
    if (!annotation || typeof annotation !== 'object') return false
    const name = (annotation as { name?: unknown }).name
    return name === 'ic50_label'
  }) as { x?: unknown; y?: unknown } | undefined

  if (!ic50Label) return fallback

  const x = toFiniteNumber(ic50Label.x)
  const y = toFiniteNumber(ic50Label.y)
  if (x === null || y === null) return fallback

  return {
    x: Math.min(0.98, Math.max(0.02, x)),
    y: Math.min(0.95, Math.max(0.02, y - 0.06)),
  }
}

// ============================================================================
// Component
// ============================================================================

export function PlotSidebar({ className }: PlotSidebarProps) {
  const { isConstrained } = useViewportMode()
  const activeTab = useAppStore((state) => state.plotSidebarTab)
  const setActiveTab = useAppStore((state) => state.setPlotSidebarTab)
  const [trendlineLoading, setTrendlineLoading] = useState(false)
  const [trendlineType, setTrendlineType] = useState<TrendlineType>('linear')
  const [trendlineDegree, setTrendlineDegree] = useState(2)
  const [interpolationEntryMode, setInterpolationEntryMode] =
    useState<InterpolationEntryMode>('single')
  const [interpolationMode, setInterpolationMode] =
    useState<DoseResponseInterpolationMode>('forward')
  const [interpolationInput, setInterpolationInput] = useState('')
  const [batchInterpolationInput, setBatchInterpolationInput] = useState('')
  const [batchInterpolationResults, setBatchInterpolationResults] = useState<
    BatchInterpolationResultRow[]
  >([])
  const [selectedInterpolationIndex, setSelectedInterpolationIndex] = useState<number | null>(
    null
  )
  const [isInterpolationNarrow, setIsInterpolationNarrow] = useState(false)
  const [allowInterpolationExtrapolation, setAllowInterpolationExtrapolation] = useState(false)
  const [interpolationFeedback, setInterpolationFeedback] = useState<{
    level: 'success' | 'warning' | 'error'
    message: string
  } | null>(null)
  const interpolationCardRef = useRef<HTMLDivElement | null>(null)
  const lastTrendlineRequestRef = useRef<{
    plotId: string
    type: TrendlineType
    degree: number
  } | null>(null)

  // Store state
  const { activePlot, updatePlot, getPlotStats, setPlotStats } = usePlotsStore(
    useShallow((state) => ({
      activePlot: state.getActivePlot(),
      updatePlot: state.updatePlot,
      getPlotStats: state.getPlotStats,
      setPlotStats: state.setPlotStats,
    }))
  )
  const getResult = useResultsStore((state) => state.getResult)
  const template = activePlot ? getPlotTemplate(activePlot.type) : null
  const resolvedDisplayTitle = useMemo(
    () => resolvePlotDisplayTitle(activePlot),
    [activePlot]
  )

  // Memoized layout and data
  const layout = useMemo<Partial<Layout>>(() => {
    return (activePlot?.plotlyLayout as Partial<Layout>) ?? {}
  }, [activePlot])

  const plotData = useMemo<Data[]>(() => {
    return (activePlot?.plotlyData as Data[]) ?? []
  }, [activePlot])
  const migratedUserBarPlotIdsRef = useRef<Set<string>>(new Set())

  // Phase 2 migration: normalize legacy single-trace user-derived bar plots to split traces.
  useEffect(() => {
    if (!activePlot) return
    if (activePlot.sourceType !== 'user_derived' || activePlot.type !== 'bar') return
    if (migratedUserBarPlotIdsRef.current.has(activePlot.id)) return
    const currentData = (activePlot.plotlyData as Data[]) ?? []
    if (!Array.isArray(currentData) || currentData.length === 0) return
    const normalized = normalizeBarSplitTraces(currentData)
    migratedUserBarPlotIdsRef.current.add(activePlot.id)
    if (!normalized.changed) return
    updatePlot(activePlot.id, { plotlyData: normalized.data })
  }, [activePlot?.id, activePlot?.sourceType, activePlot?.type, updatePlot])

  const gridUserSet = Boolean(
    (layout as { meta?: { gridUserSet?: boolean } }).meta?.gridUserSet
  )
  const barCategoryCount = useMemo(() => {
    if (plotData.length === 0) return 0
    const categories = new Set<string>()
    plotData.forEach((trace) => {
      const t = trace as any
      if (t.type !== 'bar') return
      const xValues = Array.isArray(t.x) ? t.x : []
      xValues.forEach((value: unknown) => {
        if (value !== null && value !== undefined) {
          categories.add(String(value))
        }
      })
    })
    return categories.size
  }, [plotData])

  const showBarSpacingControls =
    ['grouped_bar', 'faceted_grouped_bar', 'stacked_bar'].includes(activePlot?.type ?? '') ||
    (activePlot?.type === 'bar' && barCategoryCount > 1)
  const showGroupGapControl = ['grouped_bar', 'faceted_grouped_bar', 'stacked_bar'].includes(
    activePlot?.type ?? ''
  )
  const groupGapLabel = activePlot?.type === 'stacked_bar' ? 'Within stacks' : 'Within groups'
  const currentBarGap = typeof layout.bargap === 'number' ? layout.bargap : 0.6
  const currentGroupGap =
    typeof layout.bargroupgap === 'number' ? layout.bargroupgap : 0.15
  const showFrameToggle = ['bar', 'grouped_bar', 'faceted_grouped_bar', 'stacked_bar'].includes(
    activePlot?.type ?? ''
  )
  const layoutMeta = (layout.meta ?? {}) as PlotLayoutMeta
  const meansType =
    (layout.meta as { meansType?: string; means_type?: string } | undefined)?.meansType ??
    (layout.meta as { meansType?: string; means_type?: string } | undefined)?.means_type
  const isEstimatedMeans = meansType === 'lsmean'
  const showCiBand = layoutMeta.showCiBand ?? true
  const showIc50Label = layoutMeta.showIc50Label ?? true
  const showFittedPoints = layoutMeta.showFittedPoints ?? false
  const showObservedPoints = layoutMeta.showObservedPoints ?? true
  const confidenceBandLabel = layoutMeta.confidenceBandLabel
  const showConfidenceBand = layoutMeta.showConfidenceBand ?? true
  const hasConfidenceBand = typeof confidenceBandLabel === 'string' && confidenceBandLabel.trim().length > 0
  const frameEnabled = useMemo(() => {
    if (typeof layoutMeta.frameEnabled === 'boolean') return layoutMeta.frameEnabled
    const xAxis = layout.xaxis as Partial<Layout['xaxis']> | undefined
    const yAxis = layout.yaxis as Partial<Layout['yaxis']> | undefined
    const xFrame = Boolean(xAxis?.showline && (xAxis as any)?.mirror)
    const yFrame = Boolean(yAxis?.showline && (yAxis as any)?.mirror)
    return xFrame && yFrame
  }, [layoutMeta.frameEnabled, layout.xaxis, layout.yaxis])
  const disableColorsTab = activePlot?.type === 'synergy_contour' || activePlot?.type === 'synergy_heatmap'

  useEffect(() => {
    if (disableColorsTab && activeTab === 'colors') {
      setActiveTab('axes')
    }
  }, [disableColorsTab, activeTab, setActiveTab])
  // Error bar type restrictions per test type
  const isKruskalBar =
    activePlot?.sourceType === 'test_result' &&
    normalizeTestId(activePlot.testType ?? '') === 'kruskal_wallis' &&
    activePlot.type === 'bar'

  const isSRHBar =
    activePlot?.sourceType === 'test_result' &&
    normalizeTestId(activePlot.testType ?? '') === 'scheirer_ray_hare' &&
    activePlot.type === 'grouped_bar'

  const normalizedTestType = activePlot?.testType
    ? normalizeTestId(activePlot.testType)
    : undefined

  const isOneWayBar =
    activePlot?.sourceType === 'test_result' &&
    normalizedTestType === 'anova_one_way' &&
    (activePlot.type === 'bar' || activePlot.type === 'grouped_bar')

  // T-tests: parametric tests showing means - IQR not valid
  const isTTestBar =
    activePlot?.sourceType === 'test_result' &&
    (normalizedTestType === 't_test_two_sample' ||
      normalizedTestType === 't_test_paired' ||
      normalizedTestType === 't_test_one_sample') &&
    activePlot.type === 'bar'

  const isTwoWayBar =
    activePlot?.sourceType === 'test_result' &&
    normalizedTestType === 'anova_two_way' &&
    (activePlot.type === 'bar' || activePlot.type === 'grouped_bar')

  const isMultifactorialBar =
    activePlot?.sourceType === 'test_result' &&
    normalizedTestType === 'multifactorial_anova' &&
    (activePlot.type === 'bar' || activePlot.type === 'grouped_bar')

  // Mann-Whitney: non-parametric test showing medians - IQR only
  const isMannWhitneyBar =
    activePlot?.sourceType === 'test_result' &&
    normalizedTestType === 'mann_whitney_u' &&
    activePlot.type === 'bar'

  const isMannWhitneyColumnScatter =
    activePlot?.sourceType === 'test_result' &&
    normalizedTestType === 'mann_whitney_u' &&
    activePlot.type === 'column_scatter'

  const isTTestColumnScatter =
    activePlot?.sourceType === 'test_result' &&
    (normalizedTestType === 't_test_two_sample' ||
      normalizedTestType === 't_test_paired' ||
      normalizedTestType === 't_test_one_sample') &&
    activePlot.type === 'column_scatter'

  const isColumnScatter = activePlot?.type === 'column_scatter'
  const isMosaicPlot = activePlot?.type === 'mosaic'
  const isDoseResponse =
    activePlot?.sourceType === 'test_result' &&
    (activePlot.testType === 'dose_response_3pl' ||
      activePlot.testType === 'dose_response_4pl' ||
      activePlot.testType === 'dose_response_5pl')

  const doseInterpolationContext = useMemo<DoseResponseInterpolationContext | null>(() => {
    if (!activePlot || !isDoseResponse) return null
    const model = normalizeDoseResponseInterpolationModel(activePlot.testType)
    if (!model) return null

    const stats = getPlotStats(activePlot.id)
    const statBottom = toFiniteNumber(stats?.bottom)
    const statTop = toFiniteNumber(stats?.top)
    const statIc50 = toFiniteNumber(stats?.ic50)
    const statHill = toFiniteNumber(stats?.hill)

    let bottom = statBottom
    let top = statTop
    let ic50 = statIc50
    let hill = statHill

    const result = activePlot.resultId ? getResult(activePlot.resultId) : null
    const raw = result?.rawOutput as
      | Record<string, unknown>
      | { results?: Record<string, unknown> }
      | string
      | undefined
    let payload: Record<string, unknown> | null = null
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        payload =
          parsed && typeof parsed.results === 'object' && parsed.results !== null
            ? (parsed.results as Record<string, unknown>)
            : parsed
      } catch {
        payload = null
      }
    } else if (raw && typeof raw === 'object') {
      payload =
        raw.results && typeof raw.results === 'object'
          ? (raw.results as Record<string, unknown>)
          : (raw as Record<string, unknown>)
    }

    if (bottom === null || top === null || ic50 === null || hill === null) {
      const parameters =
        payload && typeof payload.parameters === 'object' && payload.parameters !== null
          ? (payload.parameters as Record<string, { value?: unknown }>)
          : null
      if (bottom === null) bottom = toFiniteNumber(parameters?.bottom?.value)
      if (top === null) top = toFiniteNumber(parameters?.top?.value)
      if (ic50 === null) ic50 = toFiniteNumber(parameters?.ic50?.value)
      if (hill === null) hill = toFiniteNumber(parameters?.hill?.value)
    }

    if (bottom === null || top === null || ic50 === null || hill === null) return null

    const observedTrace = plotData.find((trace) => {
      const meta = (trace as { meta?: { role?: string } }).meta
      return meta?.role === 'observed_points'
    }) as (Data & { x?: unknown[] }) | undefined
    const observedXValues: unknown[] = Array.isArray(observedTrace?.x) ? observedTrace.x : []
    const observedX = observedXValues
      .map((value: unknown) => toFiniteNumber(value))
      .filter((value: number | null): value is number => value !== null && value > 0)

    if (observedX.length === 0 && payload) {
      const fallbackDoseValues = Array.isArray(payload.input_doses)
        ? payload.input_doses
        : Array.isArray(payload.doses)
          ? payload.doses
          : []
      fallbackDoseValues.forEach((value) => {
        const parsed = toFiniteNumber(value)
        if (parsed !== null && parsed > 0) {
          observedX.push(parsed)
        }
      })
    }

    const observedDoseRange =
      observedX.length > 0
        ? ([Math.min(...observedX), Math.max(...observedX)] as [number, number])
        : null

    return {
      model,
      parameters: { bottom, top, ic50, hill },
      observedDoseRange,
    }
  }, [activePlot, getPlotStats, getResult, isDoseResponse, plotData])

  useEffect(() => {
    setInterpolationEntryMode('single')
    setInterpolationMode('forward')
    setInterpolationInput('')
    setBatchInterpolationInput('')
    setBatchInterpolationResults([])
    setSelectedInterpolationIndex(null)
    setAllowInterpolationExtrapolation(false)
    setInterpolationFeedback(null)

    if (!activePlot) return
    const stats = getPlotStats(activePlot.id) ?? {}
    const persistedMode = normalizeStoredInterpolationMode(stats.interpolation_mode) ?? 'forward'
    setInterpolationMode(persistedMode)

    const persistedInput = stats.interpolation_input
    if (typeof persistedInput === 'number' || typeof persistedInput === 'string') {
      const asText = String(persistedInput).trim()
      if (asText.length > 0) {
        setInterpolationInput(asText)
      }
    }

    const restoredRows = parseStoredBatchInterpolationResults({
      raw: stats.interpolation_results_json,
      fallbackMode: persistedMode,
    })
    if (restoredRows.length === 0) return

    setInterpolationEntryMode('batch')
    setBatchInterpolationResults(restoredRows)
    setBatchInterpolationInput(
      restoredRows.map((row) => formatDoseInterpolationValue(row.input)).join('\n')
    )

    const preferredSelected =
      toFiniteNumber(stats.selected_interpolation_index) ??
      toFiniteNumber(stats.interpolation_selected_index)
    const normalizedSelected =
      preferredSelected !== null ? Math.max(0, Math.floor(preferredSelected)) : null
    if (normalizedSelected !== null && normalizedSelected < restoredRows.length) {
      setSelectedInterpolationIndex(normalizedSelected)
    }
  }, [activePlot?.id, getPlotStats])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      setIsInterpolationNarrow(isConstrained)
      return
    }

    const node = interpolationCardRef.current
    if (!node) {
      setIsInterpolationNarrow(isConstrained)
      return
    }

    const updateNarrowState = (width: number) => {
      setIsInterpolationNarrow(width < INTERPOLATION_PANEL_SINGLE_ROW_MIN_WIDTH)
    }

    updateNarrowState(node.getBoundingClientRect().width)

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      updateNarrowState(entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [activePlot?.id, isConstrained, activeTab])

  const observedDoseRangeLabel = useMemo(() => {
    if (!doseInterpolationContext?.observedDoseRange) return null
    const [minDose, maxDose] = doseInterpolationContext.observedDoseRange
    return `[${formatDoseInterpolationValue(minDose)}, ${formatDoseInterpolationValue(maxDose)}]`
  }, [doseInterpolationContext?.observedDoseRange])

  const forwardInterpolationRangeStatus = useMemo(() => {
    if (
      interpolationEntryMode !== 'single' ||
      !doseInterpolationContext?.observedDoseRange ||
      interpolationMode !== 'forward'
    ) {
      return null
    }
    const parsed = Number(interpolationInput)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    const [minDose, maxDose] = doseInterpolationContext.observedDoseRange
    return parsed < minDose || parsed > maxDose ? 'Extrapolated' : 'In range'
  }, [
    doseInterpolationContext?.observedDoseRange,
    interpolationEntryMode,
    interpolationInput,
    interpolationMode,
  ])

  const parsedBatchInterpolationPreview = useMemo(
    () => parseBatchInterpolationInput(batchInterpolationInput),
    [batchInterpolationInput]
  )

  // Policy: Lock error bar options based on statistical validity
  // - Kruskal-Wallis/SRH/Mann-Whitney: IQR only (non-parametric, shows medians)
  // - T-tests: SE, SD, CI (parametric, shows means - IQR not valid)
  // - One-Way ANOVA: SE only (pooled error; lock out SD/CI)
  // - Two-Way ANOVA: SE only (pooled error; lock out SD/CI)
  // - Multifactorial: SE only (pooled error; lock out SD/CI)
  // - Interaction plots: SE, SD, CI
  // - T-test Column Scatter: SE, SD, CI (parametric, shows means)
  // - Mann-Whitney Column Scatter: IQR only (non-parametric, shows medians)
  // - Default: all options
  const allowedErrorBarTypes: Array<'se' | 'sd' | 'ci' | 'iqr' | 'none'> = (isKruskalBar || isSRHBar || isMannWhitneyBar || isMannWhitneyColumnScatter)
    ? ['iqr', 'none']
    : (isOneWayBar || isTwoWayBar || isMultifactorialBar)
      ? ['se', 'none']
      : isEstimatedMeans
        ? ['se', 'ci', 'none']
        : isTTestBar || isTTestColumnScatter
          ? ['se', 'sd', 'ci', 'none']
          : isColumnScatter || activePlot?.type === 'interaction'
            ? ['se', 'sd', 'ci', 'none']
            : ['se', 'sd', 'ci', 'iqr', 'none']
  const defaultErrorBarType: 'se' | 'sd' | 'ci' | 'iqr' =
    (isKruskalBar || isSRHBar || isMannWhitneyBar || isMannWhitneyColumnScatter) ? 'iqr' : 'se'
  const rawErrorBarType =
    ((layout.meta as { errorBarType?: string } | undefined)?.errorBarType as
      | 'se'
      | 'sd'
      | 'ci'
      | 'iqr'
      | 'none'
      | undefined) ?? defaultErrorBarType
  const currentErrorBarType = allowedErrorBarTypes.includes(rawErrorBarType)
    ? rawErrorBarType
    : defaultErrorBarType
  const supportsErrorBars = ['bar', 'grouped_bar', 'column_scatter', 'interaction'].includes(
    activePlot?.type ?? ''
  )
  const showErrorBarTypeControl = ['bar', 'grouped_bar', 'column_scatter'].includes(activePlot?.type ?? '')
  const errorBarsEnabled = supportsErrorBars && currentErrorBarType !== 'none'
  const selectableErrorBarTypes = allowedErrorBarTypes.filter(
    (type): type is 'se' | 'sd' | 'ci' | 'iqr' => type !== 'none'
  )
  const displayedErrorBarType: 'se' | 'sd' | 'ci' | 'iqr' =
    currentErrorBarType === 'none'
      ? selectableErrorBarTypes[0] ?? defaultErrorBarType
      : currentErrorBarType
  const errorBarTypeLabels: Record<'se' | 'sd' | 'ci' | 'iqr', string> = {
    se: 'SE',
    sd: 'SD',
    ci: 'CI (95%)',
    iqr: 'IQR (25-75%)',
  }

  // Column Scatter controls
  const showMeanLine = isColumnScatter
    ? ((layout.meta as { showMeanLine?: boolean } | undefined)?.showMeanLine ?? true)
    : false

  // Bar plot overlay points controls
  const isBarPlot = activePlot?.type === 'bar'
  const overlayPointsEnabled = isBarPlot
    ? ((layout.meta as { overlayPoints?: boolean } | undefined)?.overlayPoints ?? false)
    : false

  // Mosaic plot data labels control
  const mosaicDataLabelsEnabled = isMosaicPlot
    ? ((layout.meta as { showDataLabels?: boolean } | undefined)?.showDataLabels ?? false)
    : false

  const derivedBracketMeta = useMemo(() => {
    if (layoutMeta.bracketEffectMap && layoutMeta.bracketEffectShapes) {
      return null
    }
    const catalog = layoutMeta.bracketCatalog
    const shapes = (layout.shapes as any[]) ?? []
    const shapeNames = new Set<string>()
    shapes.forEach((shape) => {
      if (shape?.name) {
        shapeNames.add(String(shape.name))
      }
    })
    const labeled = catalog?.brackets?.filter((bracket) => Boolean(bracket.label)) ?? []
    if (labeled.length === 0 && shapeNames.size === 0) {
      return null
    }
    const effectMap: Record<
      string,
      { label: string; group: 'main' | 'simple'; significant?: boolean }
    > = {}
    const effectShapes: Record<string, string[]> = {}
    const bracketSettings = layoutMeta.bracketSettings ?? createDefaultBracketSettings()
    const significanceSettings = { ...bracketSettings, showNs: false }
    const isSignificant = (pValue: number) =>
      Boolean(getBracketLabel(pValue, significanceSettings))
    if (labeled.length > 0) {
      labeled.forEach((bracket, index) => {
        const effectId = bracket.effectId ?? `effect-${index}`
        const significant = isSignificant(bracket.pValue)
        if (!effectMap[effectId]) {
          effectMap[effectId] = {
            label: bracket.effectLabel ?? bracket.label ?? `Bracket ${index + 1}`,
            group: bracket.effectGroup ?? 'main',
            significant,
          }
        } else if (significant) {
          effectMap[effectId] = {
            ...effectMap[effectId],
            significant: true,
          }
        }
        const shapeName = `sig_bracket_${index}`
        if (shapeNames.has(shapeName)) {
          effectShapes[effectId] = [...(effectShapes[effectId] ?? []), shapeName]
        }
      })
    } else {
      shapes.forEach((shape, index) => {
        const name = typeof shape?.name === 'string' ? shape.name : null
        if (!name || !name.startsWith('sig_bracket_')) return
        const labelText = (shape as { label?: { text?: string } })?.label?.text
        const effectId = name
        if (!effectMap[effectId]) {
          effectMap[effectId] = {
            label: labelText || `Bracket ${index + 1}`,
            group: 'main',
            significant: undefined,
          }
        }
        effectShapes[effectId] = [...(effectShapes[effectId] ?? []), name]
      })
    }
    if (Object.keys(effectMap).length === 0) {
      return null
    }
    return { effectMap, effectShapes }
  }, [
    layoutMeta.bracketCatalog,
    layoutMeta.bracketEffectMap,
    layoutMeta.bracketEffectShapes,
    layout.shapes,
  ])

  const bracketEffects = useMemo(() => {
    const effectMap = layoutMeta.bracketEffectMap ?? derivedBracketMeta?.effectMap ?? {}
    const effectShapes = layoutMeta.bracketEffectShapes ?? derivedBracketMeta?.effectShapes ?? {}
    const entries = Object.entries(effectMap).map(([effectId, meta]) => ({
      effectId,
      label: meta.label,
      group: meta.group,
      shapeNames: effectShapes[effectId] ?? [],
      significant: meta.significant === true,
    }))
    const filtered =
      activePlot?.type === 'grouped_bar'
        ? entries.filter((entry) => entry.group === 'simple')
        : entries
    const order: Record<'main' | 'simple', number> = { main: 0, simple: 1 }
    return filtered.sort(
      (a, b) => order[a.group] - order[b.group] || a.label.localeCompare(b.label)
    )
  }, [
    layoutMeta.bracketEffectMap,
    layoutMeta.bracketEffectShapes,
    derivedBracketMeta?.effectMap,
    derivedBracketMeta?.effectShapes,
    activePlot?.type,
  ])

  const bracketVisibility = layoutMeta.bracketVisibility ?? {}
  const hasBrackets = bracketEffects.length > 0
  const currentBracketSettings =
    layoutMeta.bracketSettings ?? createDefaultBracketSettings()
  const currentBracketLabelMode = currentBracketSettings.labelMode ?? 'stars'

  // ============================================================================
  // Update Helpers (extracted for maintainability)
  // ============================================================================

  const updateLayout = (updates: Partial<Layout>) => {
    if (!activePlot) return
    updatePlot(activePlot.id, {
      plotlyLayout: { ...layout, ...updates },
    })
  }

  const updatePlotFrame = (enabled: boolean) => {
    const xAxis = (layout.xaxis ?? {}) as Partial<Layout['xaxis']>
    const yAxis = (layout.yaxis ?? {}) as Partial<Layout['yaxis']>
    const nextMeta: PlotLayoutMeta = { ...layoutMeta, frameEnabled: enabled }
    updateLayout({
      meta: nextMeta,
      xaxis: {
        ...xAxis,
        showline: true,
        mirror: enabled,
        linecolor: (xAxis as any).linecolor ?? '#111827',
        linewidth: (xAxis as any).linewidth ?? 2,
      },
      yaxis: {
        ...yAxis,
        showline: true,
        mirror: enabled,
        linecolor: (yAxis as any).linecolor ?? '#111827',
        linewidth: (yAxis as any).linewidth ?? 2,
      },
    })
  }

  const mergeRebuiltLayout = (
    rebuiltLayout: Partial<Layout>,
    nextMeta: PlotLayoutMeta
  ): Partial<Layout> => {
    const preservedAnnotationNames = new Set([
      '_title_',
      '_xaxis_title_',
      '_yaxis_title_',
      '_legend_',
      'figure_label',
      'panel_label',
    ])
    const CUSTOM_MARKUP_NAME_PREFIX = 'custom_markup_'

    const normalizeTitle = (title: Layout['title'] | string | undefined) => {
      if (!title) return undefined
      return typeof title === 'object' ? title : { text: title }
    }

    const mergeTitle = (
      rebuiltTitle: Layout['title'] | string | undefined,
      preservedTitle: Layout['title'] | string | undefined
    ) => {
      const rebuilt = normalizeTitle(rebuiltTitle)
      const preserved = normalizeTitle(preservedTitle)
      if (!preserved) return rebuilt ?? rebuiltTitle
      if (!rebuilt) return preserved
      const preservedFont =
        typeof preserved.font === 'object' && preserved.font ? preserved.font : undefined
      const rebuiltFont =
        typeof rebuilt.font === 'object' && rebuilt.font ? rebuilt.font : undefined
      return {
        ...rebuilt,
        ...(preserved.text !== undefined ? { text: preserved.text } : {}),
        ...(preserved.x !== undefined ? { x: preserved.x } : {}),
        ...(preserved.y !== undefined ? { y: preserved.y } : {}),
        ...(preserved.xanchor !== undefined ? { xanchor: preserved.xanchor } : {}),
        ...(preserved.yanchor !== undefined ? { yanchor: preserved.yanchor } : {}),
        ...(preservedFont || rebuiltFont
          ? { font: { ...(rebuiltFont ?? {}), ...(preservedFont ?? {}) } }
          : {}),
      }
    }

    const normalizeAxisTitle = (title: Layout['xaxis']['title'] | string | undefined) => {
      if (!title) return undefined
      return typeof title === 'object' ? title : { text: title }
    }

    const mergeAxis = (
      rebuiltAxis: Partial<Layout['xaxis']> | undefined,
      preservedAxis: Partial<Layout['xaxis']> | undefined
    ) => {
      if (!preservedAxis) return rebuiltAxis
      if (!rebuiltAxis) return preservedAxis
      const rebuiltTitle = normalizeAxisTitle(rebuiltAxis.title)
      const preservedTitle = normalizeAxisTitle(preservedAxis.title)
      const preservedTitleFont =
        preservedTitle && typeof preservedTitle.font === 'object' ? preservedTitle.font : undefined
      const rebuiltTitleFont =
        rebuiltTitle && typeof rebuiltTitle.font === 'object' ? rebuiltTitle.font : undefined
      const mergedTitle = preservedTitle
        ? {
            ...(rebuiltTitle ?? {}),
            ...(preservedTitle.text !== undefined ? { text: preservedTitle.text } : {}),
            ...(preservedTitleFont || rebuiltTitleFont
              ? { font: { ...(rebuiltTitleFont ?? {}), ...(preservedTitleFont ?? {}) } }
              : {}),
          }
        : rebuiltTitle
      const preservedTickFont =
        typeof preservedAxis.tickfont === 'object' ? preservedAxis.tickfont : undefined
      const rebuiltTickFont =
        typeof rebuiltAxis.tickfont === 'object' ? rebuiltAxis.tickfont : undefined
      return {
        ...rebuiltAxis,
        ...(mergedTitle ? { title: mergedTitle } : {}),
        ...(preservedTickFont || rebuiltTickFont
          ? { tickfont: { ...(rebuiltTickFont ?? {}), ...(preservedTickFont ?? {}) } }
          : {}),
      }
    }

    // Helper to check if an item is custom markup (by meta flag or name prefix)
    const isCustomMarkup = (item: unknown): boolean => {
      if (typeof item !== 'object' || item === null) return false
      const name = (item as { name?: unknown }).name
      const meta = (item as { meta?: { customMarkup?: boolean } }).meta
      if (meta?.customMarkup === true) return true
      return typeof name === 'string' && name.startsWith(CUSTOM_MARKUP_NAME_PREFIX)
    }

    // Helper to get unique ID for custom markup items
    const getCustomMarkupId = (item: unknown): string | null => {
      if (typeof item !== 'object' || item === null) return null
      const meta = (item as { meta?: { id?: string } }).meta
      if (typeof meta?.id === 'string') return meta.id
      const name = (item as { name?: string }).name
      if (typeof name === 'string') {
        if (name.startsWith(CUSTOM_MARKUP_NAME_PREFIX)) {
          return name.slice(CUSTOM_MARKUP_NAME_PREFIX.length)
        }
        return name
      }
      return null
    }

    // --- Annotations merge ---
    const preservedAnnotations = Array.isArray(layout.annotations)
      ? layout.annotations.filter((annotation) => {
          if (typeof annotation !== 'object' || annotation === null) return false
          const name = (annotation as { name?: unknown }).name
          return (
            (typeof name === 'string' && preservedAnnotationNames.has(name)) ||
            isCustomMarkup(annotation)
          )
        })
      : []
    const preservedSystemAnnotations = preservedAnnotations.filter((annotation) => {
      const name =
        typeof annotation === 'object' && annotation !== null
          ? (annotation as { name?: unknown }).name
          : undefined
      return typeof name === 'string' && SYSTEM_ANNOTATION_NAME_SET.has(name)
    })

    const nextAnnotations = Array.isArray(rebuiltLayout.annotations)
      ? rebuiltLayout.annotations
      : []
    let mergedAnnotations = [...nextAnnotations]
    const mergedAnnotationIds = new Set<string>()

    // Track IDs already in merged annotations
    mergedAnnotations.forEach((ann) => {
      const id = getCustomMarkupId(ann)
      if (id) mergedAnnotationIds.add(id)
    })

    // Find annotation by name or meta.id
    const findAnnotationIndex = (annotation: unknown) => {
      const id = getCustomMarkupId(annotation)
      if (!id) return -1
      return mergedAnnotations.findIndex((ann) => {
        const annId = getCustomMarkupId(ann)
        return annId === id
      })
    }

    preservedAnnotations.forEach((annotation) => {
      const id = getCustomMarkupId(annotation)
      const existingIndex = findAnnotationIndex(annotation)
      if (existingIndex >= 0) {
        // Replace existing with preserved version
        mergedAnnotations[existingIndex] = annotation
        return
      }
      // Only add if not already present (by ID)
      if (id && mergedAnnotationIds.has(id)) return
      mergedAnnotations.push(annotation)
      if (id) mergedAnnotationIds.add(id)
    })

    const mergedProtectedAnnotations = mergeAnnotationsByIdentity({
      current: mergedAnnotations as unknown[],
      incoming: preservedSystemAnnotations as unknown[],
      protectedNames: SYSTEM_ANNOTATION_NAME_SET,
    })
    const mergedAnnotationHints = getSystemAnnotationTextHints(
      {
        ...rebuiltLayout,
        xaxis: (rebuiltLayout.xaxis as Partial<Layout['xaxis']>) ?? (layout.xaxis as Partial<Layout['xaxis']>),
        yaxis: (rebuiltLayout.yaxis as Partial<Layout['yaxis']>) ?? (layout.yaxis as Partial<Layout['yaxis']>),
      },
      resolvedDisplayTitle || activePlot?.title || ''
    )
    mergedAnnotations = normalizeSystemAnnotationIdentity(
      mergedProtectedAnnotations,
      mergedAnnotationHints
    ).annotations

    // --- Shapes merge ---
    const nextShapes = Array.isArray(rebuiltLayout.shapes) ? rebuiltLayout.shapes : []
    const currentShapes = Array.isArray(layout.shapes) ? layout.shapes : []
    const currentShapeByName = new Map<string, Partial<Layout['shapes']>>()

    currentShapes.forEach((shape) => {
      if (typeof shape !== 'object' || shape === null) return
      const name = (shape as { name?: string }).name
      if (typeof name === 'string') {
        currentShapeByName.set(name, shape)
      }
    })

    const mergedShapes: Partial<Layout['shapes']>[] = []
    const mergedNames = new Set<string>()
    const mergedIds = new Set<string>()

    nextShapes.forEach((shape) => {
      if (typeof shape !== 'object' || shape === null) return
      const name = (shape as { name?: string }).name
      const id = getCustomMarkupId(shape)
      if (typeof name === 'string') {
        const currentShape = currentShapeByName.get(name)
        if (name.startsWith('sig_bracket_')) {
          if (currentShape) {
            mergedShapes.push(currentShape)
            mergedNames.add(name)
            if (id) mergedIds.add(id)
          }
          return
        }
        if (currentShape) {
          mergedShapes.push(currentShape)
        } else {
          mergedShapes.push(shape)
        }
        mergedNames.add(name)
        if (id) mergedIds.add(id)
        return
      }
      mergedShapes.push(shape)
      if (id) mergedIds.add(id)
    })

    // Add custom shapes from current that aren't already merged
    currentShapes.forEach((shape) => {
      if (typeof shape !== 'object' || shape === null) return
      const name = (shape as { name?: string }).name
      const id = getCustomMarkupId(shape)

      if (id && mergedIds.has(id)) return

      // Skip sig_bracket_ shapes (handled above)
      if (typeof name === 'string' && name.startsWith('sig_bracket_')) return

      // For named shapes, check by name
      if (typeof name === 'string') {
        if (!mergedNames.has(name)) {
          mergedShapes.push(shape)
          mergedNames.add(name)
          if (id) mergedIds.add(id)
        }
        return
      }

      // For unnamed shapes, only preserve if custom markup and not already added by ID
      if (isCustomMarkup(shape)) {
        if (id && mergedIds.has(id)) return // Already present
        mergedShapes.push(shape)
        if (id) mergedIds.add(id)
      }
      // Skip non-custom unnamed shapes to prevent duplicates
    })

    const mergedTitle = mergeTitle(rebuiltLayout.title, layout.title)
    const mergedXAxis = mergeAxis(
      rebuiltLayout.xaxis as Partial<Layout['xaxis']>,
      layout.xaxis as Partial<Layout['xaxis']>
    )
    const mergedYAxis = mergeAxis(
      rebuiltLayout.yaxis as Partial<Layout['xaxis']>,
      layout.yaxis as Partial<Layout['xaxis']>
    )

    return {
      ...rebuiltLayout,
      meta: nextMeta,
      annotations: mergedAnnotations,
      ...(mergedTitle ? { title: mergedTitle } : {}),
      ...(mergedXAxis ? { xaxis: mergedXAxis } : {}),
      ...(mergedYAxis ? { yaxis: mergedYAxis } : {}),
      ...(mergedShapes.length > 0 ? { shapes: mergedShapes } : {}),
      ...(typeof layout.bargap === 'number' ? { bargap: layout.bargap } : {}),
      ...(typeof layout.bargroupgap === 'number' ? { bargroupgap: layout.bargroupgap } : {}),
    }
  }

  const updateDoseResponseCiBand = (show: boolean) => {
    if (!activePlot) return
    const nextMeta: PlotLayoutMeta = { ...layoutMeta, showCiBand: show }
    const updated = plotData.map((trace) => {
      if (!trace || typeof trace !== 'object') return trace
      const meta = (trace as { meta?: { role?: string } }).meta
      if (meta?.role === 'ci_band') {
        return { ...trace, visible: show, showlegend: show }
      }
      return trace
    })
    updatePlot(activePlot.id, {
      plotlyData: updated,
      plotlyLayout: { ...layout, meta: nextMeta },
    })
  }

  const updateConfidenceBandVisibility = (show: boolean) => {
    if (!activePlot) return
    const nextMeta: PlotLayoutMeta = { ...layoutMeta, showConfidenceBand: show }
    const updated = plotData.map((trace) => {
      if (!trace || typeof trace !== 'object') return trace
      const meta = (trace as { meta?: { role?: string } }).meta
      if (meta?.role === 'confidence_band_upper') {
        return { ...trace, visible: show, showlegend: show }
      }
      if (meta?.role === 'confidence_band_lower') {
        return { ...trace, visible: show, showlegend: false }
      }
      return trace
    })
    updatePlot(activePlot.id, {
      plotlyData: updated,
      plotlyLayout: { ...layout, meta: nextMeta },
    })
  }

  const updateDoseResponseFittedPoints = (show: boolean) => {
    if (!activePlot) return
    const nextMeta: PlotLayoutMeta = { ...layoutMeta, showFittedPoints: show }
    const updated = plotData.map((trace) => {
      if (!trace || typeof trace !== 'object') return trace
      const meta = (trace as { meta?: { role?: string } }).meta
      if (meta?.role === 'fitted_points') {
        return { ...trace, visible: show, showlegend: show }
      }
      return trace
    })
    updatePlot(activePlot.id, {
      plotlyData: updated,
      plotlyLayout: { ...layout, meta: nextMeta },
    })
  }

  const updateDoseResponseObservedPoints = (show: boolean) => {
    if (!activePlot) return
    const nextMeta: PlotLayoutMeta = { ...layoutMeta, showObservedPoints: show }
    const updated = plotData.map((trace) => {
      if (!trace || typeof trace !== 'object') return trace
      const meta = (trace as { meta?: { role?: string } }).meta
      if (meta?.role === 'observed_points') {
        return { ...trace, visible: show, showlegend: show }
      }
      return trace
    })
    updatePlot(activePlot.id, {
      plotlyData: updated,
      plotlyLayout: { ...layout, meta: nextMeta },
    })
  }

  const updateDoseResponseIc50Label = (show: boolean) => {
    if (!activePlot) return
    const nextMeta: PlotLayoutMeta = { ...layoutMeta, showIc50Label: show }
    const nextShapes = Array.isArray(layout.shapes)
      ? layout.shapes.map((shape) => {
          if (!shape || typeof shape !== 'object') return shape
          const name = (shape as { name?: unknown }).name
          if (name === 'ic50_vline' || name === 'ic50_hline') {
            return { ...shape, visible: show }
          }
          return shape
        })
      : layout.shapes
    const nextAnnotations = Array.isArray(layout.annotations)
      ? layout.annotations.map((annotation) => {
          if (!annotation || typeof annotation !== 'object') return annotation
          const metaName = (annotation as { name?: unknown }).name
          const text = (annotation as { text?: unknown }).text
          if (metaName === 'ic50_label' || (typeof text === 'string' && text.startsWith('IC50 ='))) {
            return { ...annotation, visible: show }
          }
          return annotation
        })
      : layout.annotations

    updatePlot(activePlot.id, {
      plotlyLayout: {
        ...layout,
        shapes: nextShapes,
        annotations: nextAnnotations,
        meta: nextMeta,
      },
    })
  }

  const getClearedInterpolationState = () => {
    const nextData = plotData.filter((trace) => {
      const meta = (trace as { meta?: { role?: string } }).meta
      return meta?.role !== INTERPOLATION_TRACE_ROLE
    })

    const nextShapes = Array.isArray(layout.shapes)
      ? layout.shapes.filter((shape) => {
          if (!shape || typeof shape !== 'object') return true
          const name = (shape as { name?: unknown }).name
          return !(typeof name === 'string' && INTERPOLATION_SHAPE_NAMES.has(name))
        })
      : layout.shapes

    const nextAnnotations = Array.isArray(layout.annotations)
      ? layout.annotations.filter((annotation) => {
          if (!annotation || typeof annotation !== 'object') return true
          const name = (annotation as { name?: unknown }).name
          return name !== INTERPOLATION_ANNOTATION_NAME
        })
      : layout.annotations

    const currentStats = activePlot ? getPlotStats(activePlot.id) ?? {} : {}
    const nextStats = Object.fromEntries(
      Object.entries(currentStats).filter(
        ([key]) => !key.startsWith('interpolation_') && key !== 'selected_interpolation_index'
      )
    )

    return { nextData, nextShapes, nextAnnotations, nextStats }
  }

  const cleanupDoseInterpolationOverlay = (options?: {
    feedback?: { level: 'success' | 'warning' | 'error'; message: string }
    clearFeedback?: boolean
    normalizeAxis?: boolean
    recoveryObservedDoseRange?: [number, number] | null
  }) => {
    if (!activePlot) return
    const { nextData, nextShapes, nextAnnotations, nextStats } = getClearedInterpolationState()
    const shouldNormalize = options?.normalizeAxis === true
    const nextMeta: PlotLayoutMeta = shouldNormalize
      ? {
          ...layoutMeta,
          axisRevisionToken: getNextAxisRevisionToken(layoutMeta),
        }
      : layoutMeta

    updatePlot(activePlot.id, {
      plotlyData: nextData,
      plotlyLayout: {
        ...layout,
        meta: nextMeta,
        ...(shouldNormalize
          ? {
              xaxis: sanitizeDoseResponseXAxis(layout.xaxis as Partial<Layout['xaxis']>, {
                observedDoseRange: options?.recoveryObservedDoseRange,
              }),
            }
          : {}),
        shapes: nextShapes,
        annotations: nextAnnotations,
      },
    })
    setPlotStats(activePlot.id, nextStats)

    if (options?.clearFeedback) {
      setInterpolationFeedback(null)
      return
    }
    if (options?.feedback) {
      setInterpolationFeedback(options.feedback)
    }
  }

  const clearDoseInterpolationOverlay = () => {
    if (!activePlot) return
    setBatchInterpolationResults([])
    setSelectedInterpolationIndex(null)
    cleanupDoseInterpolationOverlay({
      clearFeedback: true,
      normalizeAxis: isDoseResponseAxisCorrupted(layout.xaxis as Partial<Layout['xaxis']>),
      recoveryObservedDoseRange: doseInterpolationContext?.observedDoseRange ?? null,
    })
  }

  const applyInterpolationOverlay = ({
    points,
    selectedPoint,
    selectedLabelText,
    shouldNormalizeAxisNow,
    observedRange,
  }: {
    points: Array<{ x: number; y: number }>
    selectedPoint: { x: number; y: number } | null
    selectedLabelText: string | null
    shouldNormalizeAxisNow: boolean
    observedRange: [number, number] | null | undefined
  }) => {
    if (!activePlot || points.length === 0) return

    const interpolationTrace: Data = {
      type: 'scatter',
      mode: 'markers',
      x: points.map((point) => point.x),
      y: points.map((point) => point.y),
      name: 'Interpolation',
      marker: { color: '#7c3aed', size: 10, symbol: 'diamond' },
      showlegend: false,
      meta: { role: INTERPOLATION_TRACE_ROLE },
    }

    const nextData = [
      ...plotData.filter((trace) => {
        const meta = (trace as { meta?: { role?: string } }).meta
        return meta?.role !== INTERPOLATION_TRACE_ROLE
      }),
      interpolationTrace,
    ]

    const axisAnchorPoint = selectedPoint ?? points[0] ?? null
    const allYValues = nextData.flatMap((trace) => {
      const values = (trace as { y?: unknown[] }).y
      if (!Array.isArray(values)) return []
      return values
        .map((value) => toFiniteNumber(value))
        .filter((value): value is number => value !== null)
    })
    const yRange = (layout.yaxis as { range?: unknown } | undefined)?.range
    const yMinFromRange =
      Array.isArray(yRange) && yRange.length >= 2
        ? Math.min(
            toFiniteNumber(yRange[0]) ?? Number.POSITIVE_INFINITY,
            toFiniteNumber(yRange[1]) ?? Number.POSITIVE_INFINITY
          )
        : Number.POSITIVE_INFINITY
    const yMin =
      Number.isFinite(yMinFromRange)
        ? yMinFromRange
        : Math.min(...allYValues, axisAnchorPoint?.y ?? 0, 0)

    const currentXAxis = (layout.xaxis as Partial<Layout['xaxis']> | undefined) ?? {}
    const xAxisForDoseInterpolation = shouldNormalizeAxisNow
      ? sanitizeDoseResponseXAxis(currentXAxis, {
          observedDoseRange: observedRange,
          anchorX: axisAnchorPoint?.x ?? null,
        })
      : stabilizeDoseResponseXAxisForInterpolation(currentXAxis)

    const nextShapes = [
      ...(Array.isArray(layout.shapes)
        ? layout.shapes.filter((shape) => {
            if (!shape || typeof shape !== 'object') return true
            const name = (shape as { name?: unknown }).name
            return !(typeof name === 'string' && INTERPOLATION_SHAPE_NAMES.has(name))
          })
        : []),
    ] as Layout['shapes']

    if (selectedPoint) {
      const xMin = getDoseInterpolationGuideStart({
        xValue: selectedPoint.x,
        observedDoseRange: observedRange,
        xAxis: layout.xaxis as Partial<Layout['xaxis']>,
      })
      nextShapes.push(
        {
          type: 'line',
          x0: selectedPoint.x,
          x1: selectedPoint.x,
          y0: yMin,
          y1: selectedPoint.y,
          xref: 'x',
          yref: 'y',
          line: { color: '#7c3aed', width: 1.2, dash: 'dot' },
          name: 'dose_interp_vline',
        },
        {
          type: 'line',
          x0: xMin,
          x1: selectedPoint.x,
          y0: selectedPoint.y,
          y1: selectedPoint.y,
          xref: 'x',
          yref: 'y',
          line: { color: '#7c3aed', width: 1.2, dash: 'dot' },
          name: 'dose_interp_hline',
        }
      )
    }

    const nextAnnotations = [
      ...(Array.isArray(layout.annotations)
        ? layout.annotations.filter((annotation) => {
            if (!annotation || typeof annotation !== 'object') return true
            const name = (annotation as { name?: unknown }).name
            return name !== INTERPOLATION_ANNOTATION_NAME
          })
        : []),
    ] as Layout['annotations']
    if (selectedPoint && selectedLabelText) {
      const paperPosition = getInterpolationPaperLabelPosition(layout.annotations)
      nextAnnotations.push({
        x: paperPosition.x,
        y: paperPosition.y,
        xref: 'paper',
        yref: 'paper',
        xanchor: 'center',
        yanchor: 'top',
        text: selectedLabelText,
        showarrow: false,
        font: {
          size: 11,
          color: '#5b21b6',
        },
        editable: false,
        name: INTERPOLATION_ANNOTATION_NAME,
      })
    }
    const nextMeta: PlotLayoutMeta = shouldNormalizeAxisNow
      ? {
          ...layoutMeta,
          axisRevisionToken: getNextAxisRevisionToken(layoutMeta),
        }
      : layoutMeta

    updatePlot(activePlot.id, {
      plotlyData: nextData,
      plotlyLayout: {
        ...layout,
        meta: nextMeta,
        xaxis: xAxisForDoseInterpolation,
        shapes: nextShapes,
        annotations: nextAnnotations,
      },
    })
  }

  const syncInterpolationStats = ({
    scalar,
    results,
    selectedIndex,
    mode,
  }: {
    scalar: {
      input: number
      output: number | null
      extrapolated: boolean
    } | null
    results?: BatchInterpolationResultRow[]
    selectedIndex?: number | null
    mode?: DoseResponseInterpolationMode
  }) => {
    if (!activePlot) return
    const currentStats = getPlotStats(activePlot.id) ?? {}
    const nextStats: Record<string, number | string> = {
      ...currentStats,
      interpolation_mode: mode ?? interpolationMode,
      interpolation_input: scalar?.input ?? '',
      interpolation_output: scalar?.output ?? '',
      interpolation_extrapolated: scalar?.extrapolated ? 'true' : 'false',
    }

    if (results) {
      nextStats.interpolation_count = results.filter((row) => row.x !== null && row.y !== null).length
      nextStats.interpolation_results_json = JSON.stringify(
        results.map((row) => ({
          input: row.input,
          output: row.output,
          status: row.status,
          extrapolated: row.extrapolated,
          message: row.message,
          mode: row.mode,
          x: row.x,
          y: row.y,
        }))
      )
      if (typeof selectedIndex === 'number' && Number.isFinite(selectedIndex)) {
        nextStats.interpolation_selected_index = selectedIndex
        nextStats.selected_interpolation_index = selectedIndex
      } else {
        nextStats.interpolation_selected_index = ''
        nextStats.selected_interpolation_index = ''
      }
    } else {
      nextStats.interpolation_count = ''
      nextStats.interpolation_results_json = ''
      nextStats.interpolation_selected_index = ''
      nextStats.selected_interpolation_index = ''
    }

    setPlotStats(activePlot.id, nextStats)
  }

  const buildBatchInterpolationRows = (
    inputs: number[],
    mode: DoseResponseInterpolationMode
  ): BatchInterpolationResultRow[] => {
    if (!doseInterpolationContext) return []
    const observedRange = doseInterpolationContext.observedDoseRange
    return inputs.map((inputValue) => {
      const interpolationResult = interpolateDoseResponse(
        doseInterpolationContext,
        mode,
        inputValue,
        { allowExtrapolation: allowInterpolationExtrapolation }
      )

      if (interpolationResult.status !== 'ok' || interpolationResult.value === null) {
        return {
          input: inputValue,
          output: null,
          status: interpolationResult.status,
          extrapolated: interpolationResult.extrapolated,
          message: interpolationResult.message,
          mode,
          x: null,
          y: null,
        }
      }

      const xValue = mode === 'forward' ? inputValue : interpolationResult.value
      const yValue = mode === 'forward' ? interpolationResult.value : inputValue
      if (
        shouldRejectDoseInterpolationByStabilityCap({
          xValue,
          allowExtrapolation: allowInterpolationExtrapolation,
          observedDoseRange: observedRange,
        })
      ) {
        return {
          input: inputValue,
          output: null,
          status: 'stability_guardrail',
          extrapolated: true,
          message: 'Interpolation point exceeds stability guardrails. Use a smaller extrapolation range.',
          mode,
          x: null,
          y: null,
        }
      }

      return {
        input: inputValue,
        output: interpolationResult.value,
        status: interpolationResult.status,
        extrapolated: interpolationResult.extrapolated,
        message: interpolationResult.message,
        mode,
        x: xValue,
        y: yValue,
      }
    })
  }

  const handleSelectBatchInterpolationRow = (index: number) => {
    if (!activePlot || !doseInterpolationContext) return
    if (interpolationEntryMode !== 'batch') return
    if (index < 0 || index >= batchInterpolationResults.length) return

    const selectedRow = batchInterpolationResults[index]
    if (!selectedRow) return

    setSelectedInterpolationIndex(index)
    const validPoints = batchInterpolationResults
      .filter((row) => row.x !== null && row.y !== null)
      .map((row) => ({ x: row.x as number, y: row.y as number }))

    if (validPoints.length === 0) {
      cleanupDoseInterpolationOverlay({
        normalizeAxis: isDoseResponseAxisCorrupted(layout.xaxis as Partial<Layout['xaxis']>),
        recoveryObservedDoseRange: doseInterpolationContext.observedDoseRange,
        feedback: {
          level: 'warning',
          message: selectedRow.message,
        },
      })
      syncInterpolationStats({
        scalar: {
          input: selectedRow.input,
          output: selectedRow.output,
          extrapolated: selectedRow.extrapolated,
        },
        results: batchInterpolationResults,
        selectedIndex: index,
        mode: selectedRow.mode,
      })
      return
    }

    const shouldNormalizeAxisNow = isDoseResponseAxisCorrupted(
      layout.xaxis as Partial<Layout['xaxis']>
    )
    const selectedPoint =
      selectedRow.x !== null && selectedRow.y !== null
        ? { x: selectedRow.x, y: selectedRow.y }
        : null
    const labelText =
      selectedPoint && selectedRow.output !== null
        ? getRowInterpolationLabel({
            input: selectedRow.input,
            output: selectedRow.output,
            mode: selectedRow.mode,
          })
        : null

    applyInterpolationOverlay({
      points: validPoints,
      selectedPoint,
      selectedLabelText: labelText,
      shouldNormalizeAxisNow,
      observedRange: doseInterpolationContext.observedDoseRange,
    })
    syncInterpolationStats({
      scalar: {
        input: selectedRow.input,
        output: selectedRow.output,
        extrapolated: selectedRow.extrapolated,
      },
      results: batchInterpolationResults,
      selectedIndex: index,
      mode: selectedRow.mode,
    })
    setInterpolationFeedback({
      level:
        selectedRow.status === 'ok'
          ? selectedRow.extrapolated
            ? 'warning'
            : 'success'
          : selectedRow.status === 'out_of_range' || selectedRow.status === 'stability_guardrail'
            ? 'warning'
            : 'error',
      message: selectedRow.message,
    })
  }

  const runDoseInterpolation = () => {
    if (!activePlot || !doseInterpolationContext) {
      setInterpolationFeedback({
        level: 'error',
        message: 'Dose-response interpolation is unavailable for this plot.',
      })
      return
    }

    if (interpolationEntryMode === 'batch') {
      const computeMode = interpolationMode
      const parsedBatchInput = parseBatchInterpolationInput(batchInterpolationInput)
      if (parsedBatchInput.values.length === 0) {
        cleanupDoseInterpolationOverlay({
          normalizeAxis: isDoseResponseAxisCorrupted(layout.xaxis as Partial<Layout['xaxis']>),
          recoveryObservedDoseRange: doseInterpolationContext.observedDoseRange,
          feedback: {
            level: 'error',
            message: 'Enter at least one numeric value for batch interpolation.',
          },
        })
        setBatchInterpolationResults([])
        setSelectedInterpolationIndex(null)
        return
      }

      const rows = buildBatchInterpolationRows(parsedBatchInput.values, computeMode)
      setBatchInterpolationResults(rows)
      const validRows = rows
        .map((row, idx) => ({ row, idx }))
        .filter(({ row }) => row.x !== null && row.y !== null)
      const selectedRowIndex =
        validRows.length > 0 ? validRows[validRows.length - 1]?.idx ?? null : null
      setSelectedInterpolationIndex(selectedRowIndex)

      if (validRows.length === 0) {
        cleanupDoseInterpolationOverlay({
          normalizeAxis: isDoseResponseAxisCorrupted(layout.xaxis as Partial<Layout['xaxis']>),
          recoveryObservedDoseRange: doseInterpolationContext.observedDoseRange,
          feedback: {
            level: 'warning',
            message: 'No valid interpolation points were produced from this batch.',
          },
        })
        const scalarRow = rows[0] ?? null
        syncInterpolationStats({
          scalar: scalarRow
            ? {
                input: scalarRow.input,
                output: scalarRow.output,
                extrapolated: scalarRow.extrapolated,
              }
            : null,
          results: rows,
          selectedIndex: selectedRowIndex,
          mode: scalarRow?.mode ?? computeMode,
        })
        return
      }

      const selectedRow =
        (selectedRowIndex !== null ? rows[selectedRowIndex] : null) ?? validRows[0]?.row ?? null
      const selectedPoint =
        selectedRow && selectedRow.x !== null && selectedRow.y !== null
          ? { x: selectedRow.x, y: selectedRow.y }
          : null
      const points = validRows.map(({ row }) => ({ x: row.x as number, y: row.y as number }))
      const shouldNormalizeAxisNow = isDoseResponseAxisCorrupted(
        layout.xaxis as Partial<Layout['xaxis']>
      )
      const labelText =
        selectedRow && selectedRow.output !== null
          ? getRowInterpolationLabel({
              input: selectedRow.input,
              output: selectedRow.output,
              mode: selectedRow.mode,
            })
          : null

      applyInterpolationOverlay({
        points,
        selectedPoint,
        selectedLabelText: labelText,
        shouldNormalizeAxisNow,
        observedRange: doseInterpolationContext.observedDoseRange,
      })

      const okCount = validRows.length
      const extrapolatedCount = rows.filter((row) => row.extrapolated).length
      const rejectedCount = rows.filter((row) => row.status === 'stability_guardrail').length
      const feedbackLevel: 'success' | 'warning' =
        extrapolatedCount > 0 ||
        rejectedCount > 0 ||
        parsedBatchInput.invalidTokenCount > 0 ||
        parsedBatchInput.truncatedValueCount > 0
          ? 'warning'
          : 'success'
      const feedbackParts = [`${okCount} of ${rows.length} values plotted`]
      if (extrapolatedCount > 0) feedbackParts.push(`${extrapolatedCount} extrapolated`)
      if (rejectedCount > 0) feedbackParts.push(`${rejectedCount} blocked by guardrail`)
      if (parsedBatchInput.invalidTokenCount > 0) {
        feedbackParts.push(`${parsedBatchInput.invalidTokenCount} invalid token(s) ignored`)
      }
      if (parsedBatchInput.truncatedValueCount > 0) {
        feedbackParts.push(`${parsedBatchInput.truncatedValueCount} value(s) omitted beyond max ${MAX_BATCH_INTERPOLATION_VALUES}`)
      }
      setInterpolationFeedback({
        level: feedbackLevel,
        message: `${feedbackParts.join('; ')}.`,
      })

      syncInterpolationStats({
        scalar: selectedRow
          ? {
              input: selectedRow.input,
              output: selectedRow.output,
              extrapolated: selectedRow.extrapolated,
            }
          : null,
        results: rows,
        selectedIndex: selectedRowIndex,
        mode: selectedRow?.mode ?? computeMode,
      })
      return
    }

    const parsedInput = Number(interpolationInput)
    setBatchInterpolationResults([])
    setSelectedInterpolationIndex(null)
    const interpolationResult = interpolateDoseResponse(
      doseInterpolationContext,
      interpolationMode,
      parsedInput,
      { allowExtrapolation: allowInterpolationExtrapolation }
    )
    const shouldNormalizeAxisNow = isDoseResponseAxisCorrupted(
      layout.xaxis as Partial<Layout['xaxis']>
    )

    if (interpolationResult.status !== 'ok' || interpolationResult.value === null) {
      if (interpolationResult.status === 'invalid_input' || interpolationResult.status === 'no_solution') {
        setInterpolationFeedback({
          level: 'error',
          message: interpolationResult.message,
        })
        return
      }

      cleanupDoseInterpolationOverlay({
        normalizeAxis: shouldNormalizeAxisNow,
        recoveryObservedDoseRange: doseInterpolationContext.observedDoseRange,
        feedback: {
          level: interpolationResult.status === 'out_of_range' ? 'warning' : 'error',
          message: interpolationResult.message,
        },
      })
      return
    }

    const xValue = interpolationMode === 'forward' ? parsedInput : interpolationResult.value
    const yValue = interpolationMode === 'forward' ? interpolationResult.value : parsedInput
    const observedRange = doseInterpolationContext.observedDoseRange
    if (
      shouldRejectDoseInterpolationByStabilityCap({
        xValue,
        allowExtrapolation: allowInterpolationExtrapolation,
        observedDoseRange: observedRange,
      })
    ) {
      cleanupDoseInterpolationOverlay({
        normalizeAxis: shouldNormalizeAxisNow,
        recoveryObservedDoseRange: observedRange,
        feedback: {
          level: 'warning',
          message:
            'Interpolation point exceeds stability guardrails. Use a smaller extrapolation range.',
        },
      })
      return
    }

    applyInterpolationOverlay({
      points: [{ x: xValue, y: yValue }],
      selectedPoint: { x: xValue, y: yValue },
      selectedLabelText:
        interpolationMode === 'forward'
          ? `y=${formatDoseInterpolationValue(yValue)} @ x=${formatDoseInterpolationValue(xValue)}`
          : `x=${formatDoseInterpolationValue(xValue)} @ y=${formatDoseInterpolationValue(yValue)}`,
      shouldNormalizeAxisNow,
      observedRange,
    })

    syncInterpolationStats({
      scalar: {
        input: parsedInput,
        output: interpolationResult.value,
        extrapolated: interpolationResult.extrapolated,
      },
    })

    setInterpolationFeedback({
      level: interpolationResult.extrapolated ? 'warning' : 'success',
      message: interpolationResult.message,
    })
  }

  const parsePathPoints = (path: string) => {
    const matches = path.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)
    if (!matches || matches.length < 8) return null
    const nums = matches.slice(0, 8).map((value: string) => Number(value))
    if (nums.some((value) => !Number.isFinite(value))) return null
    const xLeft = nums[0] ?? 0
    const yTipLeft = nums[1] ?? 0
    const yBaseLeft = nums[3] ?? 0
    const xRight = nums[4] ?? 0
    const yBaseRight = nums[5] ?? yBaseLeft
    const yTipRight = nums[7] ?? yTipLeft
    const yBase = (yBaseLeft + yBaseRight) / 2
    return {
      xLeft,
      xRight,
      yTipLeft,
      yTipRight,
      yBase,
    }
  }

  const buildCategoryMap = (data: Data[]) => {
    const categories: string[] = []
    const seen = new Set<string>()
    data.forEach((trace) => {
      if ((trace as { type?: string }).type !== 'bar') return
      const xValues = Array.isArray((trace as { x?: unknown }).x)
        ? ((trace as { x: unknown[] }).x ?? [])
        : []
      if (xValues.length === 0) return
      xValues.forEach((value) => {
        const key = String(value)
        if (!seen.has(key)) {
          seen.add(key)
          categories.push(key)
        }
      })
    })
    return categories.length > 0
      ? new Map(categories.map((category, index) => [category, index]))
      : undefined
  }

  const computeBarStep = (bargap: number, bargroupgap: number, traceCount: number) => {
    const groupWidth = 1 - bargap
    if (traceCount <= 0) return groupWidth
    const barWidth = groupWidth / (traceCount + Math.max(0, traceCount - 1) * bargroupgap)
    return barWidth * (1 + bargroupgap)
  }

  const updateBarSpacing = (nextBarGap: number, nextGroupGap: number) => {
    if (!activePlot) return
    const catalog = layoutMeta.bracketCatalog
    const barTraces = plotData.filter((trace) => (trace as { type?: string }).type === 'bar')
    if (activePlot.type !== 'bar') {
      let hasWidth = false
      const cleanedData = barTraces.length
        ? plotData.map((trace) => {
            const t = trace as { type?: string; width?: number }
            if (t.type !== 'bar' || typeof t.width !== 'number') return trace
            hasWidth = true
            const { width: _width, ...rest } = t
            return rest
          })
        : plotData
      if (hasWidth) {
        updatePlot(activePlot.id, { plotlyData: cleanedData })
        const nextMeta = { ...layoutMeta }
        delete (nextMeta as { barWidth?: number }).barWidth
        updateLayout({ meta: nextMeta })
      }
    }
    const traceCount = barTraces.length > 0
      ? new Set(
          barTraces.map((trace) => {
            const legendgroup = (trace as { legendgroup?: unknown }).legendgroup
            const name = (trace as { name?: unknown }).name
            return String(legendgroup ?? name ?? '')
          })
        ).size
      : 0
    if (!catalog?.brackets?.length || traceCount === 0) {
      updateLayout({ bargap: nextBarGap, bargroupgap: nextGroupGap })
      return
    }

    const oldStep = computeBarStep(currentBarGap, currentGroupGap, traceCount)
    const newStep = computeBarStep(nextBarGap, nextGroupGap, traceCount)
    const ratio = oldStep > 0 ? newStep / oldStep : 1
    const categoryMap = buildCategoryMap(barTraces)

    const nextBrackets = catalog.brackets.map((bracket) => ({
      ...bracket,
      group1Shift:
        typeof bracket.group1Shift === 'number' ? bracket.group1Shift * ratio : bracket.group1Shift,
      group2Shift:
        typeof bracket.group2Shift === 'number' ? bracket.group2Shift * ratio : bracket.group2Shift,
    }))

    // Check if this is a subplot-aware bracket catalog (multifactorial ANOVA)
    const subplotInfo = (catalog as any).subplotInfo as Record<string, { xref: string; yref: string; categoryOrder: Map<string, number> }> | undefined
    const isMultifactorial = Boolean(subplotInfo && Object.keys(subplotInfo).length > 0)

    const resolvePosition = (value: number | string, shift?: number, subplotCategoryOrder?: Map<string, number>) => {
      const offset = typeof shift === 'number' ? shift : 0
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value + offset
      }
      if (typeof value === 'string') {
        const targetMap = subplotCategoryOrder ?? categoryMap
        const mapped = targetMap?.get(value)
        if (typeof mapped === 'number' && Number.isFinite(mapped)) {
          return mapped + offset
        }
        const parsed = Number(value)
        if (Number.isFinite(parsed)) {
          return parsed + offset
        }
      }
      return Number.NaN
    }

    const nextShapes = Array.isArray(layout.shapes) ? [...layout.shapes] : []
    nextShapes.forEach((shape, index) => {
      if (!shape || typeof (shape as { name?: string }).name !== 'string') return
      const name = (shape as { name?: string }).name ?? ''
      
      let bracketIndex: number | null = null
      let subplotId: string | null = null
      
      if (isMultifactorial) {
        // Match subplot-aware bracket names: sig_bracket_{subplotId}_{index}
        const subplotMatch = /^sig_bracket_(.+?)_(\d+)$/.exec(name)
        if (subplotMatch) {
          subplotId = subplotMatch[1] ?? null
          bracketIndex = Number(subplotMatch[2])
        }
      } else {
        // Match standard bracket names: sig_bracket_{index}
        const standardMatch = /^sig_bracket_(\d+)$/.exec(name)
        if (standardMatch) {
          bracketIndex = Number(standardMatch[1])
        }
      }
      
      if (bracketIndex === null) return
      const bracket = nextBrackets[bracketIndex]
      if (!bracket || typeof (shape as { path?: string }).path !== 'string') return
      const parsed = parsePathPoints((shape as { path?: string }).path as string)
      if (!parsed) return
      
      // Get subplot-specific category order if available
      const rawCategoryOrder = subplotId ? subplotInfo?.[subplotId]?.categoryOrder : undefined
      const subplotCategoryOrder =
        rawCategoryOrder && rawCategoryOrder instanceof Map ? rawCategoryOrder : undefined
      
      const xLeft = resolvePosition(bracket.group1, bracket.group1Shift, subplotCategoryOrder)
      const xRight = resolvePosition(bracket.group2, bracket.group2Shift, subplotCategoryOrder)
      if (!Number.isFinite(xLeft) || !Number.isFinite(xRight)) return
      nextShapes[index] = {
        ...shape,
        path: `M ${xLeft},${parsed.yTipLeft} L ${xLeft},${parsed.yBase} L ${xRight},${parsed.yBase} L ${xRight},${parsed.yTipRight}`,
      }
    })

    updateLayout({
      bargap: nextBarGap,
      bargroupgap: nextGroupGap,
      shapes: nextShapes,
      meta: {
        ...layoutMeta,
        bracketCatalog: { 
          ...catalog,
          brackets: nextBrackets,
          bargap: nextBarGap,
          bargroupgap: nextGroupGap,
        },
      },
    })
  }

  useEffect(() => {
    if (!activePlot) return
    if (layoutMeta.bracketEffectMap && layoutMeta.bracketEffectShapes) return
    if (!derivedBracketMeta) return
    updateLayout({
      meta: {
        ...layoutMeta,
        bracketEffectMap: derivedBracketMeta.effectMap,
        bracketEffectShapes: derivedBracketMeta.effectShapes,
      },
    })
  }, [activePlot, layoutMeta, derivedBracketMeta, updateLayout])

  const updateAxisTitle = (axis: 'xaxis' | 'yaxis', title: string) => {
    if (!activePlot) return
    const currentAxis = (layout[axis] as Partial<Layout['xaxis']>) ?? {}
    updateLayout({
      [axis]: {
        ...currentAxis,
        title: {
          ...(typeof currentAxis.title === 'object' ? currentAxis.title : {}),
          text: title,
        },
      },
    })
  }

  const updateGrid = (axis: 'xaxis' | 'yaxis', showGrid: boolean) => {
    if (!activePlot) return
    const currentAxis = (layout[axis] as Partial<Layout['xaxis']>) ?? {}
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    updateLayout({
      [axis]: { ...currentAxis, showgrid: showGrid },
      meta: { ...currentMeta, gridUserSet: true },
    })
  }

  const updateLegend = (show: boolean) => {
    if (!activePlot) return
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    updateLayout({
      showlegend: show,
      meta: { ...currentMeta, legendUserSet: true },
    })
  }

  const updateBarGap = (value: number) => {
    updateBarSpacing(value, currentGroupGap)
  }

  const updateBarGroupGap = (value: number) => {
    updateBarSpacing(currentBarGap, value)
  }

  const updateTitle = (title: string) => {
    if (!activePlot) return
    updatePlot(activePlot.id, { title })
    const currentTitle = layout.title
    updateLayout({
      title: {
        ...(typeof currentTitle === 'object' ? currentTitle : {}),
        text: title,
      },
    })
  }

  const updateTitleFont = (fontFamily: string) => {
    if (!activePlot) return
    const currentTitle = layout.title
    const currentTitleObj = typeof currentTitle === 'object' ? currentTitle : {}
    updateLayout({
      title: {
        ...currentTitleObj,
        font: {
          ...(currentTitleObj.font ?? {}),
          family: fontFamily,
        },
      },
    })
  }

  const updateTitleFontColor = (color: string) => {
    if (!activePlot) return
    const currentTitle = layout.title
    const currentTitleObj = typeof currentTitle === 'object' ? currentTitle : {}
    updateLayout({
      title: {
        ...currentTitleObj,
        font: {
          ...(currentTitleObj.font ?? {}),
          color,
        },
      },
    })
  }

  const updateTitleFontColorRef = useRef(updateTitleFontColor)
  useEffect(() => {
    updateTitleFontColorRef.current = updateTitleFontColor
  }, [updateTitleFontColor])

  const debouncedUpdateTitleFontColor = useMemo(
    () =>
      debounce((color: string) => {
        updateTitleFontColorRef.current(color)
      }, 120),
    []
  )

  useEffect(() => {
    return () => debouncedUpdateTitleFontColor.cancel()
  }, [debouncedUpdateTitleFontColor])

  const updateTitleFontSize = (size: number) => {
    if (!activePlot) return
    const currentTitle = layout.title
    const currentTitleObj = typeof currentTitle === 'object' ? currentTitle : {}
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    updateLayout({
      title: {
        ...currentTitleObj,
        font: {
          ...(currentTitleObj.font ?? {}),
          size,
        },
      },
      meta: {
        ...currentMeta,
        titleFontSizeCustom: true,
      },
    })
  }

  const updateFont = (fontFamily: string) => {
    if (!activePlot) return
    const currentFont = (layout.font as Partial<Layout['font']>) ?? {}
    updateLayout({
      font: {
        ...currentFont,
        family: fontFamily,
      },
    })
  }

  const updateAxisFontColor = (color: string) => {
    if (!activePlot) return
    const currentXaxis = (layout.xaxis as any) ?? {}
    const currentYaxis = (layout.yaxis as any) ?? {}
    const currentLegend = (layout.legend as any) ?? {}
    updateLayout({
      xaxis: {
        ...currentXaxis,
        title: {
          ...(currentXaxis.title ?? {}),
          font: {
            ...(currentXaxis.title?.font ?? {}),
            color,
          },
        },
        tickfont: {
          ...(currentXaxis.tickfont ?? {}),
          color,
        },
      },
      yaxis: {
        ...currentYaxis,
        title: {
          ...(currentYaxis.title ?? {}),
          font: {
            ...(currentYaxis.title?.font ?? {}),
            color,
          },
        },
        tickfont: {
          ...(currentYaxis.tickfont ?? {}),
          color,
        },
      },
      legend: {
        ...currentLegend,
        font: {
          ...(currentLegend.font ?? {}),
          color,
        },
      },
    })
  }

  const updateAxisFontColorRef = useRef(updateAxisFontColor)
  useEffect(() => {
    updateAxisFontColorRef.current = updateAxisFontColor
  }, [updateAxisFontColor])

  const debouncedUpdateAxisFontColor = useMemo(
    () =>
      debounce((color: string) => {
        updateAxisFontColorRef.current(color)
      }, 120),
    []
  )

  useEffect(() => {
    return () => debouncedUpdateAxisFontColor.cancel()
  }, [debouncedUpdateAxisFontColor])

  const updateAnnotationFont = (fontFamily: string) => {
    if (!activePlot) return
    const resolvedFont = resolveFontFamily(fontFamily)
    updateLayout({
      meta: {
        ...layoutMeta,
        annotationFontFamily: resolvedFont,
      },
    })
  }

  const updateAnnotationFontColor = (color: string) => {
    if (!activePlot) return
    updateLayout({
      meta: {
        ...layoutMeta,
        annotationFontColor: color,
      },
    })
  }

  const updateAnnotationFontColorRef = useRef(updateAnnotationFontColor)
  useEffect(() => {
    updateAnnotationFontColorRef.current = updateAnnotationFontColor
  }, [updateAnnotationFontColor])

  const debouncedUpdateAnnotationFontColor = useMemo(
    () =>
      debounce((color: string) => {
        updateAnnotationFontColorRef.current(color)
      }, 120),
    []
  )

  useEffect(() => {
    return () => debouncedUpdateAnnotationFontColor.cancel()
  }, [debouncedUpdateAnnotationFontColor])

  const updateFontSize = (size: number) => {
    if (!activePlot) return
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    const titleFontCustom = currentMeta.titleFontSizeCustom === true
    const currentFont = (layout.font as Partial<Layout['font']>) ?? {}
    const currentXaxis = (layout.xaxis as any) ?? {}
    const currentYaxis = (layout.yaxis as any) ?? {}
    const currentTitle = layout.title
    const currentTitleFont =
      typeof currentTitle === 'object'
        ? ((currentTitle.font as Partial<Layout['font']>) ?? {})
        : {}
    const currentLegend = (layout.legend as any) ?? {}
    const nextTitleFontSize =
      titleFontCustom && typeof currentTitleFont.size === 'number'
        ? currentTitleFont.size
        : Math.round(size * 1.2)

    // Update font size on all elements to ensure consistent sizing
    updateLayout({
      font: {
        ...currentFont,
        size,
      },
      title: {
        ...(typeof currentTitle === 'object' ? currentTitle : {}),
        font: {
          ...currentTitleFont,
          size: nextTitleFontSize, // Title slightly larger unless custom size
        },
      },
      xaxis: {
        ...currentXaxis,
        title: {
          ...(currentXaxis.title ?? {}),
          font: {
            ...(currentXaxis.title?.font ?? {}),
            size,
          },
        },
        tickfont: {
          ...(currentXaxis.tickfont ?? {}),
          size: Math.round(size * 0.9), // Ticks slightly smaller
        },
      },
      yaxis: {
        ...currentYaxis,
        title: {
          ...(currentYaxis.title ?? {}),
          font: {
            ...(currentYaxis.title?.font ?? {}),
            size,
          },
        },
        tickfont: {
          ...(currentYaxis.tickfont ?? {}),
          size: Math.round(size * 0.9), // Ticks slightly smaller
        },
      },
      legend: {
        ...currentLegend,
        font: {
          ...(currentLegend.font ?? {}),
          size: Math.round(size * 0.9), // Legend slightly smaller
        },
      },
      meta: currentMeta,
    })
  }

  const updateAnnotationFontSize = (size: number) => {
    if (!activePlot) return
    updateLayout({
      meta: {
        ...layoutMeta,
        annotationFontSize: size,
      },
    })
  }

  const updateAnnotationTextAngle = (angle: number) => {
    if (!activePlot) return
    updateLayout({
      meta: {
        ...layoutMeta,
        annotationTextAngle: angle,
      },
    })
  }

  const toggleErrorBars = (visible: boolean) => {
    // Drive error bars via errorBarType meta; 'none' disables
    updateErrorBarType(
      visible
        ? (currentErrorBarType === 'none' ? defaultErrorBarType : currentErrorBarType)
        : 'none'
    )
  }

  const shapeIndexByName = useMemo(() => {
    const map = new Map<string, number>()
    const shapes = (layout.shapes as any[]) ?? []
    shapes.forEach((shape, index) => {
      if (shape?.name) {
        map.set(String(shape.name), index)
      }
    })
    return map
  }, [layout.shapes])

  const isShapeHidden = (shapeIndex: number): boolean => {
    const shapes = (layout.shapes as any[]) ?? []
    const shape = shapes[shapeIndex]
    return shape?.visible === false
  }

  const toggleEffectVisibility = (effectId: string, visible: boolean) => {
    if (!activePlot) return
    const shapes = (layout.shapes as any[]) ?? []
    const effectShapeNames =
      layoutMeta.bracketEffectShapes?.[effectId] ??
      derivedBracketMeta?.effectShapes?.[effectId] ??
      []
    const updatedShapes = shapes.map((shape) => {
      if (!shape || typeof shape.name !== 'string') return shape
      if (effectShapeNames.includes(shape.name)) {
        return { ...shape, visible }
      }
      return shape
    })
    const nextMeta: PlotLayoutMeta = {
      ...layoutMeta,
      bracketVisibility: {
        ...bracketVisibility,
        [effectId]: visible,
      },
    }
    updateLayout({
      shapes: updatedShapes,
      meta: nextMeta,
    })
  }

  const isBracketEffectVisible = (effect: { effectId: string; shapeNames: string[] }): boolean => {
    if (typeof bracketVisibility[effect.effectId] === 'boolean') {
      return bracketVisibility[effect.effectId] as boolean
    }
    if (effect.shapeNames.length === 0) {
      return true
    }
    return effect.shapeNames.some((shapeName) => {
      const shapeIndex = shapeIndexByName.get(shapeName)
      if (shapeIndex === undefined) return true
      return !isShapeHidden(shapeIndex)
    })
  }

  const updateBracketLabelMode = (mode: 'stars' | 'pvalue') => {
    if (!activePlot) return
    const nextSettings = { ...currentBracketSettings, labelMode: mode }
    const nextShapes = Array.isArray(layout.shapes) ? [...layout.shapes] : []
    const catalog = layoutMeta.bracketCatalog

    if (catalog?.brackets?.length && nextShapes.length > 0) {
      const bracketByEffectId = new Map<string, (typeof catalog.brackets)[number]>()
      catalog.brackets.forEach((bracket, index) => {
        const effectId =
          typeof bracket.effectId === 'string' && bracket.effectId.trim()
            ? bracket.effectId
            : `effect-${index}`
        if (!bracketByEffectId.has(effectId)) {
          bracketByEffectId.set(effectId, bracket)
        }
      })

      const shapeToEffectId = new Map<string, string>()
      const effectShapes =
        layoutMeta.bracketEffectShapes ?? derivedBracketMeta?.effectShapes ?? {}
      Object.entries(effectShapes).forEach(([effectId, shapeNames]) => {
        if (!Array.isArray(shapeNames)) return
        shapeNames.forEach((shapeName) => {
          if (typeof shapeName === 'string' && shapeName) {
            shapeToEffectId.set(shapeName, effectId)
          }
        })
      })

      const subplotBracketCache = new Map<string, (typeof catalog.brackets)[number][]>()
      const getSubplotBrackets = (subplotId: string) => {
        if (subplotBracketCache.has(subplotId)) {
          return subplotBracketCache.get(subplotId) ?? []
        }
        const filtered = catalog.brackets.filter((bracket, index) => {
          const effectId =
            typeof bracket.effectId === 'string' && bracket.effectId.trim()
              ? bracket.effectId
              : `effect-${index}`
          return effectId.startsWith(`${subplotId}-`)
        })
        subplotBracketCache.set(subplotId, filtered)
        return filtered
      }

      for (let i = 0; i < nextShapes.length; i++) {
        const shape = nextShapes[i] as Record<string, unknown>
        const name = typeof shape?.name === 'string' ? shape.name : ''
        if (!name.startsWith('sig_bracket_')) continue

        let bracket = shapeToEffectId.has(name)
          ? bracketByEffectId.get(shapeToEffectId.get(name) ?? '')
          : undefined

        if (!bracket) {
          const subplotMatch = /^sig_bracket_(.+?)_(\d+)$/.exec(name)
          if (subplotMatch) {
            const subplotId = subplotMatch[1] ?? ''
            const bracketIndex = Number(subplotMatch[2])
            if (subplotId) {
              bracket = getSubplotBrackets(subplotId)[bracketIndex]
            }
          } else {
            const standardMatch = /^sig_bracket_(\d+)$/.exec(name)
            if (standardMatch) {
              bracket = catalog.brackets[Number(standardMatch[1])]
            }
          }
        }

        if (!bracket) continue
        const nextLabel = formatBracketLabel(bracket, nextSettings)
        if (!nextLabel) continue
        const baseLabel = typeof shape.label === 'object' && shape.label ? shape.label : {}
        nextShapes[i] = {
          ...shape,
          label: {
            ...baseLabel,
            text: nextLabel,
          },
        }
      }
    }

    updateLayout({
      shapes: nextShapes,
      meta: {
        ...layoutMeta,
        bracketSettings: nextSettings,
      },
    })
  }

  const updateErrorBarType = (nextType: 'se' | 'sd' | 'ci' | 'iqr' | 'none') => {
    if (!activePlot) return
    const normalizedType = allowedErrorBarTypes.includes(nextType)
      ? nextType
      : defaultErrorBarType
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    const nextMeta = { ...currentMeta, errorBarType: normalizedType }
    updateLayout({ meta: nextMeta })

    let rebuiltPlotData: Data[] | null = null
    let rebuiltLayout: Partial<Layout> | null = null
    let rebuiltConfig: Partial<import('plotly.js').Config> | null = null
    let rebuiltStats: Record<string, number | string> | null = null

    if (activePlot.resultId) {
      const result = getResult(activePlot.resultId)
      if (!result) return

      const rebuilt = rebuildTestResultPlot(result, activePlot.type, {
        title: activePlot.title,
        errorBarType: normalizedType,
        bracketSettings: layoutMeta.bracketSettings ?? createDefaultBracketSettings(),
        showMeanLine: currentMeta.showMeanLine as boolean | undefined,
        overlayPoints: currentMeta.overlayPoints as boolean | undefined,
        pointJitterX: currentMeta.pointJitterX as number | undefined,
        pointSize: currentMeta.pointSize as number | undefined,
      })
      if (!rebuilt) return
      rebuiltPlotData = rebuilt.plot.plotlyData as Data[]
      rebuiltLayout = rebuilt.plot.plotlyLayout as Partial<Layout>
      rebuiltConfig = rebuilt.plot.plotlyConfig as Partial<import('plotly.js').Config>
      rebuiltStats = rebuilt.stats
    } else if (activePlot.sourceType === 'user_derived') {
      const columns = activePlot.dataSnapshot?.columns ?? []
      if (columns.length === 0) return
      const builder = getPlotBuilder(activePlot.type)
      const output = builder({
        source: 'user_derived',
        testResult: null,
        columns,
        dataPolicy: activePlot.dataPolicy,
        samplingConfig: activePlot.samplingConfig,
        aggregationConfig: activePlot.aggregationConfig,
        options: {
          title: activePlot.title,
          showLegend: legendState.showLegend,
          showGrid: true,
          colorPalette: DEFAULT_COLORS,
          errorBarType: normalizedType,
          showMeanLine: (currentMeta.showMeanLine as boolean | undefined) ?? true,
          overlayPoints: currentMeta.overlayPoints as boolean | undefined,
          pointJitterX: (currentMeta.pointJitterX as number | undefined) ?? 0.05,
          pointSize: (currentMeta.pointSize as number | undefined) ?? 8,
          splitTraces: activePlot.type === 'bar',
        },
      })
      rebuiltPlotData = output.data
      rebuiltLayout = output.layout
      rebuiltConfig = output.config
      rebuiltStats = output.stats
    } else {
      return
    }

    if (!rebuiltPlotData || !rebuiltLayout || !rebuiltConfig || !rebuiltStats) return

    const mergeMarker = (
      source: Record<string, unknown> | undefined,
      target: Record<string, unknown> | undefined
    ) => {
      if (!source) return target ?? {}
      const next = { ...(target ?? {}) }
      if (typeof source.color === 'string' || Array.isArray(source.color)) {
        next.color = source.color
      }
      if (Array.isArray(source.colors)) {
        next.colors = source.colors
      }
      if (typeof source.opacity === 'number') {
        next.opacity = source.opacity
      }
      if (typeof source.line === 'object' && source.line !== null) {
        next.line = { ...(target?.line as Record<string, unknown>), ...source.line }
      }
      if (typeof source.pattern === 'object' && source.pattern !== null) {
        next.pattern = { ...(target?.pattern as Record<string, unknown>), ...source.pattern }
      }
      return next
    }

    const mergeTraceStyle = (source: Data, target: Data) => {
      const next = { ...target } as Data & { marker?: any; line?: any }
      const sourceMarker = typeof (source as any).marker === 'object' ? (source as any).marker : undefined
      const targetMarker = typeof (target as any).marker === 'object' ? (target as any).marker : undefined
      if (sourceMarker) {
        next.marker = mergeMarker(sourceMarker, targetMarker)
      }
      if (typeof (source as any).meta === 'object' && (source as any).meta !== null) {
        ;(next as any).meta = { ...((target as any).meta ?? {}), ...(source as any).meta }
      }
      if (typeof (source as any).line === 'object' && (source as any).line !== null) {
        next.line = { ...(target as any).line, ...(source as any).line }
      }
      if (typeof (source as any).opacity === 'number') {
        ;(next as any).opacity = (source as any).opacity
      }
      if (typeof (source as any).showlegend === 'boolean') {
        ;(next as any).showlegend = (source as any).showlegend
      }
      if (typeof (source as any).fillcolor === 'string') {
        ;(next as any).fillcolor = (source as any).fillcolor
      }
      return next
    }

    const currentTraces = plotData
    const traceBuckets = new Map<string, Data[]>()
    const getTraceKey = (trace: Data) => {
      const type = (trace as { type?: string }).type ?? ''
      const name = typeof (trace as { name?: string }).name === 'string' ? (trace as { name?: string }).name : ''
      return `${type}::${name}`
    }
    currentTraces.forEach((trace) => {
      const key = getTraceKey(trace)
      const bucket = traceBuckets.get(key) ?? []
      bucket.push(trace)
      traceBuckets.set(key, bucket)
    })

    const mergedData = rebuiltPlotData.map((trace, index) => {
      const key = getTraceKey(trace)
      const bucket = traceBuckets.get(key)
      const match = bucket && bucket.length > 0 ? bucket.shift() : currentTraces[index]
      return match ? mergeTraceStyle(match, trace) : trace
    })

    const mergedLayout = mergeRebuiltLayout(rebuiltLayout, nextMeta)

    updatePlot(activePlot.id, {
      plotlyData: mergedData,
      plotlyLayout: mergedLayout,
      plotlyConfig: rebuiltConfig,
    })
    setPlotStats(activePlot.id, rebuiltStats)
  }

  // Jitter controls for box/violin plots
  const toggleJitter = (enabled: boolean) => {
    if (!activePlot) return
    const updated = plotData.map((trace) => {
      const t = trace as any
      const isBox = t.type === 'box'
      const isViolin = t.type === 'violin'
      if (!isBox && !isViolin) return trace

      const next = { ...trace } as any
      const defaultPointPos = -1.8
      const jitterValue = typeof t.jitter === 'number' ? t.jitter : 0.3
      const pointPosValue = typeof t.pointpos === 'number' ? t.pointpos : defaultPointPos
      if (isBox) {
        next.boxpoints = enabled ? 'all' : false
        if (enabled) {
          next.jitter = jitterValue
          next.pointpos = pointPosValue
        }
      } else if (isViolin) {
        next.points = enabled ? 'all' : false
        if (enabled) {
          next.jitter = jitterValue
          next.pointpos = pointPosValue
        }
      }
      return next
    })
    updatePlot(activePlot.id, { plotlyData: updated })
  }

  const updateJitterAmount = (amount: number) => {
    if (!activePlot) return
    const updated = plotData.map((trace) => {
      const t = trace as any
      const isBox = t.type === 'box'
      const isViolin = t.type === 'violin'
      if (!isBox && !isViolin) return trace

      // Only update if jitter is enabled
      if ((isBox && t.boxpoints !== 'all') || (isViolin && t.points !== 'all')) {
        return trace
      }

      const next = { ...trace } as any
      next.jitter = amount
      return next
    })
    updatePlot(activePlot.id, { plotlyData: updated })
  }

  const updatePointPosition = (position: number) => {
    if (!activePlot) return
    const updated = plotData.map((trace) => {
      const t = trace as any
      const isBox = t.type === 'box'
      const isViolin = t.type === 'violin'
      if (!isBox && !isViolin) return trace

      // Only update if jitter is enabled
      if ((isBox && t.boxpoints !== 'all') || (isViolin && t.points !== 'all')) {
        return trace
      }

      const next = { ...trace } as any
      next.pointpos = position
      return next
    })
    updatePlot(activePlot.id, { plotlyData: updated })
  }

  // Column Scatter mean line toggle
  const toggleMeanLine = (enabled: boolean) => {
    if (!activePlot) return
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    const nextMeta = { ...currentMeta, showMeanLine: enabled }
    updateLayout({ meta: nextMeta })

    if (activePlot.resultId) {
      const result = getResult(activePlot.resultId)
      if (!result) return

      const rebuilt = rebuildTestResultPlot(result, activePlot.type, {
        title: activePlot.title,
        errorBarType: currentErrorBarType,
        bracketSettings: layoutMeta.bracketSettings ?? createDefaultBracketSettings(),
        showMeanLine: enabled,
        pointJitterX: (currentMeta.pointJitterX as number | undefined) ?? 0.05,
        pointSize: (currentMeta.pointSize as number | undefined) ?? 8,
      })
      if (!rebuilt) return

      const rebuiltLayout = (rebuilt.plot.plotlyLayout as Partial<Layout>) ?? {}
      const mergedLayout = mergeRebuiltLayout(rebuiltLayout, nextMeta)
      updatePlot(activePlot.id, {
        plotlyData: rebuilt.plot.plotlyData,
        plotlyLayout: mergedLayout,
        plotlyConfig: rebuilt.plot.plotlyConfig,
      })
      setPlotStats(activePlot.id, rebuilt.stats)
      return
    }

    if (activePlot.sourceType === 'user_derived') {
      const columns = activePlot.dataSnapshot?.columns ?? []
      if (columns.length === 0) return
      const builder = getPlotBuilder(activePlot.type)
      const output = builder({
        source: 'user_derived',
        testResult: null,
        columns,
        dataPolicy: activePlot.dataPolicy,
        samplingConfig: activePlot.samplingConfig,
        aggregationConfig: activePlot.aggregationConfig,
        options: {
          title: activePlot.title,
          showLegend: legendState.showLegend,
          showGrid: true,
          colorPalette: DEFAULT_COLORS,
          errorBarType: currentErrorBarType,
          showMeanLine: enabled,
          pointJitterX: (currentMeta.pointJitterX as number | undefined) ?? 0.05,
          pointSize: (currentMeta.pointSize as number | undefined) ?? 8,
          splitTraces: activePlot.type === 'bar',
        },
      })

      const mergedLayout = mergeRebuiltLayout(output.layout as Partial<Layout>, nextMeta)
      updatePlot(activePlot.id, {
        plotlyData: output.data,
        plotlyLayout: mergedLayout,
        plotlyConfig: output.config,
      })
      setPlotStats(activePlot.id, output.stats)
    }
  }

  // Bar plot overlay points toggle
  const toggleOverlayPoints = (enabled: boolean) => {
    if (!activePlot) return
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    const nextMeta = { ...currentMeta, overlayPoints: enabled }
    updateLayout({ meta: nextMeta })

    if (activePlot.resultId) {
      const result = getResult(activePlot.resultId)
      if (!result) return

      const rebuilt = rebuildTestResultPlot(result, activePlot.type, {
        title: activePlot.title,
        errorBarType: currentErrorBarType,
        bracketSettings: layoutMeta.bracketSettings ?? createDefaultBracketSettings(),
        overlayPoints: enabled,
        pointJitterX: (currentMeta.pointJitterX as number | undefined) ?? 0.05,
        pointSize: (currentMeta.pointSize as number | undefined) ?? 8,
      })
      if (!rebuilt) return

      const rebuiltLayout = (rebuilt.plot.plotlyLayout as Partial<Layout>) ?? {}
      const mergedLayout = mergeRebuiltLayout(rebuiltLayout, nextMeta)
      updatePlot(activePlot.id, {
        plotlyData: rebuilt.plot.plotlyData,
        plotlyLayout: mergedLayout,
        plotlyConfig: rebuilt.plot.plotlyConfig,
      })
      setPlotStats(activePlot.id, rebuilt.stats)
      return
    }

    if (activePlot.sourceType === 'user_derived') {
      const columns = activePlot.dataSnapshot?.columns ?? []
      if (columns.length === 0) return
      const builder = getPlotBuilder(activePlot.type)
      const output = builder({
        source: 'user_derived',
        testResult: null,
        columns,
        dataPolicy: activePlot.dataPolicy,
        samplingConfig: activePlot.samplingConfig,
        aggregationConfig: activePlot.aggregationConfig,
        options: {
          title: activePlot.title,
          showLegend: legendState.showLegend,
          showGrid: true,
          colorPalette: DEFAULT_COLORS,
          errorBarType: currentErrorBarType,
          overlayPoints: enabled,
          pointJitterX: (currentMeta.pointJitterX as number | undefined) ?? 0.05,
          pointSize: (currentMeta.pointSize as number | undefined) ?? 8,
          splitTraces: activePlot.type === 'bar',
        },
      })

      const mergedLayout = mergeRebuiltLayout(output.layout as Partial<Layout>, nextMeta)
      updatePlot(activePlot.id, {
        plotlyData: output.data,
        plotlyLayout: mergedLayout,
        plotlyConfig: output.config,
      })
      setPlotStats(activePlot.id, output.stats)
    }
  }

  // Mosaic plot data labels toggle
  const toggleMosaicDataLabels = (enabled: boolean) => {
    if (!activePlot) return
    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    const nextMeta = { ...currentMeta, showDataLabels: enabled }
    updateLayout({ meta: nextMeta })

    // Update textposition on all bar traces
    const updated = plotData.map((trace) => {
      const t = trace as Record<string, unknown>
      if (t.type !== 'bar' || !t.text) return trace
      return {
        ...trace,
        textposition: enabled ? 'auto' : 'none',
      }
    })
    updatePlot(activePlot.id, { plotlyData: updated })
  }

  // Density curve toggle for histograms
  const toggleDensityCurve = async (enabled: boolean) => {
    if (!activePlot) return

    const currentMeta = (layout.meta as Record<string, unknown> | undefined) ?? {}
    const nextMeta = { ...currentMeta, showDensityCurve: enabled }
    updateLayout({ meta: nextMeta })

    const histTrace = plotData.find((trace) => (trace as { type?: string }).type === 'histogram') as
      | (Data & { x?: unknown; name?: string; nbinsx?: number; marker?: { color?: unknown } })
      | undefined
    const rawValues: unknown[] = Array.isArray(histTrace?.x) ? histTrace.x : []
    const values = rawValues.filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v)
    )
    if (values.length === 0) return

    const bins = typeof histTrace?.nbinsx === 'number' ? histTrace.nbinsx : undefined
    const traceName = typeof histTrace?.name === 'string' ? histTrace.name : 'Value'
    const traceColor =
      typeof histTrace?.marker?.color === 'string' ? histTrace.marker.color : undefined
    const palette = traceColor ? [traceColor] : DEFAULT_COLORS

    const { histogramBuilder } = await import('@/utils/plotBuilders/histogramBuilder')
    const rebuilt = histogramBuilder({
      source: activePlot.sourceType,
      testResult: null,
      columns: [
        {
          role: 'x',
          columnId: 'value',
          columnName: traceName,
          values,
          inferredType: 'numeric',
        },
      ],
      dataPolicy: activePlot.dataPolicy,
      samplingConfig: activePlot.samplingConfig,
      aggregationConfig: activePlot.aggregationConfig,
      options: {
        title: activePlot.title,
        showLegend: legendState.showLegend,
        showGrid: true,
        colorPalette: palette,
        histogramBins: bins,
        showDensityCurve: enabled,
      },
    })

    const rebuiltLayout = (rebuilt.layout as Partial<Layout>) ?? {}
    const nextLayout: Partial<Layout> = {
      ...rebuiltLayout,
      xaxis: {
        ...(layout.xaxis ?? {}),
        ...(rebuiltLayout.xaxis ?? {}),
      },
      yaxis: {
        ...(layout.yaxis ?? {}),
        ...(rebuiltLayout.yaxis ?? {}),
        title: (rebuiltLayout.yaxis as any)?.title ?? (layout.yaxis as any)?.title,
      },
      meta: nextMeta,
    }

    updatePlot(activePlot.id, {
      plotlyData: rebuilt.data,
      plotlyLayout: nextLayout,
      plotlyConfig: rebuilt.config,
    })
    setPlotStats(activePlot.id, rebuilt.stats)
  }

  const updateBoxWidth = (width: number) => {
    if (!activePlot) return
    const clamped = Math.min(0.9, Math.max(0.1, width))
    const updated = plotData.map((trace) => {
      const t = trace as any
      if (t.type !== 'box') return trace
      return { ...trace, width: clamped }
    })
    updatePlot(activePlot.id, { plotlyData: updated })
    updateLayout({
      meta: {
        ...layoutMeta,
        boxWidth: clamped,
      },
    })
  }

  const updateViolinWidth = (width: number) => {
    if (!activePlot) return
    const clamped = Math.min(0.9, Math.max(0.1, width))
    const updated = plotData.map((trace) => {
      const t = trace as any
      if (t.type !== 'violin') return trace
      return { ...trace, width: clamped }
    })
    updatePlot(activePlot.id, { plotlyData: updated })
    updateLayout({
      meta: {
        ...layoutMeta,
        violinWidth: clamped,
      },
    })
  }

  const updateBoxViolinPadding = (ratio: number) => {
    if (!activePlot) return
    const clamped = Math.min(0.5, Math.max(0, ratio))
    const base = resolveBoxViolinRangeBase()
    if (!base) return
    const span = Math.abs(base.max - base.min)
    const pad = (span > 0 ? span : Math.max(1, Math.abs(base.max))) * clamped
    const currentAxis = (layout.yaxis as Partial<Layout['yaxis']>) ?? {}
    updateLayout({
      yaxis: {
        ...currentAxis,
        range: [base.min - pad, base.max + pad],
        autorange: false,
      },
      meta: {
        ...layoutMeta,
        boxViolinPaddingRatio: clamped,
        boxViolinRangeBase: base,
      },
    })
  }

  const updateBarWidth = (width: number) => {
    if (!activePlot) return
    const clamped = Math.min(0.9, Math.max(0.1, width))
    const updated = plotData.map((trace) => {
      const t = trace as any
      if (t.type !== 'bar') return trace
      return { ...trace, width: clamped }
    })
    updatePlot(activePlot.id, { plotlyData: updated })
    updateLayout({
      meta: {
        ...layoutMeta,
        barWidth: clamped,
      },
    })
  }

  const getPieLabels = useCallback((trace: Data): string[] => {
    const t = trace as any
    if (!Array.isArray(t.labels)) return []
    return t.labels.map((value: unknown) => (value === null || value === undefined ? '' : String(value)))
  }, [])

  const getPieSliceColors = useCallback((trace: Data): string[] => {
    const t = trace as any
    const currentMarker = t.marker ?? {}
    const markerColors = Array.isArray(currentMarker.colors) ? currentMarker.colors : []
    const labelCount = Math.max(
      Array.isArray(t.labels) ? t.labels.length : 0,
      markerColors.length,
      1
    )
    return Array.from({ length: labelCount }, (_, idx) => {
      const raw = markerColors[idx]
      if (typeof raw === 'string') return raw
      if (typeof currentMarker.color === 'string') return currentMarker.color
      return DEFAULT_COLORS[idx % DEFAULT_COLORS.length] ?? '#4e79a7'
    })
  }, [])

  const getBarCategoryLabels = useCallback((trace: Data): string[] => {
    return getBarCategoryLabelsFromTrace(trace)
  }, [])

  const getBarCategoryStyles = useCallback((trace: Data) => {
    return extractBarCategoryStyles(trace)
  }, [])

  const updatePieSliceColor = useCallback(
    (traceIndex: number, sliceIndex: number, color: string) => {
      if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
      const updated = plotData.map((trace, idx) => {
        if (idx !== traceIndex) return trace
        const next = { ...trace } as Data & { marker?: any }
        const currentMarker = next.marker ?? {}
        const markerColors = Array.isArray(currentMarker.colors)
          ? [...currentMarker.colors]
          : []
        const rawLabels = Array.isArray((trace as any).labels)
          ? (trace as any).labels
          : []
        const colorCount = Math.max(markerColors.length, rawLabels.length, sliceIndex + 1, 1)
        const normalizedColors = Array.from({ length: colorCount }, (_, j) => {
          if (typeof markerColors[j] === 'string') return markerColors[j]
          if (typeof currentMarker.color === 'string') return currentMarker.color
          return DEFAULT_COLORS[j % DEFAULT_COLORS.length] ?? '#4e79a7'
        })
        normalizedColors[sliceIndex] = color
        next.marker = { ...currentMarker, colors: normalizedColors }
        return next
      })
      updatePlot(activePlot.id, { plotlyData: updated })
    },
    [activePlot, plotData, updatePlot]
  )

  const updateBarCategoryColor = useCallback(
    (traceIndex: number, categoryIndex: number, color: string) => {
      if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
      const updated = plotData.map((trace, idx) => {
        if (idx !== traceIndex) return trace
        return setBarCategoryColor(trace, categoryIndex, color)
      })
      updatePlot(activePlot.id, { plotlyData: updated })
    },
    [activePlot, plotData, updatePlot]
  )

  const updateBarCategoryPattern = useCallback(
    (traceIndex: number, categoryIndex: number, patternShape: BarPatternShape) => {
      if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
      const updated = plotData.map((trace, idx) => {
        if (idx !== traceIndex) return trace
        return setBarCategoryPattern(trace, categoryIndex, patternShape)
      })
      updatePlot(activePlot.id, { plotlyData: updated })
    },
    [activePlot, plotData, updatePlot]
  )

  const updateBarCategoryFrame = useCallback(
    (traceIndex: number, categoryIndex: number, enabled: boolean) => {
      if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
      const updated = plotData.map((trace, idx) => {
        if (idx !== traceIndex) return trace
        return setBarCategoryFrame(trace, categoryIndex, enabled)
      })
      updatePlot(activePlot.id, { plotlyData: updated })
    },
    [activePlot, plotData, updatePlot]
  )

  const updateBarCategoryPatternDensity = useCallback(
    (traceIndex: number, categoryIndex: number, solidity: number) => {
      if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
      const updated = plotData.map((trace, idx) => {
        if (idx !== traceIndex) return trace
        return setBarCategoryPatternSolidity(trace, categoryIndex, solidity)
      })
      updatePlot(activePlot.id, { plotlyData: updated })
    },
    [activePlot, plotData, updatePlot]
  )

  const updateBarCategoryPatternSpacing = useCallback(
    (traceIndex: number, categoryIndex: number, size: number) => {
      if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
      const updated = plotData.map((trace, idx) => {
        if (idx !== traceIndex) return trace
        return setBarCategoryPatternSize(trace, categoryIndex, size)
      })
      updatePlot(activePlot.id, { plotlyData: updated })
    },
    [activePlot, plotData, updatePlot]
  )

  const applyColorToAllPieSlices = useCallback(
    (traceIndex: number, color: string) => {
      if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
      const targetTrace = plotData[traceIndex]
      if (!targetTrace) return
      const sliceCount = Math.max(getPieLabels(targetTrace).length, getPieSliceColors(targetTrace).length, 1)
      if (sliceCount > 1 && typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const confirmed = window.confirm(`Apply selected color to all ${sliceCount} slices?`)
        if (!confirmed) return
      }
      const updated = plotData.map((trace, idx) => {
        if (idx !== traceIndex) return trace
        const next = { ...trace } as Data & { marker?: Record<string, unknown> }
        const currentMarker = (next.marker as Record<string, unknown> | undefined) ?? {}
        next.marker = {
          ...currentMarker,
          colors: Array.from({ length: sliceCount }, () => color),
        }
        return next
      })
      updatePlot(activePlot.id, { plotlyData: updated })
    },
    [activePlot, plotData, updatePlot, getPieLabels, getPieSliceColors]
  )

  const applyColorToAllBarCategoriesInTrace = useCallback(
    (traceIndex: number, color: string) => {
      if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
      const targetTrace = plotData[traceIndex]
      if (!targetTrace) return
      const categoryCount = getBarCategoryLabels(targetTrace).length
      if (categoryCount > 1 && typeof window !== 'undefined' && typeof window.confirm === 'function') {
        const confirmed = window.confirm(
          `Apply selected color to all ${categoryCount} categories?`
        )
        if (!confirmed) return
      }
      const updated = plotData.map((trace, idx) => {
        if (idx !== traceIndex) return trace
        return applyColorToAllBarCategories(trace, color)
      })
      updatePlot(activePlot.id, { plotlyData: updated })
    },
    [activePlot, plotData, updatePlot, getBarCategoryLabels]
  )

  // Update trace color (also updates legend)
  const updateTraceColor = (traceIndex: number, color: string) => {
    if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
    const targetTrace = plotData[traceIndex] as Data & { name?: string }
    const shouldUpdateCriticalLabel = targetTrace?.name === 'Critical value'
    const updated = plotData.map((trace, idx) => {
      if (idx !== traceIndex) return trace
      const next = { ...trace } as Data & { marker?: any; line?: any }
      const traceType = (next as { type?: string }).type
      const isPie = traceType === 'pie'
      const currentMarker =
        next.marker && typeof next.marker === 'object' ? next.marker : undefined
      const currentPattern = currentMarker?.pattern ?? {}
      const patternLineColor = getPatternLineColor(color)
      // Update marker color for bar/scatter; pie uses marker.colors (array)
      if (isPie) {
        const labels = (next as { labels?: unknown }).labels
        const labelCount = Array.isArray(labels)
          ? labels.length
          : Array.isArray(currentMarker?.colors)
            ? currentMarker.colors.length
            : 0
        const colors = Array.from({ length: Math.max(1, labelCount) }, () => color)
        const { color: _ignored, ...restMarker } = currentMarker ?? {}
        next.marker = { ...restMarker, colors }
      } else if (currentMarker) {
        const markerColorArray =
          Array.isArray(currentMarker.color) &&
          currentMarker.color.some((entry: unknown) => typeof entry === 'string')
            ? currentMarker.color
            : null
        if (traceType === 'bar' && markerColorArray) {
          next.marker = { ...currentMarker, color: markerColorArray.map(() => color) }
        } else {
          next.marker = { ...currentMarker, color }
        }
        if (currentPattern.shape && currentPattern.shape !== 'solid') {
          next.marker = {
            ...next.marker,
            pattern: {
              ...currentPattern,
              fgcolor: patternLineColor,
              bgcolor: color,
            },
          }
        }
        if (traceType === 'bar' && currentMarker.line && typeof currentMarker.line === 'object') {
          const currentLine = currentMarker.line as Record<string, unknown>
          const outlineColor = OUTLINE_FALLBACK
          next.marker = {
            ...next.marker,
            line: { ...currentLine, color: outlineColor },
          }
        }
      } else {
        next.marker = { color }
      }
      if (traceType === 'box') {
        next.fillcolor = applyAlpha(color, 0.35)
      } else if (traceType === 'violin') {
        next.fillcolor = applyAlpha(color, 0.4)
      } else if ((next as any).fill && typeof (next as any).fillcolor === 'string') {
        // Scatter traces with fill (e.g., CI bands) - preserve alpha at 0.3
        next.fillcolor = applyAlpha(color, 0.3)
      }
      // Update line color for line traces
      if (next.line) {
        next.line = { ...next.line, color }
      }
      // Keep error bars visible when fills are white (fallback to dark outline)
      const errorBarColor = traceType === 'bar' ? OUTLINE_FALLBACK : (normalizeOutlineColor(color) ?? color)
      if ((next as { error_x?: any }).error_x) {
        next.error_x = { ...(next as { error_x?: any }).error_x, color: errorBarColor }
      }
      if ((next as { error_y?: any }).error_y) {
        next.error_y = { ...(next as { error_y?: any }).error_y, color: errorBarColor }
      }
      if ((next as { textfont?: any }).textfont) {
        next.textfont = { ...(next as { textfont?: any }).textfont, color }
      }
      return next
    })
    if (shouldUpdateCriticalLabel) {
      const currentLayout = activePlot.plotlyLayout ?? {}
      const rawAnnotations = (currentLayout as { annotations?: unknown }).annotations
      const annotations = Array.isArray(rawAnnotations) ? rawAnnotations : []
      const updatedAnnotations = annotations.map((annotation) => {
        if (!annotation || typeof annotation !== 'object') return annotation
        const meta = (annotation as { meta?: { role?: string } }).meta
        if (meta?.role !== 'critical-label') return annotation
        const currentFont = (annotation as { font?: Record<string, unknown> }).font ?? {}
        return {
          ...annotation,
          font: { ...currentFont, color },
        }
      })
      updatePlot(activePlot.id, {
        plotlyData: updated,
        plotlyLayout: { ...currentLayout, annotations: updatedAnnotations },
      })
      return
    }
    updatePlot(activePlot.id, { plotlyData: updated })
  }

  const updateTraceColorRef = useRef(updateTraceColor)
  useEffect(() => {
    updateTraceColorRef.current = updateTraceColor
  }, [updateTraceColor])

  const debouncedUpdateTraceColor = useMemo(
    () =>
      debounce((traceIndex: number, color: string) => {
        updateTraceColorRef.current(traceIndex, color)
      }, 120),
    []
  )

  useEffect(() => {
    return () => debouncedUpdateTraceColor.cancel()
  }, [debouncedUpdateTraceColor])

  const updatePieSliceColorRef = useRef(updatePieSliceColor)
  useEffect(() => {
    updatePieSliceColorRef.current = updatePieSliceColor
  }, [updatePieSliceColor])

  const debouncedUpdatePieSliceColor = useMemo(
    () =>
      debounce((traceIndex: number, sliceIndex: number, color: string) => {
        updatePieSliceColorRef.current(traceIndex, sliceIndex, color)
      }, 120),
    []
  )

  useEffect(() => {
    return () => debouncedUpdatePieSliceColor.cancel()
  }, [debouncedUpdatePieSliceColor])

  const updateBarCategoryColorRef = useRef(updateBarCategoryColor)
  useEffect(() => {
    updateBarCategoryColorRef.current = updateBarCategoryColor
  }, [updateBarCategoryColor])

  const debouncedUpdateBarCategoryColor = useMemo(
    () =>
      debounce((traceIndex: number, categoryIndex: number, color: string) => {
        updateBarCategoryColorRef.current(traceIndex, categoryIndex, color)
      }, 120),
    []
  )

  useEffect(() => {
    return () => debouncedUpdateBarCategoryColor.cancel()
  }, [debouncedUpdateBarCategoryColor])

  // Update trace pattern (for bar charts)
  const updateTracePattern = (traceIndex: number, pattern: string) => {
    if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
    const updated = plotData.map((trace, idx) => {
      if (idx !== traceIndex) return trace
      const next = { ...trace } as Data & { marker?: any }
      const currentMarker = next.marker ?? {}
      const currentPattern = currentMarker.pattern ?? {}
      const colorArray =
        Array.isArray(currentMarker.color) && typeof currentMarker.color[0] === 'string'
          ? currentMarker.color
          : undefined
      const colorsArray =
        Array.isArray(currentMarker.colors) && typeof currentMarker.colors[0] === 'string'
          ? currentMarker.colors
          : undefined
      const baseColor =
        typeof currentMarker.color === 'string'
          ? currentMarker.color
          : colorArray?.[0] ?? colorsArray?.[0] ?? '#4e79a7'
      if (pattern === 'solid') {
        // Solid fill - remove pattern, explicitly set color for legend
        const { pattern: _, ...rest } = currentMarker
        next.marker = { ...rest }
        if (colorArray) {
          next.marker.color = colorArray
        } else if (colorsArray) {
          next.marker.colors = colorsArray
        } else {
          next.marker.color = baseColor
        }
      } else {
        const nextPattern: Record<string, unknown> = {
          ...currentPattern,
          shape: pattern,
          size: currentPattern.size ?? 6,
          solidity: currentPattern.solidity ?? 0.5,
          fgcolor: getPatternLineColor(baseColor),
        }
        if (colorArray || colorsArray) {
          delete nextPattern.bgcolor
        } else {
          nextPattern.bgcolor = baseColor
        }
        next.marker = {
          ...currentMarker,
          ...(colorArray || colorsArray ? {} : { color: baseColor }),
          pattern: nextPattern,
        }
      }
      return next
    })
    updatePlot(activePlot.id, { plotlyData: updated })
  }

  // Get current trace color
  const getTraceColor = useCallback(
    (trace: Data, index: number): string => {
      const t = trace as any
      if (t.marker?.pattern?.shape && t.marker?.pattern?.shape !== 'solid') {
        if (typeof t.marker?.pattern?.bgcolor === 'string') {
          return t.marker.pattern.bgcolor
        }
        if (
          Array.isArray(t.marker?.pattern?.bgcolor) &&
          typeof t.marker.pattern.bgcolor[0] === 'string'
        ) {
          return t.marker.pattern.bgcolor[0]
        }
        if (typeof t.marker?.color === 'string') return t.marker.color
        if (typeof t.marker?.pattern?.fgcolor === 'string') return t.marker.pattern.fgcolor
      }
      // Handle single color string
      if (t.marker?.color && typeof t.marker.color === 'string') return t.marker.color
      // Handle color arrays (bar plots)
      if (Array.isArray(t.marker?.color) && typeof t.marker.color[0] === 'string') {
        return t.marker.color[0]
      }
      // Handle colors array (pie charts)
      if (Array.isArray(t.marker?.colors) && typeof t.marker.colors[0] === 'string') {
        return t.marker.colors[0]
      }
      // Handle line color
      if (t.line?.color && typeof t.line.color === 'string') return t.line.color
      return DEFAULT_COLORS[index % DEFAULT_COLORS.length] ?? '#4e79a7'
    },
    []
  )

  // Get current trace pattern
  const getTracePattern = useCallback((trace: Data): string => {
    const t = trace as any
    const shape = t.marker?.pattern?.shape
    if (Array.isArray(shape) && typeof shape[0] === 'string') {
      return shape[0]
    }
    return shape ?? 'solid'
  }, [])

  // Get current trace pattern size
  const getTracePatternSize = useCallback((trace: Data): number => {
    const t = trace as any
    return t.marker?.pattern?.size ?? 6
  }, [])

  // Get current trace pattern solidity
  const getTracePatternSolidity = useCallback((trace: Data): number => {
    const t = trace as any
    return t.marker?.pattern?.solidity ?? 0.5
  }, [])

  // Update trace pattern size
  const updateTracePatternSize = (traceIndex: number, size: number) => {
    if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
    const updated = plotData.map((trace, idx) => {
      if (idx !== traceIndex) return trace
      const next = { ...trace } as Data & { marker?: any }
      const currentMarker = next.marker ?? {}
      const currentPattern = currentMarker.pattern ?? {}
      if (currentPattern.shape && currentPattern.shape !== 'solid') {
        next.marker = {
          ...currentMarker,
          pattern: { ...currentPattern, size },
        }
      }
      return next
    })
    updatePlot(activePlot.id, { plotlyData: updated })
  }

  // Update trace pattern solidity
  const updateTracePatternSolidity = (traceIndex: number, solidity: number) => {
    if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
    const updated = plotData.map((trace, idx) => {
      if (idx !== traceIndex) return trace
      const next = { ...trace } as Data & { marker?: any }
      const currentMarker = next.marker ?? {}
      const currentPattern = currentMarker.pattern ?? {}
      if (currentPattern.shape && currentPattern.shape !== 'solid') {
        next.marker = {
          ...currentMarker,
          pattern: { ...currentPattern, solidity },
        }
      }
      return next
    })
    updatePlot(activePlot.id, { plotlyData: updated })
  }

  // Get current line dash style (for line/scatter traces)
  const getLineDashStyle = useCallback((trace: Data): string => {
    const t = trace as any
    const dash = t.line?.dash
    if (!dash) return 'solid'
    return LINE_STYLE_OPTIONS.some((option) => option.value === dash) ? dash : 'solid'
  }, [])

  // Update line dash style (for line/scatter traces)
  const updateLineDashStyle = (traceIndex: number, dashStyle: string) => {
    if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
    const updated = plotData.map((trace, idx) => {
      if (idx !== traceIndex) return trace
      const next = { ...trace } as Data & { line?: any }
      next.line = { ...(next.line || {}), dash: dashStyle }
      return next as Data
    })
    updatePlot(activePlot.id, { plotlyData: updated })
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
      const values = matches.slice(0, 3).map((v) => Number(v))
      if (values.length === 3 && values.every((v) => Number.isFinite(v))) {
        return values.every((channel) => channel >= 250)
      }
    }
    return false
  }

  const normalizeOutlineColor = (value: unknown): string | string[] | undefined => {
    if (typeof value === 'string') {
      return isNearWhite(value) ? OUTLINE_FALLBACK : value
    }
    if (Array.isArray(value)) {
      return value.map((entry) =>
        typeof entry === 'string' && isNearWhite(entry) ? OUTLINE_FALLBACK : entry
      )
    }
    return undefined
  }

  const getBarOutlineEnabled = useCallback((trace: Data): boolean => {
    const t = trace as any
    const marker = t.marker as Record<string, unknown> | undefined
    const line = marker?.line as Record<string, unknown> | undefined
    return getBarOutlineEnabledFromWidth(line?.width, true)
  }, [])

  const updateBarOutline = (traceIndex: number, enabled: boolean) => {
    if (!activePlot || traceIndex < 0 || traceIndex >= plotData.length) return
    const updated = plotData.map((trace, idx) => {
      if (idx !== traceIndex) return trace
      const next = { ...trace } as Data & { marker?: any }
      const currentMarker = next.marker ?? {}
      const lineColor = OUTLINE_FALLBACK
      next.marker = {
        ...currentMarker,
        line: {
          ...(currentMarker.line ?? {}),
          color: lineColor,
          width: enabled ? 1 : 0,
        },
      }
      return next
    })
    updatePlot(activePlot.id, { plotlyData: updated })
  }

  // ============================================================================
  // Derived State
  // ============================================================================

  const currentFont = useMemo(() => {
    const font = layout.font as Partial<Layout['font']> | undefined
    return font?.family ?? 'Inter'
  }, [layout])
  const normalizedFont = useMemo(() => {
    return resolveFontFamily(currentFont)
  }, [currentFont])

  const currentFontSize = useMemo(() => {
    const font = layout.font as Partial<Layout['font']> | undefined
    return font?.size ?? 12
  }, [layout])

  const currentAxisFontColor = useMemo(() => {
    const xAxis = (layout.xaxis as any) ?? {}
    const yAxis = (layout.yaxis as any) ?? {}
    const layoutFontColor = (layout.font as Partial<Layout['font']> | undefined)?.color
    const axisColor =
      xAxis?.title?.font?.color ??
      yAxis?.title?.font?.color ??
      xAxis?.tickfont?.color ??
      yAxis?.tickfont?.color
    return typeof axisColor === 'string' ? axisColor : (layoutFontColor ?? '#374151')
  }, [layout])

  const currentAnnotationFont = useMemo(() => {
    if (typeof layoutMeta.annotationFontFamily === 'string') {
      return layoutMeta.annotationFontFamily
    }
    return currentFont
  }, [layoutMeta.annotationFontFamily, currentFont])

  const legendState = useMemo(
    () => getEffectiveShowLegend(layout, plotData),
    [layout, plotData]
  )

  const normalizedAnnotationFont = useMemo(() => {
    return resolveFontFamily(currentAnnotationFont)
  }, [currentAnnotationFont])

  const currentAnnotationFontSize = useMemo(() => {
    if (typeof layoutMeta.annotationFontSize === 'number' && Number.isFinite(layoutMeta.annotationFontSize)) {
      return layoutMeta.annotationFontSize
    }
    return currentFontSize
  }, [layoutMeta.annotationFontSize, currentFontSize])

  const currentAnnotationFontColor = useMemo(() => {
    if (
      typeof layoutMeta.annotationFontColor === 'string' &&
      layoutMeta.annotationFontColor.trim().length > 0
    ) {
      return layoutMeta.annotationFontColor
    }
    return (layout.font as Partial<Layout['font']> | undefined)?.color ?? '#374151'
  }, [layoutMeta.annotationFontColor, layout.font])

  const currentAnnotationTextAngle = useMemo(() => {
    if (typeof layoutMeta.annotationTextAngle === 'number' && Number.isFinite(layoutMeta.annotationTextAngle)) {
      return layoutMeta.annotationTextAngle
    }
    return 0
  }, [layoutMeta.annotationTextAngle])

  const [annotationTextAngleInput, setAnnotationTextAngleInput] = useState(
    String(currentAnnotationTextAngle)
  )

  useEffect(() => {
    setAnnotationTextAngleInput(String(currentAnnotationTextAngle))
  }, [currentAnnotationTextAngle])

  // Title-specific font settings
  const currentTitleFont = useMemo(() => {
    const title = layout.title
    if (typeof title === 'object' && title?.font?.family) {
      return title.font.family
    }
    // Fallback to global font
    return currentFont
  }, [layout, currentFont])

  const normalizedTitleFont = useMemo(() => {
    return resolveFontFamily(currentTitleFont)
  }, [currentTitleFont])

  const currentTitleFontSize = useMemo(() => {
    const title = layout.title
    if (typeof title === 'object' && title?.font?.size) {
      return title.font.size
    }
    // Fallback to scaled global font size
    return Math.round(currentFontSize * 1.2)
  }, [layout, currentFontSize])

  const currentTitleFontColor = useMemo(() => {
    const title = layout.title
    if (typeof title === 'object' && typeof title?.font?.color === 'string') {
      return title.font.color
    }
    return (layout.font as Partial<Layout['font']> | undefined)?.color ?? '#374151'
  }, [layout])

  const [titleColorInput, setTitleColorInput] = useState(
    formatColorForInput(currentTitleFontColor)
  )
  const [axisColorInput, setAxisColorInput] = useState(
    formatColorForInput(currentAxisFontColor)
  )
  const [annotationColorInput, setAnnotationColorInput] = useState(
    formatColorForInput(currentAnnotationFontColor)
  )

  useEffect(() => {
    setTitleColorInput(formatColorForInput(currentTitleFontColor))
  }, [currentTitleFontColor])

  useEffect(() => {
    setAxisColorInput(formatColorForInput(currentAxisFontColor))
  }, [currentAxisFontColor])

  useEffect(() => {
    setAnnotationColorInput(formatColorForInput(currentAnnotationFontColor))
  }, [currentAnnotationFontColor])

  useEffect(() => {
    if (!activePlot) return
    const font = (layout.font as Partial<Layout['font']> | undefined)?.family
    const hasValidFont =
      typeof font === 'string' &&
      PLOT_FONTS.some((candidate) => candidate.value === font)
    const resolvedFont = resolveFontFamily(font)
    const titleFont =
      typeof layout.title === 'object'
        ? (layout.title as Partial<Layout['title']>).font?.family
        : undefined
    const resolvedTitleFont = resolveFontFamily(titleFont)
    const titleNeedsUpdate = Boolean(titleFont && resolvedTitleFont !== titleFont)
    if (hasValidFont && !titleNeedsUpdate) return
    const nextLayout: Partial<Layout> = {}
    if (!hasValidFont) {
      nextLayout.font = {
        ...(layout.font as Partial<Layout['font']>),
        family: resolvedFont,
      }
    }
    if (titleNeedsUpdate) {
      const currentTitle = (typeof layout.title === 'object' ? layout.title : {}) as Partial<Layout['title']>
      nextLayout.title = {
        ...currentTitle,
        font: {
          ...((currentTitle.font as Partial<Layout['font']>) ?? {}),
          family: resolvedTitleFont,
        },
      }
    }
    updateLayout(nextLayout)
  }, [activePlot, layout.font, layout.title, updateLayout])

  const isTrendlineTrace = useCallback((trace: Data) => {
    const t = trace as any
    if (t?.meta?.trendline === true) return true
    if (typeof t?.name !== 'string') return false
    return t.name === 'Trendline' || t.name.startsWith('Trendline ')
  }, [])

  const getTrendlineSourceTrace = useCallback(() => {
    return plotData.find((trace) => !isTrendlineTrace(trace)) as any
  }, [plotData, isTrendlineTrace])

  const isNumericSeries = useCallback((values: unknown): values is number[] => {
    if (!Array.isArray(values)) return false
    let numericCount = 0
    for (const value of values) {
      if (value === null || value === undefined) continue
      if (typeof value !== 'number' || Number.isNaN(value)) return false
      numericCount += 1
    }
    return numericCount >= 2
  }, [])

  // Check if plot supports trendlines (numeric scatter with markers only)
  const supportsTrendline = useMemo(() => {
    const sourceTrace = getTrendlineSourceTrace()
    if (!sourceTrace) return false
    const traceType = sourceTrace?.type ?? 'scatter'
    if (!['scatter', 'scattergl'].includes(traceType)) return false
    if (!sourceTrace?.mode?.includes('markers')) return false
    return isNumericSeries(sourceTrace?.x) && isNumericSeries(sourceTrace?.y)
  }, [getTrendlineSourceTrace, isNumericSeries])

  // Check if plot supports jitter (box/violin plots only)
  const supportsJitter = useMemo(() => {
    if (plotData.length === 0) return false
    return plotData.some((trace) => {
      const t = trace as any
      return t.type === 'box' || t.type === 'violin'
    })
  }, [plotData])

  const showBarWidthControl = activePlot?.type === 'bar'

  const hasBoxTrace = useMemo(() => {
    return plotData.some((trace) => (trace as any).type === 'box')
  }, [plotData])

  const hasViolinTrace = useMemo(() => {
    return plotData.some((trace) => (trace as any).type === 'violin')
  }, [plotData])

  // Check if plot has histogram traces
  const hasHistogramTrace = useMemo(() => {
    return plotData.some((trace) => (trace as any).type === 'histogram')
  }, [plotData])

  // Check if density curve is enabled (prefer stored meta)
  const hasDensityCurve = useMemo(() => {
    const stored = (layout.meta as Record<string, unknown> | undefined)?.showDensityCurve
    if (typeof stored === 'boolean') return stored
    return plotData.some((trace) => {
      const t = trace as any
      return t.type === 'scatter' && t.name === 'Density'
    })
  }, [layout.meta, plotData])

  // Check if jitter is currently enabled
  const hasJitter = useMemo(() => {
    return plotData.some((trace) => {
      const t = trace as any
      return (t.type === 'box' && t.boxpoints === 'all') || (t.type === 'violin' && t.points === 'all')
    })
  }, [plotData])

  // Get current jitter amount (from first box/violin trace with jitter enabled)
  const currentJitterAmount = useMemo(() => {
    const trace = plotData.find((t) => {
      const trace = t as any
      return ((trace.type === 'box' && trace.boxpoints === 'all') || (trace.type === 'violin' && trace.points === 'all'))
    }) as any
    return trace?.jitter ?? 0.3
  }, [plotData])

  // Get current point position (from first box/violin trace with jitter enabled)
  const currentPointPosition = useMemo(() => {
    const trace = plotData.find((t) => {
      const trace = t as any
      return ((trace.type === 'box' && trace.boxpoints === 'all') || (trace.type === 'violin' && trace.points === 'all'))
    }) as any
    const defaultPos = -1.8
    return trace?.pointpos ?? defaultPos
  }, [plotData])

  const currentBoxWidth = useMemo(() => {
    const widthFromMeta = layoutMeta.boxWidth
    if (typeof widthFromMeta === 'number' && Number.isFinite(widthFromMeta)) {
      return widthFromMeta
    }
    const trace = plotData.find((t) => (t as any).type === 'box') as any
    const width = trace?.width
    return typeof width === 'number' && Number.isFinite(width) ? width : 0.3
  }, [layoutMeta.boxWidth, plotData])

  const currentViolinWidth = useMemo(() => {
    const widthFromMeta = layoutMeta.violinWidth
    if (typeof widthFromMeta === 'number' && Number.isFinite(widthFromMeta)) {
      return widthFromMeta
    }
    const trace = plotData.find((t) => (t as any).type === 'violin') as any
    const width = trace?.width
    return typeof width === 'number' && Number.isFinite(width) ? width : 0.3
  }, [layoutMeta.violinWidth, plotData])

  const currentBarWidth = useMemo(() => {
    const widthFromMeta = layoutMeta.barWidth
    if (typeof widthFromMeta === 'number' && Number.isFinite(widthFromMeta)) {
      return widthFromMeta
    }
    const trace = plotData.find((t) => (t as any).type === 'bar') as any
    const width = trace?.width
    return typeof width === 'number' && Number.isFinite(width) ? width : 0.4
  }, [layoutMeta.barWidth, plotData])

  const currentBoxViolinPadding = useMemo(() => {
    const value = layoutMeta.boxViolinPaddingRatio
    return typeof value === 'number' && Number.isFinite(value) ? value : 0.05
  }, [layoutMeta.boxViolinPaddingRatio])

  const resolveBoxViolinRangeBase = useCallback(() => {
    const metaRange = layoutMeta.boxViolinRangeBase
    if (
      metaRange &&
      Number.isFinite(metaRange.min) &&
      Number.isFinite(metaRange.max) &&
      metaRange.min !== metaRange.max
    ) {
      return metaRange
    }

    const axisRange = (layout.yaxis as any)?.range
    const hasAxisRange =
      Array.isArray(axisRange) &&
      axisRange.length === 2 &&
      axisRange.every((value) => typeof value === 'number' && Number.isFinite(value))
    const axisRangeValue = hasAxisRange
      ? { min: axisRange[0] as number, max: axisRange[1] as number }
      : null

    if (axisRangeValue) {
      return axisRangeValue
    }

    const values: number[] = []
    const pushValues = (input: unknown) => {
      if (!Array.isArray(input)) return
      input.forEach((value) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          values.push(value)
        }
      })
    }

    plotData.forEach((trace) => {
      const t = trace as any
      if (t.type !== 'box' && t.type !== 'violin') return
      pushValues(t.y)
      pushValues(t.lowerfence)
      pushValues(t.upperfence)
      pushValues(t.q1)
      pushValues(t.q3)
      pushValues(t.median)
    })

    if (values.length > 0) {
      return { min: Math.min(...values), max: Math.max(...values) }
    }

    return axisRangeValue
  }, [layoutMeta.boxViolinRangeBase, layout.yaxis, plotData])

  // Check if trendline trace already exists
  const hasTrendline = useMemo(() => {
    return plotData.some(isTrendlineTrace)
  }, [plotData, isTrendlineTrace])

  const getTrendlineSourceData = useCallback(() => {
    const sourceTrace = getTrendlineSourceTrace()
    const x = sourceTrace?.x as unknown
    const y = sourceTrace?.y as unknown
    return { x, y }
  }, [getTrendlineSourceTrace])

  // Get trendline stats if present
  const trendlineStats = useMemo(() => {
    const trendlineTrace = plotData.find(isTrendlineTrace) as any
    if (!trendlineTrace?.meta) return null
    return {
      equation: trendlineTrace.meta.equation ?? '',
      rSquared: trendlineTrace.meta.r_squared ?? 0,
      slope: trendlineTrace.meta.slope ?? 0,
      intercept: trendlineTrace.meta.intercept ?? 0,
      type: trendlineTrace.meta.type as TrendlineType | undefined,
      degree: trendlineTrace.meta.degree as number | undefined,
    }
  }, [plotData, isTrendlineTrace])

  const trendlineMeta = useMemo(() => {
    const trendlineTrace = plotData.find(isTrendlineTrace) as any
    return (trendlineTrace?.meta ?? null) as TrendlineStats | null
  }, [plotData, isTrendlineTrace])

  const buildTrendlineStatsPayload = useCallback((stats: TrendlineStats) => {
    const payload: Record<string, number | string> = {
      trendline_type: stats.type,
      trendline_degree: stats.degree,
      trendline_r_squared: stats.r_squared,
      trendline_n_points: stats.n_points,
    }

    if (stats.equation) {
      payload.trendline_equation = stats.equation
    }
    if (typeof stats.slope === 'number') {
      payload.trendline_slope = stats.slope
    }
    if (typeof stats.intercept === 'number') {
      payload.trendline_intercept = stats.intercept
    }
    if (Array.isArray(stats.coefficients)) {
      payload.trendline_coefficients = stats.coefficients.join(', ')
    }

    return payload
  }, [])

  const stripTrendlineStats = useCallback((stats: Record<string, number | string>) => {
    return Object.fromEntries(
      Object.entries(stats).filter(([key]) => !key.startsWith('trendline_'))
    )
  }, [])

  const syncTrendlineStats = useCallback((stats: TrendlineStats | null) => {
    if (!activePlot) return
    const current = getPlotStats(activePlot.id) ?? {}
    const baseStats = stripTrendlineStats(current)
    if (!stats) {
      setPlotStats(activePlot.id, baseStats)
      return
    }
    setPlotStats(activePlot.id, {
      ...baseStats,
      ...buildTrendlineStatsPayload(stats),
    })
  }, [activePlot, buildTrendlineStatsPayload, getPlotStats, setPlotStats, stripTrendlineStats])

  useEffect(() => {
    if (!activePlot) return
    if (trendlineStats?.type) {
      setTrendlineType(trendlineStats.type)
    } else {
      setTrendlineType('linear')
    }
    if (typeof trendlineStats?.degree === 'number') {
      const nextDegree = Math.max(2, Math.min(trendlineStats.degree, 5))
      setTrendlineDegree(nextDegree)
    } else {
      setTrendlineDegree(2)
    }
    lastTrendlineRequestRef.current = null
  }, [activePlot?.id])

  useEffect(() => {
    if (!activePlot || !trendlineMeta) return
    syncTrendlineStats(trendlineMeta)
  }, [activePlot?.id, syncTrendlineStats, trendlineMeta])

  const applyTrendline = useCallback(
    async (options: { replaceExisting: boolean; silent?: boolean }) => {
      if (!activePlot || !supportsTrendline) return

      const { x, y } = getTrendlineSourceData()
      if (!x || !y || (Array.isArray(x) && x.length === 0) || (Array.isArray(y) && y.length === 0)) {
        if (!options.silent) {
          toast.error('No data available for trendline')
        }
        return
      }
      if (!isNumericSeries(x) || !isNumericSeries(y)) {
        if (!options.silent) {
          toast.error('Trendline requires numeric X/Y data')
        }
        return
      }

      setTrendlineLoading(true)
      try {
        const desiredType = trendlineType
        const desiredDegree = trendlineType === 'polynomial' ? trendlineDegree : 2
        const result = await computeTrendline({
          x,
          y,
          type: desiredType,
          degree: desiredDegree,
          lineColor: '#222222',
          lineDash: 'solid',
        })

        if (!result.success) {
          if (!options.silent) {
            toast.error(result.error ?? 'Failed to compute trendline')
          }
          return
        }

        const trendlineTrace = {
          ...result.trace,
          meta: { ...result.stats, trendline: true },
        }

        const baseData = options.replaceExisting
          ? plotData.filter((trace) => !isTrendlineTrace(trace))
          : plotData
        const updated = [...baseData, trendlineTrace]
        updatePlot(activePlot.id, { plotlyData: updated })
        syncTrendlineStats(result.stats)
        if (!options.silent) {
          toast.success(`Trendline added: ${result.stats?.equation ?? ''}`)
        }
      } catch (error) {
        console.error('Trendline error:', error)
        if (!options.silent) {
          toast.error('Failed to compute trendline')
        }
      } finally {
        setTrendlineLoading(false)
      }
    },
    [
      activePlot,
      supportsTrendline,
      getTrendlineSourceData,
      isNumericSeries,
      trendlineType,
      trendlineDegree,
      plotData,
      updatePlot,
      isTrendlineTrace,
      syncTrendlineStats,
    ]
  )

  // Add or remove trendline
  const toggleTrendline = useCallback(async () => {
    if (!activePlot || !supportsTrendline) return

    if (hasTrendline) {
      const updated = plotData.filter((trace) => !isTrendlineTrace(trace))
      updatePlot(activePlot.id, { plotlyData: updated })
      syncTrendlineStats(null)
      lastTrendlineRequestRef.current = null
      toast.success('Trendline removed')
      return
    }

    await applyTrendline({ replaceExisting: false })
  }, [
    activePlot,
    supportsTrendline,
    hasTrendline,
    plotData,
    updatePlot,
    applyTrendline,
    isTrendlineTrace,
    syncTrendlineStats,
  ])

  useEffect(() => {
    if (!activePlot || !supportsTrendline || !hasTrendline) return
    if (trendlineLoading) return

    const desiredType = trendlineType
    const desiredDegree = trendlineType === 'polynomial' ? trendlineDegree : 2
    const currentType = trendlineStats?.type ?? 'linear'
    const currentDegree = trendlineStats?.degree ?? 2
    const needsUpdate =
      currentType !== desiredType ||
      (desiredType === 'polynomial' && currentDegree !== desiredDegree)

    if (!needsUpdate) return

    const lastRequest = lastTrendlineRequestRef.current
    if (
      lastRequest &&
      lastRequest.plotId === activePlot.id &&
      lastRequest.type === desiredType &&
      lastRequest.degree === desiredDegree
    ) {
      return
    }

    lastTrendlineRequestRef.current = {
      plotId: activePlot.id,
      type: desiredType,
      degree: desiredDegree,
    }
    applyTrendline({ replaceExisting: true, silent: true })
  }, [
    activePlot,
    supportsTrendline,
    hasTrendline,
    trendlineLoading,
    trendlineType,
    trendlineDegree,
    trendlineStats?.type,
    trendlineStats?.degree,
    applyTrendline,
  ])

  // Linked data for Data tab
  const snapshot =
    activePlot?.sourceType === 'user_derived' ? activePlot.dataSnapshot : null

  const tableData = useMemo(() => {
    if (!snapshot) return null
    const columns = snapshot.columns
    if (columns.length === 0) return null
    const rowCount = Math.min(...columns.map((col) => col.values.length))
    const rows: any[][] = []
    const limit = Math.min(rowCount, 10)
    for (let i = 0; i < limit; i++) {
      rows.push(columns.map((col) => col.values[i]))
    }
    return { columns, rows, totalRows: rowCount }
  }, [snapshot])

  const interpolationResultsTableRows = useMemo(() => {
    return batchInterpolationResults.slice(0, MAX_BATCH_INTERPOLATION_VALUES).map((row, idx) => ({
      index: idx,
      input: row.input,
      output: row.output,
      status: formatBatchInterpolationStatus(row.status),
      extrapolated: row.extrapolated ? 'yes' : 'no',
      message: row.message,
      row,
    }))
  }, [batchInterpolationResults])

  const hasInterpolationResultsTable =
    isDoseResponse &&
    interpolationEntryMode === 'batch' &&
    interpolationResultsTableRows.length > 0

  const copyInterpolationResults = useCallback(async () => {
    if (interpolationResultsTableRows.length === 0) return
    const header = ['#', 'Input', 'Output', 'Status', 'Extrapolated', 'Message']
    const lines = [
      header.join('\t'),
      ...interpolationResultsTableRows.map((entry, idx) =>
        [
          idx + 1,
          formatDoseInterpolationValue(entry.input),
          entry.output === null ? '—' : formatDoseInterpolationValue(entry.output),
          entry.status,
          entry.extrapolated,
          entry.message,
        ].join('\t')
      ),
    ]
    try {
      await writeText(lines.join('\n'))
      toast.success('Interpolation table copied')
    } catch (error) {
      console.error('Failed to copy interpolation table:', error)
      toast.error('Failed to copy interpolation table')
    }
  }, [interpolationResultsTableRows])

  const exportInterpolationResultsCsv = useCallback(async () => {
    if (interpolationResultsTableRows.length === 0) return

    const rows = interpolationResultsTableRows.map((entry, idx) => ({
      row: idx + 1,
      input: entry.input,
      output: entry.output,
      status: entry.status,
      extrapolated: entry.extrapolated,
      message: entry.message,
    }))
    const columns = ['row', 'input', 'output', 'status', 'extrapolated', 'message']

    try {
      await exportService.exportDataToCsv(rows, columns)
      toast.success('Interpolation CSV exported')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes('cancelled')) return
      console.error('Failed to export interpolation CSV:', error)
      toast.error('Interpolation CSV export failed')
    }
  }, [interpolationResultsTableRows])

  const exportLinkedDataCsv = useCallback(async () => {
    if (!snapshot) return
    const columns = snapshot.columns.map((column) => column.columnName)
    if (columns.length === 0) return

    const rowCount = Math.min(...snapshot.columns.map((column) => column.values.length))
    const rows: Record<string, unknown>[] = []
    for (let rowIdx = 0; rowIdx < rowCount; rowIdx += 1) {
      const rowEntry: Record<string, unknown> = {}
      snapshot.columns.forEach((column) => {
        rowEntry[column.columnName] = column.values[rowIdx]
      })
      rows.push(rowEntry)
    }

    try {
      await exportService.exportDataToCsv(rows, columns)
      toast.success('Linked data CSV exported')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes('cancelled')) return
      console.error('Failed to export linked data CSV:', error)
      toast.error('Linked data CSV export failed')
    }
  }, [snapshot])

  // ============================================================================
  // Render
  // ============================================================================

  if (!activePlot) {
    return (
      <div className={cn('flex flex-col h-full bg-white dark:bg-zinc-900', className)}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            Plot Settings
          </h2>
        </div>
        <div className="flex-1 flex items-center justify-center text-sm text-zinc-400">
          Select a plot
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col h-full bg-white dark:bg-zinc-900', className)}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <h2 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Settings
        </h2>
        <p className="text-[10px] font-mono text-zinc-400 mt-0.5">
          {template?.displayName || activePlot.type}
        </p>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          setActiveTab(value as 'colors' | 'axes' | 'data' | 'brackets' | 'shapes')
        }
        className="flex-1 flex flex-col min-h-0"
      >
        <div className="w-full shrink-0 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 [scrollbar-width:thin] [scrollbar-color:rgba(161,161,170,0.7)_transparent] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-700">
          <TabsList className="h-10 w-max min-w-full justify-start px-2 rounded-none bg-zinc-50 dark:bg-zinc-900 whitespace-nowrap">
            <TabsTrigger
              value="colors"
              className="text-xs shrink-0 data-[state=active]:bg-white dark:data-[state=active]:bg-zinc-800 data-[state=disabled]:opacity-50 data-[state=disabled]:cursor-not-allowed"
              disabled={disableColorsTab}
            >
              <Palette className="h-3.5 w-3.5 mr-1" weight="bold" />
              Colors
            </TabsTrigger>
            <TabsTrigger
              value="axes"
              className="text-xs shrink-0 data-[state=active]:bg-white dark:data-[state=active]:bg-zinc-800"
            >
              <Axis3d className="h-3.5 w-3.5 mr-1" />
              Axes
            </TabsTrigger>
            <TabsTrigger
              value="brackets"
              className="text-xs shrink-0 data-[state=active]:bg-white dark:data-[state=active]:bg-zinc-800 data-[state=disabled]:opacity-50 data-[state=disabled]:cursor-not-allowed"
              disabled={!hasBrackets}
            >
              <BracesIcon className="h-3.5 w-3.5 mr-1" />
              Brackets
            </TabsTrigger>
            <TabsTrigger
              value="shapes"
              className="text-xs shrink-0 data-[state=active]:bg-white dark:data-[state=active]:bg-zinc-800"
            >
              <Shapes className="h-3.5 w-3.5 mr-1" />
              Shapes
            </TabsTrigger>
            <TabsTrigger
              value="data"
              className="text-xs shrink-0 data-[state=active]:bg-white dark:data-[state=active]:bg-zinc-800"
            >
              <Table2 className="h-3.5 w-3.5 mr-1" />
              Data
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
          {/* Colors Tab - Trace color/pattern controls */}
          <TabsContent value="colors" className="m-0 flex-1 min-h-0 overflow-hidden">
            <ScrollArea className="h-full" scrollbarSide="left" leftViewportPadding="sm">
              <div className="p-4 space-y-4">
              <Label className="text-xs font-medium">Trace Colors & Patterns</Label>
              {plotData.length === 0 ? (
                <div className="text-xs text-zinc-400 text-center py-4">
                  No traces to customize
                </div>
                ) : (
                  <div className="rounded-md border border-zinc-200 dark:border-zinc-700">
                    <div className="p-3 space-y-3">
                    {plotData
                      .map((trace, idx) => ({ trace, idx }))
                      .filter(({ trace }) => (trace as any).meta?.role !== 'confidence_band_lower')
                      .map(({ trace, idx }) => {
                    const traceName =
                      (trace as any).name || `Trace ${idx + 1}`
                    const currentColor = getTraceColor(trace, idx)
                    const currentPattern = getTracePattern(trace)
                    const isPieTrace = (trace as any).type === 'pie'
                    const isBarTrace = (trace as any).type === 'bar'
                    const pieLabels = isPieTrace ? getPieLabels(trace) : []
                    const pieSliceColors = isPieTrace ? getPieSliceColors(trace) : []
                    const barCategoryLabels = isBarTrace ? getBarCategoryLabels(trace) : []
                    const barCategoryStyles = isBarTrace ? getBarCategoryStyles(trace) : []
                    const barCategoryColors = barCategoryStyles.map((entry) => entry.color)
                    const barCategoryPatterns = barCategoryStyles.map((entry) => entry.patternShape)
                    const barCategoryPatternSizes = barCategoryStyles.map((entry) => entry.patternSize)
                    const barCategoryPatternSolidities = barCategoryStyles.map((entry) => entry.patternSolidity)
                    const barCategoryFrameEnabled = barCategoryStyles.map((entry) => entry.lineWidth > 0)
                    const barTraceCount = plotData.filter((t) => (t as any).type === 'bar').length
                    const showBarCategoryColors =
                      activePlot?.sourceType === 'user_derived' &&
                      activePlot?.type === 'bar' &&
                      isBarTrace &&
                      // Phase 1 (single-trace): one trace with multiple categories.
                      // Phase 2 (split-trace): one category per trace across multiple bar traces.
                      ((barTraceCount === 1 && barCategoryLabels.length > 1) ||
                        (barTraceCount > 1 && barCategoryLabels.length >= 1))
                    const showPieSliceMode =
                      activePlot?.sourceType === 'user_derived' &&
                      isPieTrace &&
                      pieLabels.length > 0
                    const hideGlobalColorControl = showPieSliceMode || showBarCategoryColors
                    const supportsPattern = [
                      'bar',
                      'histogram',
                      'funnel',
                      'waterfall',
                      'barpolar',
                    ].includes((trace as any).type)
                    const supportsLineStyle =
                      (trace as any).type === 'scatter' &&
                      typeof (trace as any).mode === 'string' &&
                      (trace as any).mode.includes('lines')
                    const currentLineStyle = supportsLineStyle ? getLineDashStyle(trace) : 'solid'
                    const supportsBarOutline = (trace as any).type === 'bar' && !showBarCategoryColors
                    const barOutlineEnabled = supportsBarOutline ? getBarOutlineEnabled(trace) : false

                    return (
                      <div
                        key={idx}
                        className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 space-y-2"
                        style={{ borderLeftWidth: 4, borderLeftColor: currentColor }}
                      >
                        <div className="flex items-center gap-2">
                          {/* Color swatch for visual identification */}
                          <div
                            className="w-4 h-4 rounded shrink-0"
                            style={{ backgroundColor: currentColor }}
                            title={`Current: ${currentColor}`}
                          />
                          <span className="text-xs font-medium truncate flex-1">
                            {traceName}
                          </span>
                          <span className="text-[10px] text-zinc-400 font-mono">
                            {(trace as any).type || 'scatter'}
                          </span>
                        </div>

                        {/* Global trace color (hidden when category-level mode is active) */}
                        {!hideGlobalColorControl && (
                          <div className="flex items-center gap-2">
                            <Label className="text-[10px] text-zinc-500 w-12">Color</Label>
                            <Input
                              type="color"
                              value={currentColor}
                              onChange={(e) =>
                                debouncedUpdateTraceColor(idx, e.target.value)
                              }
                              className="h-7 w-14 p-0.5 cursor-pointer"
                            />
                            <div className="flex flex-wrap gap-1 flex-1 max-w-full">
                              {QUICK_TRACE_COLORS.map((color) => (
                                <button
                                  key={color}
                                  onClick={() => updateTraceColor(idx, color)}
                                  className={cn(
                                    'w-5 h-5 rounded border border-zinc-300 dark:border-zinc-600 hover:scale-110 transition-transform',
                                    currentColor === color && 'ring-2 ring-cyan-500 ring-offset-1'
                                  )}
                                  style={{ backgroundColor: color }}
                                  title={color}
                                />
                              ))}
                            </div>
                          </div>
                        )}

                      {showPieSliceMode && (
                        <div className="space-y-2">
                          <Label className="text-[10px] text-zinc-500">Slice colors</Label>
                          <div className="space-y-1">
                            {pieLabels.map((label, sliceIdx) => (
                              <div key={`${idx}-${sliceIdx}`} className="flex items-center gap-2">
                                <span className="text-[10px] text-zinc-500 truncate flex-1">
                                  {label || `Slice ${sliceIdx + 1}`}
                                </span>
                                <Input
                                  type="color"
                                  value={formatColorForInput(pieSliceColors[sliceIdx])}
                                  onChange={(e) =>
                                    debouncedUpdatePieSliceColor(
                                      idx,
                                      sliceIdx,
                                      e.target.value
                                    )
                                  }
                                  className="h-7 w-10 p-0.5 cursor-pointer"
                                />
                                <div className="flex gap-1">
                                  {QUICK_TRACE_COLORS.slice(0, 3).map((quickColor) => (
                                    <button
                                      key={quickColor}
                                      type="button"
                                      onClick={() =>
                                        updatePieSliceColor(idx, sliceIdx, quickColor)
                                      }
                                      className={cn(
                                        'w-4 h-4 rounded border border-zinc-300 dark:border-zinc-600',
                                        formatColorForInput(pieSliceColors[sliceIdx]) ===
                                          quickColor && 'ring-2 ring-cyan-500 ring-offset-1'
                                      )}
                                      style={{ backgroundColor: quickColor }}
                                      title={quickColor}
                                    />
                                  ))}
                                </div>
                                {pieLabels.length > 1 && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-2 text-[10px]"
                                    onClick={() =>
                                      applyColorToAllPieSlices(
                                        idx,
                                        formatColorForInput(pieSliceColors[sliceIdx])
                                      )
                                    }
                                  >
                                    Apply to all ({pieLabels.length})
                                  </Button>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {showBarCategoryColors && (
                        <div className="space-y-2">
                          <Label className="text-[10px] text-zinc-500">Category styles</Label>
                          <div className="space-y-1">
                            {barCategoryLabels.map((label, categoryIdx) => (
                              <div
                                key={`${idx}-bar-${categoryIdx}`}
                                className="rounded border border-zinc-200 dark:border-zinc-700 p-2 space-y-2"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] text-zinc-500 truncate flex-1">
                                    {label || `Category ${categoryIdx + 1}`}
                                  </span>
                                  <Input
                                    type="color"
                                    value={formatColorForInput(barCategoryColors[categoryIdx])}
                                    onChange={(e) =>
                                      debouncedUpdateBarCategoryColor(
                                        idx,
                                        categoryIdx,
                                        e.target.value
                                      )
                                    }
                                    className="h-7 w-10 p-0.5 cursor-pointer"
                                  />
                                  <div className="flex gap-1">
                                    {QUICK_TRACE_COLORS.slice(0, 3).map((quickColor) => (
                                      <button
                                        key={quickColor}
                                        type="button"
                                        onClick={() =>
                                          updateBarCategoryColor(idx, categoryIdx, quickColor)
                                        }
                                        className={cn(
                                          'w-4 h-4 rounded border border-zinc-300 dark:border-zinc-600',
                                          formatColorForInput(barCategoryColors[categoryIdx]) ===
                                            quickColor && 'ring-2 ring-cyan-500 ring-offset-1'
                                        )}
                                        style={{ backgroundColor: quickColor }}
                                        title={quickColor}
                                      />
                                    ))}
                                  </div>
                                  {barCategoryLabels.length > 1 && (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-6 px-2 text-[10px]"
                                      onClick={() =>
                                        applyColorToAllBarCategoriesInTrace(
                                          idx,
                                          formatColorForInput(barCategoryColors[categoryIdx])
                                        )
                                      }
                                    >
                                      Apply to all ({barCategoryLabels.length})
                                    </Button>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  <Label className="text-[10px] text-zinc-500 w-12">Fill</Label>
                                  <Select
                                    value={barCategoryPatterns[categoryIdx] ?? 'solid'}
                                    onValueChange={(value) =>
                                      updateBarCategoryPattern(idx, categoryIdx, value as BarPatternShape)
                                    }
                                  >
                                    <SelectTrigger className="h-7 text-xs flex-1">
                                      <SelectValue placeholder="Solid" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {PATTERN_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>
                                          {opt.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  <Label className="text-[10px] text-zinc-500">Frame</Label>
                                  <Switch
                                    checked={barCategoryFrameEnabled[categoryIdx] ?? true}
                                    onCheckedChange={(checked) =>
                                      updateBarCategoryFrame(idx, categoryIdx, Boolean(checked))
                                    }
                                  />
                                </div>
                                {(barCategoryPatterns[categoryIdx] ?? 'solid') !== 'solid' && (
                                  <>
                                    <div className="flex items-center gap-2">
                                      <Label className="text-[10px] text-zinc-500 w-12">Size</Label>
                                      <Input
                                        type="range"
                                        min={2}
                                        max={20}
                                        step={1}
                                        value={barCategoryPatternSizes[categoryIdx] ?? 6}
                                        onChange={(e) =>
                                          updateBarCategoryPatternSpacing(
                                            idx,
                                            categoryIdx,
                                            Number(e.target.value)
                                          )
                                        }
                                        className="h-5 flex-1"
                                      />
                                      <span className="text-[10px] text-zinc-400 w-6 text-right">
                                        {barCategoryPatternSizes[categoryIdx] ?? 6}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <Label className="text-[10px] text-zinc-500 w-12">Density</Label>
                                      <Input
                                        type="range"
                                        min={0.1}
                                        max={1}
                                        step={0.1}
                                        value={barCategoryPatternSolidities[categoryIdx] ?? 0.5}
                                        onChange={(e) =>
                                          updateBarCategoryPatternDensity(
                                            idx,
                                            categoryIdx,
                                            Number(e.target.value)
                                          )
                                        }
                                        className="h-5 flex-1"
                                      />
                                      <span className="text-[10px] text-zinc-400 w-8 text-right">
                                        {Math.round(
                                          (barCategoryPatternSolidities[categoryIdx] ?? 0.5) * 100
                                        )}
                                        %
                                      </span>
                                    </div>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Line style selector (line-type traces) */}
                      {supportsLineStyle && (
                        <div className="flex items-center gap-2">
                          <Label className="text-[10px] text-zinc-500 w-12">Style</Label>
                          <Select
                            value={currentLineStyle}
                            onValueChange={(value) => updateLineDashStyle(idx, value)}
                          >
                            <SelectTrigger className="h-7 text-xs flex-1">
                              <SelectValue placeholder="Solid" />
                            </SelectTrigger>
                            <SelectContent>
                              {LINE_STYLE_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {/* Pattern selector (bar-type traces) */}
                      {supportsPattern && !showBarCategoryColors && (
                        <>
                          <div className="flex items-center gap-2">
                            <Label className="text-[10px] text-zinc-500 w-12">Fill</Label>
                            <Select
                              value={currentPattern}
                              onValueChange={(value) => updateTracePattern(idx, value)}
                            >
                              <SelectTrigger className="h-7 text-xs flex-1">
                                <SelectValue placeholder="Solid" />
                              </SelectTrigger>
                              <SelectContent>
                                {PATTERN_OPTIONS.map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {/* Pattern spacing controls (only when pattern is active) */}
                          {currentPattern !== 'solid' && (
                            <>
                              <div className="flex items-center gap-2">
                                <Label className="text-[10px] text-zinc-500 w-12">Size</Label>
                                <Input
                                  type="range"
                                  min={2}
                                  max={20}
                                  step={1}
                                  value={getTracePatternSize(trace)}
                                  onChange={(e) => updateTracePatternSize(idx, Number(e.target.value))}
                                  className="h-5 flex-1"
                                />
                                <span className="text-[10px] text-zinc-400 w-6 text-right">
                                  {getTracePatternSize(trace)}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <Label className="text-[10px] text-zinc-500 w-12">Density</Label>
                                <Input
                                  type="range"
                                  min={0.1}
                                  max={1}
                                  step={0.1}
                                  value={getTracePatternSolidity(trace)}
                                  onChange={(e) => updateTracePatternSolidity(idx, Number(e.target.value))}
                                  className="h-5 flex-1"
                                />
                                <span className="text-[10px] text-zinc-400 w-6 text-right">
                                  {Math.round(getTracePatternSolidity(trace) * 100)}%
                                </span>
                              </div>
                            </>
                          )}
                          {supportsBarOutline && (
                            <div className="flex items-center gap-2">
                              <Label className="text-[10px] text-zinc-500 w-12">Outline</Label>
                              <Switch
                                checked={barOutlineEnabled}
                                onCheckedChange={(checked) => updateBarOutline(idx, Boolean(checked))}
                              />
                              <span className="text-[10px] text-zinc-400">Bar frame</span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )
                  })}
                </div>
                </div>
              )}

              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="brackets" className="m-0 flex-1 min-h-0 overflow-hidden">
            <ScrollArea className="h-full" scrollbarSide="left" leftViewportPadding="sm">
              <div className="p-4">
            {!hasBrackets ? (
              <div className="text-xs text-zinc-400 text-center py-6">
                Significance brackets appear after running ANOVA with post-hoc results.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Bracket labels</Label>
                  <Select
                    value={currentBracketLabelMode}
                    onValueChange={(value) => updateBracketLabelMode(value as 'stars' | 'pvalue')}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stars">Significance (***, **, *)</SelectItem>
                      <SelectItem value="pvalue">P-value</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Label className="text-xs font-medium">Significance effects</Label>
                <div className="space-y-2 pr-1">
                  {bracketEffects.map((effect) => (
                    <div
                      key={effect.effectId}
                      className="flex items-center gap-3 rounded border border-zinc-200 dark:border-zinc-700 px-3 py-2"
                    >
                      <Switch
                        checked={isBracketEffectVisible(effect)}
                        onCheckedChange={(checked) =>
                          toggleEffectVisibility(effect.effectId, Boolean(checked))
                        }
                        className={cn(
                          effect.significant
                            ? 'data-[state=checked]:bg-red-500 data-[state=checked]:border-red-500'
                            : 'data-[state=checked]:bg-blue-500 data-[state=checked]:border-blue-500'
                        )}
                      />
                      <div>
                        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-200">
                          {effect.label}
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-zinc-400">
                          {effect.group === 'main' ? 'Main effect' : 'Simple effect'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Axes Tab */}
          <TabsContent value="axes" className="m-0 flex-1 min-h-0 overflow-hidden">
            <ScrollArea className="h-full" scrollbarSide="left" leftViewportPadding="sm">
              <div className="p-4 space-y-4">
              <Tabs defaultValue="title" className="space-y-3 pb-3 border-b border-zinc-200 dark:border-zinc-700">
                <TabsList className="grid grid-cols-3 h-8">
                  <TabsTrigger value="title" className="text-xs">Title</TabsTrigger>
                  <TabsTrigger value="axis" className="text-xs">Axis</TabsTrigger>
                  <TabsTrigger value="annotation" className="text-xs">Annotation</TabsTrigger>
                </TabsList>

                <TabsContent value="title" className="space-y-2 m-0 p-0">
                  <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Title</Label>
                  <Input
                    value={activePlot.title}
                    onChange={(e) => updateTitle(e.target.value)}
                    placeholder="Plot title"
                    className="h-8 text-sm"
                  />
                  <div className={cn('flex gap-2', isConstrained && 'flex-col')}>
                    <Select value={normalizedTitleFont} onValueChange={updateTitleFont}>
                      <SelectTrigger className="h-8 flex-1">
                        <SelectValue placeholder="Font" />
                      </SelectTrigger>
                      <SelectContent>
                        {PLOT_FONTS.map((font) => (
                          <SelectItem
                            key={font.value}
                            value={font.value}
                            style={{ fontFamily: font.value }}
                          >
                            {font.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={String(currentTitleFontSize)}
                      onValueChange={(v) => updateTitleFontSize(Number(v))}
                    >
                      <SelectTrigger className={cn('h-8', isConstrained ? 'w-full' : 'w-20')}>
                        <SelectValue placeholder="Size" />
                      </SelectTrigger>
                      <SelectContent>
                        {FONT_SIZES.map((size) => (
                          <SelectItem key={size} value={String(size)}>
                            {size}pt
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Title Color
                    </Label>
                    <Input
                      type="color"
                      value={titleColorInput}
                      onChange={(e) => {
                        const next = e.target.value
                        setTitleColorInput(next)
                        debouncedUpdateTitleFontColor(next)
                      }}
                      className="h-8 w-20 p-1"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="axis" className="space-y-2 m-0 p-0">
                  <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Axis Font</Label>
                  <div className={cn('flex gap-2', isConstrained && 'flex-col')}>
                    <Select value={normalizedFont} onValueChange={updateFont}>
                      <SelectTrigger className="h-8 flex-1">
                        <SelectValue placeholder="Font" />
                      </SelectTrigger>
                      <SelectContent>
                        {PLOT_FONTS.map((font) => (
                          <SelectItem
                            key={font.value}
                            value={font.value}
                            style={{ fontFamily: font.value }}
                          >
                            {font.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={String(currentFontSize)}
                      onValueChange={(v) => updateFontSize(Number(v))}
                    >
                      <SelectTrigger className={cn('h-8', isConstrained ? 'w-full' : 'w-20')}>
                        <SelectValue placeholder="Size" />
                      </SelectTrigger>
                      <SelectContent>
                        {FONT_SIZES.map((size) => (
                          <SelectItem key={size} value={String(size)}>
                            {size}pt
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Axis Color
                    </Label>
                    <Input
                      type="color"
                      value={axisColorInput}
                      onChange={(e) => {
                        const next = e.target.value
                        setAxisColorInput(next)
                        debouncedUpdateAxisFontColor(next)
                      }}
                      className="h-8 w-20 p-1"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="annotation" className="space-y-2 m-0 p-0">
                  <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                    Annotation Font
                  </Label>
                  <div className={cn('flex gap-2', isConstrained && 'flex-col')}>
                    <Select value={normalizedAnnotationFont} onValueChange={updateAnnotationFont}>
                      <SelectTrigger className="h-8 flex-1">
                        <SelectValue placeholder="Font" />
                      </SelectTrigger>
                      <SelectContent>
                        {PLOT_FONTS.map((font) => (
                          <SelectItem
                            key={font.value}
                            value={font.value}
                            style={{ fontFamily: font.value }}
                          >
                            {font.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={String(currentAnnotationFontSize)}
                      onValueChange={(v) => updateAnnotationFontSize(Number(v))}
                    >
                      <SelectTrigger className={cn('h-8', isConstrained ? 'w-full' : 'w-20')}>
                        <SelectValue placeholder="Size" />
                      </SelectTrigger>
                      <SelectContent>
                        {FONT_SIZES.map((size) => (
                          <SelectItem key={size} value={String(size)}>
                            {size}pt
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Annotation Color
                    </Label>
                    <Input
                      type="color"
                      value={annotationColorInput}
                      onChange={(e) => {
                        const next = e.target.value
                        setAnnotationColorInput(next)
                        debouncedUpdateAnnotationFontColor(next)
                      }}
                      className="h-8 w-20 p-1"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Annotation Rotation
                    </Label>
                    <div className={cn('flex gap-2 items-center', isConstrained && 'flex-wrap')}>
                      <Input
                        type="number"
                        value={annotationTextAngleInput}
                        onChange={(e) => setAnnotationTextAngleInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return
                          e.currentTarget.blur()
                        }}
                        onBlur={() => {
                          const next = Number(annotationTextAngleInput)
                          if (!Number.isFinite(next)) {
                            setAnnotationTextAngleInput(String(currentAnnotationTextAngle))
                            return
                          }
                          const clamped = Math.max(-180, Math.min(180, next))
                          setAnnotationTextAngleInput(String(clamped))
                          updateAnnotationTextAngle(clamped)
                        }}
                        placeholder="0"
                        className="h-8 w-20 text-sm"
                        min={-180}
                        max={180}
                      />
                      <span className="text-xs text-zinc-500">degrees</span>
                      <div className="flex gap-1 ml-auto">
                        {[0, 45, 90, -45, -90].map((angle) => (
                          <button
                            key={angle}
                            type="button"
                            onClick={() => {
                              setAnnotationTextAngleInput(String(angle))
                              updateAnnotationTextAngle(angle)
                            }}
                            className={`px-2 py-1 text-xs rounded border transition-colors ${
                              currentAnnotationTextAngle === angle
                                ? 'bg-blue-500 text-white border-blue-500'
                                : 'bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-600 hover:border-blue-400'
                            }`}
                          >
                            {angle}°
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>

              {/* AXIS SECTION */}
              <div className="space-y-3 pb-3 border-b border-zinc-200 dark:border-zinc-700">
                {/* X Axis */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">X Axis Label</Label>
                  <Input
                    value={String((layout.xaxis as any)?.title?.text ?? '')}
                    onChange={(e) => updateAxisTitle('xaxis', e.target.value)}
                    placeholder="X axis title"
                    className="h-8 text-sm"
                  />
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={gridUserSet ? ((layout.xaxis as any)?.showgrid ?? false) : false}
                      onCheckedChange={(checked) => updateGrid('xaxis', checked)}
                    />
                    <span className="text-xs text-zinc-500">Show grid</span>
                  </div>
                </div>

                  {/* Y Axis */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Y Axis Label</Label>
                    <Input
                      value={String((layout.yaxis as any)?.title?.text ?? '')}
                    onChange={(e) => updateAxisTitle('yaxis', e.target.value)}
                    placeholder="Y axis title"
                    className="h-8 text-sm"
                  />
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={gridUserSet ? ((layout.yaxis as any)?.showgrid ?? false) : false}
                        onCheckedChange={(checked) => updateGrid('yaxis', checked)}
                      />
                      <span className="text-xs text-zinc-500">Show grid</span>
                    </div>
                  </div>

                {hasConfidenceBand && (
                  <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                    <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Confidence Band
                    </Label>
                      <Input
                        value={confidenceBandLabel ?? '95% CI'}
                        readOnly
                        className="h-8 text-sm"
                      />
                      <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                        <Switch
                          checked={showConfidenceBand}
                          onCheckedChange={(checked) => updateConfidenceBandVisibility(checked)}
                        />
                        <span className="text-xs text-zinc-500">
                          Show {confidenceBandLabel ?? '95% CI'}
                        </span>
                      </div>
                  </div>
                )}

                {showFrameToggle && (
                  <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                    <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                      Plot Frame
                    </Label>
                    <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                      <Switch
                        checked={frameEnabled}
                        onCheckedChange={(checked) => updatePlotFrame(Boolean(checked))}
                      />
                      <span className="text-xs text-zinc-500">Draw a border around the plot</span>
                    </div>
                  </div>
                )}

                {isDoseResponse && (
                  <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                    <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Dose-Response</Label>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={showCiBand}
                        onCheckedChange={(checked) => updateDoseResponseCiBand(checked)}
                      />
                      <span className="text-xs text-zinc-500">Show 95% CI band</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={showFittedPoints}
                        onCheckedChange={(checked) => updateDoseResponseFittedPoints(checked)}
                      />
                      <span className="text-xs text-zinc-500">Show fitted points</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={showObservedPoints}
                        onCheckedChange={(checked) => updateDoseResponseObservedPoints(checked)}
                      />
                      <span className="text-xs text-zinc-500">Show observed points</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={showIc50Label}
                        onCheckedChange={(checked) => updateDoseResponseIc50Label(checked)}
                      />
                      <span className="text-xs text-zinc-500">Show IC50 label</span>
                    </div>

                    <div
                      ref={interpolationCardRef}
                      className="space-y-2 rounded-md border border-zinc-200 p-2 dark:border-zinc-700"
                    >
                      <Label className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-300">
                        Interpolation
                      </Label>
                      <div className="inline-flex rounded-md border border-zinc-200 p-0.5 dark:border-zinc-700">
                        <Button
                          type="button"
                          size="sm"
                          variant={interpolationEntryMode === 'single' ? 'default' : 'ghost'}
                          className="h-7 rounded-sm px-2 text-xs"
                          onClick={() => setInterpolationEntryMode('single')}
                        >
                          Single
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={interpolationEntryMode === 'batch' ? 'default' : 'ghost'}
                          className="h-7 rounded-sm px-2 text-xs"
                          onClick={() => setInterpolationEntryMode('batch')}
                        >
                          Batch
                        </Button>
                      </div>

                      <div className={cn('grid gap-2', isInterpolationNarrow ? 'grid-cols-1' : 'grid-cols-2')}>
                        <Select
                          value={interpolationMode}
                          onValueChange={(value) =>
                            setInterpolationMode(value as DoseResponseInterpolationMode)
                          }
                        >
                          <SelectTrigger
                            className="h-8 w-full min-w-0 text-xs"
                            data-testid="dose-interpolation-mode"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="forward">Conc -&gt; Response</SelectItem>
                            <SelectItem value="inverse">Response -&gt; Conc</SelectItem>
                          </SelectContent>
                        </Select>
                        {interpolationEntryMode === 'single' ? (
                          <Input
                            data-testid="dose-interpolation-input"
                            value={interpolationInput}
                            onChange={(event) => setInterpolationInput(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                runDoseInterpolation()
                              }
                            }}
                            inputMode="decimal"
                            placeholder={interpolationMode === 'forward' ? 'Concentration' : 'Response'}
                            className="h-8 min-w-0 text-xs"
                          />
                        ) : (
                          <Textarea
                            data-testid="dose-interpolation-batch-input"
                            value={batchInterpolationInput}
                            onChange={(event) => setBatchInterpolationInput(event.target.value)}
                            placeholder={`One per line or comma-separated (max ${MAX_BATCH_INTERPOLATION_VALUES})`}
                            className="min-h-20 text-xs font-mono"
                          />
                        )}
                      </div>

                      {interpolationEntryMode === 'batch' && (
                        <p className="text-[11px] text-zinc-500">
                          {parsedBatchInterpolationPreview.values.length} / {MAX_BATCH_INTERPOLATION_VALUES} values
                          {parsedBatchInterpolationPreview.invalidTokenCount > 0 && (
                            <span className="ml-1 text-amber-600">
                              ({parsedBatchInterpolationPreview.invalidTokenCount} invalid ignored)
                            </span>
                          )}
                          {parsedBatchInterpolationPreview.truncatedValueCount > 0 && (
                            <span className="ml-1 text-amber-600">
                              (+{parsedBatchInterpolationPreview.truncatedValueCount} omitted)
                            </span>
                          )}
                        </p>
                      )}

                      <div className="flex items-center gap-2">
                        <Switch
                          data-testid="dose-interpolation-extrapolation"
                          checked={allowInterpolationExtrapolation}
                          onCheckedChange={setAllowInterpolationExtrapolation}
                        />
                        <span className="text-xs text-zinc-500">Allow extrapolation</span>
                      </div>

                      {observedDoseRangeLabel && (
                        <p className="text-[11px] text-zinc-500">
                          Observed dose range: {observedDoseRangeLabel}
                          {forwardInterpolationRangeStatus ? (
                            <span className="ml-1">
                              ({forwardInterpolationRangeStatus})
                            </span>
                          ) : null}
                        </p>
                      )}

                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          data-testid="dose-interpolation-compute"
                          onClick={runDoseInterpolation}
                          disabled={
                            !doseInterpolationContext ||
                            (interpolationEntryMode === 'single'
                              ? interpolationInput.trim().length === 0
                              : parsedBatchInterpolationPreview.values.length === 0)
                          }
                        >
                          Compute
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-testid="dose-interpolation-clear"
                          onClick={clearDoseInterpolationOverlay}
                        >
                          Clear
                        </Button>
                        {interpolationEntryMode === 'batch' && batchInterpolationResults.length > 0 && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setActiveTab('data')}
                          >
                            View results table
                          </Button>
                        )}
                      </div>

                      {interpolationFeedback && (
                        <p
                          data-testid="dose-interpolation-feedback"
                          className={cn(
                            'text-xs',
                            interpolationFeedback.level === 'success' && 'text-emerald-600',
                            interpolationFeedback.level === 'warning' && 'text-amber-600',
                            interpolationFeedback.level === 'error' && 'text-rose-600'
                          )}
                        >
                          {interpolationFeedback.message}
                        </p>
                      )}

                      {!doseInterpolationContext && (
                        <p className="text-xs text-zinc-500">
                          Interpolation requires fitted 3PL/4PL parameters.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Bar spacing (bar/grouped/stacked plots) */}
                {showBarSpacingControls && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Bar Spacing</Label>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label className="text-[10px] text-zinc-500 w-24">Between groups</Label>
                        <Input
                          type="range"
                          min={0}
                          max={0.9}
                          step={0.05}
                          value={currentBarGap}
                          onChange={(e) => updateBarGap(Number(e.target.value))}
                          className="h-5 flex-1"
                        />
                        <span className="text-[10px] text-zinc-400 w-8 text-right">
                          {currentBarGap.toFixed(2)}
                        </span>
                      </div>
                      {showGroupGapControl && (
                      <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                          <Label className="text-[10px] text-zinc-500 w-24">{groupGapLabel}</Label>
                          <Input
                            type="range"
                            min={0}
                            max={0.6}
                            step={0.05}
                            value={currentGroupGap}
                            onChange={(e) => updateBarGroupGap(Number(e.target.value))}
                            className="h-5 flex-1"
                          />
                          <span className="text-[10px] text-zinc-400 w-8 text-right">
                            {currentGroupGap.toFixed(2)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {showBarWidthControl && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Bar Width</Label>
                    <div className="flex items-center gap-2">
                      <Label className="text-[10px] text-zinc-500 w-20">Width</Label>
                      <Input
                        type="range"
                        min={0.1}
                        max={0.9}
                        step={0.05}
                        value={currentBarWidth}
                        onChange={(e) => updateBarWidth(Number(e.target.value))}
                        className="h-5 flex-1"
                      />
                      <span className="text-[10px] text-zinc-400 w-8 text-right">
                        {currentBarWidth.toFixed(2)}
                      </span>
                    </div>
                  </div>
                )}

                {/* Box/Violin sizing */}
                {supportsJitter && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                      Box/Violin Size
                    </Label>
                    <div className="space-y-2">
                      {hasBoxTrace && (
                  <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                          <Label className="text-[10px] text-zinc-500 w-20">Box Width</Label>
                          <Input
                            type="range"
                            min={0.1}
                            max={0.9}
                            step={0.05}
                            value={currentBoxWidth}
                            onChange={(e) => updateBoxWidth(Number(e.target.value))}
                            className="h-5 flex-1"
                          />
                          <span className="text-[10px] text-zinc-400 w-8 text-right">
                            {currentBoxWidth.toFixed(2)}
                          </span>
                        </div>
                      )}
                      {hasViolinTrace && (
                      <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                          <Label className="text-[10px] text-zinc-500 w-20">Violin Width</Label>
                          <Input
                            type="range"
                            min={0.1}
                            max={0.9}
                            step={0.05}
                            value={currentViolinWidth}
                            onChange={(e) => updateViolinWidth(Number(e.target.value))}
                            className="h-5 flex-1"
                          />
                          <span className="text-[10px] text-zinc-400 w-8 text-right">
                            {currentViolinWidth.toFixed(2)}
                          </span>
                        </div>
                      )}
                  <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                        <Label className="text-[10px] text-zinc-500 w-20">Y Padding</Label>
                        <Input
                          type="range"
                          min={0}
                          max={0.5}
                          step={0.02}
                          value={currentBoxViolinPadding}
                          onChange={(e) => updateBoxViolinPadding(Number(e.target.value))}
                          className="h-5 flex-1"
                        />
                        <span className="text-[10px] text-zinc-400 w-8 text-right">
                          {currentBoxViolinPadding.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* LEGEND SECTION */}
              <div className="space-y-2">
                <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Legend</Label>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={legendState.showLegend}
                    onCheckedChange={(checked) => updateLegend(checked)}
                  />
                  <span className="text-xs text-zinc-500">Show legend</span>
                </div>
              </div>

              {/* Density Curve (histogram only) */}
              {hasHistogramTrace && (
                <div className="space-y-2">
                  <Label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Density Curve</Label>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={hasDensityCurve}
                      onCheckedChange={toggleDensityCurve}
                    />
                    <span className="text-xs text-zinc-500">Show KDE overlay</span>
                  </div>
                </div>
              )}

              {/* Trendline (scatter plots only) */}
              {supportsTrendline && (
                <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                  <div className="flex items-center gap-2">
                    <TrendUp className="h-4 w-4 text-zinc-500" weight="bold" />
                    <Label className="text-xs font-medium">Trendline</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={hasTrendline}
                      onCheckedChange={toggleTrendline}
                      disabled={trendlineLoading}
                    />
                    <span className="text-xs text-zinc-500">
                      {trendlineLoading ? 'Computing...' : 'Show trendline'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label className="text-[10px] text-zinc-500 w-12">Type</Label>
                    <Select
                      value={trendlineType}
                      onValueChange={(value) => setTrendlineType(value as TrendlineType)}
                      disabled={trendlineLoading}
                    >
                      <SelectTrigger className="h-7 text-xs flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TRENDLINE_TYPES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value.charAt(0).toUpperCase() + value.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {trendlineType === 'polynomial' && (
                    <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                      <Label className="text-[10px] text-zinc-500 w-12">Degree</Label>
                      <Select
                        value={String(trendlineDegree)}
                        onValueChange={(value) => setTrendlineDegree(Number(value))}
                        disabled={trendlineLoading}
                      >
                        <SelectTrigger className="h-7 text-xs flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[2, 3, 4, 5].map((value) => (
                            <SelectItem key={value} value={String(value)}>
                              {value}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {hasTrendline && trendlineStats && (
                    <div className="p-2 rounded bg-zinc-50 dark:bg-zinc-800 space-y-1">
                      <p className="text-[10px] font-mono text-zinc-600 dark:text-zinc-400">
                        {trendlineStats.equation}
                      </p>
                      <p className="text-[10px] font-mono text-zinc-500">
                        R^2 = {trendlineStats.rSquared.toFixed(4)}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {supportsErrorBars && (
                <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                  <Label className="text-xs font-medium">Error Bars</Label>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={errorBarsEnabled}
                      onCheckedChange={toggleErrorBars}
                    />
                    <span className="text-xs text-zinc-500">Show error bars</span>
                  </div>
                  {showErrorBarTypeControl && selectableErrorBarTypes.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Label className="text-[10px] text-zinc-500 w-16">Type</Label>
                      <Select
                        value={displayedErrorBarType}
                        onValueChange={(value) =>
                          updateErrorBarType(value as 'se' | 'sd' | 'ci' | 'iqr')
                        }
                      >
                        <SelectTrigger className="h-7 text-xs flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {selectableErrorBarTypes.map((type) => (
                            <SelectItem key={type} value={type}>
                              {errorBarTypeLabels[type]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}

              {/* Jitter (box/violin plots only) */}
              {supportsJitter && (
                <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                  <Label className="text-xs font-medium">Jitter Points</Label>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={hasJitter}
                      onCheckedChange={toggleJitter}
                    />
                    <span className="text-xs text-zinc-500">Show individual points</span>
                  </div>
                  {hasJitter && (
                    <>
                      <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                        <Label className="text-[10px] text-zinc-500 w-16">Jitter</Label>
                        <Input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={currentJitterAmount}
                          onChange={(e) => updateJitterAmount(Number(e.target.value))}
                          className="h-5 flex-1"
                        />
                        <span className="text-[10px] text-zinc-400 w-10 text-right">
                          {currentJitterAmount.toFixed(2)}
                        </span>
                      </div>
                      <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                        <Label className="text-[10px] text-zinc-500 w-16">Position</Label>
                        <Input
                          type="range"
                          min={-2}
                          max={2}
                          step={0.1}
                          value={currentPointPosition}
                          onChange={(e) => updatePointPosition(Number(e.target.value))}
                          className="h-5 flex-1"
                        />
                        <span className="text-[10px] text-zinc-400 w-10 text-right">
                          {currentPointPosition.toFixed(1)}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Column Scatter controls */}
              {isColumnScatter && (
                <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                  <Label className="text-xs font-medium">Mean Line</Label>
                  <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                    <Switch
                      checked={showMeanLine}
                      onCheckedChange={toggleMeanLine}
                    />
                    <span className="text-xs text-zinc-500">Show mean line</span>
                  </div>
                </div>
              )}

              {/* Bar plot overlay points */}
              {isBarPlot && barCategoryCount === 1 && (
                <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                  <Label className="text-xs font-medium">Overlay Points</Label>
                  <div className={cn('flex items-center gap-2', isConstrained && 'flex-wrap')}>
                    <Switch
                      checked={overlayPointsEnabled}
                      onCheckedChange={toggleOverlayPoints}
                    />
                    <span className="text-xs text-zinc-500">Show individual points</span>
                  </div>
                </div>
              )}

              {/* Mosaic plot data labels */}
              {isMosaicPlot && (
                <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-zinc-700">
                  <Label className="text-xs font-medium">Data Labels</Label>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={mosaicDataLabelsEnabled}
                      onCheckedChange={toggleMosaicDataLabels}
                    />
                    <span className="text-xs text-zinc-500">Show count & percent</span>
                  </div>
                </div>
              )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Data Tab (Integrated LinkedDataTable) */}
          <TabsContent value="data" className="m-0 flex-1 min-h-0 overflow-hidden">
            <ScrollArea className="h-full" scrollbarSide="left" leftViewportPadding="sm">
              <div className="p-4 space-y-4">
              {/* Data Info */}
              <div className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Policy</span>
                  <span className="font-mono">{activePlot.dataPolicy}</span>
                </div>
                {activePlot.samplingConfig && (
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Sampled</span>
                    <span className="font-mono">
                      {activePlot.samplingConfig.sampleSize.toLocaleString()} rows
                    </span>
                  </div>
                )}
                {activePlot.aggregationConfig && (
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Grouped by</span>
                    <span className="font-mono truncate max-w-[120px]">
                      {activePlot.aggregationConfig.groupBy.join(', ')}
                    </span>
                  </div>
                )}
              </div>

              {/* Linked Data Table */}
              {tableData && (
                <div className="border border-zinc-200 dark:border-zinc-700 rounded-md overflow-hidden">
                  <div className="flex items-center justify-between gap-2 px-3 py-2 bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
                    <div>
                      <span className="text-xs font-medium">Linked Data</span>
                      <span className="text-[10px] text-zinc-400 ml-2">
                        ({tableData.rows.length} of {tableData.totalRows})
                      </span>
                    </div>
                    <Button type="button" size="sm" variant="outline" onClick={exportLinkedDataCsv}>
                      Export CSV
                    </Button>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px] font-mono">
                      <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-800">
                        <tr>
                          <th className="px-2 py-1.5 text-left text-zinc-400">#</th>
                          {tableData.columns.map((col) => (
                            <th
                              key={col.columnId}
                              className="px-2 py-1.5 text-left font-medium"
                            >
                              {col.columnName}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {tableData.rows.map((row, idx) => (
                          <tr
                            key={idx}
                            className="border-t border-zinc-100 dark:border-zinc-800"
                          >
                            <td className="px-2 py-1 text-zinc-400">{idx + 1}</td>
                            {row.map((value: any, colIdx: number) => (
                              <td key={colIdx} className="px-2 py-1">
                                {value === null || value === undefined
                                  ? '—'
                                  : String(value)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Interpolation Results Table (dose-response test plots) */}
              {hasInterpolationResultsTable && (
                <div className="border border-zinc-200 dark:border-zinc-700 rounded-md overflow-hidden">
                  <div className="flex items-center justify-between gap-2 px-3 py-2 bg-zinc-50 dark:bg-zinc-800 border-b border-zinc-200 dark:border-zinc-700">
                    <div>
                      <span className="text-xs font-medium">Interpolation Results</span>
                      <span className="text-[10px] text-zinc-400 ml-2">
                        ({interpolationResultsTableRows.length} rows)
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={copyInterpolationResults}
                      >
                        Copy
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={exportInterpolationResultsCsv}
                      >
                        Export CSV
                      </Button>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[10px] font-mono">
                      <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-800">
                        <tr>
                          <th className="px-2 py-1.5 text-left text-zinc-400">#</th>
                          <th className="px-2 py-1.5 text-left font-medium">Input</th>
                          <th className="px-2 py-1.5 text-left font-medium">Output</th>
                          <th className="px-2 py-1.5 text-left font-medium">Status</th>
                          <th className="px-2 py-1.5 text-left font-medium">Extrapolated</th>
                          <th className="px-2 py-1.5 text-left font-medium">Message</th>
                        </tr>
                      </thead>
                      <tbody>
                        {interpolationResultsTableRows.map((entry, idx) => {
                          const isSelected = selectedInterpolationIndex === entry.index
                          return (
                            <tr
                              key={`${entry.index}-${entry.input}`}
                              className={cn(
                                'border-t border-zinc-100 dark:border-zinc-800 cursor-pointer',
                                isSelected && 'bg-violet-50/70 dark:bg-violet-900/20'
                              )}
                              onClick={() => handleSelectBatchInterpolationRow(entry.index)}
                            >
                              <td className="px-2 py-1 text-zinc-400">{idx + 1}</td>
                              <td className="px-2 py-1">{formatDoseInterpolationValue(entry.input)}</td>
                              <td className="px-2 py-1">
                                {entry.output === null ? '—' : formatDoseInterpolationValue(entry.output)}
                              </td>
                              <td
                                className={cn(
                                  'px-2 py-1 capitalize',
                                  entry.status === 'ok' && 'text-emerald-600',
                                  (entry.status === 'out_of_range' || entry.status === 'guardrail') &&
                                    'text-amber-600',
                                  (entry.status === 'invalid_input' || entry.status === 'no_solution') &&
                                    'text-rose-600'
                                )}
                              >
                                {entry.status}
                              </td>
                              <td className="px-2 py-1">{entry.extrapolated}</td>
                              <td className="px-2 py-1 text-zinc-500">{entry.message}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {!tableData && !hasInterpolationResultsTable && (
                <div className="text-center py-8 text-xs text-zinc-400">
                  {isDoseResponse
                    ? 'Run batch interpolation to populate interpolation results.'
                    : activePlot.sourceType !== 'user_derived'
                      ? 'Data available for user-derived plots only'
                      : 'No linked data'}
                </div>
              )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Shapes Tab - Custom shapes and annotations */}
          <TabsContent value="shapes" className="m-0 flex-1 min-h-0 overflow-hidden">
            <ScrollArea className="h-full" scrollbarSide="left" leftViewportPadding="sm">
              <div className="p-4">
                <ShapesAnnotationsEditor
                  layout={layout}
                  onUpdateLayout={updateLayout}
                />
              </div>
            </ScrollArea>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}

export default PlotSidebar
