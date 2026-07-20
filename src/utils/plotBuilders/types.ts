/**
 * Plot Builder Types - Phase 1 Plots Feature
 *
 * Type definitions for plot builder functions.
 * Inspired by Data Formulator's EncodingItem patterns.
 *
 * Key concepts:
 * - ColumnMapping: Maps grid columns to plot roles
 * - PlotBuilderInput: Input data for builders
 * - PlotBuilderOutput: Standard output format with stats for E2E
 */

import type { Config, Data, Layout } from 'plotly.js'
import type { PlotType, PlotRole, PlotDataType, PlotCategory } from '@/config/plotRegistry'
import type { TestResult } from '@/store/results-store'
import type { TraceRoleMapping } from '@/services/plotResult/lmm/resolveTraceRoles'
import type { PlotColumn, SamplingConfig, AggregationConfig } from '@/store/plots-store'

// =============================================================================
// COLUMN MAPPING
// =============================================================================

/**
 * Column mapping for plot creation
 * Links grid columns to plot roles
 */
export interface ColumnMapping {
  role: PlotRole
  columnId: string
  columnName: string
  inferredType: PlotDataType
}

/**
 * State for CreatePlotDialog
 */
export interface PlotEncodingState {
  plotType: PlotType
  mappings: ColumnMapping[]
  title: string
  category: PlotCategory
}

// =============================================================================
// BUILDER INPUT/OUTPUT
// =============================================================================

/**
 * Input data for plot builders
 * Can come from test results or user column selection
 */
export interface PlotBuilderInput {
  /** Source type */
  source: 'test_result' | 'user_derived'

  /** Test result (if source is 'test_result') */
  testResult: TestResult | null

  /** Column data (if source is 'user_derived' or extracted from test) */
  columns: PlotColumn[]

  /** Data policy applied by plotDataService */
  dataPolicy: 'raw' | 'sampled' | 'aggregated'
  samplingConfig: SamplingConfig | null
  aggregationConfig: AggregationConfig | null

  /** Additional options */
  options: {
    title: string
    showLegend: boolean
    showGrid: boolean
    colorPalette: string[]
    histogramBins?: number
    showDensityCurve?: boolean  // Show KDE density curve overlay on histogram (default: true)
    errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'  // SE = Standard Error, SD = Standard Deviation, CI = 95% Confidence Interval, IQR = Interquartile Range, none = No error bars
    showJitter?: boolean  // Show jittered points on box/violin plots (default: false)
    jitterAmount?: number  // Jitter amount 0-1 (default: 0.3)
    pointPosition?: number  // Point position -2 to 2 (default: -1.8 for box, 0 for violin)
    showMeanLine?: boolean  // Show horizontal mean line on column scatter (default: true)
    pointJitterX?: number  // X-axis jitter amount for column scatter 0-0.2 (default: 0.05)
    pointSize?: number  // Point size for column scatter 4-12 (default: 8)
    overlayPoints?: boolean  // Overlay scatter points on bar plot (default: false)
    violinWidth?: number  // Width of violin plots 0-1 (default: 0.2 for narrow appearance)
    boxWidth?: number  // Width of box plots 0-1 (default: 0.2 for narrow appearance)
    bargap?: number  // Gap between bar groups 0-1 (default: 0.6, higher = narrower bars)
    bargroupgap?: number  // Gap within bar groups 0-1 (default: 0.15)
    splitTraces?: boolean  // For bar: render one trace per category (enables per-category color/pattern control)
    bracketSettings?: BracketSettings  // Significance bracket settings (for bar plots with post-hoc tests)
    brackets?: SignificanceBracket[]  // Pre-extracted significance brackets (populated by buildBarPlotFromResult)
  }
}

/**
 * Standard output from plot builders
 * Includes computed stats for E2E validation
 */
export interface PlotBuilderOutput {
  /** Plotly data traces */
  data: Data[]

  /** Plotly layout */
  layout: Partial<Layout>

  /** Plotly config */
  config: Partial<Config>

  /** Computed statistics for E2E validation via hidden DOM node */
  stats: Record<string, number | string>

  /** Data policy applied */
  dataPolicy: 'raw' | 'sampled' | 'aggregated'

  /** Sampling config if data was sampled */
  samplingConfig: SamplingConfig | null

  /** Aggregation config if data was aggregated */
  aggregationConfig: AggregationConfig | null
}

/**
 * Plot builder function signature
 */
export type PlotBuilderFn = (input: PlotBuilderInput) => PlotBuilderOutput

// =============================================================================
// COLUMN DATA FETCHING
// =============================================================================

/**
 * Response from fetchColumnData
 */
export interface FetchColumnDataResponse {
  columns: {
    columnId: string
    columnName: string
    values: unknown[]
    inferredType: PlotDataType
  }[]
  totalRows: number
  sampledRows: number
}

// =============================================================================
// SETTINGS INTERFACES
// =============================================================================

/**
 * Font configuration for plots
 */
export interface PlotFontConfig {
  family: string
  size: number
  color: string
  weight?: number
}

/**
 * Axis configuration
 */
export interface AxisConfig {
  title: string
  showGrid: boolean
  showLine: boolean
  showTickLabels: boolean
  tickAngle: number
  range: [number | null, number | null]
  type: 'linear' | 'log' | 'date' | 'category'
  font: PlotFontConfig
}

/**
 * Legend configuration
 */
export interface LegendConfig {
  show: boolean
  position: 'top' | 'bottom' | 'left' | 'right' | 'inside'
  orientation: 'horizontal' | 'vertical'
  font: PlotFontConfig
}

/**
 * Error bar configuration
 */
export interface ErrorBarConfig {
  show: boolean
  type: 'std' | 'sem' | 'ci95' | 'ci99' | 'custom'
  symmetric: boolean
  color: string
  thickness: number
  width: number
}

/**
 * Annotation configuration (for significance brackets, etc.)
 */
export interface AnnotationConfig {
  show: boolean
  text: string
  x: number | string
  y: number | string
  font: PlotFontConfig
  arrowhead: number
  arrowsize: number
  arrowwidth: number
  arrowcolor: string
}

/**
 * Complete plot settings
 */
export interface PlotSettings {
  // Appearance
  title: string
  titleFont: PlotFontConfig
  backgroundColor: string
  paperColor: string
  colorPalette: string[]
  showLegend: boolean

  // Axes
  xAxis: AxisConfig
  yAxis: AxisConfig

  // Legend
  legend: LegendConfig

  // Error bars (if applicable)
  errorBars: ErrorBarConfig

  // Annotations
  annotations: AnnotationConfig[]

  // Margins
  margin: {
    top: number
    right: number
    bottom: number
    left: number
  }
}

/**
 * Default plot settings factory
 */
export function createDefaultSettings(): PlotSettings {
  const defaultFont: PlotFontConfig = {
    family: 'Inter, sans-serif',
    size: 12,
    color: '#333333',
    weight: 700,
  }

  const defaultAxis: AxisConfig = {
    title: '',
    showGrid: true,
    showLine: true,
    showTickLabels: true,
    tickAngle: 0,
    range: [null, null],
    type: 'linear',
    font: { ...defaultFont },
  }

  return {
    title: '',
    titleFont: { ...defaultFont, size: 16 },
    backgroundColor: '#ffffff',
    paperColor: '#ffffff',
    colorPalette: [
      '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
      '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
    ],
    showLegend: true,

    xAxis: { ...defaultAxis, title: 'X' },
    yAxis: { ...defaultAxis, title: 'Y' },

    legend: {
      show: true,
      position: 'right',
      orientation: 'vertical',
      font: { ...defaultFont },
    },

    errorBars: {
      show: false,
      type: 'sem',
      symmetric: true,
      color: '#333333',
      thickness: 1,
      width: 4,
    },

    annotations: [],

    margin: {
      top: 50,
      right: 50,
      bottom: 50,
      left: 60,
    },
  }
}

// =============================================================================
// SIGNIFICANCE BRACKETS
// =============================================================================

/**
 * Significance bracket for post-hoc comparisons
 */
export interface SignificanceBracket {
  /** First group position (x-axis) */
  group1: number | string
  /** Second group position (x-axis) */
  group2: number | string
  /** Shift for group1 when using categorical axes (Plotly x0shift) */
  group1Shift?: number
  /** Shift for group2 when using categorical axes (Plotly x1shift) */
  group2Shift?: number
  /** P-value for the comparison */
  pValue: number
  /** Raw p-value text from results (if available) */
  pValueText?: string
  /** Label prefix for value display (defaults to p) */
  valueLabel?: 'p' | 'q'
  /** Optional effect identifier for bracket grouping */
  effectId?: string
  /** Optional effect label (e.g., "A vs B | factor1|factor2=X") */
  effectLabel?: string
  /** Optional effect group (main vs simple) */
  effectGroup?: 'main' | 'simple'
  /** Formatted label (e.g., "***", "ns", "p=0.023") */
  label: string
  /** Bracket height (auto-calculated to avoid overlap) */
  height: number
}

/**
 * Bracket settings
 */
export interface BracketSettings {
  /** Show significance brackets */
  show: boolean
  /** Bracket label mode */
  labelMode: 'stars' | 'pvalue'
  /** P-value thresholds for star notation */
  thresholds: {
    '***': number  // e.g., 0.001
    '**': number   // e.g., 0.01
    '*': number    // e.g., 0.05
  }
  /** Show "ns" for non-significant comparisons */
  showNs: boolean
  /** Bracket line color */
  lineColor: string
  /** Bracket line width */
  lineWidth: number
  /** Label font */
  font: PlotFontConfig
  /** Vertical offset from data max */
  offsetY: number
  /** Height step for stacked brackets */
  heightStep: number
  /** Tip length as fraction of y-range (default 0.03 = 3%) */
  tipLength: number
}

export interface BracketCatalog {
  brackets: SignificanceBracket[]
}

export interface BracketEffectMeta {
  label: string
  group: 'main' | 'simple' | 'comparison'
  significant?: boolean
  /** effectId of the master comparison toggle this entry belongs to (child entries only) */
  parentId?: string
}

export interface PlotLayoutMeta {
  gridUserSet?: boolean
  axisRevisionToken?: number
  editRevisionToken?: number
  systemAnnotationPositions?: Partial<
    Record<
      '_title_' | '_xaxis_title_' | '_yaxis_title_' | '_legend_',
      {
        x?: number
        y?: number
        xanchor?: 'left' | 'center' | 'right'
        yanchor?: 'top' | 'middle' | 'bottom'
        textangle?: number
      }
    >
  >
  errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
  // Plot-type-specific toggles stored in Plotly layout.meta for persistence.
  showMeanLine?: boolean
  frameEnabled?: boolean
  overlayPoints?: boolean
  annotationFontFamily?: string
  annotationFontSize?: number
  annotationFontColor?: string
  annotationTextAngle?: number
  bracketCatalog?: BracketCatalog
  bracketEffectMap?: Record<string, BracketEffectMeta>
  bracketEffectShapes?: Record<string, string[]>
  bracketVisibility?: Record<string, boolean>
  bracketSettings?: BracketSettings
  editSignificanceMode?: boolean
  /** hovermode in effect before Edit Significance mode was enabled — restored on disable */
  priorHovermode?: string | false
  /** Parameters used to build sig_bracket_* shapes — stored for edit-mode rebuild */
  bracketShapeParams?: {
    halfWidth: number        // cap half-width in x-axis categorical units (e.g. 0.15)
    tickHeightRatio: number  // tickHeight as fraction of ySpan (e.g. 0.001 thin, 0.04 fat)
    lineWidth: number        // stroke width in px (e.g. 0.5 thin, 3 fat)
    ySpan: number            // data y-span at build time — reliable fallback when yaxis.range unset
  }
  boxViolinPaddingRatio?: number
  boxViolinRangeBase?: { min: number; max: number }
  barWidth?: number
  boxWidth?: number
  violinWidth?: number
  showIc50Label?: boolean
  showCiBand?: boolean
  showConfidenceBand?: boolean
  confidenceBandLabel?: string
  showFittedPoints?: boolean
  showObservedPoints?: boolean
  ic50Color?: string
  customMarkupEnabled?: boolean
  activeShapeTool?: 'line' | 'rect' | 'circle' | 'path' | null
  shapeCoordinateMode?: 'auto' | 'data' | 'paper'
  lastCreatedCustomMarkupId?: string | null
  /** LMM trajectory role mapping — persisted for deterministic rebuild and override display */
  traceRoleMapping?: TraceRoleMapping
  /** Whether this layout was built as a compound or legacy LMM trajectory */
  trajectoryLayout?: 'legacy' | 'compound'
  /** Why compound trajectory was not activated (stratified results only) */
  compoundGuardReason?: string
  /** Color map used when building compound trajectory traces — persisted for rebuild/export consistency */
  colorMap?: Record<string, string>
}

/**
 * Default bracket settings
 */
export function createDefaultBracketSettings(): BracketSettings {
  return {
    show: true,
    labelMode: 'stars',
    thresholds: {
      '***': 0.001,
      '**': 0.01,
      '*': 0.05,
    },
    showNs: false,
    lineColor: '#111827',
    lineWidth: 2,
    font: {
      family: 'Inter, sans-serif',
      size: 11,
      color: '#111827',
      weight: 700,
    },
    offsetY: 0.07,  // 7% above max value
    heightStep: 0.04,  // 4% per bracket level
    tipLength: 0.05,  // 5% of y-range (shorter bracket tips)
  }
}

/**
 * Generate bracket label from p-value
 */
export function getBracketLabel(pValue: number, settings: BracketSettings): string {
  if (pValue <= settings.thresholds['***']) return '***'
  if (pValue <= settings.thresholds['**']) return '**'
  if (pValue <= settings.thresholds['*']) return '*'
  return settings.showNs ? 'ns' : ''
}
