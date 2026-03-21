/**
 * Payload Extraction and Data Series Utilities
 *
 * Functions for extracting plot data from TestResult payloads
 */

import type { TestResult } from '@/store/results-store'
import { normalizeTestId, toNumber, toNumberArray } from './normalize'

export type PlotPayload = {
  test?: string
  data?: Record<string, unknown>
  parameters?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

/**
 * Extract result data from TestResult, handling nested structure
 */
export function getResultData(result: TestResult): Record<string, unknown> {
  const rawOutput = result.rawOutput
  if (rawOutput && typeof rawOutput === 'object') {
    const rawObject = rawOutput as Record<string, unknown>
    const nested = rawObject.results
    if (nested && typeof nested === 'object') {
      return nested as Record<string, unknown>
    }
    return rawObject
  }
  return result as unknown as Record<string, unknown>
}

/**
 * Extract plot payload from TestResult
 */
export function getPlotPayload(result: TestResult): PlotPayload | null {
  const payload = (result as { plotPayload?: PlotPayload }).plotPayload
  if (payload && typeof payload === 'object') {
    return payload
  }
  return null
}

/**
 * Calculate pairwise differences between two arrays
 */
export function calculateDifferences(group1: unknown, group2: unknown): number[] {
  const g1 = toNumberArray(group1)
  const g2 = toNumberArray(group2)
  const len = Math.min(g1.length, g2.length)
  const diffs: number[] = []
  for (let i = 0; i < len; i++) {
    const v1 = g1[i]
    const v2 = g2[i]
    if (v1 !== undefined && v2 !== undefined) {
      diffs.push(v1 - v2)
    }
  }
  return diffs
}

/**
 * Resolve the primary independent t-test p-value based on recommended method.
 */
export function resolveIndependentTTestPrimaryPValue(
  resultData: Record<string, unknown>
): { pValue: number | null; method: 'pooled' | 'welch' | 'unknown' } {
  const pooledP = toNumber(resultData.pooled_p)
  const welchP = toNumber(resultData.welch_p)
  const equalVariances = resultData.equal_variances
  const equalVarAssumed = resultData.equal_variance_assumed
  const testMethod = resultData.test_method
  const recommendedMethod = resultData.recommended_method

  let method: 'pooled' | 'welch' | 'unknown' = 'unknown'
  if (typeof recommendedMethod === 'string') {
    const normalized = recommendedMethod.toLowerCase()
    method = normalized.includes('welch') ? 'welch' : 'pooled'
  } else if (typeof testMethod === 'string') {
    const normalized = testMethod.toLowerCase()
    method = normalized.includes('welch') ? 'welch' : 'pooled'
  } else if (typeof equalVariances === 'boolean') {
    method = equalVariances ? 'pooled' : 'welch'
  } else if (typeof equalVarAssumed === 'boolean') {
    method = equalVarAssumed ? 'pooled' : 'welch'
  }

  const pValue =
    method === 'welch'
      ? welchP ?? pooledP ?? toNumber(resultData.p_value)
      : method === 'pooled'
        ? pooledP ?? welchP ?? toNumber(resultData.p_value)
        : toNumber(resultData.p_value) ?? pooledP ?? welchP

  return { pValue, method }
}

/**
 * Flatten groups array into y-values and group labels
 */
export function flattenGroupsWithLabels(
  groups: unknown[][],
  labels: string[]
): { yValues: number[]; groupValues: string[] } {
  const yValues: number[] = []
  const groupValues: string[] = []
  groups.forEach((group, index) => {
    const label = labels[index] ?? `Group ${index + 1}`
    for (const value of group) {
      const numeric = toNumber(value)
      if (numeric !== null) {
        yValues.push(numeric)
        groupValues.push(label)
      }
    }
  })
  return { yValues, groupValues }
}

/**
 * Resolve value label from payload metadata
 */
export function resolveValueLabel(payload: PlotPayload | null, fallback: string): string {
  const data = payload?.data ?? {}
  const metadata = payload?.metadata ?? {}
  const candidates = [
    metadata.variable_name,
    data.value_name,
    data.dependent_name,
    data.value_column,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }
  return fallback
}

/**
 * Resolve group label from payload metadata
 */
export function resolveGroupLabel(payload: PlotPayload | null, fallback: string): string {
  const data = payload?.data ?? {}
  const metadata = payload?.metadata ?? {}
  const candidates = [metadata.grouping_variable, data.grouping_variable, data.group_column]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }
  return fallback
}

/**
 * Resolve group names from payload
 */
export function resolveGroupNames(payload: PlotPayload | null, count: number): string[] {
  const data = payload?.data ?? {}
  const parameters = payload?.parameters ?? {}
  const fromData = Array.isArray(data.group_names) ? data.group_names.map((name) => String(name)) : []
  const fromDataLabels = Array.isArray(data.group_labels)
    ? data.group_labels.map((name) => String(name))
    : []
  const fromParams = Array.isArray(parameters.group_labels)
    ? parameters.group_labels.map((name) => String(name))
    : []

  const names =
    fromData.length >= count
      ? fromData
      : fromDataLabels.length >= count
        ? fromDataLabels
        : fromParams.length >= count
          ? fromParams
          : []
  if (names.length >= count) {
    return names.slice(0, count)
  }
  return Array.from({ length: count }, (_, index) => `Group ${index + 1}`)
}

/**
 * Build plot series for single-column tests (descriptive/normality/outliers).
 */
export function buildSingleColumnSeries(
  result: TestResult
): { yValues: number[]; yLabel: string } | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null
  const data = payload.data
  const values = toNumberArray(data.values)
  if (values.length === 0) return null

  const directLabel =
    typeof data.variable_name === 'string' && data.variable_name.trim()
      ? data.variable_name
      : null

  return {
    yValues: values,
    yLabel: directLabel ?? resolveValueLabel(payload, 'Value'),
  }
}

/**
 * Build plot series data from payload based on test type
 */
export function buildPayloadSeries(
  result: TestResult
): { yValues: number[]; groupValues?: string[]; yLabel: string; groupLabel?: string } | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null
  const data = payload.data
  const normalizedTestId = normalizeTestId(result.testId)

  if (normalizedTestId === 't_test_two_sample' || normalizedTestId === 'mann_whitney_u') {
    const group1 = toNumberArray(data.group1 ?? data.data1)
    const group2 = toNumberArray(data.group2 ?? data.data2)
    if (group1.length === 0 && group2.length === 0) return null

    const group1Name =
      (typeof data.group1_name === 'string' && data.group1_name) ||
      (typeof data.group_name1 === 'string' && data.group_name1) ||
      'Group 1'
    const group2Name =
      (typeof data.group2_name === 'string' && data.group2_name) ||
      (typeof data.group_name2 === 'string' && data.group_name2) ||
      'Group 2'

    const yValues = [...group1, ...group2]
    const groupValues = [
      ...Array(group1.length).fill(group1Name),
      ...Array(group2.length).fill(group2Name),
    ]

    return {
      yValues,
      groupValues,
      yLabel: resolveValueLabel(payload, 'Value'),
      groupLabel: resolveGroupLabel(payload, 'Group'),
    }
  }

  if (normalizedTestId === 't_test_paired' || normalizedTestId === 'wilcoxon_signed_rank') {
    const diffs = calculateDifferences(data.group1, data.group2)
    if (diffs.length === 0) return null
    const group1Name = typeof data.group1_name === 'string' ? data.group1_name : 'Group 1'
    const group2Name = typeof data.group2_name === 'string' ? data.group2_name : 'Group 2'
    const diffLabel = `${group1Name} - ${group2Name}`
    return {
      yValues: diffs,
      yLabel: diffLabel || 'Difference',
    }
  }

  if (normalizedTestId === 't_test_one_sample') {
    const values = toNumberArray(data.values)
    if (values.length === 0) return null
    return {
      yValues: values,
      yLabel: resolveValueLabel(payload, 'Value'),
    }
  }

  if (normalizedTestId === 'anova_one_way' || normalizedTestId === 'kruskal_wallis') {
    const groups = Array.isArray(data.groups) ? (data.groups as unknown[][]) : []
    if (groups.length === 0) return null
    const labels = resolveGroupNames(payload, groups.length)
    const { yValues, groupValues } = flattenGroupsWithLabels(groups, labels)
    if (yValues.length === 0) return null
    return {
      yValues,
      groupValues,
      yLabel: resolveValueLabel(payload, 'Value'),
      groupLabel: resolveGroupLabel(payload, 'Group'),
    }
  }

  const singleColumnTests = new Set([
    'descriptive_stats',
    'outlier_detection',
    'normality_shapiro',
    'normality_ks',
    'normality_ad',
    'normality_cvm',
    'normality_jb',
    'normality_all',
    'normality_tests',
  ])
  if (singleColumnTests.has(normalizedTestId)) {
    return buildSingleColumnSeries(result)
  }

  return null
}
