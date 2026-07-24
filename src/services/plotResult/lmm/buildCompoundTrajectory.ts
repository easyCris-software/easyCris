/**
 * buildCompoundTrajectory — Compound trajectory activation guard
 *
 * Determines whether a compound (multi-panel) trajectory plot can be built
 * from an LMM result. Returns resolved roles when all guards pass, or a
 * descriptive failure reason when they do not.
 */

import type { Data } from 'plotly.js'
import type { LmmTrajectoryRow } from './normalize'
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
// Factor name normalization for Guards 7 & 8
// Allows "condition"/"treatment"/"group" to match each other,
// and "day"/"time"/"week"/"visit" to match each other.
// Strict: only aliases within each group are accepted, not broad fuzzy matching.
// ---------------------------------------------------------------------------

// Approved alias groups: exact normalized strings only (trim + lowercase).
// No token chopping — 'group_size' must NOT alias to 'group'.
// Add new aliases here explicitly if a real backend variant appears.
const FACTOR_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['condition', 'treatment', 'group'],
  ['day', 'time', 'week', 'visit', 'timepoint'],
]

function normalizeFactorName(name: string): string {
  const lower = name.trim().toLowerCase()
  for (const group of FACTOR_ALIAS_GROUPS) {
    if ((group as readonly string[]).includes(lower)) return group[0]!
  }
  return lower
}

export function factorNamesMatch(a: string, b: string): boolean {
  return normalizeFactorName(a) === normalizeFactorName(b)
}

export type CompoundRoles =
  | { resolved: true; styleFactor: string; withinFactor: string; colorFactor: string; panelFactors: string[]; titleFactors: string[]; referenceLevel?: string }
  | { resolved: false; reason: string }

export function canBuildCompoundTrajectory(
  trajectoryRows: LmmTrajectoryRow[],
  rawResult: Record<string, unknown>,
): CompoundRoles {
  // Guard 1: at least one trajectory row must exist (cheapest check first)
  if (trajectoryRows.length === 0) {
    return { resolved: false, reason: 'no trajectory rows' }
  }

  // Guard 2: stratify_by must be an array of at least 2 strings
  // colorFactor = stratify_by[0], panelFactors = stratify_by[1..] (supports 2+ dims)
  const stratifyBy = rawResult.stratify_by
  if (!Array.isArray(stratifyBy) || stratifyBy.length === 0) {
    return { resolved: false, reason: 'stratify_by missing or empty' }
  }
  if (stratifyBy.length < 2) {
    return { resolved: false, reason: `requires at least 2 stratify dims, got ${stratifyBy.length}` }
  }
  if (!stratifyBy.every((s): s is string => typeof s === 'string' && s.trim().length > 0)) {
    return { resolved: false, reason: 'stratify_by elements must be non-empty strings' }
  }

  const stratifySet = new Set(stratifyBy as string[])

  // ---------------------------------------------------------------------------
  // Resolve colorFactor / panelFactors
  //
  // Priority 1 — plot_facet_roles (explicit user choice, persisted in config)
  // Priority 2 — index-based fallback: colorFactor = stratify_by[0], rest = panels
  //
  // Fallback conditions (either triggers full index-based fallback):
  //   - color_by absent or not in stratify_by
  //   - color_by === facet_by (degenerate config)
  // ---------------------------------------------------------------------------
  let colorFactor: string
  let panelFactors: string[]

  const rawFPR = rawResult['plot_facet_roles']
  const hasFPR =
    rawFPR !== null &&
    typeof rawFPR === 'object' &&
    typeof (rawFPR as Record<string, unknown>)['color_by'] === 'string' &&
    ((rawFPR as Record<string, unknown>)['color_by'] as string).trim().length > 0

  if (hasFPR) {
    const fpr = rawFPR as Record<string, unknown>
    const colorByRaw = ((fpr['color_by'] as string)).trim()
    const facetByRaw = typeof fpr['facet_by'] === 'string' ? (fpr['facet_by'] as string).trim() : ''

    const colorByValid = stratifySet.has(colorByRaw)
    const colorsConflict = colorByRaw === facetByRaw && colorByRaw.length > 0

    if (colorByValid && !colorsConflict) {
      colorFactor = colorByRaw
      const facetByValid = facetByRaw.length > 0 && stratifySet.has(facetByRaw)
      if (facetByValid) {
        // facet_by goes first in panelFactors; remaining strata fill in after
        panelFactors = [
          facetByRaw,
          ...(stratifyBy as string[]).filter(s => s !== colorFactor && s !== facetByRaw),
        ]
      } else {
        panelFactors = (stratifyBy as string[]).filter(s => s !== colorFactor)
      }
    } else {
      // Invalid color_by or conflict — fall through to index-based
      colorFactor = (stratifyBy as string[])[0]!
      panelFactors = (stratifyBy as string[]).slice(1)
    }
  } else {
    // No plot_facet_roles — use index-based convention
    colorFactor = (stratifyBy as string[])[0]!
    panelFactors = (stratifyBy as string[]).slice(1)
  }

  // ---------------------------------------------------------------------------
  // Guard 3: resolve styleFactor / withinFactor
  //
  // Priority 1 — trajectory_roles (explicit, authoritative)
  // Priority 2 — simple_effects[0] (legacy, inferred)
  // If neither yields valid string factors, fail with descriptive reason.
  // ---------------------------------------------------------------------------
  let styleFactor: string
  let withinFactor: string
  let referenceLevel: string | undefined

  const rawTR = rawResult['trajectory_roles']
  const hasTR =
    rawTR !== null &&
    typeof rawTR === 'object' &&
    typeof (rawTR as Record<string, unknown>)['treatment_factor'] === 'string' &&
    ((rawTR as Record<string, unknown>)['treatment_factor'] as string).trim().length > 0 &&
    typeof (rawTR as Record<string, unknown>)['time_factor'] === 'string' &&
    ((rawTR as Record<string, unknown>)['time_factor'] as string).trim().length > 0

  if (hasTR) {
    const tr = rawTR as Record<string, unknown>
    const tfRaw = (tr['treatment_factor'] as string).trim()
    const timRaw = (tr['time_factor'] as string).trim()
    const refRaw = typeof tr['reference_level'] === 'string' ? tr['reference_level'] : undefined

    // Hard guard: treatment and time must be different
    if (tfRaw === timRaw) {
      return {
        resolved: false,
        reason: `trajectory_roles treatment_factor and time_factor must be different, got '${tfRaw}' for both`,
      }
    }

    // Hard guard: treatment factor must not overlap with stratification factors
    if (stratifySet.has(tfRaw)) {
      return {
        resolved: false,
        reason: `trajectory_roles treatment_factor '${tfRaw}' overlaps with stratify_by — treatment and stratification factors must be distinct`,
      }
    }

    // Hard guard: time factor must not overlap with stratification factors
    if (stratifySet.has(timRaw)) {
      return {
        resolved: false,
        reason: `trajectory_roles time_factor '${timRaw}' overlaps with stratify_by — time and stratification factors must be distinct`,
      }
    }

    styleFactor = tfRaw
    withinFactor = timRaw
    referenceLevel = refRaw
  } else {
    // Fall through to simple_effects[0]
    const topLevelSE = rawResult['simple_effects']
    const strataResults = rawResult['strata_results']
    const firstStratumSE = Array.isArray(strataResults)
      ? strataResults
          .map(s => (s !== null && typeof s === 'object')
            ? (s as Record<string, unknown>)['simple_effects']
            : undefined)
          .find((se): se is unknown[] => Array.isArray(se) && se.length > 0)
      : undefined
    const simpleEffects = (Array.isArray(topLevelSE) && topLevelSE.length > 0)
      ? topLevelSE
      : firstStratumSE
    if (!Array.isArray(simpleEffects) || simpleEffects.length === 0) {
      return { resolved: false, reason: 'simple_effects missing or empty' }
    }

    const firstEntry = simpleEffects[0]
    if (typeof firstEntry !== 'object' || firstEntry === null) {
      return { resolved: false, reason: 'simple_effects entry missing factor or within' }
    }
    const rawFactor = (firstEntry as Record<string, unknown>).factor
    const rawWithin = (firstEntry as Record<string, unknown>).within
    if (
      typeof rawFactor !== 'string' || rawFactor.trim().length === 0 ||
      typeof rawWithin !== 'string' || rawWithin.trim().length === 0
    ) {
      return { resolved: false, reason: 'simple_effects entry missing factor or within' }
    }

    styleFactor = rawFactor.trim()
    withinFactor = rawWithin.trim()
  }

  // Guard 4: colorFactor must not collide with styleFactor
  if (colorFactor === styleFactor) {
    return {
      resolved: false,
      reason: `colorFactor '${colorFactor}' collides with styleFactor — they must be different dimensions`,
    }
  }

  // Guard 5: colorFactor must appear in every row's facetValues
  const colorFound = trajectoryRows.every(row => colorFactor in row.facetValues)
  if (!colorFound) {
    return { resolved: false, reason: `colorFactor '${colorFactor}' not found in trajectory row facetValues` }
  }

  // Guards 7 & 8: alias-normalized factor name validation against row data.
  // Skipped when trajectory_roles provided — the explicit contract is authoritative.
  // A mismatch when using trajectory_roles just means sparse traces, not a bad result.
  if (!hasTR) {
    // Guard 7: styleFactor must match every row's groupFactor (alias-normalized)
    const styleFactorFound = trajectoryRows.every(row => factorNamesMatch(row.groupFactor, styleFactor))
    if (!styleFactorFound) {
      return {
        resolved: false,
        reason: `styleFactor '${styleFactor}' does not match row groupFactor '${trajectoryRows[0]?.groupFactor ?? 'unknown'}'`,
      }
    }

    // Guard 8: withinFactor must match every row's timeFactor (alias-normalized)
    const withinFactorFound = trajectoryRows.every(row => factorNamesMatch(row.timeFactor, withinFactor))
    if (!withinFactorFound) {
      return {
        resolved: false,
        reason: `withinFactor '${withinFactor}' does not match row timeFactor '${trajectoryRows[0]?.timeFactor ?? 'unknown'}'`,
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Title-only factors — from plot_facet_roles.title_only_factors
  // These factors are excluded from panelFactors and exposed as titleFactors.
  // titleFactors create separate compound plot specs (one per title-value combo).
  // Guards: must be in stratifySet and must not be colorFactor. Invalid entries ignored.
  // ---------------------------------------------------------------------------
  let titleFactors: string[] = []

  if (hasFPR) {
    const fpr = rawResult['plot_facet_roles'] as Record<string, unknown>
    const rawTOF = fpr['title_only_factors']
    if (Array.isArray(rawTOF)) {
      titleFactors = (rawTOF as unknown[])
        .filter((v): v is string =>
          typeof v === 'string' && v.trim().length > 0 &&
          stratifySet.has(v.trim()) &&
          v.trim() !== colorFactor
        )
        .map(v => v.trim())
      // Remove title-only factors from panelFactors
      const titleSet = new Set(titleFactors)
      panelFactors = panelFactors.filter(f => !titleSet.has(f))
    }
  }

  // Guard 6: every panelFactor AND titleFactor must have a defined value in every row's facetValues.
  // Uses row.facetValues[f] !== undefined (not 'f in row.facetValues') to match splitByTitleFactors
  // semantics exactly — a key present with value undefined would pass 'in' but be silently dropped
  // by the splitter, creating invisible row loss. Both checks use the same defined-value test.
  for (const pf of panelFactors) {
    const pfFound = trajectoryRows.every(row => row.facetValues[pf] !== undefined)
    if (!pfFound) {
      return { resolved: false, reason: `panelFactor '${pf}' not found in trajectory row facetValues` }
    }
  }
  for (const tf of titleFactors) {
    const tfFound = trajectoryRows.every(row => row.facetValues[tf] !== undefined)
    if (!tfFound) {
      return { resolved: false, reason: `titleFactor '${tf}' not found in trajectory row facetValues` }
    }
  }

  return {
    resolved: true,
    styleFactor,
    withinFactor,
    colorFactor,
    panelFactors,
    titleFactors,
    referenceLevel,
  }
}

// ---------------------------------------------------------------------------
// splitByTitleFactors
// ---------------------------------------------------------------------------

/**
 * Splits trajectory rows into groups by the composite of title-factor values.
 * Returns Map<titleKey, rows[]> where titleKey is e.g. "Sex=M" or "Sex=M, Strain=B6".
 *
 * When titleFactors is empty, returns a single entry with key '' containing all rows.
 * Rows missing any title-factor in their facetValues are silently excluded.
 */
export function splitByTitleFactors(
  rows: LmmTrajectoryRow[],
  titleFactors: string[],
): Map<string, LmmTrajectoryRow[]> {
  if (titleFactors.length === 0) {
    return new Map([['', rows]])
  }

  const result = new Map<string, LmmTrajectoryRow[]>()

  for (const row of rows) {
    const parts = titleFactors.map(f => {
      const v = row.facetValues[f]
      return v !== undefined ? `${f}=${v}` : null
    })
    if (parts.some(p => p === null)) continue

    const key = parts.join(', ')
    let group = result.get(key)
    if (!group) {
      group = []
      result.set(key, group)
    }
    group.push(row)
  }

  return result
}

// ---------------------------------------------------------------------------
// Task 2: groupRowsForCompound
// ---------------------------------------------------------------------------

export interface CompoundGroupKey {
  panelValue: string   // composite: panelFactors values joined with '|', e.g. 'M|Tail.Flick.Late'
  colorValue: string   // e.g. 'B6' (facetValues[colorFactor])
  groupValue: string   // e.g. 'VEH' (row.groupValue — the style/treatment level)
}

export interface CompoundTraceGroup {
  key: CompoundGroupKey
  rows: LmmTrajectoryRow[]  // sorted ascending by timeValue
}

/**
 * Group trajectory rows into per-panel compound trace groups.
 *
 * Uses explicit role dims from CompoundRoles — does NOT infer from facetDims order.
 * Rows missing colorFactor or panelFactor in facetValues are silently excluded.
 *
 * Returns Map<panelValue, CompoundTraceGroup[]>
 * Each entry in the array is one trace (colorValue × groupValue combination).
 * Rows within each group are sorted ascending by timeValue.
 */
export function groupRowsForCompound(
  rows: LmmTrajectoryRow[],
  roles: Extract<CompoundRoles, { resolved: true }>,
): Map<string, CompoundTraceGroup[]> {
  const { panelFactors, colorFactor } = roles

  // bucket key → { key, rows[] }
  const buckets = new Map<string, CompoundTraceGroup>()

  for (const row of rows) {
    // Build composite panel value from all panelFactors joined with '|'
    const panelParts = panelFactors.map(f => row.facetValues[f])
    if (panelParts.some(v => v === undefined)) continue  // missing a panel dim
    const panelValue = panelParts.join('|')

    const colorValue = row.facetValues[colorFactor]

    // Silently exclude rows missing color dimension
    if (colorValue === undefined) continue

    const bucketKey = `${panelValue}||${colorValue}||${row.groupValue}`

    let bucket = buckets.get(bucketKey)
    if (bucket === undefined) {
      bucket = {
        key: { panelValue, colorValue, groupValue: row.groupValue },
        rows: [],
      }
      buckets.set(bucketKey, bucket)
    }
    bucket.rows.push(row)
  }

  // Sort rows within each bucket ascending by timeValue
  for (const bucket of buckets.values()) {
    bucket.rows.sort((a, b) => a.timeValue - b.timeValue)
  }

  // Assemble result Map<panelValue, CompoundTraceGroup[]>
  const result = new Map<string, CompoundTraceGroup[]>()

  for (const group of buckets.values()) {
    const panelValue = group.key.panelValue
    let panelGroups = result.get(panelValue)
    if (panelGroups === undefined) {
      panelGroups = []
      result.set(panelValue, panelGroups)
    }
    panelGroups.push(group)
  }

  return result
}

// ---------------------------------------------------------------------------
// Task 3: buildCompoundColorMap, buildCompoundDashMap,
//         buildCompoundTrajectoryTraces, buildCompoundXAxisConfig
// ---------------------------------------------------------------------------

const COLORS = LMM_COLORS

/**
 * Assigns a color from the COLORS palette to each unique colorDim value.
 * Cycles if more than 10 values are provided.
 */
export function buildCompoundColorMap(colorValues: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  colorValues.forEach((value, i) => {
    result[value] = COLORS[i % COLORS.length]!
  })
  return result
}

/**
 * Assigns dash style per groupValue.
 * Priority (highest first):
 *   1. Explicit referenceLevel override (referenceLevel→dot, other→solid)
 *   2. groupRole metadata from rows (baseline→dot, contrast→solid)
 *   3. Alphabetical fallback (first sorted groupValue→solid, rest→dot)
 */
export function buildCompoundDashMap(
  traceGroups: CompoundTraceGroup[],
  opts?: { referenceLevel?: string },
): Record<string, 'solid' | 'dot'> {
  if (traceGroups.length === 0) return {}

  // Collect all unique groupValues and their roles
  const groupRoleMap = new Map<string, string | null>()
  for (const group of traceGroups) {
    const { groupValue } = group.key
    if (!groupRoleMap.has(groupValue)) {
      // Use role from first row of this group
      const role = group.rows[0]?.groupRole ?? null
      groupRoleMap.set(groupValue, role)
    }
  }

  const result: Record<string, 'solid' | 'dot'> = {}

  // Priority 1: explicit referenceLevel override
  // When an explicit reference is provided, it is authoritative — always apply it, even if
  // the reference level is absent from this panel (sparse data: all others become solid).
  const refLevel = opts?.referenceLevel
  if (refLevel !== undefined) {
    for (const groupValue of groupRoleMap.keys()) {
      result[groupValue] = groupValue === refLevel ? 'dot' : 'solid'
    }
    return result
  }

  // Priority 2: semantic groupRole metadata
  const hasRoles = [...groupRoleMap.values()].some(r => r !== null)
  if (hasRoles) {
    for (const [groupValue, role] of groupRoleMap) {
      result[groupValue] = role === 'baseline' ? 'dot' : 'solid'
    }
    return result
  }

  // Priority 3: alphabetical fallback — first sorted groupValue→solid, rest→dot
  const sorted = [...groupRoleMap.keys()].sort()
  sorted.forEach((groupValue, i) => {
    result[groupValue] = i === 0 ? 'solid' : 'dot'
  })

  return result
}

/**
 * Builds Plotly traces for a set of CompoundTraceGroups.
 * - x = numeric timeValue
 * - y = mean
 * - error_y uses se values
 * - line color and dash from colorMap / dashMap
 * - name = "${colorValue} — ${groupValue}"
 */
export function buildCompoundTrajectoryTraces(
  traceGroups: CompoundTraceGroup[],
  colorMap: Record<string, string>,
  dashMap: Record<string, 'solid' | 'dot'>,
): Data[] {
  return traceGroups.map((group): Data => {
    const { colorValue, groupValue } = group.key
    const color = colorMap[colorValue] ?? '#000000'
    const dash = dashMap[groupValue] ?? 'solid'

    const x = group.rows.map(r => r.timeValue)
    const y = group.rows.map(r => r.mean)
    const seArray = group.rows.map(r => r.se)

    return {
      type: 'scatter',
      mode: 'lines+markers',
      name: `${colorValue} — ${groupValue}`,
      x,
      y,
      error_y: {
        type: 'data',
        array: seArray,
        visible: true,
      },
      line: { color, dash },
      marker: { color },
    } as Data
  })
}

/**
 * Derives x-axis tick config from all rows across all trace groups.
 * tickvals = sorted unique numeric timeValue
 * ticktext = canonical timeValueRaw for each (first encountered per timeValue)
 */
export function buildCompoundXAxisConfig(
  traceGroups: CompoundTraceGroup[],
): { tickvals: number[]; ticktext: string[] } {
  const seen = new Map<number, string>()

  for (const group of traceGroups) {
    for (const row of group.rows) {
      if (!seen.has(row.timeValue)) {
        seen.set(row.timeValue, row.timeValueRaw)
      }
    }
  }

  const tickvals = [...seen.keys()].sort((a, b) => a - b)
  const ticktext = tickvals.map(v => seen.get(v)!)

  return { tickvals, ticktext }
}

// ---------------------------------------------------------------------------
// Task 4: buildCompoundSignificance
// ---------------------------------------------------------------------------

const COMPOUND_X_OFFSET = 0.2  // horizontal stagger between color-level significance markers

function pStar(p: number): string {
  if (p < 0.001) return '***'
  if (p < 0.01)  return '**'
  if (p < 0.05)  return '*'
  return 'ns'
}

export interface CompoundSignificanceResult {
  shapes: Record<string, unknown>[]
  bracketCatalog: BracketCatalog
  bracketEffectMap: Record<string, BracketEffectMeta>
  bracketEffectShapes: Record<string, string[]>
  bracketVisibility: Record<string, boolean>
  bracketSettings: BracketSettings
  bracketShapeParams: { halfWidth: number; tickHeightRatio: number; lineWidth: number; ySpan: number }
  needsFootnote: boolean
  yMax: number
}

/**
 * Builds Plotly path shapes and full bracket metadata for a single compound plot panel.
 * One shape per (colorValue, timeValue) pair with p-value, staggered horizontally by colorValue index.
 *
 * Returns null when no shapes can be built (no rows have p-values, or no colorValue has exactly 2 groupValues).
 */
export function buildCompoundSignificance(
  traceGroups: CompoundTraceGroup[],   // all groups for ONE panel
  panelKey: string,                     // e.g. 'sex=M'  (used in effectId)
  colorValues: string[],               // ordered unique colorValues (index drives x-offset)
  colorMap: Record<string, string>,    // color for each colorValue
  roles: Extract<CompoundRoles, { resolved: true }>,
  simpleEffectsRequested: boolean,
): CompoundSignificanceResult | null {
  if (!simpleEffectsRequested) return null
  if (colorValues.length === 0) return null

  // Collect all rows across all groups for global range computation
  const allRows = traceGroups.flatMap(g => g.rows)
  if (allRows.length === 0) return null

  const globalYTop = Math.max(...allRows.map(r => r.mean + r.se))
  const globalYBot = Math.min(...allRows.map(r => r.mean - r.se))
  const ySpan = Math.max(globalYTop - globalYBot, 1)
  const baseGap = ySpan * 0.07

  const { halfWidth: HALF_WIDTH, tickHeightRatio: TICK_HEIGHT_RATIO, lineWidth: LINE_WIDTH } = BRACKET_THIN_PARAMS
  const tickHeight = ySpan * TICK_HEIGHT_RATIO

  const seSettings: BracketSettings = { ...createDefaultBracketSettings(), showNs: true }

  const shapes: Record<string, unknown>[] = []
  const brackets: SignificanceBracket[] = []
  const bracketEffectMap: Record<string, BracketEffectMeta> = {}
  const bracketEffectShapes: Record<string, string[]> = {}
  const bracketVisibility: Record<string, boolean> = {}
  let yMax = globalYTop

  // needsFootnote is panel-wide: true if any row has !interactionSignificant
  const needsFootnote = allRows.some(r => !r.interactionSignificant)

  for (let colorIdx = 0; colorIdx < colorValues.length; colorIdx++) {
    const colorValue = colorValues[colorIdx]!

    // Collect all rows for this colorValue
    const colorGroups = traceGroups.filter(g => g.key.colorValue === colorValue)
    const colorRows = colorGroups.flatMap(g => g.rows)

    if (colorRows.length === 0) continue

    // Filter to rows conforming to roles contract (timeFactor must alias-match withinFactor)
    const conformingRows = colorRows.filter(r => factorNamesMatch(r.timeFactor, roles.withinFactor))
    if (conformingRows.length === 0) continue

    // Find unique groupValues for this colorValue
    const groupValuesSet = new Set(colorGroups.map(g => g.key.groupValue))
    if (groupValuesSet.size !== 2) continue

    // Sort for stable effectId
    const [g1, g2] = [...groupValuesSet].sort()

    // Group rows by timeValue (numeric)
    const byTimeValue = new Map<number, LmmTrajectoryRow[]>()
    for (const row of conformingRows) {
      let bucket = byTimeValue.get(row.timeValue)
      if (bucket === undefined) {
        bucket = []
        byTimeValue.set(row.timeValue, bucket)
      }
      bucket.push(row)
    }

    // Sort timepoints ascending
    const sortedTimepoints = [...byTimeValue.entries()].sort((a, b) => a[0] - b[0])

    const colorOffset = colorValues.length === 1 ? 0 : (colorIdx - (colorValues.length - 1) / 2) * COMPOUND_X_OFFSET
    const masterEffectId = `lmm_cmp|${panelKey}|${colorValue}|${g1}_vs_${g2}`
    const comparisonLabel = `${g1} vs ${g2} | ${colorValue}`
    const labelColor = colorMap[colorValue] ?? seSettings.font.color

    const shapeNamesForThisColor: string[] = []

    for (const [timeValue, rowsAtTime] of sortedTimepoints) {
      // Guard: both compared groups must be present at this timepoint
      const groupValuesAtTime = new Set(rowsAtTime.map(r => r.groupValue))
      if (!groupValuesAtTime.has(g1!) || !groupValuesAtTime.has(g2!)) continue

      const nonNullPValues = rowsAtTime.map(r => r.pValue).filter((p): p is number => p !== null)
      if (nonNullPValues.length === 0) continue
      // Use min p-value for deterministic behavior when multiple differing values exist
      const pValue = Math.min(...nonNullPValues)

      const label = pStar(pValue)
      const x = timeValue + colorOffset
      const yTopLocal = Math.max(...rowsAtTime.map(r => r.mean + r.se))
      const baseY = yTopLocal + baseGap
      const tipY = baseY + tickHeight

      yMax = Math.max(yMax, tipY)

      const xL = x - HALF_WIDTH
      const xR = x + HALF_WIDTH
      const pathStr = `M ${xL},${tipY} L ${xL},${baseY} L ${xR},${baseY} L ${xR},${tipY}`

      const shapeName = `sig_bracket_${shapes.length}`

      const timeFactor = rowsAtTime[0]?.timeFactor ?? 'Time'
      const timeValueRaw = rowsAtTime[0]?.timeValueRaw ?? String(timeValue)
      const tpEffectId = `lmm_se|${panelKey}|${colorValue}|${g1}_vs_${g2}|${timeFactor}=${timeValueRaw}`
      const tpLabel = `${g1} vs ${g2} | ${colorValue} | ${timeFactor}=${timeValueRaw}`

      shapes.push({
        type: 'path',
        name: shapeName,
        path: pathStr,
        xref: 'x',
        yref: 'y',
        layer: 'above',
        line: { color: BRACKET_THIN_PARAMS.lineColor, width: LINE_WIDTH },
        label: {
          text: label,
          textposition: 'top center',
          font: {
            size: seSettings.font.size,
            color: labelColor,
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

      shapeNamesForThisColor.push(shapeName)
    }

    // Master toggle per colorValue (only if any shapes were added for this colorValue)
    if (shapeNamesForThisColor.length > 0) {
      const isAnySig = brackets
        .filter(b => b.effectId?.startsWith(`lmm_se|${panelKey}|${colorValue}|`))
        .some(b => b.pValue < 0.05)

      bracketEffectMap[masterEffectId] = {
        label: comparisonLabel,
        group: 'comparison',
        significant: isAnySig,
      }
      bracketEffectShapes[masterEffectId] = shapeNamesForThisColor
      bracketVisibility[masterEffectId] = true
    }
  }

  if (shapes.length === 0) return null

  const bracketCatalog: BracketCatalog = { brackets }

  return {
    shapes,
    bracketCatalog,
    bracketEffectMap,
    bracketEffectShapes,
    bracketVisibility,
    bracketSettings: seSettings,
    bracketShapeParams: { halfWidth: HALF_WIDTH, tickHeightRatio: TICK_HEIGHT_RATIO, lineWidth: LINE_WIDTH, ySpan },
    needsFootnote,
    yMax,
  }
}
