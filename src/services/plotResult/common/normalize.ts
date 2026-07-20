/**
 * Normalization and Type Conversion Utilities
 * 
 * Stateless helper functions for normalizing test IDs, mapping families/types,
 * and converting values to expected types.
 */

import type { PlotType, StatisticalFamily } from '@/config/plotRegistry'

/**
 * Map test family to PlotRegistry family category
 */
export function mapFamily(family: string): Exclude<StatisticalFamily, 'user_derived'> {
  switch (family) {
    case 'parametric':
    case 'nonparametric':
      return 'hypothesis'
    case 'correlation':
    case 'regression':
      return 'regression'
    case 'distribution':
    case 'descriptive':
      return 'descriptive'
    case 'categorical':
      return 'categorical'
    case 'survival':
      return 'survival'
    case 'pharmacology':
      return 'pharmacology'
    case 'mediation':
    case 'moderation':
      return 'mediation'
    default:
      return 'hypothesis'
  }
}

/**
 * Map Plotly trace type to PlotRegistry plot type
 */
export function mapPlotlyType(plotlyType: string | undefined, plotlyMode?: string): PlotType {
  switch (plotlyType) {
    case 'scatter':
      if (plotlyMode?.includes('lines') && !plotlyMode.includes('markers')) {
        return 'line'
      }
      return 'scatter'
    case 'scattergl':
      return 'scattergl'
    case 'bar':
      return 'bar'
    case 'box':
      return 'box'
    case 'histogram':
      return 'histogram'
    case 'pie':
      return 'pie'
    case 'violin':
      return 'violin'
    case 'heatmap':
      return 'heatmap'
    case 'histogram2d':
    case 'histogram2dcontour':
    case 'contour':
      return 'heatmap'
    default:
      return 'scatter'
  }
}

/**
 * Normalize test ID from various formats to canonical form
 */
export function normalizeTestId(testId: string): string {
  switch (testId) {
    case 'independent_ttest':
      return 't_test_two_sample'
    case 'paired_ttest':
      return 't_test_paired'
    case 'one_sample_ttest':
      return 't_test_one_sample'
    case 'one_way_anova':
      return 'anova_one_way'
    case 'two_way_anova':
      return 'anova_two_way'
    case 'mann_whitney':
      return 'mann_whitney_u'
    case 'wilcoxon':
      return 'wilcoxon_signed_rank'
    case 'chi_square':
      return 'chi_squared'
    case 'fishers_exact':
      return 'fisher_exact'
    case 'cox_regression':
      return 'cox_proportional_hazards'
    case 'logistic_regression':
      return 'logistic_binary'
    case 'lmm_anova_stratified':
      return 'lmm_anova'
    default:
      return testId
  }
}

/**
 * Convert unknown value to number (null if invalid)
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Convert array of unknown values to number array
 */
export function toNumberArray(values: unknown): number[] {
  if (!Array.isArray(values)) return []
  return values
    .map((value) => toNumber(value))
    .filter((value): value is number => value !== null)
}

function normalInv(p: number): number {
  if (p <= 0 || p >= 1) return NaN

  const a = [
    -39.69683028665376,
    220.9460984245205,
    -275.9285104469687,
    138.3577518672690,
    -30.66479806614716,
    2.506628277459239,
  ] as const
  const b = [
    -54.47609879822406,
    161.5858368580409,
    -155.6989798598866,
    66.80131188771972,
    -13.28068155288572,
  ] as const
  const c = [
    -0.007784894002430293,
    -0.3223964580411365,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ] as const
  const d = [
    0.007784695709041462,
    0.3224671290700398,
    2.445134137142996,
    3.754408661907416,
  ] as const

  const [a0, a1, a2, a3, a4, a5] = a
  const [b0, b1, b2, b3, b4] = b
  const [c0, c1, c2, c3, c4, c5] = c
  const [d0, d1, d2, d3] = d

  const plow = 0.02425
  const phigh = 1 - plow
  let q: number
  let r: number

  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    )
  }

  if (phigh < p) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    )
  }

  q = p - 0.5
  r = q * q
  return (
    (((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  )
}

export function tCriticalFromDf(df: number, alpha: number): number {
  if (!Number.isFinite(df) || df <= 0) return 1.96
  const p = 1 - alpha / 2
  const z = normalInv(p)
  if (!Number.isFinite(z)) return 1.96

  const z2 = z * z
  const z3 = z2 * z
  const z5 = z3 * z2
  const z7 = z5 * z2
  const dfInv = 1 / df
  const dfInv2 = dfInv * dfInv
  const dfInv3 = dfInv2 * dfInv

  return (
    z +
    (z3 + z) * dfInv / 4 +
    (5 * z5 + 16 * z3 + 3 * z) * dfInv2 / 96 +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) * dfInv3 / 384
  )
}

/**
 * Parse comma/semicolon-separated string into label array
 */
export function parseLabelList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item))
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    const separator = trimmed.includes(';') ? ';' : ','
    return trimmed
      .split(separator)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}
