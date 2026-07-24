/**
 * Data Transform Service - Arquero Integration
 *
 * Provides pivot (wider/longer) and filter operations using Arquero.
 * Group, sort, and add column operations use existing app logic.
 */

import * as aq from 'arquero'
import type { ColumnTable } from 'arquero'
import { computePivotIdColumns } from '@/utils/transformSchema'
import { isMissingValue } from '@/services/columnDataService'

export interface PivotWiderConfig {
  /** Column ID to spread into new columns */
  namesFrom: string  // columnId
  /** Column ID(s) to use as values */
  valuesFrom: string[]  // always array of columnIds
  /** Optional aggregation function if multiple values per cell */
  aggregation?: 'mean' | 'sum' | 'first' | 'last' | 'count' | 'list'
  /** Keep original names/value columns as list columns */
  keepOriginalColumns?: boolean
  /** Use per-group row index when no id columns are present */
  useRowIndex?: boolean
}

export interface PivotRuntimeOptions {
  signal?: AbortSignal
  onProgress?: (percent: number) => void
  yieldEvery?: number
  cacheKey?: string
}

export interface PivotLongerConfig {
  /** Columns to gather into long format */
  cols: string[]
  /** Name for the new column containing former column names */
  namesTo: string
  /** Name for the new column containing values */
  valuesTo: string
}

export interface FilterCondition {
  columnId: string  // Use column ID, not name
  operator:
    | 'eq'
    | 'ne'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'isEmpty'
    | 'isNotEmpty'
    | 'regex'
  value: string | number
  /** If true, string comparisons (eq/ne/contains/startsWith/endsWith) are case-sensitive */
  caseSensitive?: boolean
}

export interface FilterGroup {
  op: 'AND' | 'OR'
  conditions: FilterCondition[]
}

export interface FilterConfig {
  groups: FilterGroup[]
  /** Operator between groups. Defaults to 'AND' for backward compatibility */
  groupOperator?: 'AND' | 'OR'
}

export type AggregationFunction =
  | 'sum'
  | 'avg'
  | 'count'
  | 'min'
  | 'max'
  | 'median'
  | 'stdev'
  | 'none'

export interface GroupAggregateConfig {
  groupByColumns: string[]
  aggregations: Record<string, AggregationFunction>
}

const VALID_AGGREGATION_FUNCTIONS = new Set<AggregationFunction>([
  'sum',
  'avg',
  'count',
  'min',
  'max',
  'median',
  'stdev',
  'none',
])

type PreparedFilterCondition = FilterCondition & {
  operator: FilterCondition['operator']
  compiledRegex?: RegExp
}

type PreparedFilterGroup = {
  op: 'AND' | 'OR'
  conditions: PreparedFilterCondition[]
}

export class DataTransformService {
  private static readonly MAX_PIVOT_COLUMNS = 1000
  private static readonly MAX_PIVOT_CACHE_ENTRIES = 8
  private static pivotCache = new Map<string, Record<string, any>[]>()
  /**
   * Convert plain data array to Arquero table
   */
  static fromArray(data: Record<string, any>[]): ColumnTable {
    return aq.from(data)
  }

  /**
   * Convert Arquero table back to plain array
   */
  static toArray(table: ColumnTable): Record<string, any>[] {
    return table.objects()
  }

  /**
   * Pivot wider: Spread a key-value pair across columns
   *
   * Example:
   *   Input:  { drugId: 'A', concId: '1uM', viabilityId: 95 }
   *   Output: { drugId: 'A', '1uM_viability': 95, '10uM_viability': 85, ... }
   */
  static pivotWider(
    data: Record<string, any>[],
    config: PivotWiderConfig,
    options: PivotRuntimeOptions = {}
  ): Record<string, any>[] {
    const cached = DataTransformService.getPivotCache(options.cacheKey)
    if (cached) {
      return cached
    }
    const shouldStripRowIndex = DataTransformService.shouldInjectRowIndex(data, config)
    const dataForPivot = DataTransformService.preparePivotData(data, config)
    const normalizedConfig = DataTransformService.normalizePivotWiderConfig(dataForPivot, config)
    DataTransformService.assertPivotColumnLimit(dataForPivot, normalizedConfig)
    const table = this.fromArray(dataForPivot)

    const idCols = DataTransformService.getPivotIdCols(dataForPivot, normalizedConfig)
    const keepOriginalColumns = normalizedConfig.keepOriginalColumns ?? false
    const originalColumnsByKey = keepOriginalColumns
      ? this.collectOriginalColumns(table, idCols, normalizedConfig)
      : null

    const hasDuplicates = !normalizedConfig.aggregation
      ? DataTransformService.hasDuplicatePivotKeys(dataForPivot, normalizedConfig, { preprocessed: true })
      : false
    let aggregation = normalizedConfig.aggregation ?? (hasDuplicates ? 'list' : undefined)

    let processedTable = table

    if (aggregation === 'first' || aggregation === 'last') {
      const reducedRows = DataTransformService.reducePivotFirstLastRows(
        dataForPivot,
        normalizedConfig,
        idCols,
        aggregation
      )
      processedTable = this.fromArray(reducedRows)
      aggregation = undefined
    } else if (aggregation) {
      const aggOpFor = (valueCol: string) => {
        switch (aggregation) {
          case 'mean': return aq.op.mean(valueCol)
          case 'sum': return aq.op.sum(valueCol)
          case 'count': return aq.op.count()
          case 'first': return aq.op.any(valueCol)
          case 'last': return aq.op.any(valueCol)
          case 'list': return aq.op.array_agg(valueCol)
          default: return aq.op.mean(valueCol)
        }
      }

      const rollupSpec: Record<string, any> = {}
      for (const valueCol of normalizedConfig.valuesFrom) {
        rollupSpec[valueCol] = aggOpFor(valueCol)
      }

      processedTable = table
        .groupby(...idCols, normalizedConfig.namesFrom)
        .rollup(rollupSpec)
    }

    const pivotBase = idCols.length > 0 ? processedTable.groupby(...idCols) : processedTable
    const pivoted = pivotBase.pivot(normalizedConfig.namesFrom, normalizedConfig.valuesFrom, {
      valueSeparator: '__',
    })
    const results = this.toArray(pivoted)
    const finalize = (rows: Record<string, any>[]) => {
      const finalRows = DataTransformService.stripPivotRowIndex(rows, shouldStripRowIndex)
      if (options.cacheKey) {
        DataTransformService.setPivotCache(options.cacheKey, finalRows)
      }
      return finalRows
    }
    if (!originalColumnsByKey) {
      return finalize(results)
    }

    const merged = results.map((row) => {
      const rowKey = this.buildRowKey(row, idCols)
      const originals = originalColumnsByKey.get(rowKey)
      return originals ? { ...DataTransformService.renameOriginalColumns(row, originals), ...row } : row
    })
    return finalize(merged)
  }

  static async pivotWiderStreaming(
    data: Record<string, any>[],
    config: PivotWiderConfig,
    options: PivotRuntimeOptions = {}
  ): Promise<Record<string, any>[]> {
    let lastProgress = -1
    const reportProgress = (percent: number) => {
      if (!options.onProgress) return
      const next = Math.max(lastProgress, Math.min(100, Math.floor(percent)))
      if (next === lastProgress) return
      lastProgress = next
      options.onProgress(next)
    }
    const cached = DataTransformService.getPivotCache(options.cacheKey)
    if (cached) {
      reportProgress(100)
      return cached
    }
    DataTransformService.throwIfAborted(options.signal)
    const shouldStripRowIndex = DataTransformService.shouldInjectRowIndex(data, config)
    const dataForPivot = DataTransformService.preparePivotData(data, config)
    const normalizedConfig = DataTransformService.normalizePivotWiderConfig(dataForPivot, config)
    DataTransformService.assertPivotColumnLimit(dataForPivot, normalizedConfig)

    const idCols = DataTransformService.getPivotIdCols(dataForPivot, normalizedConfig)
    const keepOriginalColumns = normalizedConfig.keepOriginalColumns ?? false
    const originalColumnsByKey = keepOriginalColumns
      ? this.collectOriginalColumns(this.fromArray(dataForPivot), idCols, normalizedConfig)
      : null

    const hasDuplicates = !normalizedConfig.aggregation
      ? DataTransformService.hasDuplicatePivotKeys(dataForPivot, normalizedConfig, { preprocessed: true })
      : false
    const aggregation = normalizedConfig.aggregation ?? (hasDuplicates ? 'list' : undefined)
    const needsValuePrefix = normalizedConfig.valuesFrom.length > 1
    const valueSeparator = '__'

    const resultsByKey = new Map<string, Record<string, any>>()
    const meanStateByKey =
      aggregation === 'mean'
        ? new Map<string, Map<string, { sum: number; count: number }>>()
        : null

    const total = dataForPivot.length
    const defaultYieldEvery =
      total < 50_000 ? 5_000 : total < 100_000 ? 10_000 : 20_000
    const yieldEvery = Math.max(1, options.yieldEvery ?? defaultYieldEvery)

    for (let i = 0; i < total; i += 1) {
      if (i % yieldEvery === 0) {
        DataTransformService.throwIfAborted(options.signal)
        reportProgress(Math.min(99, (i / Math.max(1, total)) * 100))
        await DataTransformService.yieldToMain()
      }

      const row = dataForPivot[i]
      if (!row) continue

      const rowKey = this.buildRowKey(row, idCols)
      let out = resultsByKey.get(rowKey)
      if (!out) {
        out = {}
        for (const idCol of idCols) {
          out[idCol] = row[idCol]
        }
        resultsByKey.set(rowKey, out)
      }

      const pivotKeyValue = row[normalizedConfig.namesFrom]
      const pivotKey = pivotKeyValue === null || pivotKeyValue === undefined ? '' : String(pivotKeyValue)

      for (const valueCol of normalizedConfig.valuesFrom) {
        const value = row[valueCol]
        const outKey = needsValuePrefix ? `${valueCol}${valueSeparator}${pivotKey}` : pivotKey

        switch (aggregation) {
          case 'sum': {
            const n = DataTransformService.toNumber(value)
            if (!Number.isFinite(n)) break
            const current = typeof out[outKey] === 'number' ? out[outKey] : 0
            out[outKey] = current + n
            break
          }
          case 'count': {
            const current = typeof out[outKey] === 'number' ? out[outKey] : 0
            out[outKey] = current + 1
            break
          }
          case 'first': {
            if (!Object.prototype.hasOwnProperty.call(out, outKey)) {
              out[outKey] = value
            }
            break
          }
          case 'last': {
            out[outKey] = value
            break
          }
          case 'list': {
            const existing = out[outKey]
            if (Array.isArray(existing)) {
              existing.push(value)
            } else if (existing === undefined) {
              out[outKey] = [value]
            } else {
              out[outKey] = [existing, value]
            }
            break
          }
          case 'mean': {
            const n = DataTransformService.toNumber(value)
            if (!Number.isFinite(n)) break
            let perRow = meanStateByKey?.get(rowKey)
            if (!perRow) {
              perRow = new Map()
              meanStateByKey?.set(rowKey, perRow)
            }
            const state = perRow.get(outKey) ?? { sum: 0, count: 0 }
            state.sum += n
            state.count += 1
            perRow.set(outKey, state)
            break
          }
          default: {
            if (value === null || value === undefined) break
            const current = out[outKey]
            if (current === null || current === undefined) {
              out[outKey] = value
            }
          }
        }
      }
    }

    if (aggregation === 'mean' && meanStateByKey) {
      reportProgress(95)
      DataTransformService.throwIfAborted(options.signal)
      const meanYieldEvery = Math.max(1000, Math.floor(yieldEvery / 2))
      let meanIndex = 0
      for (const [rowKey, perRow] of meanStateByKey.entries()) {
        if (meanIndex % meanYieldEvery === 0) {
          DataTransformService.throwIfAborted(options.signal)
          await DataTransformService.yieldToMain()
        }
        const out = resultsByKey.get(rowKey)
        if (!out) continue
        for (const [outKey, state] of perRow.entries()) {
          out[outKey] = state.count > 0 ? state.sum / state.count : null
        }
        meanIndex += 1
      }
    }

    reportProgress(100)

    const results = Array.from(resultsByKey.values())
    const finalize = (rows: Record<string, any>[]) => {
      const finalRows = DataTransformService.stripPivotRowIndex(rows, shouldStripRowIndex)
      if (options.cacheKey) {
        DataTransformService.setPivotCache(options.cacheKey, finalRows)
      }
      return finalRows
    }
    if (!originalColumnsByKey) {
      return finalize(results)
    }

    const merged = results.map((row) => {
      const rowKey = this.buildRowKey(row, idCols)
      const originals = originalColumnsByKey.get(rowKey)
      return originals ? { ...DataTransformService.renameOriginalColumns(row, originals), ...row } : row
    })
    return finalize(merged)
  }

  /**
   * Pivot longer: Gather multiple columns into key-value pairs
   *
   * Example:
   *   Input:  { drug: 'A', '1uM': 95, '10uM': 85 }
   *   Output: { drug: 'A', conc: '1uM', viability: 95 }
   */
  static pivotLonger(
    data: Record<string, any>[],
    config: PivotLongerConfig
  ): Record<string, any>[] {
    const namesTo = config.namesTo.trim()
    const valuesTo = config.valuesTo.trim()
    if (!namesTo || !valuesTo) {
      throw new Error('Pivot longer output column names are required.')
    }
    if (namesTo === valuesTo) {
      throw new Error('Pivot longer requires different names for "names to" and "values to".')
    }

    const availableColumns = DataTransformService.getAvailableColumnIds(data)
    const missingCols = config.cols.filter((col) => !availableColumns.has(col))
    if (missingCols.length > 0) {
      throw new Error(`Missing pivot longer column(s): ${missingCols.join(', ')}`)
    }
    if (config.cols.length === 0) {
      throw new Error('No selected columns were found in the dataset.')
    }
    const table = this.fromArray(data)

    const folded = table.fold(config.cols, {
      as: [namesTo, valuesTo]
    })

    return this.toArray(folded)
  }

  /**
   * Filter rows based on grouped conditions (AND/OR logic)
   */
  static filter(
    data: Record<string, any>[],
    config: FilterConfig
  ): Record<string, any>[] {
    const table = this.fromArray(data)
    const availableColumns = DataTransformService.getAvailableColumnIds(data)
    const prepared = DataTransformService.prepareFilterConfig(config, availableColumns)

    const filtered = table.filter(aq.escape((d: any) => {
      // Evaluate each group
      const groupResults = prepared.groups.map((group) => {
        // Within a group, evaluate all conditions
        const conditionResults = group.conditions.map((cond) => {
          return DataTransformService.evaluateCondition(d, cond)
        })

        // Combine conditions within group based on group operator
        if (group.op === 'AND') {
          return conditionResults.every((r) => r)
        } else {
          // OR
          return conditionResults.some((r) => r)
        }
      })

      // Combine groups based on top-level group operator
      if (prepared.groupOperator === 'AND') {
        return groupResults.every((r) => r)
      } else {
        return groupResults.some((r) => r)
      }
    }))

    return this.toArray(filtered)
  }

  /**
   * Count how many rows would match a filter config (for preview)
   */
  static countFilterMatches(
    data: Record<string, any>[],
    config: FilterConfig
  ): number {
    const availableColumns = DataTransformService.getAvailableColumnIds(data)
    const prepared = DataTransformService.prepareFilterConfig(config, availableColumns)

    let count = 0
    for (const row of data) {
      const groupResults = prepared.groups.map((group) => {
        const conditionResults = group.conditions.map((cond) => {
          return DataTransformService.evaluateCondition(row, cond)
        })
        if (group.op === 'AND') {
          return conditionResults.every((r) => r)
        } else {
          return conditionResults.some((r) => r)
        }
      })

      const matches = prepared.groupOperator === 'AND'
        ? groupResults.every((r) => r)
        : groupResults.some((r) => r)

      if (matches) count++
    }
    return count
  }

  /**
   * Group & Aggregate: Group data by columns and apply aggregation functions
   *
   * Example:
   *   Input:  [{ category: 'A', value: 10 }, { category: 'A', value: 20 }, { category: 'B', value: 30 }]
   *   Config: { groupByColumns: ['category'], aggregations: { value: 'sum' } }
   *   Output: [{ category: 'A', value: 30 }, { category: 'B', value: 30 }]
   */
  static groupAggregate(
    data: Record<string, any>[],
    config: GroupAggregateConfig
  ): Record<string, any>[] {
    if (data.length === 0) {
      return []
    }

    if (config.groupByColumns.length === 0) {
      throw new Error('At least one group-by column is required')
    }

    const availableColumns = DataTransformService.getAvailableColumnIds(data)
    const missingGroups = config.groupByColumns.filter((col) => !availableColumns.has(col))
    if (missingGroups.length > 0) {
      throw new Error(`Missing group-by column(s): ${missingGroups.join(', ')}`)
    }

    const table = this.fromArray(data)

    // Build rollup operations for each aggregation
    const rollupSpec: Record<string, any> = {}
    const groupBySet = new Set(config.groupByColumns)
    const missingAggregations: string[] = []
    const invalidAggregations: string[] = []
    const invalidNumericAggregations: string[] = []
    const numericCompatibility = new Map<string, boolean>()

    const supportsNumericAggregation = (columnId: string): boolean => {
      const cached = numericCompatibility.get(columnId)
      if (cached !== undefined) return cached
      let sawNonBlank = false
      for (const row of data) {
        const value = row[columnId]
        if (DataTransformService.isBlank(value)) continue
        sawNonBlank = true
        if (DataTransformService.tryParseNumber(value) === null) {
          numericCompatibility.set(columnId, false)
          return false
        }
      }
      const result = sawNonBlank ? true : true
      numericCompatibility.set(columnId, result)
      return result
    }

    Object.entries(config.aggregations).forEach(([columnId, aggregation]) => {
      if (!VALID_AGGREGATION_FUNCTIONS.has(aggregation as AggregationFunction)) {
        invalidAggregations.push(`${columnId} (${String(aggregation)})`)
        return
      }
      if (groupBySet.has(columnId)) {
        return
      }
      if (aggregation !== 'none' && !availableColumns.has(columnId)) {
        missingAggregations.push(columnId)
        return
      }
      const requiresNumeric =
        aggregation === 'sum' ||
        aggregation === 'avg' ||
        aggregation === 'median' ||
        aggregation === 'stdev'
      if (requiresNumeric && !supportsNumericAggregation(columnId)) {
        invalidNumericAggregations.push(`${columnId} (${aggregation})`)
        return
      }
      switch (aggregation) {
        case 'sum':
          rollupSpec[columnId] = aq.op.sum(columnId)
          break
        case 'avg':
          rollupSpec[columnId] = aq.op.mean(columnId)
          break
        case 'count':
          rollupSpec[columnId] = aq.op.valid(columnId)
          break
        case 'min':
          rollupSpec[columnId] = aq.op.min(columnId)
          break
        case 'max':
          rollupSpec[columnId] = aq.op.max(columnId)
          break
        case 'median':
          rollupSpec[columnId] = aq.op.median(columnId)
          break
        case 'stdev':
          rollupSpec[columnId] = aq.op.stdev(columnId)
          break
        default:
          // 'none' - skip this column
          break
      }
    })

    if (missingAggregations.length > 0) {
      throw new Error(`Missing aggregation column(s): ${missingAggregations.join(', ')}`)
    }
    if (invalidAggregations.length > 0) {
      throw new Error(`Invalid aggregation function(s): ${invalidAggregations.join(', ')}`)
    }
    if (invalidNumericAggregations.length > 0) {
      throw new Error(
        `Numeric aggregation requires numeric values. Invalid column(s): ${invalidNumericAggregations.join(', ')}`
      )
    }

    if (Object.keys(rollupSpec).length === 0) {
      throw new Error('At least one aggregation column is required')
    }

    // Group by the specified columns and apply aggregations
    const grouped = table.groupby(config.groupByColumns).rollup(rollupSpec)

    return this.toArray(grouped)
  }

  /**
   * Check if a value is blank (null, undefined, or empty string)
   */
  private static isBlank(value: unknown): boolean {
    return isMissingValue(value)
  }

  /**
   * Attempt to parse a value as a number for numeric comparisons
   */
  private static tryParseNumber(value: unknown): number | null {
    if (typeof value === 'number') return value
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed === '') return null
      const num = Number(trimmed)
      return Number.isFinite(num) ? num : null
    }
    return null
  }

  /**
   * Evaluate a single filter condition with proper type handling
   */
  private static evaluateCondition(row: any, condition: PreparedFilterCondition): boolean {
    const cellValue = row[condition.columnId]
    const filterValue = condition.value
    const caseSensitive = condition.caseSensitive ?? false

    switch (condition.operator) {
      case 'isEmpty':
        return DataTransformService.isBlank(cellValue)

      case 'isNotEmpty':
        return !DataTransformService.isBlank(cellValue)

      case 'eq': {
        // Handle blank comparison
        if (DataTransformService.isBlank(cellValue) && DataTransformService.isBlank(filterValue)) {
          return true
        }
        if (DataTransformService.isBlank(cellValue) || DataTransformService.isBlank(filterValue)) {
          return false
        }
        // Numeric comparison only if the cell is a number
        if (typeof cellValue === 'number') {
          const filterNum = DataTransformService.tryParseNumber(filterValue)
          if (filterNum === null) return false
          return cellValue === filterNum
        }
        // Fall back to string comparison
        const cellStr = String(cellValue)
        const filterStr = String(filterValue)
        return caseSensitive ? cellStr === filterStr : cellStr.toLowerCase() === filterStr.toLowerCase()
      }

      case 'ne': {
        // Handle blank comparison
        if (DataTransformService.isBlank(cellValue) && DataTransformService.isBlank(filterValue)) {
          return false
        }
        if (DataTransformService.isBlank(cellValue) || DataTransformService.isBlank(filterValue)) {
          return true
        }
        // Numeric comparison only if the cell is a number
        if (typeof cellValue === 'number') {
          const filterNum = DataTransformService.tryParseNumber(filterValue)
          if (filterNum === null) return true
          return cellValue !== filterNum
        }
        // Fall back to string comparison
        const cellStr = String(cellValue)
        const filterStr = String(filterValue)
        return caseSensitive ? cellStr !== filterStr : cellStr.toLowerCase() !== filterStr.toLowerCase()
      }

      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        // Numeric comparisons require numeric values (coerce numeric strings)
        const cellNum = DataTransformService.tryParseNumber(cellValue)
        if (cellNum === null) return false
        const filterNum = DataTransformService.tryParseNumber(filterValue)
        if (filterNum === null) return false
        switch (condition.operator) {
          case 'gt': return cellNum > filterNum
          case 'gte': return cellNum >= filterNum
          case 'lt': return cellNum < filterNum
          case 'lte': return cellNum <= filterNum
        }
        return false
      }

      case 'contains': {
        if (DataTransformService.isBlank(cellValue)) return false
        const cellStr = String(cellValue)
        const filterStr = String(filterValue)
        return caseSensitive
          ? cellStr.includes(filterStr)
          : cellStr.toLowerCase().includes(filterStr.toLowerCase())
      }

      case 'startsWith': {
        if (DataTransformService.isBlank(cellValue)) return false
        const cellStr = String(cellValue)
        const filterStr = String(filterValue)
        return caseSensitive
          ? cellStr.startsWith(filterStr)
          : cellStr.toLowerCase().startsWith(filterStr.toLowerCase())
      }

      case 'endsWith': {
        if (DataTransformService.isBlank(cellValue)) return false
        const cellStr = String(cellValue)
        const filterStr = String(filterValue)
        return caseSensitive
          ? cellStr.endsWith(filterStr)
          : cellStr.toLowerCase().endsWith(filterStr.toLowerCase())
      }

      case 'regex': {
        if (DataTransformService.isBlank(cellValue)) return false
        try {
          const regex =
            condition.compiledRegex ??
            new RegExp(String(filterValue), caseSensitive ? '' : 'i')
          return regex.test(String(cellValue))
        } catch {
          // Invalid regex pattern - treat as no match
          return false
        }
      }

      default:
        return false
    }
  }

  private static prepareFilterConfig(
    config: FilterConfig,
    availableColumns: Set<string>
  ): { groups: PreparedFilterGroup[]; groupOperator: 'AND' | 'OR' } {
    const groupOperator = config.groupOperator ?? 'AND'
    const canValidateColumns = availableColumns.size > 0
    const allowedOps = new Set<FilterCondition['operator']>([
      'eq',
      'ne',
      'gt',
      'gte',
      'lt',
      'lte',
      'contains',
      'startsWith',
      'endsWith',
      'isEmpty',
      'isNotEmpty',
      'regex',
    ])

    const missingColumns = new Set<string>()
    const invalidOperators = new Set<string>()
    const preparedGroups: PreparedFilterGroup[] = []

    for (const group of config.groups ?? []) {
      const preparedConditions: PreparedFilterCondition[] = []
      for (const condition of group.conditions ?? []) {
        if (canValidateColumns && !availableColumns.has(condition.columnId)) {
          missingColumns.add(condition.columnId)
          continue
        }
        if (!allowedOps.has(condition.operator)) {
          invalidOperators.add(String(condition.operator))
          continue
        }

        let compiledRegex: RegExp | undefined
        if (condition.operator === 'regex') {
          try {
            compiledRegex = new RegExp(
              String(condition.value),
              condition.caseSensitive ? '' : 'i'
            )
          } catch {
            throw new Error(`Invalid regex pattern for column ${condition.columnId}`)
          }
        }

        preparedConditions.push({
          ...condition,
          operator: condition.operator,
          compiledRegex,
        })
      }
      preparedGroups.push({
        op: group.op === 'OR' ? 'OR' : 'AND',
        conditions: preparedConditions,
      })
    }

    // If there are no rows, we can't infer available columns from data payload.
    // In that case, treat missing-column validation as indeterminate and allow
    // filter execution (it will naturally return 0 matches).
    if (canValidateColumns && missingColumns.size > 0) {
      throw new Error(`Missing filter column(s): ${Array.from(missingColumns).join(', ')}`)
    }
    if (invalidOperators.size > 0) {
      throw new Error(`Invalid filter operator(s): ${Array.from(invalidOperators).join(', ')}`)
    }
    if (preparedGroups.length === 0) {
      throw new Error('At least one filter group is required')
    }
    for (const group of preparedGroups) {
      if (group.conditions.length === 0) {
        throw new Error('Each filter group requires at least one valid condition')
      }
    }

    return { groups: preparedGroups, groupOperator }
  }

  private static buildRowKey(row: Record<string, any>, idCols: string[]): string {
    if (idCols.length === 0) return '__single__'
    const parts = idCols.map((col) => String(row[col] ?? ''))
    return JSON.stringify(parts)
  }

  private static preparePivotData(
    data: Record<string, any>[],
    config: PivotWiderConfig
  ): Record<string, any>[] {
    if (!DataTransformService.shouldInjectRowIndex(data, config)) return data

    const counts = new Map<string, number>()
    return data.map((row) => {
      const key = String(row[config.namesFrom] ?? '')
      const nextIndex = (counts.get(key) ?? 0) + 1
      counts.set(key, nextIndex)
      return { ...row, _pivot_row_index: nextIndex }
    })
  }

  private static shouldInjectRowIndex(
    data: Record<string, any>[],
    config: PivotWiderConfig
  ): boolean {
    if (!config.useRowIndex) return false
    return DataTransformService.getPivotIdCols(data, config).length === 0
  }

  private static stripPivotRowIndex(
    rows: Record<string, any>[],
    shouldStrip: boolean
  ): Record<string, any>[] {
    if (!shouldStrip) return rows
    return rows.map((row) => {
      if (!Object.prototype.hasOwnProperty.call(row, '_pivot_row_index')) return row
      const { _pivot_row_index, ...rest } = row
      return rest
    })
  }

  private static getPivotIdCols(
    data: Record<string, any>[],
    config: PivotWiderConfig
  ): string[] {
    return computePivotIdColumns(data, config)
  }

  private static assertPivotColumnLimit(
    data: Record<string, any>[],
    config: PivotWiderConfig
  ): void {
    const uniqueKeys = new Set<string>()
    for (const row of data) {
      const key = row[config.namesFrom]
      uniqueKeys.add(key === null || key === undefined ? '' : String(key))
    }
    const expectedCols = uniqueKeys.size * Math.max(1, config.valuesFrom.length)
    if (expectedCols > DataTransformService.MAX_PIVOT_COLUMNS) {
      throw new Error(
        `Pivot would create ${expectedCols.toLocaleString()} columns (limit: ${DataTransformService.MAX_PIVOT_COLUMNS.toLocaleString()}). ` +
        `Column "${config.namesFrom}" has ${uniqueKeys.size.toLocaleString()} unique values.`
      )
    }
  }

  private static toNumber(value: unknown): number {
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim() !== '') {
      return Number(value)
    }
    return Number.NaN
  }

  private static throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('Pivot cancelled')
    }
  }

  private static async yieldToMain(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  private static getPivotCache(cacheKey?: string): Record<string, any>[] | null {
    if (!cacheKey) return null
    return DataTransformService.pivotCache.get(cacheKey) ?? null
  }

  private static setPivotCache(cacheKey: string, rows: Record<string, any>[]): void {
    DataTransformService.pivotCache.set(cacheKey, rows)
    if (DataTransformService.pivotCache.size <= DataTransformService.MAX_PIVOT_CACHE_ENTRIES) {
      return
    }
    const oldestKey = DataTransformService.pivotCache.keys().next().value
    if (typeof oldestKey === 'string') {
      DataTransformService.pivotCache.delete(oldestKey)
    }
  }

  static hasDuplicatePivotKeys(
    data: Record<string, any>[],
    config: PivotWiderConfig,
    options: { preprocessed?: boolean } = {}
  ): boolean {
    const dataForPivot = options.preprocessed ? data : DataTransformService.preparePivotData(data, config)
    const idCols = DataTransformService.getPivotIdCols(dataForPivot, config)
    const seen = new Set<string>()

    for (const row of dataForPivot) {
      const keyParts = [...idCols, config.namesFrom].map((col) => String(row[col] ?? ''))
      const key = keyParts.join('|')
      if (seen.has(key)) {
        return true
      }
      seen.add(key)
    }

    return false
  }

  private static reducePivotFirstLastRows(
    data: Record<string, any>[],
    config: PivotWiderConfig,
    idCols: string[],
    mode: 'first' | 'last'
  ): Record<string, any>[] {
    const rowsByKey = new Map<string, Record<string, any>>()
    const nameKey = config.namesFrom

    for (const row of data) {
      const keyParts = [...idCols, nameKey].map((col) => String(row[col] ?? ''))
      const key = keyParts.join('|')

      if (mode === 'first' && rowsByKey.has(key)) {
        continue
      }

      const next: Record<string, any> = {}
      for (const col of idCols) {
        next[col] = row[col]
      }
      next[nameKey] = row[nameKey]
      for (const valueCol of config.valuesFrom) {
        next[valueCol] = row[valueCol]
      }
      rowsByKey.set(key, next)
    }

    return Array.from(rowsByKey.values())
  }

  private static collectOriginalColumns(
    table: ColumnTable,
    idCols: string[],
    config: PivotWiderConfig
  ): Map<string, Record<string, any>> {
    const originalCols = Array.from(
      new Set([config.namesFrom, ...config.valuesFrom])
    ).filter(Boolean)
    const originalsByKey = new Map<string, Record<string, any>>()

    if (originalCols.length === 0) return originalsByKey

    const rollupSpec: Record<string, any> = {}
    for (const col of originalCols) {
      rollupSpec[col] = aq.op.array_agg(col)
    }

    const grouped = idCols.length > 0 ? table.groupby(...idCols) : table
    const rolled = grouped.rollup(rollupSpec)
    const rolledRows = this.toArray(rolled)

    for (const row of rolledRows) {
      const rowKey = this.buildRowKey(row, idCols)
      const originals: Record<string, any> = {}
      for (const col of originalCols) {
        originals[col] = row[col] ?? []
      }
      originalsByKey.set(rowKey, originals)
    }

    return originalsByKey
  }

  static getPivotWiderCollisionKeys(
    data: Record<string, any>[],
    config: PivotWiderConfig
  ): string[] {
    if (data.length === 0) return []
    if (!config.namesFrom || config.valuesFrom.length === 0) return []

    const existing = DataTransformService.getAvailableColumnIds(data)
    const uniqueKeys = new Set<string>()
    for (const row of data) {
      const raw = row[config.namesFrom]
      uniqueKeys.add(raw === null || raw === undefined ? '' : String(raw))
    }

    const collisions = new Set<string>()
    const needsValuePrefix = config.valuesFrom.length > 1
    for (const pivotKey of uniqueKeys) {
      for (const valueCol of config.valuesFrom) {
        const outKey = needsValuePrefix ? `${valueCol}__${pivotKey}` : pivotKey
        if (existing.has(outKey)) {
          collisions.add(outKey)
        }
      }
    }

    return Array.from(collisions)
  }

  /**
   * Get unique values from a column (useful for pivot previews)
   */
  static getUniqueValues(
    data: Record<string, any>[],
    column: string
  ): (string | number)[] {
    const availableColumns = DataTransformService.getAvailableColumnIds(data)
    if (!availableColumns.has(column)) {
      return []
    }
    const table = this.fromArray(data)
    const unique = table
      .rollup({ values: aq.op.array_agg_distinct(column) })
      .get('values', 0)

    return Array.from(unique || [])
  }

  /**
   * Preview pivot result (first 10 rows)
   */
  static previewPivotWider(
    data: Record<string, any>[],
    config: PivotWiderConfig
  ): { preview: Record<string, any>[]; newColumns: string[] } {
    const result = this.pivotWider(data, config)
    const preview = result.slice(0, 10)

    // Get new column names (those created by pivot)
    const originalCols = new Set(Object.keys(data[0] || {}))
    const newCols = Object.keys(result[0] || {}).filter(
      col => !originalCols.has(col)
    )

    return { preview, newColumns: newCols }
  }

  private static normalizePivotWiderConfig(
    data: Record<string, any>[],
    config: PivotWiderConfig
  ): PivotWiderConfig {
    const availableColumns = DataTransformService.getAvailableColumnIds(data)
    if (!availableColumns.has(config.namesFrom)) {
      throw new Error(`Column not found for pivot: ${config.namesFrom}`)
    }
    const filteredValues = config.valuesFrom.filter((col) => availableColumns.has(col))
    const missingValues = config.valuesFrom.filter((col) => !availableColumns.has(col))
    if (filteredValues.length === 0) {
      throw new Error('No value columns were found for pivot.')
    }
    if (missingValues.length > 0) {
      throw new Error(`Missing pivot value column(s): ${missingValues.join(', ')}`)
    }
    return {
      ...config,
      valuesFrom: filteredValues,
    }
  }

  private static getAvailableColumnIds(data: Record<string, any>[]): Set<string> {
    const keys = new Set<string>()
    for (const row of data) {
      for (const key of Object.keys(row)) {
        keys.add(key)
      }
    }
    return keys
  }

  private static renameOriginalColumns(
    pivotRow: Record<string, any>,
    originals: Record<string, any>
  ): Record<string, any> {
    const renamed: Record<string, any> = {}
    const occupied = new Set<string>(Object.keys(pivotRow))

    const makeUnique = (base: string): string => {
      if (!occupied.has(base)) {
        occupied.add(base)
        return base
      }
      let idx = 1
      while (occupied.has(`${base}_${idx}`)) {
        idx += 1
      }
      const next = `${base}_${idx}`
      occupied.add(next)
      return next
    }

    for (const [key, value] of Object.entries(originals)) {
      if (!occupied.has(key)) {
        renamed[key] = value
        occupied.add(key)
        continue
      }
      const renamedKey = makeUnique(`${key}__original`)
      renamed[renamedKey] = value
    }

    return renamed
  }
}

export default DataTransformService
