/**
 * Test Data Factories
 *
 * Provides reusable factories for generating test data:
 * - ColumnClassification objects
 * - Regression data rows
 * - Survival data rows
 * - Arrays of classifications
 *
 * All factories use deterministic seeded RNG for reproducible tests.
 */

import { ColumnDataType, type ColumnClassification } from '@/lib/modules/core/types'

/**
 * Seeded random number generator (LCG algorithm)
 * Ensures deterministic test data across all runs
 */
const seededRandom = (seed: number) => {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

/**
 * Factory for ColumnClassification objects
 *
 * @param overrides - Partial ColumnClassification to override defaults
 * @returns Complete ColumnClassification object
 */
export function makeColumnClassification(
  overrides: Partial<ColumnClassification> = {}
): ColumnClassification {
  const defaults = {
    columnIndex: 0,
    columnName: 'TestColumn',
    dataType: ColumnDataType.Numeric,
    totalValues: 100,
    numericValues: 100,
    categoricalValues: 0,
    missingValues: 0,
    uniqueValueCount: 10,
    isBinary: false,
    isOrdinal: false,
    hasMissingData: false,
    numericRatio: 1.0,
    allIntegerValues: false,
    uniqueValues: [],
    suggestedTests: [],
  }

  return {
    ...defaults,
    ...overrides,
  }
}

/**
 * Factory for regression data rows
 *
 * Generates synthetic regression data with configurable characteristics.
 *
 * @param n - Number of rows to generate
 * @param config - Configuration for data generation
 * @param seed - RNG seed for deterministic generation (default: 42)
 * @returns 2D array of regression data
 *
 * @example
 * // Binary logistic with 2 predictors
 * const rows = makeRegressionRows(100, {
 *   dv: 'binary',
 *   dvLevels: ['Control', 'Treatment'],
 *   predictors: [
 *     { type: 'numeric' },
 *     { type: 'categorical', levels: ['Low', 'Medium', 'High'] }
 *   ],
 *   missingRate: 0.05
 * })
 */
export function makeRegressionRows(
  n: number,
  config: {
    dv: 'numeric' | 'binary' | 'categorical'
    dvLevels?: string[]
    predictors: Array<{ type: 'numeric' | 'categorical'; levels?: string[] }>
    missingRate?: number // 0-1, fraction of rows with missing data
  },
  seed = 42
): any[][] {
  const random = seededRandom(seed)
  const rows: any[][] = []
  const missingRate = config.missingRate ?? 0

  for (let i = 0; i < n; i++) {
    const row: any[] = []

    // Dependent variable
    if (random() < missingRate) {
      row.push(null) // Missing DV
    } else {
      if (config.dv === 'numeric') {
        row.push(random() * 100)
      } else if (config.dv === 'binary') {
        const levels = config.dvLevels ?? ['No', 'Yes']
        row.push(levels[Math.floor(random() * 2)]!)
      } else {
        const levels = config.dvLevels ?? ['A', 'B', 'C']
        row.push(levels[Math.floor(random() * levels.length)]!)
      }
    }

    // Predictors
    for (const pred of config.predictors) {
      if (random() < missingRate) {
        row.push(null)
      } else {
        if (pred.type === 'numeric') {
          row.push(random() * 100)
        } else {
          const levels = pred.levels ?? ['Control', 'High', 'Low']
          row.push(levels[Math.floor(random() * levels.length)]!)
        }
      }
    }

    rows.push(row)
  }

  return rows
}

/**
 * Factory for survival data rows
 *
 * Generates synthetic survival analysis data.
 *
 * @param n - Number of rows to generate
 * @param config - Configuration for data generation
 * @param seed - RNG seed for deterministic generation (default: 42)
 * @returns 2D array of survival data
 *
 * @example
 * // Kaplan-Meier with groups
 * const rows = makeSurvivalRows(100, {
 *   eventRate: 0.6,
 *   groupLevels: ['Control', 'Treatment'],
 *   missingRate: 0.05
 * })
 *
 * @example
 * // Cox regression with numeric and categorical covariates
 * const rows = makeSurvivalRows(100, {
 *   eventRate: 0.5,
 *   covariates: [
 *     { type: 'numeric' }, // Age
 *     { type: 'categorical', levels: ['Stage1', 'Stage2', 'Stage3'] }
 *   ]
 * })
 */
export function makeSurvivalRows(
  n: number,
  config: {
    eventRate?: number // 0-1, fraction that experienced event
    groupLevels?: string[]
    covariates?: Array<{ type: 'numeric' | 'categorical'; levels?: string[] }>
    missingRate?: number
  },
  seed = 42
): any[][] {
  const random = seededRandom(seed)
  const rows: any[][] = []
  const eventRate = config.eventRate ?? 0.5
  const missingRate = config.missingRate ?? 0

  for (let i = 0; i < n; i++) {
    const row: any[] = []

    // Time
    if (random() < missingRate) {
      row.push(null)
    } else {
      row.push(random() * 1000) // 0-1000 time units
    }

    // Event
    if (random() < missingRate) {
      row.push(null)
    } else {
      row.push(random() < eventRate ? 1 : 0)
    }

    // Optional group
    if (config.groupLevels) {
      if (random() < missingRate) {
        row.push(null)
      } else {
        row.push(config.groupLevels[Math.floor(random() * config.groupLevels.length)]!)
      }
    }

    // Optional covariates
    if (config.covariates) {
      for (const cov of config.covariates) {
        if (random() < missingRate) {
          row.push(null)
        } else {
          if (cov.type === 'numeric') {
            row.push(random() * 100)
          } else {
            const levels = cov.levels ?? ['A', 'B', 'C']
            row.push(levels[Math.floor(random() * levels.length)]!)
          }
        }
      }
    }

    rows.push(row)
  }

  return rows
}

/**
 * Factory for ColumnClassification arrays
 *
 * Generates arrays of ColumnClassification objects with specified types.
 *
 * @param configs - Array of column configurations
 * @returns Array of ColumnClassification objects
 *
 * @example
 * const classifications = makeClassifications([
 *   { name: 'Age', type: ColumnDataType.Numeric },
 *   { name: 'Treatment', type: ColumnDataType.Categorical, uniqueCount: 3 },
 *   { name: 'Outcome', type: ColumnDataType.Binary, binary: true }
 * ])
 */
export function makeClassifications(
  configs: Array<{
    name: string
    type: ColumnDataType
    binary?: boolean
    ordinal?: boolean
    uniqueCount?: number
    totalValues?: number
    missingValues?: number
  }>
): ColumnClassification[] {
  return configs.map(cfg =>
    makeColumnClassification({
      columnName: cfg.name,
      dataType: cfg.type,
      isBinary: cfg.binary ?? false,
      isOrdinal: cfg.ordinal ?? false,
      uniqueValueCount: cfg.uniqueCount ?? 10,
      totalValues: cfg.totalValues ?? 100,
      missingValues: cfg.missingValues ?? 0,
      hasMissingData: (cfg.missingValues ?? 0) > 0,
    })
  )
}

/**
 * Helper to create balanced categorical data
 *
 * Ensures equal representation of each level.
 *
 * @param n - Total number of values
 * @param levels - Categorical levels
 * @param seed - RNG seed
 * @returns Array of categorical values
 *
 * @example
 * const treatment = makeBalancedCategorical(100, ['Control', 'Drug'])
 * // Returns ~50 'Control', ~50 'Drug'
 */
export function makeBalancedCategorical(
  n: number,
  levels: string[],
  seed = 42
): string[] {
  const random = seededRandom(seed)
  const result: string[] = []
  const perLevel = Math.floor(n / levels.length)

  for (const level of levels) {
    for (let i = 0; i < perLevel; i++) {
      result.push(level)
    }
  }

  // Fill remaining slots
  while (result.length < n) {
    result.push(levels[Math.floor(random() * levels.length)]!)
  }

  // Shuffle
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }

  return result
}

/**
 * Helper to create imbalanced categorical data
 *
 * Creates data with specified proportions for each level.
 *
 * @param n - Total number of values
 * @param levelProportions - Map of level → proportion (0-1)
 * @param seed - RNG seed
 * @returns Array of categorical values
 *
 * @example
 * // 80% Control, 20% Drug
 * const treatment = makeImbalancedCategorical(100, {
 *   'Control': 0.8,
 *   'Drug': 0.2
 * })
 */
export function makeImbalancedCategorical(
  n: number,
  levelProportions: Record<string, number>,
  seed = 42
): string[] {
  const random = seededRandom(seed)
  const result: string[] = []

  for (const [level, proportion] of Object.entries(levelProportions)) {
    const count = Math.floor(n * proportion)
    for (let i = 0; i < count; i++) {
      result.push(level)
    }
  }

  // Fill any remaining slots with random levels
  const levels = Object.keys(levelProportions)
  while (result.length < n) {
    result.push(levels[Math.floor(random() * levels.length)]!)
  }

  // Shuffle
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }

  return result
}
