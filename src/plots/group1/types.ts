/**
 * Group 1 (Hypothesis Testing) Plot Types
 *
 * Shared type definitions for parametric and nonparametric tests.
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file is part of the Group 1 E2E validation suite (655 metrics).
 * All types are validated against validation baseline. Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { TestResult } from '@/store/results-store'
import type { BracketSettings } from '@/utils/plotBuilders/types'

/**
 * Options for grouped bar plots with brackets
 */
export interface GroupedBarOptions {
  /** Error bar type: 'se' (standard error), 'sd', 'ci', 'iqr', or 'none' */
  errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'

  /** Bracket rendering settings */
  bracketSettings?: BracketSettings

  /** Whether to show jitter points */
  showJitter?: boolean

  /** Plot title */
  title?: string
}

/**
 * Cell summary data (from Python backend)
 */
export interface CellSummary {
  /** Factor values keyed by factor name */
  [factorName: string]: string | number | undefined

  /** Mean value */
  mean?: number

  /** Median value */
  median?: number

  /** Standard deviation */
  std?: number

  /** Standard error */
  se?: number

  /** Sample size */
  n?: number

  /** First quartile */
  q1?: number

  /** Third quartile */
  q3?: number

  /** Interquartile range */
  iqr?: number
}

/**
 * Grouped bar plot builder function signature
 */
export type GroupedBarBuilder = (
  result: TestResult,
  options: GroupedBarOptions
) => Promise<unknown> | unknown
