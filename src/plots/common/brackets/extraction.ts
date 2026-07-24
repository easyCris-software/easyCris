/**
 * Bracket Extraction Module - Group 1 Plots Feature
 *
 * Extracts significance brackets from test results for rendering.
 * Supports various post-hoc test formats (pairwise, simple effects, etc.)
 */

import type { TestResult } from '@/store/results-store'
import type { BracketSettings, SignificanceBracket } from '@/utils/plotBuilders/types'
import { getBracketLabel } from '@/utils/plotBuilders/types'

/**
 * Helper: Convert unknown value to number or null
 */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function applyFdrThresholds(settings: BracketSettings, qValue: number): void {
  if (!Number.isFinite(qValue) || qValue <= 0 || qValue > 1) return
  const currentStar = settings.thresholds['*']
  if (!Number.isFinite(currentStar) || currentStar <= 0) return
  const appliedQ = (settings as { _fdrThresholdQ?: number })._fdrThresholdQ
  if (appliedQ === qValue) return

  const scale = qValue / currentStar
  const star = Math.min(Math.max(qValue, 0), 1)
  const two = Math.min(Math.max(settings.thresholds['**'] * scale, 0), star)
  const three = Math.min(Math.max(settings.thresholds['***'] * scale, 0), two)
  settings.thresholds = {
    '***': three,
    '**': two,
    '*': star,
  }
  ;(settings as { _fdrThresholdQ?: number })._fdrThresholdQ = qValue
}

/**
 * Helper: Get result data from TestResult
 */
function getResultData(result: TestResult): Record<string, unknown> {
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
 * Extract significance brackets from post-hoc test results
 * Converts TestResult.postHoc array to SignificanceBracket format
 * Used for simple bar plots (One-Way ANOVA). Grouped bars use their own logic.
 *
 * @param result Test result containing post-hoc comparisons
 * @param settings Bracket rendering settings
 * @returns Array of significance brackets
 */
export function extractPostHocBrackets(
  result: TestResult,
  settings: BracketSettings
): SignificanceBracket[] {
  const resultData = getResultData(result)
  const rawComparisons: Record<string, unknown>[] = []

  // Collect comparisons from various sources
  if (Array.isArray(result.postHoc)) {
    rawComparisons.push(...(result.postHoc as Record<string, unknown>[]))
  } else if (Array.isArray(resultData.pairwise_comparisons)) {
    rawComparisons.push(...(resultData.pairwise_comparisons as Record<string, unknown>[]))
  }

  // Add main effects post-hoc tests (Two-Way ANOVA)
  if (resultData.post_hoc_main_effects && typeof resultData.post_hoc_main_effects === 'object') {
    Object.values(resultData.post_hoc_main_effects as Record<string, unknown>).forEach((value) => {
      if (Array.isArray(value)) {
        rawComparisons.push(...(value as Record<string, unknown>[]))
      }
    })
  }

  // Add simple effects (Two-Way ANOVA, Scheirer-Ray-Hare)
  if (Array.isArray(resultData.simple_effects)) {
    rawComparisons.push(...(resultData.simple_effects as Record<string, unknown>[]))
  }

  if (rawComparisons.length === 0) {
    return []
  }

  const brackets: SignificanceBracket[] = []
  const seenPairs = new Set<string>()
  const adjustmentMethodRaw =
    (typeof resultData.adjustment_method === 'string' && resultData.adjustment_method) ||
    (typeof (resultData as Record<string, unknown>).method === 'string' &&
      (resultData as Record<string, unknown>).method) ||
    ''

  const isFdrMethod = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    return /fdr|benjamini/i.test(value)
  }
  const posthocQ = toNumber(
    resultData.posthoc_q ?? (resultData as Record<string, unknown>).posthocQ
  )
  if (isFdrMethod(adjustmentMethodRaw) && posthocQ !== null) {
    applyFdrThresholds(settings, posthocQ)
  }
  const defaultValueLabel: 'p' | 'q' = isFdrMethod(adjustmentMethodRaw) ? 'q' : 'p'

  // Helpers for consistent pair matching
  const normalizeKey = (value: string): string =>
    value.trim().toLowerCase().replace(/\s+/g, ' ')

  const buildPairKey = (group1: string, group2: string): string => {
    const left = normalizeKey(group1)
    const right = normalizeKey(group2)
    return left <= right ? `${left}||${right}` : `${right}||${left}`
  }

  // Helper: Resolve p-value text from various field names
  const resolvePValueText = (record: Record<string, unknown>): string | undefined => {
    const candidates = [
      record.p_adjusted,
      record.pValueAdjusted,
      record.p_adj,
      record.p_value,
      record.pValue,
      record.p,
      record.p_raw,
      record.pRaw,
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

  // Extract brackets from comparisons
  for (const comparison of rawComparisons) {
    const comparisonRecord = comparison as Record<string, unknown>

    // Get comparison label
    const comparisonText =
      (typeof comparisonRecord.comparison === 'string' && comparisonRecord.comparison) ||
      (typeof comparisonRecord.contrast === 'string' && comparisonRecord.contrast) ||
      (typeof comparisonRecord.label === 'string' && comparisonRecord.label) ||
      ''

    // Extract group names
    let group1 =
      typeof comparisonRecord.group1 === 'string' ? comparisonRecord.group1 : undefined
    let group2 =
      typeof comparisonRecord.group2 === 'string' ? comparisonRecord.group2 : undefined

    // Fallback: Parse from comparison text
    if (!group1 || !group2) {
      const match =
        comparisonText.match(/(.+?)\s+vs\.?\s+(.+)/i) ??
        comparisonText.match(/(.+?)\s+-\s+(.+)/)
      if (match && match[1] && match[2]) {
        group1 = match[1].trim()
        group2 = match[2].trim()
      }
    }

    if (!group1 || !group2) continue

    // Extract p-value
    const pValue =
      toNumber(comparisonRecord.p_adjusted ?? comparisonRecord.pValueAdjusted) ??
      toNumber(comparisonRecord.p_value ?? comparisonRecord.pValue) ??
      toNumber(comparisonRecord.p)

    if (pValue === null) continue
    const pValueText = resolvePValueText(comparisonRecord)
    const recordMethod =
      comparisonRecord.method ?? comparisonRecord.adjustment_method ?? adjustmentMethodRaw
    const valueLabel: 'p' | 'q' = isFdrMethod(recordMethod) ? 'q' : defaultValueLabel

    // Generate label (stars or p-value)
    const bracketSettingsWithNs = { ...settings, showNs: true }
    const label = getBracketLabel(pValue, bracketSettingsWithNs)

    // Deduplicate pairs
    const pairKey = buildPairKey(group1, group2)
    if (seenPairs.has(pairKey)) continue
    seenPairs.add(pairKey)

    const effectLabel = comparisonText || `${group1} vs ${group2}`

    brackets.push({
      group1,
      group2,
      pValue,
      pValueText,
      valueLabel,
      effectId: pairKey,
      effectLabel,
      effectGroup: 'main',
      label,
      height: 0,
    })
  }

  return brackets
}
