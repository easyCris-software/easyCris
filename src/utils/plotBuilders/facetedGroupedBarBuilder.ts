/**
 * Faceted Grouped Bar Plot Builder for Multifactorial ANOVA
 *
 * Handles N-way ANOVA (3+ factors) with mandatory faceting:
 * - Factor with most levels → X-axis
 * - Factor with second most levels → Series (grouped bars)
 * - Remaining factors → Facets (small multiples)
 *
 * Features:
 * - Plotly subplots (row × col grid)
 * - Simple effects brackets (facet-filtered, no main effects)
 * - Error bars (SE default, user-toggleable)
 * - Synchronized legend toggling (legendgroup)
 * - E2E validation (data-stat attributes)
 *
 * References:
 * - MULTIFACTORIAL_ANOVA_PLOT_PLAN.md
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * Used by: Multifactorial ANOVA (113 metrics). Validated against validation baseline.
 * Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import {
  createBaseLayout,
  createDefaultConfig,
  getColor,
  createBracketShapes,
  stackBrackets,
  repelBracketLayout,
  formatBracketLabel,
} from './common'
import { createPlaceholderOutputFromInput } from './placeholder'
import {
  assignFactorRoles,
  getFactorNamesFromResult,
  getFactorLevelOrder,
  normalizeFactorMapping,
  type CellMean,
} from './factorRoleAssignment'
import type { SignificanceBracket } from './types'
import { createDefaultBracketSettings, getBracketLabel } from './types'
import {
  filterSimpleEffectBrackets,
  groupBracketsBySubplot,
  createSubplotId,
  type SimpleEffectBracket,
  type FacetLevel,
} from './filterSimpleEffectBrackets'

/**
 * Faceted Grouped Bar Plot Builder
 *
 * Auto-generates faceted grouped bar plots for multifactorial ANOVA (3+ factors).
 * Uses smart factor role assignment and faceting.
 */
export const facetedGroupedBarBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const stats: Record<string, number> = {}
  const { options } = input
  const errorBarType = options.errorBarType ?? 'se'
  const bracketSettings = options.bracketSettings ?? createDefaultBracketSettings()
  const toNumber = (value: unknown): number | null => {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }

  // Extract from result data (Python backend format)
  const resultData = (input as any).resultData as Record<string, unknown> | undefined
  if (!resultData) {
    return createPlaceholderOutputFromInput('grouped_bar', input, options.title)
  }

  try {
    // Extract factor names and cell means
    const factorNames = getFactorNamesFromResult(resultData)
    const summaries =
      (resultData.cell_summaries as Record<string, unknown>[] | undefined) ??
      (resultData.cell_means as Record<string, unknown>[] | undefined) ??
      (resultData.cell_medians as Record<string, unknown>[] | undefined)
    const emmeans = Array.isArray(resultData.cell_emmeans)
      ? (resultData.cell_emmeans as Record<string, unknown>[])
      : null
    const counts = resultData.cell_counts as { is_balanced?: boolean; isBalanced?: boolean } | undefined
    const isBalanced =
      typeof counts?.is_balanced === 'boolean'
        ? counts.is_balanced
        : typeof counts?.isBalanced === 'boolean'
          ? counts.isBalanced
          : undefined
    const meansType =
      typeof resultData.means_type === 'string'
        ? (resultData.means_type as string)
        : isBalanced === false
          ? 'lsmean'
          : 'cell_mean'
    const useEMMeans =
      Array.isArray(emmeans) &&
      emmeans.length > 0 &&
      (meansType === 'lsmean' || isBalanced === false || !summaries)
    const rawCells = (useEMMeans ? emmeans : summaries) ?? []
    const statsFallback = (input as any).testResult?.statistics as
      | {
          residual_ms?: unknown
          ms_residual?: unknown
          residual_ss?: unknown
          residual_df?: unknown
          residual?: { MS?: unknown }
        }
      | undefined
    const residualMs =
      toNumber(resultData.residual_ms) ??
      toNumber(resultData.ms_residual) ??
      (typeof resultData.residual === 'object' && resultData.residual !== null
        ? toNumber((resultData.residual as { MS?: unknown }).MS)
        : null) ??
      toNumber(statsFallback?.residual_ms) ??
      toNumber(statsFallback?.ms_residual) ??
      (statsFallback?.residual ? toNumber(statsFallback.residual.MS) : null)
    const residualSs =
      toNumber(resultData.residual_ss) ?? toNumber(statsFallback?.residual_ss)
    const residualDf =
      toNumber(resultData.residual_df) ?? toNumber(statsFallback?.residual_df)
    const pooledMs =
      residualMs ??
      (residualSs !== null && residualDf !== null && residualDf > 0
        ? residualSs / residualDf
        : null) ??
      toNumber(resultData.ms_within) ??
      toNumber(resultData.mse)
    const usePooledSe = pooledMs !== null && !useEMMeans

    const parseCellFactors = (cell: Record<string, unknown>): Record<string, string> => {
      const rawFactors = cell.factors
      if (rawFactors && typeof rawFactors === 'object' && !Array.isArray(rawFactors)) {
        const entries = Object.entries(rawFactors as Record<string, unknown>)
          .filter(([, value]) => value !== null && value !== undefined)
          .map(([key, value]) => [key, String(value)])
        if (entries.length > 0) {
          return Object.fromEntries(entries)
        }
      }

      const factors: Record<string, string> = {}
      factorNames.forEach((factorName, index) => {
        const direct = cell[factorName]
        const byLevel = cell[`${factorName}_level`]
        const byCamel = cell[`${factorName}Level`]
        const byIndex = cell[`factor${index + 1}_level`]
        const value =
          direct ?? byLevel ?? byCamel ?? byIndex ?? cell[`factor${index + 1}`]
        if (value !== null && value !== undefined) {
          factors[factorName] = String(value)
        }
      })
      return factors
    }

    const toNumberOrUndefined = (value: unknown): number | undefined => {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined
      }
      if (typeof value === 'string') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
      }
      return undefined
    }

    const cellMeans: CellMean[] = rawCells.map((cell) => {
      const mean = toNumberOrUndefined(cell.emmean ?? cell.mean ?? cell.median)
      const std = toNumberOrUndefined(cell.std ?? cell.sd)
      const se = toNumberOrUndefined(cell.se ?? cell.sem ?? cell.stderr ?? cell.std_error)
      const n = Number(cell.n ?? cell.count ?? 0)
      return {
        factors: parseCellFactors(cell),
        mean: mean ?? Number.NaN,
        std: std ?? Number.NaN,
        se: se,
        n,
        ci_lower: toNumberOrUndefined(cell.ci_lower ?? cell.ci_95_lower),
        ci_upper: toNumberOrUndefined(cell.ci_upper ?? cell.ci_95_upper),
        q1: toNumberOrUndefined(cell.q1),
        q3: toNumberOrUndefined(cell.q3),
        iqr: toNumberOrUndefined(cell.iqr),
      }
    })

    if (factorNames.length < 3 || cellMeans.length === 0) {
      // Not multifactorial (3+) or no data
      return createPlaceholderOutputFromInput('grouped_bar', input, options.title)
    }

    // Assign factor roles (x, series, facets)
    // Extract explicit factor role mapping from test result parameters
    const explicitMapping = normalizeFactorMapping(
      input.testResult?.parameters?.factor_role_mapping,
      factorNames
    )
    const roles = assignFactorRoles(factorNames, explicitMapping)

    const normalizeKey = (value: string): string => value.trim().toLowerCase()
    const factorAliasMap = new Map<string, string>()
    factorNames.forEach((name, index) => {
      const normalized = normalizeKey(name)
      factorAliasMap.set(normalized, name)
      factorAliasMap.set(`factor${index + 1}`, name)
      factorAliasMap.set(`factor_${index + 1}`, name)
    })
    const resolveFactorName = (value?: string | null): string | undefined => {
      if (!value) return undefined
      const normalized = normalizeKey(value)
      return factorAliasMap.get(normalized) ?? value.trim()
    }
    const adjustmentMethodRaw =
      (typeof (resultData as any)?.adjustment_method === 'string' &&
        (resultData as any)?.adjustment_method) ||
      (typeof (resultData as any)?.posthoc_adjustment === 'string' &&
        (resultData as any)?.posthoc_adjustment) ||
      ''
    const isFdrMethod = (value: unknown): boolean => {
      if (typeof value !== 'string') return false
      return /fdr|benjamini/i.test(value)
    }
    const defaultValueLabel: 'p' | 'q' = isFdrMethod(adjustmentMethodRaw) ? 'q' : 'p'
    const applyFdrThresholds = (qValue: number | null): void => {
      if (!Number.isFinite(qValue) || qValue === null || qValue <= 0 || qValue > 1) return
      const currentStar = bracketSettings.thresholds['*']
      if (!Number.isFinite(currentStar) || currentStar <= 0) return
      const appliedQ = (bracketSettings as { _fdrThresholdQ?: number })._fdrThresholdQ
      if (appliedQ === qValue) return

      const scale = qValue / currentStar
      const star = Math.min(Math.max(qValue, 0), 1)
      const two = Math.min(Math.max(bracketSettings.thresholds['**'] * scale, 0), star)
      const three = Math.min(Math.max(bracketSettings.thresholds['***'] * scale, 0), two)
      bracketSettings.thresholds = {
        '***': three,
        '**': two,
        '*': star,
      }
      ;(bracketSettings as { _fdrThresholdQ?: number })._fdrThresholdQ = qValue
    }
    const posthocQ = toNumber((resultData as any)?.posthoc_q ?? (resultData as any)?.posthocQ)
    if (isFdrMethod(adjustmentMethodRaw)) {
      applyFdrThresholds(posthocQ)
    }

    const parseSimpleEffectBrackets = (records: Record<string, unknown>[]): SimpleEffectBracket[] => {
      const brackets: SimpleEffectBracket[] = []
      const normalize = (value: string) => value.trim()
      const toNumber = (value: unknown): number | null => {
        if (typeof value === 'number') {
          return Number.isFinite(value) ? value : null
        }
        if (typeof value === 'string') {
          const parsed = Number(value)
          return Number.isFinite(parsed) ? parsed : null
        }
        return null
      }
      const parseGroups = (text: string): { group1?: string; group2?: string } => {
        const match =
          text.match(/(.+?)\s+vs\.?\s+(.+)/i) ?? text.match(/(.+?)\s+-\s+(.+)/)
        if (!match || !match[1] || !match[2]) return {}
        return { group1: match[1].trim(), group2: match[2].trim() }
      }
      const resolvePValueText = (record: Record<string, unknown>): string | undefined => {
        const candidates = [
          record.p_adjusted,
          record.pValueAdjusted,
          record.p_adj,
          record.p_value,
          record.pValue,
          record.p,
          record.p_value_formatted,
          record.pValueFormatted,
          record.p_formatted,
        ]
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim()
          }
          if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return String(candidate)
          }
        }
        return undefined
      }

      records.forEach((record) => {
        const comparisonText =
          (typeof record.comparison === 'string' && record.comparison) ||
          (typeof record.contrast === 'string' && record.contrast) ||
          (typeof record.label === 'string' && record.label) ||
          ''
        if (!comparisonText) return

        const comparisonSegments = comparisonText.split('|').map((part) => part.trim())
        const comparisonPart = comparisonSegments[0] ?? ''
        const scopePart =
          comparisonSegments.length > 1 ? comparisonSegments.slice(1).join('|').trim() : ''

        let group1 = typeof record.group1 === 'string' ? record.group1 : undefined
        let group2 = typeof record.group2 === 'string' ? record.group2 : undefined
        if (!group1 || !group2) {
          const parsed = parseGroups(comparisonPart)
          group1 = group1 ?? parsed.group1
          group2 = group2 ?? parsed.group2
        }
        if (!group1 || !group2) return

        const pValue =
          toNumber(record.p_adj ?? record.p_adjusted) ??
          toNumber(record.p_value ?? record.pValue) ??
          toNumber(record.p)
        if (pValue === null) return

        const pValueText = resolvePValueText(record)
        const sig =
          (typeof record.sig_stars === 'string' && record.sig_stars) ||
          (typeof record.sig === 'string' && record.sig) ||
          getBracketLabel(pValue, { ...bracketSettings, showNs: true })

        const factors: Record<string, string> = {}
        const rawFactors = record.factors
        if (rawFactors && typeof rawFactors === 'object' && !Array.isArray(rawFactors)) {
          Object.entries(rawFactors as Record<string, unknown>).forEach(([key, value]) => {
            if (value !== null && value !== undefined) {
              const resolvedKey = resolveFactorName(key) ?? key
              factors[resolvedKey] = String(value)
            }
          })
        }

        const scopeTokens = scopePart.split('|').map((part) => part.trim()).filter(Boolean)
        const comparedFactor = resolveFactorName(scopeTokens[0]) ?? scopeTokens[0]
        scopeTokens.slice(1).forEach((token) => {
          const [key, value] = token.split('=').map((part) => part.trim())
          if (key && value) {
            const resolvedKey = resolveFactorName(key) ?? key
            factors[resolvedKey] = value
          }
        })

        const withinFactorRaw =
          typeof record.within_factor === 'string'
            ? record.within_factor
            : typeof record.withinFactor === 'string'
              ? record.withinFactor
              : undefined
        const withinFactor = resolveFactorName(withinFactorRaw)
        const withinLevel =
          (typeof record.within_level === 'string' && record.within_level) ||
          (typeof record.withinLevel === 'string' && record.withinLevel)
        if (withinFactor && withinLevel) {
          factors[withinFactor] = String(withinLevel)
        }

        brackets.push({
          group1: normalize(group1),
          group2: normalize(group2),
          p_value: pValue,
          p_value_text: pValueText,
          sig,
          factors: Object.keys(factors).length > 0 ? factors : undefined,
          compared_factor: comparedFactor || undefined,
        })
      })

      return brackets
    }

    const simpleBrackets = Array.isArray((resultData.simple_effects as any)?.brackets)
      ? ((resultData.simple_effects as any)?.brackets as SimpleEffectBracket[])
      : Array.isArray(resultData.simple_effects)
        ? parseSimpleEffectBrackets(resultData.simple_effects as Record<string, unknown>[])
        : []

    // Get factor level orders (deterministic, alphabetical)
    const xLevels = getFactorLevelOrder(cellMeans, roles.x)
    const seriesLevels = getFactorLevelOrder(cellMeans, roles.series)

    // Build facet combinations
    const facetLevelLists = roles.facets.map((factor) => ({
      factor,
      levels: getFactorLevelOrder(cellMeans, factor),
    }))

    const facetCombinations = buildFacetCombinations(facetLevelLists)

    // Group brackets by subplot (facet filtering)
    const bracketsBySubplot = groupBracketsBySubplot(simpleBrackets, roles.facets)

    // Calculate subplot grid dimensions
    const numSubplots = facetCombinations.length
    const numCols = Math.ceil(Math.sqrt(numSubplots))
    const numRows = Math.ceil(numSubplots / numCols)

    // Create subplot traces
    const data: PlotBuilderOutput['data'] = []
    const annotations: any[] = []
    const allShapes: any[] = []
    const allBrackets: SignificanceBracket[] = []
    const bracketEffectMap: Record<string, { label: string; group: 'main' | 'simple'; significant?: boolean }> = {}
    const bracketEffectShapes: Record<string, string[]> = {}
    const bracketVisibility: Record<string, boolean> =
      (options as any)?.meta?.bracketVisibility ?? {}

    const bargap = typeof (options as any)?.bargap === 'number' ? (options as any).bargap : 0.6
    const bargroupgap =
      typeof (options as any)?.bargroupgap === 'number' ? (options as any).bargroupgap : 0.15
    const groupWidth = 1 - bargap
    const barWidth =
      seriesLevels.length > 0
        ? groupWidth / (seriesLevels.length + Math.max(0, seriesLevels.length - 1) * bargroupgap)
        : groupWidth
    const barStep = barWidth * (1 + bargroupgap)
    const seriesShiftByLevel = new Map<string, number>()
    seriesLevels.forEach((level, index) => {
      const shift = (index - (seriesLevels.length - 1) / 2) * barStep
      seriesShiftByLevel.set(level, shift)
    })

    // Aggregates for plot-level stats
    const aggregateMeans: number[] = []
    const aggregateSEs: number[] = []

    facetCombinations.forEach((facetLevels, subplotIdx) => {
      const subplotId = createSubplotId(facetLevels)
      const row = Math.floor(subplotIdx / numCols) + 1
      const col = (subplotIdx % numCols) + 1

      // Filter cell means for this subplot
      const subplotCells = cellMeans.filter((cell) =>
        facetLevels.every(({ factorName, level }) => String(cell.factors[factorName]) === level)
      )

      // Build grouped bars for this subplot
      const rangeValues: number[] = []
      seriesLevels.forEach((seriesLevel, seriesIdx) => {
        const means: number[] = []
        const errorBars: number[] = []

        xLevels.forEach((xLevel) => {
          // Find cell mean matching x + series + facets
          const cell = subplotCells.find(
            (c) =>
              String(c.factors[roles.x]) === xLevel &&
              String(c.factors[roles.series]) === seriesLevel
          )

          if (cell) {
            const mean = typeof cell.mean === 'number' ? cell.mean : parseFloat(String(cell.mean))
            if (!Number.isFinite(mean)) {
              means.push(null as any)
              errorBars.push(null as any)
              return
            }
            const n = cell.n
            if (!Number.isFinite(n) || n <= 0) {
              means.push(null as any)
              errorBars.push(null as any)
              return
            }
            const std = typeof cell.std === 'number' ? cell.std : parseFloat(String(cell.std))
            const rawSe =
              typeof cell.se === 'number'
                ? cell.se
                : Number.isFinite(std) && cell.n > 0
                  ? std / Math.sqrt(cell.n)
                  : 0
            const pooledSe =
              usePooledSe && Number.isFinite(n) && n > 0 && pooledMs !== null
                ? Math.sqrt(pooledMs / n)
                : null
            const se = Number.isFinite(pooledSe ?? rawSe) ? (pooledSe ?? rawSe) : 0
            const ciLower = Number(cell.ci_lower)
            const ciUpper = Number(cell.ci_upper)
            const q1 = Number(cell.q1)
            const q3 = Number(cell.q3)
            const iqr = Number(cell.iqr)

            means.push(mean)
            // Only include in aggregate stats if cell has actual data
            if (Number.isFinite(n) && n > 0) {
              aggregateMeans.push(mean)
            }

            // Calculate error bar
            let errorBar = 0
            if (errorBarType === 'se') errorBar = se
            else if (errorBarType === 'sd') errorBar = Number.isFinite(std) ? std : 0
            else if (errorBarType === 'ci') {
              if (Number.isFinite(ciLower) && Number.isFinite(ciUpper)) {
                errorBar = (ciUpper - ciLower) / 2
              } else {
                errorBar = 1.96 * se
              }
            } else if (errorBarType === 'iqr') {
              if (Number.isFinite(iqr)) {
                errorBar = iqr / 2
              } else if (Number.isFinite(q1) && Number.isFinite(q3)) {
                errorBar = (q3 - q1) / 2
              }
            }
            errorBars.push(errorBar)
            rangeValues.push(mean - errorBar, mean + errorBar)

            // Store stats for E2E validation
            const statKey = `${subplotId}_${seriesLevel}_${xLevel}`.toLowerCase().replace(/[^a-z0-9]+/g, '_')
            stats[`${statKey}_mean`] = mean
            stats[`${statKey}_se`] = se
            stats[`${statKey}_n`] = n
            // Only include in aggregate stats if cell has actual data
            if (Number.isFinite(se) && n > 0) {
              aggregateSEs.push(se)
            }
          } else {
            // No data for this combination; use null so Plotly skips it
            means.push(null as any)
            errorBars.push(null as any)
          }
        })

        // Create trace for this series in this subplot
        const trace: any = {
          type: 'bar',
          x: xLevels,
          y: means,
          name: seriesLevel,
          legendgroup: seriesLevel,
          marker: {
            color: getColor(seriesIdx),
            line: { color: '#000000', width: 1 },
          },
          showlegend: subplotIdx === 0, // Only show legend for first subplot
        }

        // Add error bars if not 'none'
        if (errorBarType !== 'none') {
          trace.error_y = {
            type: 'data',
            array: errorBars,
            visible: true,
            color: '#000000',
          }
        }

        data.push(trace)
      })

      // Add subplot title annotation
      const facetTitle = facetLevels.map(({ factorName, level }) => `${factorName}=${level}`).join(', ')
      const axisIdx = (row - 1) * numCols + col
      const xref = axisIdx === 1 ? 'x domain' : `x${axisIdx} domain`
      const yref = axisIdx === 1 ? 'y domain' : `y${axisIdx} domain`
      annotations.push({
        text: facetTitle,
        xref,
        yref,
        x: 0.5,
        y: 1.1,
        xanchor: 'center',
        yanchor: 'bottom',
        showarrow: false,
        font: { size: 12, weight: 700 },
      })

      // Add significance brackets (facet-filtered, simple effects only)
      if (bracketSettings.show) {
        const subplotBrackets = bracketsBySubplot.get(subplotId) ?? []
        const filteredBrackets = filterSimpleEffectBrackets(subplotBrackets, facetLevels)

        const xLevelSet = new Set(xLevels)
        const seriesLevelSet = new Set(seriesLevels)
        const categoryOrder = new Map<string, number>()
        xLevels.forEach((level, idx) => categoryOrder.set(level, idx))

        const positioned: SignificanceBracket[] = []
        filteredBrackets.forEach((bracket) => {
          const group1 = bracket.group1
          const group2 = bracket.group2
          if (!group1 || !group2) return
          const label = bracket.sig ?? getBracketLabel(bracket.p_value, { ...bracketSettings, showNs: true })
          if (!label && !bracketSettings.showNs) return

          const factors = bracket.factors ?? {}
          const comparedFactor = bracket.compared_factor
          const inX = xLevelSet.has(group1) && xLevelSet.has(group2)
          const inSeries = seriesLevelSet.has(group1) && seriesLevelSet.has(group2)

          if (inX && (!inSeries || comparedFactor === roles.x)) {
            const seriesLevel = factors[roles.series]
            if (!seriesLevel || !seriesShiftByLevel.has(seriesLevel)) return
            const shift = seriesShiftByLevel.get(seriesLevel) ?? 0
            positioned.push({
              group1,
              group2,
              group1Shift: shift,
              group2Shift: shift,
              pValue: bracket.p_value,
              pValueText: bracket.p_value_text,
              valueLabel: defaultValueLabel,
              effectId: `${subplotId}-${group1}-${group2}`,
              effectLabel: `${group1} vs ${group2}`,
              effectGroup: 'simple',
              label,
              height: 0,
            })
            return
          }

          if (inSeries && (!inX || comparedFactor === roles.series)) {
            const xLevel = factors[roles.x]
            if (!xLevel || !categoryOrder.has(xLevel)) return
            const shift1 = seriesShiftByLevel.get(group1)
            const shift2 = seriesShiftByLevel.get(group2)
            if (shift1 === undefined || shift2 === undefined) return
            positioned.push({
              group1: xLevel,
              group2: xLevel,
              group1Shift: shift1,
              group2Shift: shift2,
              pValue: bracket.p_value,
              pValueText: bracket.p_value_text,
              valueLabel: defaultValueLabel,
              effectId: `${subplotId}-${group1}-${group2}-${xLevel}`,
              effectLabel: `${group1} vs ${group2}`,
              effectGroup: 'simple',
              label,
              height: 0,
            })
          }
        })

        if (positioned.length > 0) {
          const stacked = stackBrackets(positioned, bracketSettings, categoryOrder)
          const yMax = Math.max(0, ...rangeValues)
          const yMin = Math.min(0, ...rangeValues)
          const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
          const adjusted = repelBracketLayout(stacked, bracketSettings, yMin, yMax)
          const labeled = adjusted
            .map((bracket) => ({ bracket, label: formatBracketLabel(bracket, bracketSettings) }))
            .filter((entry) => Boolean(entry.label))
          const axisSuffix = (row - 1) * numCols + col
          const axisId = axisSuffix === 1 ? '' : String(axisSuffix)
          // Pass data range for stable direction determination (prevents flipping when dragging near zero)
          const shapes = createBracketShapes(adjusted, bracketSettings, yMax, yScale, categoryOrder, { yMin, yMax })

          labeled.forEach(({ bracket, label }, index) => {
            const shape = shapes[index]
            if (!shape) return
            const shapeName = `sig_bracket_${subplotId}_${index}`
            const facetLabel = facetLevels.length > 0 ? `${facetTitle}` : ''
            const effectLabel = facetLabel
              ? `${bracket.effectLabel ?? `${bracket.group1} vs ${bracket.group2}`} | ${facetLabel}`
              : bracket.effectLabel ?? `${bracket.group1} vs ${bracket.group2}`
            const significant = Boolean(getBracketLabel(bracket.pValue, { ...bracketSettings, showNs: false }))
            const effectId = bracket.effectId ?? shapeName

            allShapes.push({
              ...shape,
              name: shapeName,
              xref: `x${axisId}`,
              yref: `y${axisId}`,
              label: {
                ...(shape as any).label,
                text: label,
              },
            })

            allBrackets.push({ ...bracket, label, effectId, effectLabel, effectGroup: 'simple' })
            if (!bracketEffectMap[effectId]) {
              bracketEffectMap[effectId] = {
                label: effectLabel,
                group: 'simple',
                significant,
              }
            } else if (significant) {
              bracketEffectMap[effectId] = {
                ...bracketEffectMap[effectId],
                significant: true,
              }
            }
            bracketEffectShapes[effectId] = [...(bracketEffectShapes[effectId] ?? []), shapeName]
          })
        }
      }
    })

    // Build subplot info for bracket catalog (enables dynamic bracket scaling)
    const subplotInfo: Record<string, { xref: string; yref: string; categoryOrder: Map<string, number> }> = {}
    facetCombinations.forEach((facetLevels, subplotIdx) => {
      const subplotId = createSubplotId(facetLevels)
      const row = Math.floor(subplotIdx / numCols) + 1
      const col = (subplotIdx % numCols) + 1
      const axisSuffix = (row - 1) * numCols + col
      const axisId = axisSuffix === 1 ? '' : String(axisSuffix)
      
      const categoryOrder = new Map<string, number>()
      xLevels.forEach((level, idx) => categoryOrder.set(level, idx))
      
      subplotInfo[subplotId] = {
        xref: `x${axisId}`,
        yref: `y${axisId}`,
        categoryOrder,
      }
    })

    // Build subplot layout
    const baseTitle = options.title || 'Multifactorial ANOVA'
    const displayTitle =
      useEMMeans && baseTitle.trim().toLowerCase() === 'cell means'
        ? 'LS Means (Estimated Marginal Means)'
        : baseTitle
    const yAxisTitle = useEMMeans ? 'Predicted Mean' : 'Mean'
    const layout: any = {
      ...createBaseLayout({ title: displayTitle, showLegend: true }),
      title: {
        text: displayTitle,
        y: 0.98,  // Position title above subplot facet labels (which are at y: 1.1)
        yanchor: 'top',
      },
      annotations,
      barmode: 'group',
      shapes: allShapes,
      bargap,
      bargroupgap,
      meta: {
        ...(options as any).meta,
        stats,
        errorBarType,
        meansType: useEMMeans ? 'lsmean' : 'cell_mean',
        bracketCatalog: { 
          brackets: allBrackets,
          subplotInfo,
          seriesLevels,
          xLevels,
          bargap,
          bargroupgap,
        },
        bracketEffectMap,
        bracketEffectShapes,
        bracketVisibility,
        bracketSettings,
      },
    }

    // Configure axes for each subplot
    // Reserve top 8% of paper for main title (subplots use 0-0.92 range)
    const subplotYRange = 0.92
    for (let row = 1; row <= numRows; row++) {
      for (let col = 1; col <= numCols; col++) {
        const axisIdx = (row - 1) * numCols + col
        const xKey = axisIdx === 1 ? 'xaxis' : `xaxis${axisIdx}`
        const yKey = axisIdx === 1 ? 'yaxis' : `yaxis${axisIdx}`
        const xStart = (col - 1) / numCols
        const xEnd = col / numCols
        const yStart = subplotYRange * (1 - row / numRows)
        const yEnd = subplotYRange * (1 - (row - 1) / numRows)

        layout[xKey] = {
          domain: [xStart, xEnd],
          anchor: yKey,
          title: row === numRows ? { text: roles.x, font: { weight: 700 } } : undefined,
          tickfont: { weight: 700 },
        }

        layout[yKey] = {
          domain: [yStart, yEnd],
          anchor: xKey,
          title: col === 1 ? { text: yAxisTitle, font: { weight: 700 } } : undefined,
          tickfont: { weight: 700 },
        }
      }
    }

    // E2E validation stats
    stats['factor_count'] = factorNames.length
    stats['subplot_count'] = numSubplots
    stats['x_factor'] = roles.x.toLowerCase().replace(/[^a-z0-9]+/g, '_') as any
    stats['series_factor'] = roles.series.toLowerCase().replace(/[^a-z0-9]+/g, '_') as any
    stats['facet_factor_count'] = roles.facets.length
    stats['error_bar_type'] = errorBarType === 'none' ? 0 : errorBarType === 'se' ? 1 : errorBarType === 'sd' ? 2 : errorBarType === 'ci' ? 3 : 4

    // Aggregate plot stats (for E2E validation against validation baseline)
    const allMeans = aggregateMeans.filter((m) => Number.isFinite(m))
    const allSEs = aggregateSEs.filter((se) => Number.isFinite(se))

    stats['n_facets'] = facetCombinations.length  // Number of facet panels
    stats['n_traces_per_facet'] = seriesLevels.length  // Series per facet (factor2 levels)
    stats['n_points_per_trace'] = xLevels.length  // Points per series (factor1 levels)
    stats['total_points'] = allMeans.length  // Only count real cells
    stats['overall_mean'] = allMeans.length > 0 ? allMeans.reduce((a, b) => a + b, 0) / allMeans.length : 0
    stats['mean_se'] = allSEs.length > 0 ? allSEs.reduce((a, b) => a + b, 0) / allSEs.length : 0
    stats['min_mean'] = allMeans.length > 0 ? Math.min(...allMeans) : 0
    stats['max_mean'] = allMeans.length > 0 ? Math.max(...allMeans) : 0

    return {
      data,
      layout,
      config: createDefaultConfig(),
      stats,
      dataPolicy: input.dataPolicy,
      samplingConfig: input.samplingConfig,
      aggregationConfig: input.aggregationConfig,
    }
  } catch (error) {
    console.error('facetedGroupedBarBuilder error:', error)
    return createPlaceholderOutputFromInput('grouped_bar', input, options.title)
  }
}

/**
 * Build all facet level combinations (Cartesian product)
 *
 * @example
 * buildFacetCombinations([
 *   {factor: "Temp", levels: ["Low", "High"]},
 *   {factor: "Age", levels: ["Young", "Old"]}
 * ])
 * // Returns: [
 * //   [{factorName: "Temp", level: "Low"}, {factorName: "Age", level: "Young"}],
 * //   [{factorName: "Temp", level: "Low"}, {factorName: "Age", level: "Old"}],
 * //   [{factorName: "Temp", level: "High"}, {factorName: "Age", level: "Young"}],
 * //   [{factorName: "Temp", level: "High"}, {factorName: "Age", level: "Old"}],
 * // ]
 */
function buildFacetCombinations(
  facetLevelLists: Array<{ factor: string; levels: string[] }>
): FacetLevel[][] {
  if (facetLevelLists.length === 0) {
    return [[]]
  }

  const [first, ...rest] = facetLevelLists
  if (!first) return [[]]
  const restCombinations = buildFacetCombinations(rest)

  const combinations: FacetLevel[][] = []
  for (const level of first.levels) {
    for (const restCombo of restCombinations) {
      combinations.push([{ factorName: first.factor, level }, ...restCombo])
    }
  }

  return combinations
}

export default facetedGroupedBarBuilder
