/**
 * LMM Plot Builder
 *
 * Converts a TestResult into PlotSpecWithStats[] for LMM ANOVA results.
 * Produces:
 *   1. line (trajectory) — per-group means over time from backend
 *   2. line (contrast)   — continuous-effects contrasts over time (when present)
 *   3. grouped_bar       — not emitted (line-only policy)
 *
 * Facets are fully dynamic — derived at runtime from stratify_by + stratum keys.
 * No hardcoded trait/sex/strain assumptions.
 */

import type { Data, Layout, Config } from 'plotly.js'
import type { TestResult } from '@/store/results-store'
import { createTestResultPlotSpec, type TestResultPlotSpec } from '@/store/plots-store'
import { useAppStore } from '@/store/app-store'
import { mapFamily } from '@/services/plotResult/common/normalize'
import {
  normalizeLmmForPlots,
  type LmmLineRow,
  type LmmTrajectoryRow,
  type CompoundPanelPayload,
} from './normalize'
import {
  canBuildCompoundTrajectory,
  groupRowsForCompound,
  splitByTitleFactors,
  buildCompoundColorMap,
  buildCompoundDashMap,
  buildCompoundTrajectoryTraces,
  buildCompoundXAxisConfig,
  buildCompoundSignificance,
} from './buildCompoundTrajectory'
import { resolveTraceRoles, type TraceRoleMapping, type LmmTraceRoleOverride } from './resolveTraceRoles'
import type {
  BracketCatalog,
  BracketEffectMeta,
  BracketSettings,
  SignificanceBracket,
} from '@/utils/plotBuilders/types'
import { createDefaultBracketSettings } from '@/utils/plotBuilders/types'
import { BRACKET_THIN_PARAMS } from '@/utils/plotBuilders/rebuildBracketShapes'
import { LMM_COLORS } from './lmmPalette'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PlotSpecWithStats {
  plot: TestResultPlotSpec
  stats: Record<string, number | string>
}

// ---------------------------------------------------------------------------
// Color palette — imported from shared lmmPalette (single source of truth)
// ---------------------------------------------------------------------------

const COLORS = LMM_COLORS

function colorAt(i: number): string {
  return COLORS[i % COLORS.length]!
}

// ---------------------------------------------------------------------------
// p-value star annotation
// ---------------------------------------------------------------------------

function pStar(p: number): string {
  if (p < 0.001) return '***'
  if (p < 0.01)  return '**'
  if (p < 0.05)  return '*'
  return 'ns'
}

// ---------------------------------------------------------------------------
// Trajectory significance shape builder
// ---------------------------------------------------------------------------

interface TrajectorySignificanceResult {
  shapes: Record<string, unknown>[]
  bracketCatalog: BracketCatalog
  bracketEffectMap: Record<string, BracketEffectMeta>
  bracketEffectShapes: Record<string, string[]>
  bracketVisibility: Record<string, boolean>
  bracketSettings: BracketSettings
  bracketShapeParams: { halfWidth: number; tickHeightRatio: number; lineWidth: number; ySpan: number }
  needsFootnote: boolean
  yMax: number  // max y among all shapes (for headroom)
}

/**
 * Build draggable significance shape markers for a trajectory plot.
 *
 * One sig_bracket_* path shape per timepoint that has a p-value.
 * Shapes use the 8-number degenerate path format (M x,tipY L x,baseY L x,baseY L x,tipY)
 * required by PlotCanvas parsePathPoints for y-range expansion and x-lock on drag.
 *
 * effectId = lmm_se|<facetKey>|<group1>_vs_<group2>|<timeFactor>=<timeValue>  (one toggle per
 * simple effect; group names sorted alphabetically so id is stable regardless of data order)
 *
 * Returns null when no shapes should be emitted (guard: simpleEffectsRequested=false,
 * groupCount != 2, or no rows with p-values).
 */
function buildTrajectorySignificanceShapes(
  rows: LmmTrajectoryRow[],
  facetKey: string | null,
  simpleEffectsRequested: boolean,
  sigLabelColor?: string,
): TrajectorySignificanceResult | null {
  if (!simpleEffectsRequested || rows.length === 0) return null

  // Guard: exactly 2 group values (ambiguous comparison suppressed for 3+)
  const groupValues = new Set(rows.map(r => r.groupValue))
  if (groupValues.size !== 2) return null

  const interactionSignificant = rows[0]!.interactionSignificant
  // Base effectId: lmm_se|<facet>|<g1>_vs_<g2>  — groups sorted for stability.
  const [g1, g2] = [...groupValues].sort()
  const baseEffectId = `lmm_se|${facetKey ?? 'pooled'}|${g1}_vs_${g2}`
  const masterEffectId = `lmm_cmp|${facetKey ?? 'pooled'}|${g1}_vs_${g2}`
  const comparisonLabel = `${g1} vs ${g2}`

  const seSettings: BracketSettings = { ...createDefaultBracketSettings(), showNs: true }

  // Compute global y range across all rows for proportional spacing
  const allYTops = rows.map(r => r.mean + r.se)
  const allYBots = rows.map(r => r.mean - r.se)
  const globalYTop = Math.max(...allYTops)
  const globalYBot = Math.min(...allYBots)
  const ySpan = Math.max(globalYTop - globalYBot, 1)
  const baseGap = ySpan * 0.07       // 7% above max y top
  // Shape geometry params — use BRACKET_THIN_PARAMS (centralized in rebuildBracketShapes.ts)
  const { halfWidth: HALF_WIDTH, tickHeightRatio: TICK_HEIGHT_RATIO, lineWidth: LINE_WIDTH } = BRACKET_THIN_PARAMS
  const tickHeight = ySpan * TICK_HEIGHT_RATIO

  // Group rows by timeValueRaw, sorted by numeric timeValue
  const byTimepoint = new Map<string, LmmTrajectoryRow[]>()
  for (const row of rows) {
    const existing = byTimepoint.get(row.timeValueRaw) ?? []
    existing.push(row)
    byTimepoint.set(row.timeValueRaw, existing)
  }
  const sortedTimepoints = [...byTimepoint.entries()].sort((a, b) => {
    const aVal = a[1][0]?.timeValue ?? 0
    const bVal = b[1][0]?.timeValue ?? 0
    return aVal - bVal
  })

  const brackets: SignificanceBracket[] = []
  const shapes: Record<string, unknown>[] = []
  const bracketEffectMap: Record<string, BracketEffectMeta> = {}
  const bracketEffectShapes: Record<string, string[]> = {}
  const bracketVisibility: Record<string, boolean> = {}
  let yMax = globalYTop

  for (const [sortIdx, [timeValueRaw, tpRows]] of sortedTimepoints.entries()) {
    // Use first non-null pValue at this timepoint (both groups share same comparison p)
    const pValue = tpRows.find(r => r.pValue !== null)?.pValue ?? null
    if (pValue === null) continue

    const label = pStar(pValue)

    // Use sort index as x — traces use timeValueRaw strings creating a categorical axis;
    // Plotly maps category positions to 0-based indices, so sort index aligns correctly.
    const x = sortIdx
    const yTopLocal = Math.max(...tpRows.map(r => r.mean + r.se))
    const baseY = yTopLocal + baseGap
    const tipY = baseY + tickHeight

    // Track yMax from y-values only (not x, which are category indices)
    yMax = Math.max(yMax, tipY)

    const shapeName = `sig_bracket_${shapes.length}`
    // 8-number path: M xL,tipY L xL,baseY L xR,baseY L xR,tipY
    // Real-width bracket (xL < xR) so Plotly has a drag surface for edits.shapePosition.
    // Stem is near-zero height + low-alpha so the star label is the only visual element.
    const xL = x - HALF_WIDTH
    const xR = x + HALF_WIDTH
    const pathStr = `M ${xL},${tipY} L ${xL},${baseY} L ${xR},${baseY} L ${xR},${tipY}`

    // Per-timepoint effectId: one sidebar toggle per simple effect
    const timeFactor = tpRows[0]?.timeFactor ?? 'Time'
    const tpEffectId = `${baseEffectId}|${timeFactor}=${timeValueRaw}`
    const tpLabel = `${comparisonLabel} | ${timeFactor}=${timeValueRaw}`

    shapes.push({
      type: 'path',
      name: shapeName,
      path: pathStr,
      xref: 'x',
      yref: 'y',
      layer: 'above',
      // Anchor is fully transparent — star label is the only visual element.
      // In edit mode PlotSidebar rebuilds to fat params (larger hit target), still transparent.
      line: { color: BRACKET_THIN_PARAMS.lineColor, width: LINE_WIDTH },
      label: {
        text: label,
        textposition: 'top center',
        font: {
          size: seSettings.font.size,
          color: sigLabelColor ?? seSettings.font.color,
          family: seSettings.font.family,
        },
        padding: 2,
        xanchor: 'center',
        yanchor: 'top',
      },
    })

    brackets.push({
      group1: x,
      group2: x,
      pValue,
      label,
      effectId: tpEffectId,
      effectGroup: 'simple',
      height: 0,
    })

    bracketEffectMap[tpEffectId] = {
      label: tpLabel,
      group: 'simple',
      significant: pValue < 0.05,
      parentId: masterEffectId,
    }
    bracketEffectShapes[tpEffectId] = [shapeName]
    bracketVisibility[tpEffectId] = true
  }

  if (shapes.length === 0) return null

  // Master comparison toggle: controls all per-timepoint children simultaneously
  const allShapeNames = Object.values(bracketEffectShapes).flat()
  const isAnySig = brackets.some(b => b.pValue < 0.05)
  bracketEffectMap[masterEffectId] = {
    label: comparisonLabel,
    group: 'comparison',
    significant: isAnySig,
  }
  bracketEffectShapes[masterEffectId] = allShapeNames
  bracketVisibility[masterEffectId] = true

  const bracketCatalog: BracketCatalog = { brackets }

  return {
    shapes,
    bracketCatalog,
    bracketEffectMap,
    bracketEffectShapes,
    bracketVisibility,
    bracketSettings: seSettings,
    bracketShapeParams: { halfWidth: HALF_WIDTH, tickHeightRatio: TICK_HEIGHT_RATIO, lineWidth: LINE_WIDTH, ySpan },
    needsFootnote: !interactionSignificant,
    yMax,
  }
}

// ---------------------------------------------------------------------------
// Line plot builder
// ---------------------------------------------------------------------------

/**
 * Strip the trailing `|{time_factor}={time_value}` token from a backend label.
 *
 * Backend format: "{g1} vs {g2}|{group_factor}|{time_factor}={time_value}"
 * Stable identity:  "{g1} vs {g2}|{group_factor}"
 *
 * The last pipe-delimited segment always contains `=` when the time token is
 * present. Stripping it gives a key that is constant across all time points
 * of the same contrast, which lets us group them into a single trajectory.
 */
function stableSeriesKey(label: string): string {
  // Remove trailing "|key=value" segment (the time token)
  return label.replace(/\|[^|]+=.*$/, '')
}

interface LineDataResult {
  traces: Data[]
  needsFootnote: boolean
}

function buildContrastLineData(
  lineRows: LmmLineRow[],
  facetDims: string[]
): LineDataResult {
  if (lineRows.length === 0) return { traces: [], needsFootnote: false }

  // Group by facet + stable series identity (label with time token stripped)
  const groups = new Map<string, LmmLineRow[]>()
  for (const row of lineRows) {
    const facetKey = facetDims.length > 0
      ? facetDims.map(d => `${d}:${row.facetValues[d] ?? ''}`).join('|')
      : 'pooled'
    const key = `${facetKey}||${stableSeriesKey(row.label)}`
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }

  const traces: Data[] = []
  let colorIdx = 0
  let needsFootnote = false
  for (const [, rows] of groups) {
    const sorted = [...rows].sort((a, b) => a.timeValue - b.timeValue)
    const color = colorAt(colorIdx++)
    // Display name: stable identity (time token stripped), fallback to raw label
    const name = stableSeriesKey(rows[0]?.label ?? '') || rows[0]?.label || 'Contrast'
    // Per-row flags — all rows in one stratum share the same values
    const interactionSignificant = rows[0]?.interactionSignificant ?? false
    const simpleEffectsRequested = rows[0]?.simpleEffectsRequested ?? false
    const labels = sorted.map(r => (r.pValue == null ? '' : pStar(r.pValue)))
    // Labels shown only when simple effects were user-requested + pValue non-null.
    // No interaction gate (Task 4 policy).
    const hasLabels = simpleEffectsRequested && labels.some(label => label.length > 0)
    if (hasLabels && !interactionSignificant) needsFootnote = true

    traces.push({
      type: 'scatter',
      x: sorted.map(r => r.timeValue),
      y: sorted.map(r => r.estimate),
      error_y: {
        type: 'data',
        array: sorted.map(r => r.se),
        visible: true,
      },
      line: { color },
      marker: { color },
      name,
      mode: hasLabels ? ('lines+markers+text' as const) : ('lines+markers' as const),
      text: hasLabels ? labels : undefined,
      textposition: hasLabels ? ('top center' as const) : undefined,
    } as Data)
  }
  return { traces, needsFootnote }
}

/**
 * Build trajectory traces. Significance labels are NOT included in traces —
 * they are emitted as draggable shapes via buildTrajectorySignificanceShapes.
 *
 * When roleMapping.resolved, all traces share sharedColor and get dash from dashMap.
 * Fallback: cycling colors, no dash override.
 */
function buildTrajectoryLineData(
  rows: LmmTrajectoryRow[],
  facetDims: string[],
  roleMapping?: TraceRoleMapping,
): { traces: Data[] } {
  if (rows.length === 0) return { traces: [] }
  const groups = new Map<string, LmmTrajectoryRow[]>()
  for (const row of rows) {
    const facetKey = facetDims.length > 0
      ? facetDims.map(d => `${d}:${row.facetValues[d] ?? ''}`).join('|')
      : 'pooled'
    const key = `${facetKey}||${row.groupFactor}=${row.groupValue}`
    const existing = groups.get(key) ?? []
    existing.push(row)
    groups.set(key, existing)
  }

  const traces: Data[] = []
  let colorIdx = 0
  for (const [, grouped] of groups) {
    const sorted = [...grouped].sort((a, b) => a.timeValue - b.timeValue)
    const groupValue = sorted[0]?.groupValue ?? ''
    const color = roleMapping?.resolved ? roleMapping.sharedColor : colorAt(colorIdx)
    const dash = roleMapping?.resolved ? (roleMapping.dashMap[groupValue] ?? 'solid') : undefined
    traces.push({
      type: 'scatter',
      x: sorted.map(r => r.timeValueRaw),
      y: sorted.map(r => r.mean),
      error_y: {
        type: 'data',
        array: sorted.map(r => r.se),
        visible: true,
      },
      line: { color, ...(dash !== undefined ? { dash } : {}) },
      marker: { color },
      name: groupValue || 'Group',
      mode: 'lines+markers' as const,
    } as Data)
    colorIdx += 1
  }
  return { traces }
}

function buildLineLayout(
  outcomeLabel: string,
  isContrast: boolean,
  needsFootnote = false,
  shapes?: Record<string, unknown>[],
  yAxisRange?: [number, number],
): Partial<Layout> {
  const layout: Partial<Layout> = {
    yaxis: {
      title: isContrast ? `${outcomeLabel} contrast` : outcomeLabel,
      ...(yAxisRange ? { range: yAxisRange, autorange: false } : {}),
      tickfont: { weight: 700 },
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
    },
    xaxis: {
      title: 'Time',
      tickfont: { weight: 700 },
      tickwidth: 4,
      ticklen: 6,
      ticklabelshift: 1,
    },
    legend: { orientation: 'h', y: -0.2 },
    margin: { t: 40, b: 80 },
  }

  const annotations: Partial<Layout>['annotations'] = []

  if (needsFootnote) {
    annotations.push({
      x: 0,
      y: -0.22,
      xref: 'paper',
      yref: 'paper',
      text: 'Simple effects shown by user request; interaction term not significant',
      showarrow: false,
      font: { size: 10, color: '#666' },
      align: 'left',
    } as any)
  }

  if (annotations.length > 0) {
    layout.annotations = annotations as Layout['annotations']
  }

  if (shapes && shapes.length > 0) {
    layout.shapes = shapes as Layout['shapes']
  }

  return layout
}

function buildUnavailableLayout(outcomeLabel: string): Partial<Layout> {
  return {
    yaxis: { title: outcomeLabel },
    xaxis: { title: 'Time' },
    annotations: [
      {
        x: 0.5,
        y: 0.5,
        xref: 'paper',
        yref: 'paper',
        text: 'No time-resolved LMM line data available for this run. Configure continuous follow-up to generate trajectory/contrast lines.',
        showarrow: false,
        font: { size: 12, color: '#666' },
        align: 'center',
      },
    ],
    margin: { t: 40, b: 80 },
  }
}

// Plotly config for trajectory specs with draggable significance shapes.
// Note: PlotCanvas forces displayModeBar: false at render time, so eraseshape button
// is not currently visible. Sidebar toggle is the guaranteed hide/show control path.
// modeBarButtonsToAdd retained for future-proofing if modebar policy changes.
const TRAJECTORY_SHAPE_CONFIG: Partial<Config> = {
  modeBarButtonsToAdd: ['eraseshape'],
  edits: {
    shapePosition: true,
    annotationPosition: true,
  },
}

// ---------------------------------------------------------------------------
// Raw output extraction
// ---------------------------------------------------------------------------

function extractRawOutput(result: TestResult): Record<string, unknown> | null {
  const raw = result.rawOutput
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }
  if (raw && typeof raw === 'object') {
    return raw as Record<string, unknown>
  }
  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a stable facetKey string from a set of facet dimension values.
 * Format: "dim1=val1|dim2=val2" (sorted by dim name for stability).
 * Returns null for pooled results (no facet dims).
 */
function makeFacetKey(facetValues: Record<string, string>, facetDims: string[]): string | null {
  if (facetDims.length === 0) return null
  return facetDims.map(d => `${d}=${facetValues[d] ?? ''}`).join('|')
}

function resolveFacetOutcomeLabel(
  baseOutcomeLabel: string,
  facetValues: Record<string, string>
): string {
  const normalized = baseOutcomeLabel.trim().toLowerCase()
  if (normalized !== 'value' && normalized !== 'values') return baseOutcomeLabel

  const traitKey = Object.keys(facetValues).find(k => /trait|phenotype|outcome/i.test(k))
  const traitValue = traitKey ? facetValues[traitKey] : undefined
  if (traitValue && traitValue.trim().length > 0) return traitValue
  return baseOutcomeLabel
}

/**
 * Compute y-axis range with headroom for trajectory plots with significance shapes.
 * Returns [yMin - pad, yMax + pad] where yMax accounts for shapes.
 */
function computeTrajectoryYRange(
  rows: LmmTrajectoryRow[],
  sigResult: TrajectorySignificanceResult | null,
): [number, number] | null {
  if (rows.length === 0) return null

  const allYTops = rows.map(r => r.mean + r.se)
  const allYBots = rows.map(r => r.mean - r.se)
  const dataYTop = Math.max(...allYTops)
  const dataYBot = Math.min(...allYBots)
  const ySpan = Math.max(dataYTop - dataYBot, 1)

  const yMax = sigResult ? sigResult.yMax + ySpan * 0.12 : dataYTop + ySpan * 0.12
  const yMin = dataYBot - ySpan * 0.05

  return [yMin, yMax]
}

// ---------------------------------------------------------------------------
// v1 E2E stat contract for LMM trajectory plots
// ---------------------------------------------------------------------------

/**
 * Compute numeric plot stats for a trajectory spec.
 *
 * v1 contract (numeric-only, adjustment-sensitive):
 *   total_points          — total rows (traces × timepoints)
 *   trace_count           — distinct group values (one per trace)
 *   n_points_per_trace    — timepoints in first trace (assumes uniform)
 *   overall_mean          — mean of all row means
 *   mean_se               — mean of all row SEs
 *   min_mean              — minimum row mean
 *   max_mean              — maximum row mean
 *   sig_total_points      — unique timepoints with a non-null pValue
 *   sig_significant_points— unique timepoints with pValue < 0.05
 *   sig_ns_points         — unique timepoints with pValue >= 0.05
 */
/**
 * Converts backend CompoundPanelPayload.trajectory_rows into LmmTrajectoryRow[] suitable for
 * buildCompoundTrajectoryTraces and buildCompoundSignificance.
 *
 * This ensures traces and significance shapes come from the same pooled model as the stats
 * (single-scope consistency). Uses ordinal fallback for non-numeric time values,
 * matching the same strategy as extractTrajectoryFromEstimatedMeans in normalize.ts.
 */
function backendPanelToLmmTrajectoryRows(
  panel: CompoundPanelPayload,
  simpleEffectsRequested: boolean,
): LmmTrajectoryRow[] {
  const { trajectory_rows, simple_effects_by_time, panel_filter, color_factor } = panel

  // Pre-compute ordinal positions for non-numeric time values (same strategy as normalize.ts)
  const uniqueTimeValues: string[] = []
  for (const row of trajectory_rows) {
    if (!uniqueTimeValues.includes(row.time_value)) uniqueTimeValues.push(row.time_value)
  }
  const levelOrdinal = new Map(uniqueTimeValues.map((v, i) => [v, i]))
  const parseNum = (v: unknown): number | null => {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  return trajectory_rows.map((row): LmmTrajectoryRow => {
    const timeValueRaw = row.time_value
    const timeValue = parseNum(timeValueRaw) ?? (levelOrdinal.get(timeValueRaw) ?? 0)
    const pValue = simpleEffectsRequested
      ? (simple_effects_by_time[timeValueRaw] ?? null)
      : null

    const facetValues: Record<string, string> = {
      ...panel_filter,
      [color_factor]: row.color_value,
    }

    return {
      facetValues,
      timeFactor: row.time_factor,
      timeValue,
      timeValueRaw,
      groupFactor: row.group_factor,
      groupValue: row.group_value,
      mean: row.emmean,
      se: row.se,
      ciLower: row.ci_lower,
      ciUpper: row.ci_upper,
      n: row.n ?? null,
      pValue,
      // interactionSignificant: backend simple effects are from the pooled model —
      // suppress the "interaction not significant" footnote (it doesn't apply here).
      interactionSignificant: true,
      source: 'estimated_means',
      groupRole: null,
    }
  })
}

function computeTrajectoryStats(
  rows: LmmTrajectoryRow[],
  overrides?: { traceCount?: number; nPointsPerTrace?: number },
): Record<string, number> {
  if (rows.length === 0) return {}

  const groupValues = [...new Set(rows.map(r => r.groupValue))]
  const traceCount = overrides?.traceCount ?? groupValues.length

  const means = rows.map(r => r.mean)
  const ses = rows.map(r => r.se)

  // Significance counts: one entry per unique timepoint (not per row).
  // NOTE: pValue dedup uses timeValueRaw as the key. This is correct when each timepoint
  // has at most one comparison (2-group LMM trajectory constraint — treatment has exactly
  // 2 levels, so pairs() yields one p-value per within-level). Multi-group designs would
  // require selecting the min/representative p-value per timepoint instead.
  const byTimepoint = new Map<string, number | null>()
  for (const row of rows) {
    if (!byTimepoint.has(row.timeValueRaw) || (byTimepoint.get(row.timeValueRaw) === null && row.pValue !== null)) {
      byTimepoint.set(row.timeValueRaw, row.pValue)
    }
  }
  const timepointPValues = [...byTimepoint.values()].filter((p): p is number => p !== null)

  // Derive n_points_per_trace from unique timepoints (robust to unbalanced traces;
  // first-group filter would be wrong for compound where groupValue ≠ unique-timepoint count).
  const nPointsPerTrace = overrides?.nPointsPerTrace ?? byTimepoint.size

  return {
    total_points: rows.length,
    trace_count: traceCount,
    n_points_per_trace: nPointsPerTrace,
    overall_mean: means.reduce((a, b) => a + b, 0) / means.length,
    mean_se: ses.reduce((a, b) => a + b, 0) / ses.length,
    min_mean: Math.min(...means),
    max_mean: Math.max(...means),
    sig_total_points: timepointPValues.length,
    sig_significant_points: timepointPValues.filter(p => p < 0.05).length,
    sig_ns_points: timepointPValues.filter(p => p >= 0.05).length,
  }
}

export function buildLmmPlots(
  result: TestResult,
  overrides?: Record<string, LmmTraceRoleOverride>,
): PlotSpecWithStats[] {
  const raw = extractRawOutput(result)
  if (!raw) return []

  const dependentName =
    (result.plotPayload?.data?.['dependent_name'] as string | undefined) ||
    (result.plotPayload?.data?.['value_column'] as string | undefined)

  // Inject plot_facet_roles from the stored payload parameters into raw so that
  // canBuildCompoundTrajectory can read it. This is a frontend-only concern — Python
  // does not process or return plot_facet_roles; it lives only in plotPayload.parameters.
  // Runtime shape guard: only inject when the stored value is a non-null object with
  // at least a string color_by field — malformed persisted configs are silently ignored.
  const rawStoredFPR = result.plotPayload?.parameters?.['plot_facet_roles']
  const storedPlotFacetRoles: { facet_by: string; color_by: string; title_only_factors?: string[] } | undefined =
    rawStoredFPR !== null &&
    typeof rawStoredFPR === 'object' &&
    typeof (rawStoredFPR as Record<string, unknown>)['color_by'] === 'string'
      ? {
          // Explicit field-by-field reconstruction — never rely on spread to carry extra
          // fields through the type boundary. Any field not listed here is intentionally
          // excluded from the injected contract.
          color_by: (rawStoredFPR as Record<string, unknown>)['color_by'] as string,
          facet_by: typeof (rawStoredFPR as Record<string, unknown>)['facet_by'] === 'string'
            ? (rawStoredFPR as Record<string, unknown>)['facet_by'] as string
            : '',
          ...(Array.isArray((rawStoredFPR as Record<string, unknown>)['title_only_factors'])
            ? { title_only_factors: (rawStoredFPR as Record<string, unknown>)['title_only_factors'] as string[] }
            : {}),
        }
      : undefined
  const rawForPlots: Record<string, unknown> = storedPlotFacetRoles
    ? { ...raw, plot_facet_roles: storedPlotFacetRoles }
    : raw

  const { summaryRows, trajectoryRows, contrastRows, facetDims, outcomeLabel, simpleEffectsRequested, compoundPanels, compoundPanelsWarnings } =
    normalizeLmmForPlots(rawForPlots, { dependentName })

  if (compoundPanelsWarnings.length > 0) {
    console.warn('[buildLmmPlots] compound panel warnings from backend:', compoundPanelsWarnings)
  }

  // Only bail out early for truly invalid/empty payloads (no success flag).
  // Valid results (success=true) with no plottable rows still get a placeholder — plan line 29.
  const isValidResult = raw['success'] === true
  if (!isValidResult && summaryRows.length === 0 && trajectoryRows.length === 0 && contrastRows.length === 0) {
    return []
  }

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const specs: PlotSpecWithStats[] = []

  // Pooled path: no facet dims — emit trajectory/contrast lines only
  if (facetDims.length === 0) {
    if (trajectoryRows.length === 0 && contrastRows.length === 0) {
      // No plottable line data (with or without summary rows) — emit placeholder.
      // Satisfies plan line 29: no silent zero-spec return for valid results.
      specs.push({
        plot: createTestResultPlotSpec({
          id: `plot-${result.id}-lmm-line-unavailable`,
          type: 'line',
          title: `${outcomeLabel} — Plot Unavailable`,
          statisticsFamilyId,
          resultId: result.id,
          testType: result.testId,
          testFamily,
          plotlyData: [] as Data[],
          plotlyLayout: buildUnavailableLayout(outcomeLabel) as Layout,
          dataPolicy: 'raw',
          samplingConfig: null,
          aggregationConfig: null,
          facetKey: null,
          lmmMode: 'line_unavailable',
        }),
        stats: {},
      })
      return specs
    }

    if (trajectoryRows.length > 0) {
      const pooledTrajKey = `${result.id}|pooled|trajectory`
      const roleMapping = resolveTraceRoles(trajectoryRows, facetDims, 0, overrides?.[pooledTrajKey])
      const { traces: lineData } = buildTrajectoryLineData(trajectoryRows, facetDims, roleMapping)
      const sigResult = buildTrajectorySignificanceShapes(
        trajectoryRows, null, simpleEffectsRequested,
        roleMapping.resolved ? roleMapping.sharedColor : undefined,
      )
      const yRange = computeTrajectoryYRange(trajectoryRows, sigResult)
      const lineLayout = buildLineLayout(
        outcomeLabel,
        false,
        sigResult?.needsFootnote ?? false,
        sigResult?.shapes,
        yRange ?? undefined,
      )
      ;(lineLayout as any).meta = {
        ...((lineLayout as any).meta ?? {}),
        traceRoleMapping: roleMapping,
        ...(sigResult ? {
          bracketCatalog: sigResult.bracketCatalog,
          bracketEffectMap: sigResult.bracketEffectMap,
          bracketEffectShapes: sigResult.bracketEffectShapes,
          bracketVisibility: sigResult.bracketVisibility,
          bracketSettings: sigResult.bracketSettings,
          bracketShapeParams: sigResult.bracketShapeParams,
        } : {}),
      }
      specs.push({
        plot: createTestResultPlotSpec({
          id: `plot-${result.id}-lmm-line-trajectory`,
          type: 'line',
          title: `${outcomeLabel} — Trajectory (Mean ± SE)`,
          statisticsFamilyId,
          resultId: result.id,
          testType: result.testId,
          testFamily,
          plotlyData: lineData as Data[],
          plotlyLayout: lineLayout as Layout,
          plotlyConfig: sigResult ? TRAJECTORY_SHAPE_CONFIG as any : undefined,
          dataPolicy: 'raw',
          samplingConfig: null,
          aggregationConfig: null,
          facetKey: null,
          lmmMode: 'trajectory',
        }),
        stats: computeTrajectoryStats(trajectoryRows),
      })
    }

    if (contrastRows.length > 0) {
      const { traces: lineData, needsFootnote } = buildContrastLineData(contrastRows, facetDims)
      const lineLayout = buildLineLayout(outcomeLabel, true, needsFootnote)
      specs.push({
        plot: createTestResultPlotSpec({
          id: `plot-${result.id}-lmm-line-contrast`,
          type: 'line',
          title: `${outcomeLabel} — Time Contrast`,
          statisticsFamilyId,
          resultId: result.id,
          testType: result.testId,
          testFamily,
          plotlyData: lineData as Data[],
          plotlyLayout: lineLayout as Layout,
          dataPolicy: 'raw',
          samplingConfig: null,
          aggregationConfig: null,
          facetKey: null,
          lmmMode: 'contrast',
        }),
        stats: {},
      })
    }

    return specs
  }

  // Stratified path: emit trajectory/contrast lines per stratum
  // Collect unique facet value combinations in encounter order
  const strataKeys = new Map<string, { facetValues: Record<string, string> }>()
  for (const row of summaryRows) {
    const key = makeFacetKey(row.facetValues, facetDims)!
    if (!strataKeys.has(key)) strataKeys.set(key, { facetValues: row.facetValues })
  }
  // Also register strata that only appear in line payloads (no summary rows)
  for (const row of trajectoryRows) {
    const key = makeFacetKey(row.facetValues, facetDims)!
    if (!strataKeys.has(key)) strataKeys.set(key, { facetValues: row.facetValues })
  }
  for (const row of contrastRows) {
    const key = makeFacetKey(row.facetValues, facetDims)!
    if (!strataKeys.has(key)) strataKeys.set(key, { facetValues: row.facetValues })
  }

  // ---------------------------------------------------------------------------
  // Compound trajectory branch: activated when canBuildCompoundTrajectory resolves.
  // When active, emits one spec per panelValue instead of per-stratum legacy trajectories.
  // Per-stratum contrast rows are still emitted in the strata loop below.
  // ---------------------------------------------------------------------------
  let compoundTrajectoryBuilt = false
  let compoundGuardReason: string | undefined

  if (trajectoryRows.length > 0) {
    const compoundRoles = canBuildCompoundTrajectory(trajectoryRows, rawForPlots)
    if (!compoundRoles.resolved) {
      // Only surface the reason for stratified results where compound was actually attempted
      // (stratify_by present in raw). Non-stratified results return 'stratify_by missing or empty'
      // which is not meaningful to show as a diagnostic.
      const isStratifiedCandidate = Array.isArray(rawForPlots['stratify_by']) && (rawForPlots['stratify_by'] as unknown[]).length > 0
      if (isStratifiedCandidate) {
        compoundGuardReason = compoundRoles.reason
      }
    }

    if (compoundRoles.resolved) {
      // Split by title-only factors first — each split produces a separate compound spec group.
      // When titleFactors is empty this returns a single Map entry with key '' containing all rows.
      const titleSplits = splitByTitleFactors(trajectoryRows, compoundRoles.titleFactors)

      // Collect unique colorValues globally (stable color assignment across title splits)
      const allColorValues = [...new Set(
        trajectoryRows.map(r => r.facetValues[compoundRoles.colorFactor] ?? '').filter(Boolean)
      )].sort()
      const colorMap = buildCompoundColorMap(allColorValues)

      for (const [titleKey, titleRows] of titleSplits) {
      const compoundGroups = groupRowsForCompound(titleRows, compoundRoles)
      // Only suppress legacy trajectories if compound actually produced panels.
      // (Structurally prevented by Guard 6, but guarded here as a safety net.)
      if (compoundGroups.size > 0) {
        compoundTrajectoryBuilt = true

        for (const [panelValue, panelGroups] of compoundGroups) {
          // panelValue is a composite key: panelFactors values joined with '|'
          // e.g. 'M|Tail.Flick.Late' for panelFactors=['Sex','Trait']
          const panelValueParts = panelValue.split('|')
          const panelKey = compoundRoles.panelFactors.map((f, i) => `${f}=${panelValueParts[i] ?? ''}`).join('|')

          // effectivePanelKey includes the titleKey so that specs from different title splits
          // get distinct facetKeys, IDs, and bracket effect namespaces.
          // When titleKey is '' (no title factors) this collapses to panelKey unchanged.
          //
          // INVARIANT: effectivePanelKey must never be '' in compound mode.
          // Guard 2 (stratify_by.length >= 2) guarantees panelFactors is non-empty when
          // titleFactors is empty, so panelKey is always non-empty on the no-title-factors path.
          // On the title-factors path, titleKey is always non-empty (splitByTitleFactors only
          // emits non-empty keys when titleFactors.length > 0). Both paths produce a non-empty
          // effectivePanelKey, keeping spec ID, facetKey, and bracket namespace collision-free.
          const effectivePanelKey = [titleKey, panelKey].filter(Boolean).join('|')

          // Match backend panel by panel_filter object (not facet_key string) to avoid
          // '|' delimiter ambiguity when factor values contain that character.
          // Title-factor values are included in the filter so different title splits never
          // match the same backend panel.
          const backendPanel = compoundPanels != null
            ? (compoundPanels.find(p =>
                compoundRoles.panelFactors.every((f, i) => p.panel_filter[f] === (panelValueParts[i] ?? '')) &&
                compoundRoles.titleFactors.every(tf => {
                  const titleValue = titleKey.split(', ').find(seg => seg.startsWith(`${tf}=`))?.slice(tf.length + 1)
                  return titleValue === undefined || p.panel_filter[tf] === titleValue
                })
              ) ?? null)
            : null

          if (compoundPanels != null && compoundPanels.length > 0 && backendPanel === null) {
            // Backend provided panels but none matched this frontend panel — log for diagnostics.
            console.warn(
              `[buildLmmPlots] compound panel mismatch: no backend panel matched panelKey="${effectivePanelKey}". ` +
              `Frontend will fall back to per-stratum stats/traces for this panel.`
            )
          }

          // When backend panel has trajectory_rows, use them for traces + significance to keep
          // stats and visual data in the same model scope (single pooled fit).
          // Fall back to frontend panelGroups when backend rows are absent.
          const backendRows = (backendPanel != null && backendPanel.trajectory_rows.length > 0)
            ? backendPanelToLmmTrajectoryRows(backendPanel, simpleEffectsRequested)
            : null
          const activeGroups = backendRows != null
            ? groupRowsForCompound(backendRows, compoundRoles)
            : compoundGroups

          // Use backend or frontend groups for this panel
          const activePanelGroups = activeGroups.get(panelValue) ?? panelGroups

          const dashMap = buildCompoundDashMap(activePanelGroups, { referenceLevel: compoundRoles.referenceLevel })
          const traces = buildCompoundTrajectoryTraces(activePanelGroups, colorMap, dashMap)
          const { tickvals, ticktext } = buildCompoundXAxisConfig(activePanelGroups)
          // Panel-local colorValues for centered x-offsets (only colors present in this panel)
          const panelColorValues = [...new Set(activePanelGroups.map(g => g.key.colorValue))].sort()
          const sigResult = buildCompoundSignificance(activePanelGroups, effectivePanelKey, panelColorValues, colorMap, compoundRoles, simpleEffectsRequested)

          // Y-axis range: account for significance shapes — use activePanelGroups for single-scope consistency
          const allPanelRows = activePanelGroups.flatMap(g => g.rows)
          const dataYTops = allPanelRows.map(r => r.mean + r.se)
          const dataYBots = allPanelRows.map(r => r.mean - r.se)
          const dataYTop = Math.max(...dataYTops)
          const dataYBot = Math.min(...dataYBots)
          const ySpan = Math.max(dataYTop - dataYBot, 1)
          const yMax = sigResult ? sigResult.yMax + ySpan * 0.12 : dataYTop + ySpan * 0.12
          const yMin = dataYBot - ySpan * 0.05
          const yAxisRange: [number, number] = [yMin, yMax]

          // Build facetValues map for this panel (panelFactor → value)
          const panelFacetValues: Record<string, string> = {}
          compoundRoles.panelFactors.forEach((f, i) => { panelFacetValues[f] = panelValueParts[i] ?? '' })

          // Promote trait value into outcome label (same resolver used by legacy path)
          const panelOutcomeLabel = resolveFacetOutcomeLabel(outcomeLabel, panelFacetValues)

          // Build parenthetical suffix from panelFactors, excluding any factor whose value
          // was promoted into the title prefix by resolveFacetOutcomeLabel.
          // e.g. if Trait='Tail.Flick.Late' drove the label change, show only 'Sex = M'.
          const panelLabel = compoundRoles.panelFactors
            .reduce<string[]>((acc, f, i) => {
              if (panelOutcomeLabel !== outcomeLabel) {
                const singleTest = resolveFacetOutcomeLabel(outcomeLabel, { [f]: panelValueParts[i] ?? '' })
                if (singleTest !== outcomeLabel) return acc // this factor drove the promotion
              }
              acc.push(`${f} = ${panelValueParts[i] ?? ''}`)
              return acc
            }, [])
            .join(', ')

          // Build layout with numeric x-axis and tick labels
          const compoundLayout: Partial<Layout> = {
            yaxis: {
              title: panelOutcomeLabel,
              range: yAxisRange,
              autorange: false,
              tickfont: { weight: 700 },
              tickwidth: 4,
              ticklen: 6,
              ticklabelshift: 1,
            },
            xaxis: {
              title: compoundRoles.withinFactor,
              tickvals,
              ticktext,
              type: 'linear',
              tickfont: { weight: 700 },
              tickwidth: 4,
              ticklen: 6,
              ticklabelshift: 1,
            },
            legend: { orientation: 'h', y: -0.2 },
            margin: { t: 40, b: 80 },
            ...(sigResult ? { shapes: sigResult.shapes as Layout['shapes'] } : {}),
          }

          if (sigResult?.needsFootnote) {
            const annotations: NonNullable<Layout['annotations']> = [{
              x: 0,
              y: -0.22,
              xref: 'paper',
              yref: 'paper',
              text: 'Simple effects shown by user request; interaction term not significant',
              showarrow: false,
              font: { size: 10, color: '#666' },
              align: 'left',
            }]
            compoundLayout.annotations = annotations
          }

          ;(compoundLayout as any).meta = {
            trajectoryLayout: 'compound',
            // colorMap persisted for rebuild/export consistency (same object for all panels)
            colorMap,
            traceRoleMapping: {
              resolved: false,
              reason: 'compound layout (style overrides not supported)',
              dashMap: {},
              sharedColor: '',
              lineStyleFactor: compoundRoles.styleFactor,
              colorFactor: compoundRoles.colorFactor,
            },
            ...(sigResult ? {
              bracketCatalog: sigResult.bracketCatalog,
              bracketEffectMap: sigResult.bracketEffectMap,
              bracketEffectShapes: sigResult.bracketEffectShapes,
              bracketVisibility: sigResult.bracketVisibility,
              bracketSettings: sigResult.bracketSettings,
              bracketShapeParams: sigResult.bracketShapeParams,
            } : {}),
          }

          specs.push({
            plot: createTestResultPlotSpec({
              id: `plot-${result.id}-lmm-compound-trajectory-${effectivePanelKey || panelValue}`,
              type: 'line',
              title: (() => {
                const parts = [panelLabel, titleKey].filter(Boolean).join(', ')
                return parts
                  ? `${panelOutcomeLabel} — Trajectory (Mean ± SE) (${parts})`
                  : `${panelOutcomeLabel} — Trajectory (Mean ± SE)`
              })(),
              statisticsFamilyId,
              resultId: result.id,
              testType: result.testId,
              testFamily,
              plotlyData: traces as Data[],
              plotlyLayout: compoundLayout as Layout,
              plotlyConfig: sigResult ? TRAJECTORY_SHAPE_CONFIG as any : undefined,
              dataPolicy: 'raw',
              samplingConfig: null,
              aggregationConfig: null,
              facetKey: effectivePanelKey,
              lmmMode: 'trajectory',
            }),
            stats: backendPanel?.stats ?? computeTrajectoryStats(activePanelGroups.flatMap(g => g.rows), {
              traceCount: activePanelGroups.length,
              nPointsPerTrace: activePanelGroups[0]?.rows.length ?? 0,
            }),
          })
        }
      }  // closes if (compoundGroups.size > 0)
      }  // closes for titleSplits
    }  // closes if (compoundRoles.resolved)
  }

  let stratumColorIdx = 0
  for (const [facetKey, { facetValues }] of strataKeys) {
    const stratumSummaryRows = summaryRows.filter(r =>
      makeFacetKey(r.facetValues, facetDims) === facetKey
    )
    const stratumTrajectoryRows = trajectoryRows.filter(r =>
      makeFacetKey(r.facetValues, facetDims) === facetKey
    )
    const stratumContrastRows = contrastRows.filter(r =>
      makeFacetKey(r.facetValues, facetDims) === facetKey
    )

    // Build a stratum title suffix from facetValues, e.g. "sex = M"
    const stratumLabel = facetDims.map(d => `${d} = ${facetValues[d] ?? '?'}`).join(', ')

    const stratumOutcomeLabel = resolveFacetOutcomeLabel(outcomeLabel, facetValues)

    if (!compoundTrajectoryBuilt && stratumTrajectoryRows.length > 0) {
      const stratumTrajKey = `${result.id}|${facetKey}|trajectory`
      const roleMapping = resolveTraceRoles(stratumTrajectoryRows, facetDims, stratumColorIdx, overrides?.[stratumTrajKey])
      stratumColorIdx++
      const { traces: lineData } = buildTrajectoryLineData(stratumTrajectoryRows, [], roleMapping)
      const sigResult = buildTrajectorySignificanceShapes(
        stratumTrajectoryRows, facetKey, simpleEffectsRequested,
        roleMapping.resolved ? roleMapping.sharedColor : undefined,
      )
      const yRange = computeTrajectoryYRange(stratumTrajectoryRows, sigResult)
      const lineLayout = buildLineLayout(
        stratumOutcomeLabel,
        false,
        sigResult?.needsFootnote ?? false,
        sigResult?.shapes,
        yRange ?? undefined,
      )
      ;(lineLayout as any).meta = {
        ...((lineLayout as any).meta ?? {}),
        traceRoleMapping: roleMapping,
        ...(compoundGuardReason !== undefined ? { compoundGuardReason } : {}),
        ...(sigResult ? {
          bracketCatalog: sigResult.bracketCatalog,
          bracketEffectMap: sigResult.bracketEffectMap,
          bracketEffectShapes: sigResult.bracketEffectShapes,
          bracketVisibility: sigResult.bracketVisibility,
          bracketSettings: sigResult.bracketSettings,
          bracketShapeParams: sigResult.bracketShapeParams,
        } : {}),
      }
      specs.push({
        plot: createTestResultPlotSpec({
          id: `plot-${result.id}-lmm-line-trajectory-${facetKey}`,
          type: 'line',
          title: `${stratumOutcomeLabel} — Trajectory (Mean ± SE) (${stratumLabel})`,
          statisticsFamilyId,
          resultId: result.id,
          testType: result.testId,
          testFamily,
          plotlyData: lineData as Data[],
          plotlyLayout: lineLayout as Layout,
          plotlyConfig: sigResult ? TRAJECTORY_SHAPE_CONFIG as any : undefined,
          dataPolicy: 'raw',
          samplingConfig: null,
          aggregationConfig: null,
          facetKey,
          lmmMode: 'trajectory',
        }),
        stats: computeTrajectoryStats(stratumTrajectoryRows),
      })
    }

    if (stratumContrastRows.length > 0) {
      const { traces: lineData, needsFootnote } = buildContrastLineData(stratumContrastRows, [])
      const lineLayout = buildLineLayout(stratumOutcomeLabel, true, needsFootnote)
      specs.push({
        plot: createTestResultPlotSpec({
          id: `plot-${result.id}-lmm-line-contrast-${facetKey}`,
          type: 'line',
          title: `${stratumOutcomeLabel} — Time Contrast (${stratumLabel})`,
          statisticsFamilyId,
          resultId: result.id,
          testType: result.testId,
          testFamily,
          plotlyData: lineData as Data[],
          plotlyLayout: lineLayout as Layout,
          dataPolicy: 'raw',
          samplingConfig: null,
          aggregationConfig: null,
          facetKey,
          lmmMode: 'contrast',
        }),
        stats: {},
      })
    }

    if (!compoundTrajectoryBuilt && stratumTrajectoryRows.length === 0 && stratumContrastRows.length === 0 && stratumSummaryRows.length > 0) {
      specs.push({
        plot: createTestResultPlotSpec({
          id: `plot-${result.id}-lmm-line-unavailable-${facetKey}`,
          type: 'line',
          title: `${stratumOutcomeLabel} — Plot Unavailable (${stratumLabel})`,
          statisticsFamilyId,
          resultId: result.id,
          testType: result.testId,
          testFamily,
          plotlyData: [] as Data[],
          plotlyLayout: buildUnavailableLayout(stratumOutcomeLabel) as Layout,
          dataPolicy: 'raw',
          samplingConfig: null,
          aggregationConfig: null,
          facetKey,
          lmmMode: 'line_unavailable',
        }),
        stats: {},
      })
    }

    void stratumSummaryRows
  }

  return specs
}
