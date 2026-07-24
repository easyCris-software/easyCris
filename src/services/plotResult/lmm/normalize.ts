/**
 * LMM Plot Normalizer
 *
 * Converts pooled and stratified LMM ANOVA results into a canonical row model
 * for plot builders. Fully dynamic — no hardcoded trait/sex/strain assumptions.
 * Facet dimensions are derived from stratify_by + stratum keys (union).
 */

export interface LmmSummaryRow {
  facetValues: Record<string, string>
  x: string
  y: number
  se: number
  ciLower: number
  ciUpper: number
  n: number
}

export interface LmmLineRow {
  facetValues: Record<string, string>
  timeValue: number
  estimate: number
  se: number
  pValue: number | null
  label: string
  /** Whether the interaction term was significant in the stratum this row belongs to. */
  interactionSignificant: boolean
  /** Whether simple effects were user-requested in the stratum this row belongs to. */
  simpleEffectsRequested: boolean
}

export interface LmmTrajectoryRow {
  facetValues: Record<string, string>
  timeFactor: string
  timeValue: number
  /** Original string value of the time/within factor — used for x-axis display. */
  timeValueRaw: string
  groupFactor: string
  groupValue: string
  mean: number
  se: number
  ciLower: number
  ciUpper: number
  n: number | null
  pValue: number | null
  interactionSignificant: boolean
  /** Which data source produced this row. */
  source: 'cell_summaries' | 'pgmot' | 'estimated_means'
  /**
   * Semantic role of this group level in the comparison.
   * Derived from pairwise_comparisons.group1 (reference level in R emmeans output).
   * null when no pairwise data available or more than 2 group levels present.
   */
  groupRole: 'baseline' | 'contrast' | null
}

export interface LmmPairwiseRow {
  group1: string
  group2: string
  pAdjusted: number
  significant: boolean
  facetValues: Record<string, string>
}

// ---------------------------------------------------------------------------
// Compound panel payload — stats from pooled backend model per panel
// ---------------------------------------------------------------------------

/**
 * Per-cell trajectory row from the pooled compound panel model.
 * SE comes from the pooled model's variance-covariance matrix, not from
 * per-stratum model averaging.
 */
export interface CompoundPanelTrajectoryRow {
  group_factor: string
  group_value: string
  color_factor: string
  color_value: string
  time_factor: string
  time_value: string
  emmean: number
  se: number
  ci_lower: number
  ci_upper: number
  n: number | null
}

/**
 * Pooled compound panel payload emitted by the backend when stratify_by >= 2 dims.
 * Stats (especially mean_se) are derived from a single pooled model fit per panel,
 * not from averaging per-stratum outputs.
 *
 * Statistical rationale: per emmeans/Lenth and BMJ g4539, combining outputs of
 * separately fit subgroup models produces SEs with incompatible variance structures.
 * Refs: https://rvlenth.github.io/emmeans/articles/xplanations.html
 *       https://www.bmj.com/content/349/bmj.g4539
 */
export interface CompoundPanelPayload {
  facet_key: string
  panel_filter: Record<string, string>
  color_factor: string
  panel_factors: string[]
  trajectory_rows: CompoundPanelTrajectoryRow[]
  simple_effects_by_time: Record<string, number | null>
  stats: Record<string, number>
}

export interface LmmNormalizedResult {
  summaryRows: LmmSummaryRow[]
  trajectoryRows: LmmTrajectoryRow[]
  contrastRows: LmmLineRow[]
  pairwiseRows: LmmPairwiseRow[]
  facetDims: string[]
  outcomeLabel: string
  interactionSignificant: boolean
  notes: string[]
  /** Simple effects config echoed from result.simple_effects — null when not requested. */
  simpleEffectsConfig: Array<{ factor: string; within: string }> | null
  /** True when user requested simple effects (simpleEffectsConfig is non-empty). */
  simpleEffectsRequested: boolean
  /** Pooled compound panel payloads from backend — null when not a 2+ dim stratified result.
   *  [] is valid for default R-parity subgroup mode; warnings indicate attempted/skipped pooled-panel builds. */
  compoundPanels: CompoundPanelPayload[] | null
  /** Warnings from compound panel pool-fit failures. Empty when all panels succeeded. */
  compoundPanelsWarnings: string[]
}

export interface LmmPlotMeta {
  dependentName?: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>

/**
 * Parse a value as a finite number. Returns null if invalid.
 * Rejects null, undefined, empty string, and non-finite results.
 * Never coerces to 0 to avoid fabricating data points.
 */
function parseNum(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return isFinite(n) ? n : null
}

function toStr(v: unknown): string {
  return v == null ? '' : String(v)
}

/**
 * Detect whether a fixed_effects source string represents an interaction.
 * Backend writes " x " (via _internal_term_label in lmm_anova.py:581).
 * Defensive fallback also matches ":" for asymptotic path or future changes.
 */
function isInteractionSource(source: string): boolean {
  return source.includes(' x ') || source.includes(':')
}

/**
 * Detect whether any significant interaction term exists in fixed_effects.
 */
function detectInteractionSignificant(result: AnyRecord): boolean {
  const effects = result['fixed_effects']
  if (!Array.isArray(effects)) return false
  return (effects as AnyRecord[]).some(
    fe => isInteractionSource(toStr(fe['source'])) && fe['significant'] === true
  )
}

/**
 * Parse a stratum_label string into a key→value record.
 * Format: "key1=val1 | key2=val2" (space-pipe-space separated, = delimited).
 * Returns empty record if the label is blank or unparseable.
 */
function parseStratumLabel(label: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const part of label.split('|')) {
    const trimmed = part.trim()
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    if (key) result[key] = val
  }
  return result
}

/**
 * Resolve facet values for a stratum, falling back to stratum_label parsing when
 * the stratum dict is absent or empty.
 */
function resolveStratumFacetValues(child: AnyRecord): Record<string, string> {
  const stratum = (child['stratum'] as AnyRecord | undefined) ?? {}
  if (Object.keys(stratum).length > 0) return stratum as Record<string, string>
  const label = toStr(child['stratum_label'])
  if (label) return parseStratumLabel(label)
  return {}
}

/**
 * Derive all facet dimension keys from stratify_by + union of successful stratum keys.
 * Only successful strata contribute keys — failed strata may carry dirty/phantom keys.
 * Handles missing/partial stratify_by gracefully. Falls back to stratum_label parsing
 * when stratum dict is empty/absent.
 */
function deriveFacetDims(
  stratifyBy: string[],
  strata: AnyRecord[]
): string[] {
  const dimSet = new Set<string>(stratifyBy)
  for (const child of strata) {
    if (child['success'] !== true) continue
    const facetValues = resolveStratumFacetValues(child)
    for (const key of Object.keys(facetValues)) {
      dimSet.add(key)
    }
  }
  return Array.from(dimSet)
}

/**
 * Extract summary rows from estimated_means or cell_summaries (fallback).
 * Drops rows where the y value (emmean/mean) is not a valid finite number.
 */
function extractSummaryRows(
  result: AnyRecord,
  facetValues: Record<string, string>
): LmmSummaryRow[] {
  const means = Array.isArray(result['estimated_means']) ? result['estimated_means'] as AnyRecord[] : []
  const cells = Array.isArray(result['cell_summaries']) ? result['cell_summaries'] as AnyRecord[] : []
  const source = means.length > 0 ? means : cells
  const yKey = means.length > 0 ? 'emmean' : 'mean'

  const rows: LmmSummaryRow[] = []
  for (const entry of source) {
    const y = parseNum(entry[yKey])
    if (y === null) continue // drop invalid rows — never fabricate 0

    const factors = (entry['factors'] as AnyRecord | undefined) ?? {}
    const xParts = Object.values(factors).map(toStr).filter(Boolean)

    rows.push({
      facetValues,
      x: xParts.join(' / ') || 'group',
      y,
      se: parseNum(entry['se']) ?? 0,
      ciLower: parseNum(entry['ci_lower']) ?? y,
      ciUpper: parseNum(entry['ci_upper']) ?? y,
      n: parseNum(entry['n']) ?? 0,
    })
  }
  return rows
}

/**
 * Extract pairwise rows from pairwise_comparisons.
 * pAdjusted may arrive as a formatted string from format_number — parseNum handles it.
 * Only rows with non-empty group labels are kept.
 */
function extractPairwiseRows(
  result: AnyRecord,
  facetValues: Record<string, string>
): LmmPairwiseRow[] {
  const comparisons = Array.isArray(result['pairwise_comparisons'])
    ? (result['pairwise_comparisons'] as AnyRecord[])
    : []
  const rows: LmmPairwiseRow[] = []
  for (const c of comparisons) {
    const group1 = toStr(c['group1'])
    const group2 = toStr(c['group2'])
    if (!group1 || !group2) continue
    rows.push({
      group1,
      group2,
      pAdjusted: parseNum(c['p_adjusted']) ?? 1,
      significant: c['significant'] === true,
      facetValues,
    })
  }
  return rows
}

/**
 * Extract line rows from continuous_effects.
 * Drops rows where timeValue or estimate is not a valid finite number.
 */
function extractLineRows(
  result: AnyRecord,
  facetValues: Record<string, string>,
  interactionSignificant: boolean,
  simpleEffectsRequested: boolean
): LmmLineRow[] {
  const effects = result['continuous_effects']
  if (!Array.isArray(effects)) return []

  const rows: LmmLineRow[] = []
  for (const entry of effects as AnyRecord[]) {
    const timeValue = parseNum(entry['time_value'])
    const estimate = parseNum(entry['estimate'])
    if (timeValue === null || estimate === null) continue // drop invalid rows

    rows.push({
      facetValues,
      timeValue,
      estimate,
      se: parseNum(entry['se']) ?? 0,
      pValue: parseNum(entry['p'] ?? entry['p_raw']),
      label: toStr(entry['label']),
      interactionSignificant,
      simpleEffectsRequested,
    })
  }
  return rows
}

/**
 * Extract the unambiguous baseline group value from pairwise_comparisons.
 *
 * Strict 2-group guard: requires ALL of:
 *   - exactly one unique group1 value (the reference level)
 *   - exactly one unique group2 value (the comparison level)
 *   - group1 !== group2 (sanity: they must differ)
 *
 * Returns null on one-vs-many structures (group1 consistent but multiple group2 values),
 * mixed-baseline structures, or no comparisons — forcing alphabetical dash fallback.
 */
function extractBaselineGroupValue(result: AnyRecord): string | null {
  const comparisons = Array.isArray(result['pairwise_comparisons'])
    ? (result['pairwise_comparisons'] as AnyRecord[])
    : []

  const group1Values = new Set(
    comparisons.map(c => toStr(c['group1'])).filter(g => g.length > 0)
  )
  const group2Values = new Set(
    comparisons.map(c => toStr(c['group2'])).filter(g => g.length > 0)
  )

  if (group1Values.size !== 1 || group2Values.size !== 1) return null

  const baseline = [...group1Values][0]!
  const contrast = [...group2Values][0]!
  if (baseline === contrast) return null

  return baseline
}

/**
 * Build a map from within_level (string) to pAdjusted, extracted from
 * pairwise_comparisons rows that have factor_scope = "{groupFactor}|{withinFactor}={level}".
 * Both the groupFactor (left of |) and withinFactor (right of |, before =) must match
 * case-insensitively. First occurrence wins — avoids fabricating a "best" p when multiple
 * pairs exist for the same within-level.
 */
function buildSimpleEffectPValueMap(
  result: AnyRecord,
  groupFactor: string,
  withinFactor: string
): Map<string, number> {
  const comparisons = Array.isArray(result['pairwise_comparisons'])
    ? (result['pairwise_comparisons'] as AnyRecord[])
    : []
  const map = new Map<string, number>()
  for (const c of comparisons) {
    const scope = toStr(c['factor_scope'])
    if (!scope) continue
    const pipeIdx = scope.indexOf('|')
    if (pipeIdx === -1) continue
    const scopeGroupName = scope.slice(0, pipeIdx)
    if (scopeGroupName.toLowerCase() !== groupFactor.toLowerCase()) continue
    const rest = scope.slice(pipeIdx + 1) // "{withinName}={withinLevel}"
    const eqIdx = rest.indexOf('=')
    if (eqIdx === -1) continue
    const scopeWithinName = rest.slice(0, eqIdx)
    const withinLevel = rest.slice(eqIdx + 1)
    if (scopeWithinName.toLowerCase() !== withinFactor.toLowerCase()) continue
    const p = parseNum(c['p_adjusted'])
    if (p === null) continue
    if (!map.has(withinLevel)) map.set(withinLevel, p) // first occurrence wins
  }
  return map
}

/**
 * Count distinct active group levels for a given within-level from trajectory rows.
 * Used to suppress stars when more than 2 groups are present (ambiguous which pair).
 */
function countGroupLevels(rows: LmmTrajectoryRow[]): number {
  return new Set(rows.map(r => r.groupValue)).size
}

/**
 * Extract simple_effects config from result-level simple_effects array.
 * Returns null when absent or empty. Filters out entries with blank factor/within.
 */
function extractSimpleEffects(result: AnyRecord): Array<{ factor: string; within: string }> | null {
  const se = result['simple_effects']
  if (!Array.isArray(se) || se.length === 0) return null
  const filtered = (se as AnyRecord[])
    .filter(e => toStr(e['factor']) !== '' && toStr(e['within']) !== '')
    .map(e => ({ factor: toStr(e['factor']), within: toStr(e['within']) }))
  return filtered.length > 0 ? filtered : null
}

type AxisRoles =
  | { resolved: true; groupFactor: string; withinFactor: string; fromSimpleEffects: boolean }
  | { resolved: false }

/**
 * Resolve axis roles for trajectory rows with factors.
 * Priority 0: trajectory_roles (explicit contract from frontend config — authoritative).
 * Priority 1: result.simple_effects[0] declares factor (group) and within (x-axis).
 * Priority 2: 2-factor heuristic — one numeric-like factor becomes x-axis, one categorical-like becomes group.
 * Priority 3: unresolvable → { resolved: false }.
 * Never hardcodes factor names.
 */
function resolveAxisRoles(
  factorRows: AnyRecord[],
  simpleEffects: Array<{ factor: string; within: string }> | null,
  trajectoryRoles?: { treatment_factor: string; time_factor: string } | null,
): AxisRoles {
  // Priority 0: explicit trajectory_roles contract (authoritative — not a heuristic)
  if (
    trajectoryRoles &&
    trajectoryRoles.treatment_factor.trim().length > 0 &&
    trajectoryRoles.time_factor.trim().length > 0
  ) {
    return {
      resolved: true,
      groupFactor: trajectoryRoles.treatment_factor.trim(),
      withinFactor: trajectoryRoles.time_factor.trim(),
      fromSimpleEffects: true,  // treat as explicit → enables p-value injection
    }
  }

  // Priority 1: user-declared via simple_effects
  if (simpleEffects && simpleEffects.length > 0) {
    const first = simpleEffects[0]!
    return { resolved: true, groupFactor: first.factor, withinFactor: first.within, fromSimpleEffects: true }
  }

  // Priority 2: heuristic — exactly 2 factors, one numeric-like, one categorical-like
  const allFactorKeys = new Set<string>()
  for (const row of factorRows) {
    const factors = (row['factors'] as AnyRecord | undefined) ?? {}
    for (const k of Object.keys(factors)) allFactorKeys.add(k)
  }
  const factorNames = Array.from(allFactorKeys)
  if (factorNames.length !== 2) return { resolved: false }

  const isNumericLike = (name: string): boolean => {
    const vals = factorRows.map(r => toStr(((r['factors'] as AnyRecord) ?? {})[name]))
    return vals.length > 0 && vals.every(v => v !== '' && isFinite(Number(v)))
  }

  const [a, b] = factorNames as [string, string]
  const aNumeric = isNumericLike(a)
  const bNumeric = isNumericLike(b)
  if (aNumeric === bNumeric) return { resolved: false } // both or neither numeric → ambiguous
  const withinFactor = aNumeric ? a : b
  const groupFactor = aNumeric ? b : a
  return { resolved: true, groupFactor, withinFactor, fromSimpleEffects: false }
}

/**
 * Extract trajectory rows from estimated_means using resolved axis roles.
 * Returns { rows, unresolvable } — unresolvable=true when resolveAxisRoles fails.
 */
function extractTrajectoryFromEstimatedMeans(
  result: AnyRecord,
  facetValues: Record<string, string>,
  interactionSignificant: boolean,
  simpleEffects: Array<{ factor: string; within: string }> | null,
  baselineGroupValue: string | null = null,
  trajectoryRoles?: { treatment_factor: string; time_factor: string } | null,
): { rows: LmmTrajectoryRow[]; unresolvable: boolean } {
  const means = Array.isArray(result['estimated_means']) ? result['estimated_means'] as AnyRecord[] : []
  if (means.length === 0) return { rows: [], unresolvable: false }

  const roles = resolveAxisRoles(means, simpleEffects, trajectoryRoles)
  if (!roles.resolved) return { rows: [], unresolvable: true }

  // Pre-compute ordinal positions for within-levels that are not numeric.
  // When parseNum returns null (categorical strings like "Pre"/"Post"), we assign
  // a stable ordinal index based on first-appearance order so distinct levels get
  // distinct timeValue positions instead of all collapsing to 0.
  const uniqueWithinLevels: string[] = []
  for (const entry of means) {
    const factors = (entry['factors'] as AnyRecord | undefined) ?? {}
    const v = toStr(factors[roles.withinFactor])
    if (v !== '' && !uniqueWithinLevels.includes(v)) uniqueWithinLevels.push(v)
  }
  const levelOrdinal = new Map(uniqueWithinLevels.map((v, i) => [v, i]))

  const rows: LmmTrajectoryRow[] = []
  for (const entry of means) {
    const factors = (entry['factors'] as AnyRecord | undefined) ?? {}
    const groupValue = toStr(factors[roles.groupFactor])
    const withinRaw = toStr(factors[roles.withinFactor])
    if (withinRaw === '') continue
    const mean = parseNum(entry['emmean'])
    if (mean === null) continue
    rows.push({
      facetValues,
      timeFactor: roles.withinFactor,
      timeValue: parseNum(withinRaw) ?? (levelOrdinal.get(withinRaw) ?? 0),
      timeValueRaw: withinRaw,
      groupFactor: roles.groupFactor,
      groupValue,
      mean,
      se: parseNum(entry['se']) ?? 0,
      ciLower: parseNum(entry['ci_lower']) ?? mean,
      ciUpper: parseNum(entry['ci_upper']) ?? mean,
      n: parseNum(entry['n']),
      pValue: null,
      interactionSignificant,
      source: 'estimated_means',
      groupRole: baselineGroupValue === null ? null
        : groupValue === baselineGroupValue ? 'baseline'
        : 'contrast',
    })
  }

  // Inject pValues from simple-effect pairwise rows — only when exactly 2 group levels
  // (suppressed for 3+ groups: ambiguous which pair's p to display)
  if (roles.fromSimpleEffects && countGroupLevels(rows) === 2) {
    const pMap = buildSimpleEffectPValueMap(result, roles.groupFactor, roles.withinFactor)
    for (const row of rows) {
      row.pValue = pMap.get(row.timeValueRaw) ?? null
    }
  }

  return { rows, unresolvable: false }
}

/**
 * Extract raw grouped trajectory rows from cell_summaries.
 *
 * lmm_anova_test.R plots raw subgroup Mean ± SE by treatment × time, while the
 * estimated_means/per_group_means paths contain model-derived SEs. In default
 * R-parity stratified mode, these raw rows are the authoritative trajectory
 * source; model rows remain the fallback for non-parity/future pooled paths.
 */
function extractTrajectoryFromCellSummaries(
  result: AnyRecord,
  facetValues: Record<string, string>,
  interactionSignificant: boolean,
  simpleEffects: Array<{ factor: string; within: string }> | null,
  baselineGroupValue: string | null = null,
  trajectoryRoles?: { treatment_factor: string; time_factor: string } | null,
): { rows: LmmTrajectoryRow[]; unresolvable: boolean } {
  const cells = Array.isArray(result['cell_summaries']) ? result['cell_summaries'] as AnyRecord[] : []
  if (cells.length === 0) return { rows: [], unresolvable: false }

  const roles = resolveAxisRoles(cells, simpleEffects, trajectoryRoles)
  if (!roles.resolved) return { rows: [], unresolvable: true }

  const uniqueWithinLevels: string[] = []
  for (const entry of cells) {
    const factors = (entry['factors'] as AnyRecord | undefined) ?? {}
    const v = toStr(factors[roles.withinFactor])
    if (v !== '' && !uniqueWithinLevels.includes(v)) uniqueWithinLevels.push(v)
  }
  const levelOrdinal = new Map(uniqueWithinLevels.map((v, i) => [v, i]))

  const rows: LmmTrajectoryRow[] = []
  for (const entry of cells) {
    const factors = (entry['factors'] as AnyRecord | undefined) ?? {}
    const groupValue = toStr(factors[roles.groupFactor])
    const withinRaw = toStr(factors[roles.withinFactor])
    if (withinRaw === '') continue
    const mean = parseNum(entry['mean'])
    if (mean === null) continue

    rows.push({
      facetValues,
      timeFactor: roles.withinFactor,
      timeValue: parseNum(withinRaw) ?? (levelOrdinal.get(withinRaw) ?? 0),
      timeValueRaw: withinRaw,
      groupFactor: roles.groupFactor,
      groupValue,
      mean,
      se: parseNum(entry['se']) ?? 0,
      ciLower: parseNum(entry['ci_lower']) ?? mean,
      ciUpper: parseNum(entry['ci_upper']) ?? mean,
      n: parseNum(entry['n']),
      pValue: null,
      interactionSignificant,
      source: 'cell_summaries',
      groupRole: baselineGroupValue === null ? null
        : groupValue === baselineGroupValue ? 'baseline'
        : 'contrast',
    })
  }

  if (simpleEffects && simpleEffects.length > 0 && countGroupLevels(rows) === 2) {
    const se = simpleEffects[0]!
    const pMap = buildSimpleEffectPValueMap(result, se.factor, se.within)
    for (const row of rows) {
      row.pValue = pMap.get(row.timeValueRaw) ?? null
    }
  }

  return { rows, unresolvable: false }
}

/**
 * Extract trajectory rows from backend-provided per_group_means_over_time.
 * pValues are sourced exclusively from pairwise_comparisons.factor_scope (simple-effect
 * pairwise scope), injected only when simple effects were user-requested and exactly
 * 2 group levels are present (same policy as estimated_means path).
 */
function extractTrajectoryRows(
  result: AnyRecord,
  facetValues: Record<string, string>,
  interactionSignificant: boolean,
  simpleEffects: Array<{ factor: string; within: string }> | null,
  baselineGroupValue: string | null = null,
): LmmTrajectoryRow[] {
  const rowsRaw = result['per_group_means_over_time']
  if (!Array.isArray(rowsRaw)) return []

  const groupLevels = new Set<string>()
  for (const entry of rowsRaw as AnyRecord[]) {
    const groupValue = toStr(entry['group_value'])
    if (groupValue) groupLevels.add(groupValue)
  }

  const rows: LmmTrajectoryRow[] = []
  for (const entry of rowsRaw as AnyRecord[]) {
    const timeValue = parseNum(entry['time_value'])
    const mean = parseNum(entry['mean'])
    if (timeValue === null || mean === null) continue
    const timeValueRaw = toStr(entry['time_value'])
    rows.push({
      facetValues,
      timeFactor: toStr(entry['time_factor']),
      timeValue,
      timeValueRaw,
      groupFactor: toStr(entry['group_factor']),
      groupValue: toStr(entry['group_value']),
      mean,
      se: parseNum(entry['se']) ?? 0,
      ciLower: parseNum(entry['ci_lower']) ?? mean,
      ciUpper: parseNum(entry['ci_upper']) ?? mean,
      n: parseNum(entry['n']),
      pValue: null,
      interactionSignificant,
      source: 'pgmot',
      groupRole: baselineGroupValue === null ? null
        : toStr(entry['group_value']) === baselineGroupValue ? 'baseline'
        : 'contrast',
    })
  }

  // Inject pValues from simple-effect pairwise scope — same policy as estimated_means path.
  // Only when simple effects were user-requested AND exactly 2 group levels present.
  if (simpleEffects && simpleEffects.length > 0 && groupLevels.size === 2) {
    const se = simpleEffects[0]!
    const pMap = buildSimpleEffectPValueMap(result, se.factor, se.within)
    for (const row of rows) {
      row.pValue = pMap.get(row.timeValueRaw) ?? null
    }
  }

  return rows
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function normalizeLmmForPlots(
  result: AnyRecord,
  meta: LmmPlotMeta
): LmmNormalizedResult {
  const notes: string[] = []
  const outcomeLabel = meta.dependentName ?? 'Value'

  // Extract top-level trajectory_roles (passed from frontend payload → echoed by backend)
  // Used as priority 0 in resolveAxisRoles for the estimated_means fallback path.
  const rawTR = result['trajectory_roles']
  const topLevelTrajectoryRoles: { treatment_factor: string; time_factor: string; reference_level?: string } | null =
    rawTR !== null &&
    typeof rawTR === 'object' &&
    typeof (rawTR as AnyRecord)['treatment_factor'] === 'string' &&
    typeof (rawTR as AnyRecord)['time_factor'] === 'string'
      ? {
          treatment_factor: toStr((rawTR as AnyRecord)['treatment_factor']),
          time_factor: toStr((rawTR as AnyRecord)['time_factor']),
          ...(typeof (rawTR as AnyRecord)['reference_level'] === 'string' &&
            toStr((rawTR as AnyRecord)['reference_level']).length > 0
            ? { reference_level: toStr((rawTR as AnyRecord)['reference_level']) }
            : {}),
        }
      : null

  // Stratified path
  if (result['stratified'] === true && Array.isArray(result['strata_results'])) {
    const stratifyBy = Array.isArray(result['stratify_by'])
      ? (result['stratify_by'] as unknown[]).map(toStr)
      : []

    const strataArr = result['strata_results'] as AnyRecord[]
    const rawCompoundPanels = (result as AnyRecord)['compound_panels']
    const rawCompoundWarnings = (result as AnyRecord)['compound_panels_warnings']
    const isDefaultRParitySubgroupMode =
      Array.isArray(rawCompoundPanels) &&
      rawCompoundPanels.length === 0 &&
      Array.isArray(rawCompoundWarnings) &&
      rawCompoundWarnings.length === 0

    // Derive facet dims from stratify_by UNION stratum keys — handles missing/partial stratify_by
    const facetDims = deriveFacetDims(stratifyBy, strataArr)

    const summaryRows: LmmSummaryRow[] = []
    const trajectoryRows: LmmTrajectoryRow[] = []
    const lineRows: LmmLineRow[] = []
    const pairwiseRows: LmmPairwiseRow[] = []
    let interactionSignificant = false
    let hasAnyContinuousEffects = false
    let simpleEffectsConfig: Array<{ factor: string; within: string }> | null = null

    for (const child of strataArr) {
      if (child['success'] !== true) continue

      const stratumValues = resolveStratumFacetValues(child)
      const facetValues: Record<string, string> = {}
      for (const dim of facetDims) {
        facetValues[dim] = toStr(stratumValues[dim])
      }

      const childInteractionSig = detectInteractionSignificant(child)
      if (childInteractionSig) interactionSignificant = true

      // Cache per-stratum simple_effects to avoid redundant calls
      const childSimpleEffects = extractSimpleEffects(child)
      const childSimpleEffectsRequested = childSimpleEffects !== null

      // Collect simple_effects config from first successful stratum that declares it (C1 clarity fix)
      if (simpleEffectsConfig === null && childSimpleEffects !== null) {
        simpleEffectsConfig = childSimpleEffects
      }

      summaryRows.push(...extractSummaryRows(child, facetValues))

      const childBaseline =
        extractBaselineGroupValue(child) ?? topLevelTrajectoryRoles?.reference_level ?? null

      const childRaw = isDefaultRParitySubgroupMode
        ? extractTrajectoryFromCellSummaries(child, facetValues, childInteractionSig, childSimpleEffects, childBaseline, topLevelTrajectoryRoles)
        : { rows: [] as LmmTrajectoryRow[], unresolvable: false }

      // Hybrid trajectory per stratum:
      // R-parity default: raw cell_summaries first (matches lmm_anova_test.R plots).
      // Otherwise: backend PGMOT first, estimated_means fallback.
      // trajectory_roles is used when resolving raw/estimated-means axes.
      const childPgmot = childRaw.rows.length > 0
        ? childRaw.rows
        : extractTrajectoryRows(child, facetValues, childInteractionSig, childSimpleEffects, childBaseline)
      if (childPgmot.length > 0) {
        trajectoryRows.push(...childPgmot)
      } else {
        const childEm = extractTrajectoryFromEstimatedMeans(child, facetValues, childInteractionSig, childSimpleEffects, childBaseline, topLevelTrajectoryRoles)
        trajectoryRows.push(...childEm.rows)
        if ((childRaw.unresolvable || childEm.unresolvable) && childEm.rows.length === 0) {
          notes.push('No trajectory source available — line unavailable: axis roles could not be resolved.')
        }
      }

      const childLineRows = extractLineRows(child, facetValues, childInteractionSig, childSimpleEffectsRequested)
      lineRows.push(...childLineRows)
      pairwiseRows.push(...extractPairwiseRows(child, facetValues))
      if (childLineRows.length > 0) hasAnyContinuousEffects = true
    }

    if (!hasAnyContinuousEffects) {
      notes.push('No continuous_effects available — contrast line omitted.')
    }
    if (trajectoryRows.length === 0) {
      notes.push('No trajectory source available — trajectory line omitted.')
    }

    const simpleEffectsRequested = simpleEffectsConfig !== null && simpleEffectsConfig.length > 0

    // Preserve [] vs null: [] can be the normal stratified R-parity default
    // (pooled backend panels disabled) or a failed pooled build. Treat warnings,
    // not emptiness alone, as the signal that a pooled build was attempted/skipped.
    // null means compound feature is not applicable (non-stratified result).
    const compoundPanels: CompoundPanelPayload[] | null =
      Array.isArray(rawCompoundPanels)
        ? (rawCompoundPanels as CompoundPanelPayload[])
        : null

    const compoundPanelsWarnings: string[] = Array.isArray(rawCompoundWarnings)
      ? (rawCompoundWarnings as string[])
      : []

    // Surface backend compound build warnings into notes so the UI can display them.
    for (const w of compoundPanelsWarnings) {
      notes.push(w)
    }

    return {
      summaryRows,
      trajectoryRows,
      contrastRows: lineRows,
      pairwiseRows,
      facetDims,
      outcomeLabel,
      interactionSignificant,
      notes,
      simpleEffectsConfig,
      simpleEffectsRequested,
      compoundPanels,
      compoundPanelsWarnings,
    }
  }

  // Pooled path
  const summaryRows = extractSummaryRows(result, {})
  const interactionSignificant = detectInteractionSignificant(result)
  const simpleEffectsConfig = extractSimpleEffects(result)
  const simpleEffectsRequested = simpleEffectsConfig !== null && simpleEffectsConfig.length > 0

  // Hybrid trajectory: PGMOT first, estimated_means fallback
  const baselineGroupValue =
    extractBaselineGroupValue(result) ?? topLevelTrajectoryRoles?.reference_level ?? null
  let trajectoryRows: LmmTrajectoryRow[]
  const pgmotRows = extractTrajectoryRows(result, {}, interactionSignificant, simpleEffectsConfig, baselineGroupValue)
  if (pgmotRows.length > 0) {
    trajectoryRows = pgmotRows
  } else {
    const emResult = extractTrajectoryFromEstimatedMeans(result, {}, interactionSignificant, simpleEffectsConfig, baselineGroupValue, topLevelTrajectoryRoles)
    trajectoryRows = emResult.rows
    if (emResult.unresolvable) {
      notes.push('No trajectory source available — line unavailable: axis roles could not be resolved.')
    }
  }

  const lineRows = extractLineRows(result, {}, interactionSignificant, simpleEffectsRequested)
  const pairwiseRows = extractPairwiseRows(result, {})

  if (lineRows.length === 0) {
    notes.push('No continuous_effects available — contrast line omitted.')
  }
  if (trajectoryRows.length === 0 && !notes.some(n => n.includes('line unavailable'))) {
    notes.push('No trajectory source available — trajectory line omitted.')
  }

  return {
    summaryRows,
    trajectoryRows,
    contrastRows: lineRows,
    pairwiseRows,
    facetDims: [],
    outcomeLabel,
    interactionSignificant,
    notes,
    simpleEffectsConfig,
    simpleEffectsRequested,
    compoundPanels: null,
    compoundPanelsWarnings: [],
  }
}
