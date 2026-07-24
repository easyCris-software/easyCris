/**
 * Dialog Helper Functions
 *
 * Converts ColumnClassification data to dialog-specific prop types.
 * Bridges the gap between controller state and React dialog components.
 */

import type { ColumnClassification } from '@/lib/modules/core/types'
import { ColumnDataType } from '@/lib/modules/core/types'
import type { ColumnMetadata } from '@/components/dialogs/DependentVariableDialog'
import type { FactorMetadata } from '@/components/dialogs/FactorEncodingDialog'
import type { MultiFactorialFactorMetadata } from '@/components/dialogs/MultiFactorialEncodingDialog'
import { DependentVariableDialogMode } from '@/components/dialogs/DependentVariableDialog'

/**
 * Convert ColumnClassification to DependentVariableDialog ColumnMetadata
 */
export function toColumnMetadata(
  classifications: ColumnClassification[]
): ColumnMetadata[] {
  return classifications.map((col) => ({
    columnName: col.columnName,
    dataType: col.dataType,
    uniqueValueCount: col.uniqueValueCount,
    levels: col.uniqueValues, // Use uniqueValues array as levels
  }))
}

/**
 * Convert ColumnClassification to FactorMetadata (for factor encoding)
 */
export function toFactorMetadata(
  classifications: ColumnClassification[]
): FactorMetadata[] {
  return classifications
    .filter(
      (col) =>
        col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary
    )
    .map((col) => ({
      columnName: col.columnName,
      levels: col.uniqueValues,
    }))
}

/**
 * Convert ColumnClassification to MultiFactorialFactorMetadata
 */
export function toMultiFactorialMetadata(
  classifications: ColumnClassification[]
): MultiFactorialFactorMetadata[] {
  return classifications
    .filter(
      (col) =>
        col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary
    )
    .map((col) => ({
      columnName: col.columnName,
      levels: col.uniqueValues,
    }))
}

/**
 * Normalize test name for comparison (handle both IDs and display names)
 * Converts underscores/dashes to spaces for consistent matching
 */
function normalizeTestName(name: string): string {
  return name.toLowerCase().replace(/[_-]+/g, ' ').trim()
}

/**
 * Determine dependent variable dialog mode from test types
 *
 * @param testNames - Array of selected test names (can be IDs or display names)
 * @returns Appropriate dialog mode
 */
export function getDVDialogMode(testNames: string[]): DependentVariableDialogMode {
  const hasLinearRegression = testNames.some((t) => {
    const normalized = normalizeTestName(t)
    return normalized.includes('linear regression')
  })
  const hasBinaryLogistic = testNames.some((t) => {
    const normalized = normalizeTestName(t)
    return (
      normalized.includes('binary logistic') ||
      (normalized.includes('logistic regression') && !normalized.includes('multinomial'))
    )
  })
  const hasMultinomialLogistic = testNames.some((t) =>
    normalizeTestName(t).includes('multinomial')
  )
  const hasANOVA = testNames.some((t) => {
    const normalized = normalizeTestName(t)
    return (
      normalized.includes('anova') ||
      normalized.includes('friedman') ||
      normalized.includes('scheirer')
    )
  })

  // Determine mode based on test types
  if (hasLinearRegression && (hasBinaryLogistic || hasMultinomialLogistic)) {
    return DependentVariableDialogMode.RegressionMixedOutcome
  } else if (hasLinearRegression) {
    return DependentVariableDialogMode.RegressionNumericOutcome
  } else if (hasBinaryLogistic || hasMultinomialLogistic) {
    return DependentVariableDialogMode.RegressionCategoricalOutcome
  } else if (hasANOVA) {
    return DependentVariableDialogMode.AnovaOrFriedman
  } else {
    // Default to ANOVA mode
    return DependentVariableDialogMode.AnovaOrFriedman
  }
}

/**
 * Determine if DV encoding dialog should use binary or multinomial mode
 *
 * @param classification - The DV column classification
 * @returns 'binary' if 2 unique values, 'multinomial' otherwise
 */
export function getDVEncodingType(
  classification: ColumnClassification | undefined
): 'binary' | 'multinomial' {
  if (!classification) return 'binary'
  return classification.uniqueValueCount === 2 ? 'binary' : 'multinomial'
}

/**
 * Extract categorical levels from a column classification
 *
 * @param classification - Column classification
 * @returns Array of level names
 */
export function extractLevels(classification: ColumnClassification | undefined): string[] {
  if (!classification) return []
  return classification.uniqueValues
}

/**
 * Determine if simple effects should be shown (for 2-way ANOVA)
 *
 * @param testNames - Array of selected test names
 * @returns True if test is 2-way ANOVA
 */
export function shouldShowSimpleEffects(testNames: string[]): boolean {
  return testNames.some(test => {
    const normalized = test.toLowerCase().replace(/[_-]+/g, ' ')
    return (
      normalized.includes('two way') ||
      normalized.includes('scheirer') ||
      normalized.includes('multi factorial') ||
      normalized.includes('multifactorial')
    )
  })
}
