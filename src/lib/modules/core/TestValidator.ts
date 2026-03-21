/**
 * Test Validator
 *
 * Shared validation helpers for statistical test modules.
 * Ported from Avalonia TestValidator.cs
 *
 * Phase 2: Core Infrastructure
 * - Reusable validation logic across all modules
 * - Consistent error messages and suggestions
 * - Reduces code duplication in individual modules
 */

import type { ColumnClassification, TestValidationResult } from './types'
import { ColumnDataType } from './types'

/**
 * Validation Helpers
 *
 * Collection of reusable validation functions that can be composed
 * in individual test modules.
 */
export class TestValidator {
  /**
   * Check if the correct number of columns are selected
   *
   * @param columns - Classified columns
   * @param expected - Expected number of columns
   * @param testName - Name of the test (for error messages)
   * @returns Validation result (error if count doesn't match)
   */
  static checkColumnCount(
    columns: ColumnClassification[],
    expected: number,
    testName: string
  ): TestValidationResult | null {
    if (columns.length !== expected) {
      return {
        isValid: false,
        errors: [`${testName} requires exactly ${expected} column${expected === 1 ? '' : 's'}. ${columns.length} selected.`],
        warnings: [],
        suggestions: [
          expected === 1
            ? 'Select a single column'
            : `Select ${expected} columns for comparison`,
        ],
      }
    }
    return null // Validation passed
  }

  /**
   * Check if columns are within a range
   *
   * @param columns - Classified columns
   * @param min - Minimum number of columns
   * @param max - Maximum number of columns
   * @param testName - Name of the test (for error messages)
   * @returns Validation result (error if count out of range)
   */
  static checkColumnCountRange(
    columns: ColumnClassification[],
    min: number,
    max: number,
    testName: string
  ): TestValidationResult | null {
    if (columns.length < min || columns.length > max) {
      return {
        isValid: false,
        errors: [
          `${testName} requires between ${min} and ${max} columns. ${columns.length} selected.`,
        ],
        warnings: [],
        suggestions: [`Select between ${min} and ${max} columns`],
      }
    }
    return null // Validation passed
  }

  /**
   * Check if all columns are numeric (not categorical/binary)
   *
   * @param columns - Classified columns
   * @param testName - Name of the test (for error messages)
   * @returns Validation result (error if any column is not numeric)
   */
  static checkAllNumeric(
    columns: ColumnClassification[],
    testName: string,
    options?: { allowBinary?: boolean }
  ): TestValidationResult | null {
    const allowBinary = options?.allowBinary === true

    for (const col of columns) {
      if (col.isConstant) {
        return {
          isValid: false,
          errors: [
            `Column '${col.columnName}' has no variation (constant values). ${testName} requires variable data.`,
          ],
          warnings: [],
          suggestions: ['Select a column with at least two distinct numeric values'],
        }
      }

      if (
        col.dataType === ColumnDataType.Categorical ||
        col.dataType === ColumnDataType.Mixed ||
        (!allowBinary && col.dataType === ColumnDataType.Binary)
      ) {
        const typeLabel =
          col.dataType === ColumnDataType.Binary
            ? 'binary'
            : col.dataType === ColumnDataType.Mixed
              ? 'mixed'
              : 'categorical'
        return {
          isValid: false,
          errors: [
            `Column '${col.columnName}' contains ${typeLabel} data. ${testName} requires numeric data.`,
          ],
          warnings: [],
          suggestions: [
            'Use Chi-Square Test for categorical data',
            'Use Mann-Whitney U Test for ordinal data',
          ],
        }
      }

      if (col.dataType === ColumnDataType.Empty) {
        return {
          isValid: false,
          errors: [`Column '${col.columnName}' is empty.`],
          warnings: [],
          suggestions: ['Select a different column with data'],
        }
      }
    }
    return null // Validation passed
  }

  /**
   * Check if all columns are categorical/binary/ordinal (not continuous numeric)
   *
   * @param columns - Classified columns
   * @param testName - Name of the test (for error messages)
   * @returns Validation result (error if any column is continuous numeric)
   */
  static checkAllCategorical(
    columns: ColumnClassification[],
    testName: string
  ): TestValidationResult | null {
    for (const col of columns) {
      if (col.dataType === ColumnDataType.Mixed) {
        return {
          isValid: false,
          errors: [
            `Column '${col.columnName}' has mixed data types. ${testName} requires categorical data.`,
          ],
          warnings: [],
          suggestions: [
            'Clean or recode mixed values into consistent categories',
            'Use numeric tests only after converting values to numeric',
          ],
        }
      }

      if (col.dataType === ColumnDataType.Numeric && !col.isOrdinal) {
        return {
          isValid: false,
          errors: [
            `Column '${col.columnName}' contains continuous numeric data. ${testName} requires categorical data.`,
          ],
          warnings: [],
          suggestions: [
            'Use Correlation Analysis for numeric data',
            'Consider binning numeric data into categories if appropriate',
          ],
        }
      }

      if (col.dataType === ColumnDataType.Empty) {
        return {
          isValid: false,
          errors: [`Column '${col.columnName}' is empty.`],
          warnings: [],
          suggestions: ['Select a different column'],
        }
      }
    }
    return null // Validation passed
  }

  /**
   * Check if all columns have sufficient unique values (categories)
   *
   * @param columns - Classified columns
   * @param minCategories - Minimum number of unique values required
   * @param testName - Name of the test (for error messages)
   * @returns Validation result (error if any column has insufficient categories)
   */
  static checkMinCategories(
    columns: ColumnClassification[],
    minCategories: number,
    testName: string
  ): TestValidationResult | null {
    for (const col of columns) {
      if (col.uniqueValueCount < minCategories) {
        return {
          isValid: false,
          errors: [
            `Column '${col.columnName}' has only ${col.uniqueValueCount} unique value${col.uniqueValueCount === 1 ? '' : 's'}. ${testName} requires at least ${minCategories}.`,
          ],
          warnings: [],
          suggestions: [
            `Ensure each column has at least ${minCategories} distinct values`,
          ],
        }
      }
    }
    return null // Validation passed
  }

  /**
   * Check for ordinal data and return appropriate warnings
   *
   * @param columns - Classified columns
   * @param testName - Name of the test
   * @param preferNonparametric - Whether to suggest nonparametric alternative
   * @returns Validation result with warnings (not errors)
   */
  static checkOrdinalWarning(
    columns: ColumnClassification[],
    testName: string,
    preferNonparametric: boolean = true
  ): TestValidationResult | null {
    const hasOrdinal = columns.some(col => col.isOrdinal)

    if (hasOrdinal && preferNonparametric) {
      return {
        isValid: true, // Still allow test to run
        errors: [],
        warnings: [
          `One or more columns appear to be ordinal (Likert scale). ${testName} assumes continuous interval/ratio data.`,
        ],
        suggestions: ['Consider using Mann-Whitney U Test for ordinal data'],
      }
    }

    return null // No warnings
  }

  /**
   * Warn on high tie ratios in ordinal data (rank-based correlations).
   *
   * @param columns - Classified columns
   * @param testName - Name of the test
   * @param options - Thresholds and message tuning
   * @returns Validation result with warnings (not errors)
   */
  static checkOrdinalTieWarning(
    columns: ColumnClassification[],
    testName: string,
    options?: {
      tieRatioThreshold?: number
      lowUniqueThreshold?: number
      lowUniqueMinN?: number
      includeBinary?: boolean
      suggestKendall?: boolean
    }
  ): TestValidationResult | null {
    const tieRatioThreshold = options?.tieRatioThreshold ?? 0.5
    const lowUniqueThreshold = options?.lowUniqueThreshold ?? 5
    const lowUniqueMinN = options?.lowUniqueMinN ?? 30
    const includeBinary = options?.includeBinary === true
    const suggestKendall = options?.suggestKendall !== false

    const warnings: string[] = []
    const suggestions: string[] = []

    for (const col of columns) {
      const isOrdinal = col.isOrdinal || col.dataType === ColumnDataType.Ordinal
      if (!isOrdinal) continue

      const nonMissingByTypeCounts = Math.max(0, (col.numericValues ?? 0) + (col.categoricalValues ?? 0))
      const nUsed = nonMissingByTypeCounts > 0
        ? nonMissingByTypeCounts
        : Math.max(0, col.totalValues - col.missingValues)
      if (nUsed === 0) continue

      const unique = col.uniqueValueCount
      const isBinary = col.isBinary || unique === 2

      if (unique <= 1) {
        warnings.push(
          `Column '${col.columnName}' has only ${unique} unique value. ${testName} may be unreliable with near-constant ordinal data.`
        )
        suggestions.push('Choose an ordinal column with more variation')
        continue
      }

      if (isBinary && !includeBinary) {
        continue
      }

      const tieRatio = 1 - unique / nUsed
      const tooManyTies = tieRatio > tieRatioThreshold
      const tooFewLevels = unique <= lowUniqueThreshold && nUsed >= lowUniqueMinN

      if (tooManyTies || tooFewLevels) {
        const percent = Math.round(tieRatio * 100)
        const suffix = suggestKendall
          ? "Consider Kendall's tau-b for better tie handling, or verify ordinal encoding is appropriate."
          : 'Verify ordinal encoding is appropriate.'
        warnings.push(
          `Column '${col.columnName}' has a high proportion of tied values (~${percent}%). ${suffix}`
        )
        if (suggestKendall) {
          suggestions.push("Consider Kendall's tau-b for better tie handling")
        }
        suggestions.push('Verify ordinal encoding is appropriate')
      }
    }

    if (warnings.length === 0) {
      return null
    }

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  }

  /**
   * Check for 2×2 contingency tables (suggest Fisher's Exact Test)
   *
   * @param columns - Classified columns (should be 2 categorical columns)
   * @returns Validation result with warning for 2×2 tables
   */
  static checkFisherExactSuggestion(
    columns: ColumnClassification[]
  ): TestValidationResult | null {
    if (
      columns.length === 2 &&
      columns[0]!.uniqueValueCount === 2 &&
      columns[1]!.uniqueValueCount === 2
    ) {
      return {
        isValid: true, // Still allow Chi-Square
        errors: [],
        warnings: [
          "For 2×2 contingency tables, Fisher's Exact Test is more accurate.",
        ],
        suggestions: ["Consider using Fisher's Exact Test instead"],
      }
    }

    return null // Not a 2×2 table
  }

  /**
   * Check if columns match long-format pattern (1 numeric + 1 categorical)
   * Used for ANOVA and Kruskal-Wallis tests
   *
   * Long format: One numeric column (values) + One categorical column (group labels)
   * Example:
   *   Score | Treatment
   *   ------+----------
   *     5.2 | Control
   *     6.1 | Drug A
   *     7.3 | Drug B
   *
   * @param columns - Classified columns (should be exactly 2)
   * @returns Object with isLongFormat flag and indices, or null if not long format
   */
  static detectLongFormat(
    columns: ColumnClassification[]
  ): {
    isLongFormat: boolean
    numericIndex: number
    categoricalIndex: number
    groupCount: number
    warning?: string
  } | null {
    // Must be exactly 2 columns
    if (columns.length !== 2) {
      return null
    }

    const col0 = columns[0]!
    const col1 = columns[1]!

    // Check for 1 numeric + 1 categorical pattern
    const col0IsNumeric =
      col0.dataType === ColumnDataType.Numeric ||
      col0.dataType === ColumnDataType.Ordinal
    const col1IsNumeric =
      col1.dataType === ColumnDataType.Numeric ||
      col1.dataType === ColumnDataType.Ordinal
    const col0IsCategorical =
      col0.dataType === ColumnDataType.Categorical ||
      col0.dataType === ColumnDataType.Binary
    const col1IsCategorical =
      col1.dataType === ColumnDataType.Categorical ||
      col1.dataType === ColumnDataType.Binary

    // Pattern 1: col0 numeric, col1 categorical
    if (col0IsNumeric && col1IsCategorical) {
      const groupCount = col1.uniqueValueCount

      // Warn about high cardinality (> 50 groups)
      const warning =
        groupCount > 50
          ? `High cardinality factor: ${groupCount} groups detected. Consider whether this is intentional.`
          : undefined

      return {
        isLongFormat: true,
        numericIndex: 0,
        categoricalIndex: 1,
        groupCount,
        warning,
      }
    }

    // Pattern 2: col0 categorical, col1 numeric
    if (col0IsCategorical && col1IsNumeric) {
      const groupCount = col0.uniqueValueCount

      const warning =
        groupCount > 50
          ? `High cardinality factor: ${groupCount} groups detected. Consider whether this is intentional.`
          : undefined

      return {
        isLongFormat: true,
        numericIndex: 1,
        categoricalIndex: 0,
        groupCount,
        warning,
      }
    }

    // Not long format
    return null
  }

  /**
   * Combine multiple validation results
   *
   * Returns the first error result, or combines all warnings if no errors.
   *
   * @param results - Array of validation results (null means passed)
   * @returns Combined validation result
   */
  static combineResults(
    results: Array<TestValidationResult | null>
  ): TestValidationResult {
    // Filter out null (passed validations)
    const validResults = results.filter((r): r is TestValidationResult => r !== null)

    if (validResults.length === 0) {
      // All validations passed
      return {
        isValid: true,
        errors: [],
        warnings: [],
        suggestions: [],
      }
    }

    // Find first error (if any)
    const errorResult = validResults.find(r => !r.isValid)
    if (errorResult) {
      return errorResult
    }

    // Combine all warnings (no errors, but some warnings)
    const allWarnings = validResults.flatMap(r => r.warnings)
    const allSuggestions = validResults.flatMap(r => r.suggestions)

    return {
      isValid: true,
      errors: [],
      warnings: [...new Set(allWarnings)], // Remove duplicates
      suggestions: [...new Set(allSuggestions)], // Remove duplicates
    }
  }
}
