/**
 * Plot Data Service - Phase 1 Plots Feature
 *
 * Service layer for plot data access with cap enforcement.
 * Uses cacheService for raw + backend sampling/aggregation (large dataset safe).
 *
 * Key responsibilities:
 * - Evaluate data against PLOT_HARD_CAPS
 * - Delegate to appropriate data fetch strategy (raw, sampled, aggregated)
 * - Use cacheService.getAllColumnStats() + getRowCount() for group counts
 * - Sampling supports large datasets via backend sampling
 * - Aggregation falls back to sampling until backend aggregation is available
 */

import type { PlotType, PlotRole } from '@/config/plotRegistry'
import { PLOT_HARD_CAPS, evaluateCap } from '@/config/plotRegistry'
import type { PlotSpec, SamplingConfig, AggregationConfig } from '@/store/plots-store'
import cacheService from '@/services/cacheService'
import { sampleRows } from '@/utils/plotBuilders/common'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Column mapping for plot data extraction
 */
export interface PlotColumnMapping {
  columnId: string
  columnName: string
  role: PlotRole
  inferredType: 'numeric' | 'categorical' | 'datetime' | 'any'
}

/**
 * Result of plot data preparation
 */
export interface PlotDataResult {
  type: 'raw' | 'sampled' | 'aggregated'
  columns: PlotColumnData[]
  rowCount: number
  sampledFrom: number | null  // Original row count if sampled
  groupCount: number
  maxGroupSize: number
  samplingConfig: SamplingConfig | null
  aggregationConfig: AggregationConfig | null
}

/**
 * Column data for plotting
 */
export interface PlotColumnData {
  columnId: string
  columnName: string
  role: PlotRole
  inferredType: PlotColumnMapping['inferredType']
  values: (string | number | boolean | null)[]
}

/**
 * Cap evaluation result
 */
export interface CapEvaluationResult {
  allowed: boolean
  exceeded: 'maxPoints' | 'maxGroups' | 'maxPointsPerGroup' | null
  limit: number | null
  reason: string | null
  recommendedPolicy: 'raw' | 'sampled' | 'aggregated'
}

/**
 * Error for plot data operations
 */
export class PlotDataError extends Error {
  constructor(
    message: string,
    public code: 'EXCEEDS_CAP' | 'AGGREGATION_NOT_AVAILABLE' | 'SAMPLING_NOT_AVAILABLE' | 'NO_DATA' | 'INVALID_COLUMNS',
    public details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'PlotDataError'
  }
}

// =============================================================================
// MAIN SERVICE FUNCTIONS
// =============================================================================

/**
 * Get plot data with cap enforcement
 * Main entry point for all plot data access
 */
export async function getPlotData(
  spec: PlotSpec,
  datasetId: string
): Promise<PlotDataResult> {
  await cacheService.ensureLatestCache(datasetId)

  const plotType = spec.type
  const cap = PLOT_HARD_CAPS[plotType]

  // Get dataset stats
  const rowCount = await cacheService.getRowCount(datasetId)

  if (rowCount === 0) {
    throw new PlotDataError('Dataset has no rows', 'NO_DATA')
  }

  // Extract column mappings from PlotSpec
  const columnMappings = getColumnMappings(spec)

  if (columnMappings.length === 0) {
    throw new PlotDataError('No columns specified for plot', 'INVALID_COLUMNS')
  }

  // Get group statistics
  const groupInfo = await getGroupInfo(datasetId, columnMappings)

  // Evaluate caps
  const capResult = evaluateCapForPlot(plotType, rowCount, groupInfo.groupCount, groupInfo.maxGroupSize)

  if (!capResult.allowed) {
    // Apply policy based on cap's default
    if (cap.defaultPolicy === 'sampled') {
      return await fetchSampledData(datasetId, columnMappings, rowCount, cap.maxPoints, groupInfo)
    } else if (cap.defaultPolicy === 'aggregated') {
      if (capResult.exceeded === 'maxGroups') {
        throw new PlotDataError(
          `Plot type "${plotType}" exceeds group limits (${groupInfo.groupCount} groups > ${cap.maxGroups}).`,
          'EXCEEDS_CAP',
          { rowCount, groupCount: groupInfo.groupCount, plotType }
        )
      }
      return await fetchAggregatedData(plotType, datasetId, columnMappings, rowCount, groupInfo)
    } else {
      // Raw-only plots must stay within caps
      throw new PlotDataError(
        `Plot type "${plotType}" exceeds the raw data limit of ${cap.maxPoints.toLocaleString()} points.`,
        'EXCEEDS_CAP',
        { rowCount, maxPoints: cap.maxPoints, plotType }
      )
    }
  }

  // Data is within caps - fetch raw
  return await fetchRawData(datasetId, columnMappings, rowCount, groupInfo)
}

/**
 * Evaluate caps for a specific plot type and data dimensions
 */
export function evaluateCapForPlot(
  plotType: PlotType,
  rowCount: number,
  groupCount: number,
  maxGroupSize: number
): CapEvaluationResult {
  const cap = PLOT_HARD_CAPS[plotType]
  const exceeded = evaluateCap(plotType, rowCount, groupCount, maxGroupSize)

  if (exceeded) {
    return {
      allowed: false,
      exceeded: exceeded.exceeded,
      limit: exceeded.limit,
      reason: getCapExceededMessage(exceeded.exceeded, exceeded.limit, {
        rowCount,
        groupCount,
        maxGroupSize,
      }),
      recommendedPolicy: cap.defaultPolicy,
    }
  }

  return {
    allowed: true,
    exceeded: null,
    limit: null,
    reason: null,
    recommendedPolicy: 'raw',
  }
}

/**
 * Check if a plot type is available for the given data dimensions
 * Returns available/unavailable status with reason
 */
export async function checkPlotAvailability(
  plotType: PlotType,
  datasetId: string,
  groupColumnId?: string
): Promise<{ available: boolean; reason: string | null }> {
  const cap = PLOT_HARD_CAPS[plotType]
  const rowCount = await cacheService.getRowCount(datasetId)

  let groupCount = 1
  let maxGroupSize = rowCount

  if (groupColumnId) {
    const stats = await cacheService.getAllColumnStats(datasetId)
    const groupStats = stats.find(s => s.columnId === groupColumnId)
    if (groupStats) {
      groupCount = Math.max(1, groupStats.distinctCount)
      maxGroupSize = Math.ceil(rowCount / groupCount)
    }
  }

  const exceeded = evaluateCap(plotType, rowCount, groupCount, maxGroupSize)

  if (exceeded) {
    // Check if policy can handle it
    if (cap.defaultPolicy === 'sampled') {
      if (exceeded.exceeded === 'maxGroups') {
        return {
          available: false,
          reason: `Exceeds group limit (${groupCount} groups > ${cap.maxGroups})`,
        }
      }
      return { available: true, reason: null }
    }
    if (cap.defaultPolicy === 'aggregated') {
      if (exceeded.exceeded === 'maxGroups') {
        return {
          available: false,
          reason: `Exceeds group limit (${groupCount} groups > ${cap.maxGroups})`,
        }
      }
      return { available: true, reason: null }
    }
    if (cap.defaultPolicy === 'raw') {
      return {
        available: false,
        reason: `Exceeds raw limit (${cap.maxPoints.toLocaleString()} points max)`,
      }
    }
    return {
      available: false,
      reason: getCapExceededMessage(exceeded.exceeded, exceeded.limit, { rowCount, groupCount, maxGroupSize }),
    }
  }

  return { available: true, reason: null }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Extract column mappings from PlotSpec
 */
function getColumnMappings(spec: PlotSpec): PlotColumnMapping[] {
  if (spec.sourceType === 'user_derived' && spec.dataSnapshot) {
    return spec.dataSnapshot.columns.map(col => ({
      columnId: col.columnId,
      columnName: col.columnName,
      role: col.role,
      inferredType: col.inferredType,
    }))
  }

  // For test_result specs, we'd need to extract from plotlyData
  // For Phase 1, this returns empty - test result plots use pre-computed data
  return []
}

/**
 * Get group information from dataset
 * Uses existing cacheService.getAllColumnStats()
 */
async function getGroupInfo(
  datasetId: string,
  columnMappings: PlotColumnMapping[]
): Promise<{ groupCount: number; maxGroupSize: number }> {
  const groupColumn = columnMappings.find(c => c.role === 'group' || c.role === 'color')

  if (!groupColumn) {
    const rowCount = await cacheService.getRowCount(datasetId)
    return { groupCount: 1, maxGroupSize: rowCount }
  }

  let stats: Awaited<ReturnType<typeof cacheService.getAllColumnStats>>
  try {
    stats = await cacheService.getAllColumnStats(datasetId)
  } catch (err) {
    console.warn('Failed to load column stats for grouping, falling back to no-group:', err)
    const rowCount = await cacheService.getRowCount(datasetId)
    return { groupCount: 1, maxGroupSize: rowCount }
  }

  const groupStats = stats.find(s => s.columnId === groupColumn.columnId)

  if (!groupStats) {
    const rowCount = await cacheService.getRowCount(datasetId)
    return { groupCount: 1, maxGroupSize: rowCount }
  }

  const groupCount = Math.max(1, groupStats.distinctCount)
  const rowCount = await cacheService.getRowCount(datasetId)
  const maxGroupSize = Math.ceil(rowCount / groupCount)

  return { groupCount, maxGroupSize }
}

/**
 * Fetch raw data for all columns
 */
async function fetchRawData(
  datasetId: string,
  columnMappings: PlotColumnMapping[],
  rowCount: number,
  groupInfo: { groupCount: number; maxGroupSize: number }
): Promise<PlotDataResult> {
  const columnIds = columnMappings.map(c => c.columnId)
  // getColumnsData returns Record<string, unknown[]>
  const columnsData = await cacheService.getColumnsData(datasetId, columnIds)

  const columns: PlotColumnData[] = columnMappings.map(mapping => {
    const values = columnsData[mapping.columnId] ?? []
    return {
      columnId: mapping.columnId,
      columnName: mapping.columnName,
      role: mapping.role,
      inferredType: mapping.inferredType,
      values: normalizeValues(values, mapping.inferredType),
    }
  })

  return {
    type: 'raw',
    columns,
    rowCount,
    sampledFrom: null,
    groupCount: groupInfo.groupCount,
    maxGroupSize: groupInfo.maxGroupSize,
    samplingConfig: null,
    aggregationConfig: null,
  }
}

/**
 * Fetch sampled data for columns
 * Phase 1: Sample in memory (small datasets only)
 */
async function fetchSampledData(
  datasetId: string,
  columnMappings: PlotColumnMapping[],
  originalRowCount: number,
  sampleLimit: number,
  groupInfo: { groupCount: number; maxGroupSize: number }
): Promise<PlotDataResult> {
  const columnIds = columnMappings.map(c => c.columnId)
  let didBackendSample = false

  let columnsData: Record<string, unknown[]>
  if (originalRowCount > sampleLimit) {
    didBackendSample = true
    columnsData = await cacheService.getColumnsSampledData(datasetId, columnIds, sampleLimit, 42)
  } else {
    columnsData = await cacheService.getColumnsData(datasetId, columnIds)
  }

  if (didBackendSample) {
    const columns: PlotColumnData[] = columnMappings.map(mapping => {
    const values = columnsData[mapping.columnId] ?? []
    return {
      columnId: mapping.columnId,
      columnName: mapping.columnName,
      role: mapping.role,
      inferredType: mapping.inferredType,
      values: normalizeValues(values, mapping.inferredType),
    }
  })

    const sampledRowCount = columns.reduce((max, col) => Math.max(max, col.values.length), 0)

    return {
      type: 'sampled',
      columns,
      rowCount: sampledRowCount,
      sampledFrom: originalRowCount,
      groupCount: groupInfo.groupCount,
      maxGroupSize: Math.ceil(sampledRowCount / Math.max(1, groupInfo.groupCount)),
      samplingConfig: {
        method: 'systematic',
        sampleSize: sampledRowCount,
        seed: 42,
      },
      aggregationConfig: null,
    }
  }

  // Sample row indices
  const rowIndices = sampleRows(
    Array.from({ length: originalRowCount }, (_, i) => i),
    sampleLimit,
    42
  )
  const sampledRowCount = rowIndices.length

  const columns: PlotColumnData[] = columnMappings.map(mapping => {
    const allValues = (columnsData[mapping.columnId] ?? []) as unknown[]
    const sampledValues = rowIndices.map((i) =>
      normalizeValue(allValues[i], mapping.inferredType)
    )

    return {
      columnId: mapping.columnId,
      columnName: mapping.columnName,
      role: mapping.role,
      inferredType: mapping.inferredType,
      values: sampledValues,
    }
  })

  return {
    type: 'sampled',
    columns,
    rowCount: sampledRowCount,
    sampledFrom: originalRowCount,
    groupCount: groupInfo.groupCount,
    maxGroupSize: Math.ceil(sampledRowCount / groupInfo.groupCount),
    samplingConfig: {
      method: 'random',
      sampleSize: sampledRowCount,
      seed: 42,
    },
    aggregationConfig: null,
  }
}

type AggregationFunction = AggregationConfig['aggregations'][number]['function']
type AggregationRequest = { columnId?: string | null; func: AggregationFunction; alias: string }

function selectColumn(
  columnMappings: PlotColumnMapping[],
  roles: PlotRole[],
  inferredType?: PlotColumnMapping['inferredType'],
  exclude?: PlotColumnMapping
): PlotColumnMapping | undefined {
  const byRole = columnMappings.find((c) => roles.includes(c.role) && c !== exclude)
  if (byRole) return byRole
  if (inferredType) {
    return columnMappings.find((c) => c.inferredType === inferredType && c !== exclude)
  }
  return undefined
}

function aggregationLabel(func: AggregationFunction): string {
  switch (func) {
    case 'mean':
      return 'Mean'
    case 'std':
      return 'Std Dev'
    case 'sum':
      return 'Sum'
    case 'count':
      return 'Count'
    case 'median':
      return 'Median'
    case 'q1':
      return 'Q1'
    case 'q3':
      return 'Q3'
    case 'min':
      return 'Min'
    case 'max':
      return 'Max'
    default:
      return func
  }
}

async function fetchAggregatedData(
  plotType: PlotType,
  datasetId: string,
  columnMappings: PlotColumnMapping[],
  originalRowCount: number,
  groupInfo: { groupCount: number; maxGroupSize: number }
): Promise<PlotDataResult> {
  const xColumn = selectColumn(columnMappings, ['x'], 'categorical')
  const categoryColumn = selectColumn(columnMappings, ['x', 'group', 'color'], 'categorical')
  const groupColumn = selectColumn(columnMappings, ['group', 'color'], 'categorical', xColumn)
  const yColumn = selectColumn(columnMappings, ['y', 'response'], 'numeric')
  const thetaColumn = selectColumn(columnMappings, ['theta'], 'numeric')

  let groupBy: PlotColumnMapping[] = []
  let aggregations: AggregationRequest[] = []
  let valueRole: PlotRole = 'y'
  let primaryFunc: AggregationFunction | null = null
  let needsSe = false

  switch (plotType) {
    case 'bar': {
      if (!categoryColumn) {
        throw new PlotDataError('Bar chart requires a categorical column', 'INVALID_COLUMNS')
      }
      groupBy = [categoryColumn]
      if (yColumn) {
        aggregations = [
          { columnId: yColumn.columnId, func: 'mean', alias: `${yColumn.columnId}__mean` },
          { columnId: yColumn.columnId, func: 'std', alias: `${yColumn.columnId}__std` },
          { columnId: yColumn.columnId, func: 'count', alias: `${yColumn.columnId}__count` },
        ]
        primaryFunc = 'mean'
        needsSe = true
      } else {
        aggregations = [{ columnId: null, func: 'count', alias: 'count' }]
        primaryFunc = 'count'
      }
      break
    }
    case 'grouped_bar': {
      if (!xColumn || !groupColumn || !yColumn) {
        throw new PlotDataError('Grouped bar chart requires x, group, and y columns', 'INVALID_COLUMNS')
      }
      groupBy = [xColumn, groupColumn]
      aggregations = [
        { columnId: yColumn.columnId, func: 'mean', alias: `${yColumn.columnId}__mean` },
        { columnId: yColumn.columnId, func: 'std', alias: `${yColumn.columnId}__std` },
        { columnId: yColumn.columnId, func: 'count', alias: `${yColumn.columnId}__count` },
      ]
      primaryFunc = 'mean'
      needsSe = true
      break
    }
    case 'stacked_bar': {
      if (!xColumn) {
        throw new PlotDataError('Stacked bar chart requires an x column', 'INVALID_COLUMNS')
      }
      groupBy = groupColumn ? [xColumn, groupColumn] : [xColumn]
      if (yColumn) {
        aggregations = [
          { columnId: yColumn.columnId, func: 'sum', alias: `${yColumn.columnId}__sum` },
          { columnId: yColumn.columnId, func: 'count', alias: `${yColumn.columnId}__count` },
        ]
        primaryFunc = 'sum'
      } else {
        aggregations = [{ columnId: null, func: 'count', alias: 'count' }]
        primaryFunc = 'count'
      }
      break
    }
    case 'interaction': {
      if (!xColumn || !groupColumn || !yColumn) {
        throw new PlotDataError('Interaction plot requires x, group, and y columns', 'INVALID_COLUMNS')
      }
      groupBy = [xColumn, groupColumn]
      aggregations = [
        { columnId: yColumn.columnId, func: 'mean', alias: `${yColumn.columnId}__mean` },
        { columnId: yColumn.columnId, func: 'std', alias: `${yColumn.columnId}__std` },
        { columnId: yColumn.columnId, func: 'count', alias: `${yColumn.columnId}__count` },
      ]
      primaryFunc = 'mean'
      needsSe = true
      break
    }
    case 'pie': {
      const labelColumn = categoryColumn ?? groupColumn
      if (!labelColumn) {
        throw new PlotDataError('Pie chart requires a categorical column', 'INVALID_COLUMNS')
      }
      groupBy = [labelColumn]
      if (thetaColumn) {
        aggregations = [{ columnId: thetaColumn.columnId, func: 'sum', alias: `${thetaColumn.columnId}__sum` }]
        primaryFunc = 'sum'
        valueRole = 'theta'
      } else if (yColumn) {
        aggregations = [{ columnId: yColumn.columnId, func: 'sum', alias: `${yColumn.columnId}__sum` }]
        primaryFunc = 'sum'
        valueRole = 'theta'
      } else {
        aggregations = [{ columnId: null, func: 'count', alias: 'count' }]
        primaryFunc = 'count'
        valueRole = 'theta'
      }
      break
    }
    case 'box':
    case 'violin': {
      if (!yColumn) {
        throw new PlotDataError('Box/violin plot requires a numeric column', 'INVALID_COLUMNS')
      }
      groupBy = groupColumn ? [groupColumn] : []
      aggregations = [
        { columnId: yColumn.columnId, func: 'q1', alias: `${yColumn.columnId}__q1` },
        { columnId: yColumn.columnId, func: 'median', alias: `${yColumn.columnId}__median` },
        { columnId: yColumn.columnId, func: 'q3', alias: `${yColumn.columnId}__q3` },
        { columnId: yColumn.columnId, func: 'min', alias: `${yColumn.columnId}__min` },
        { columnId: yColumn.columnId, func: 'max', alias: `${yColumn.columnId}__max` },
        { columnId: yColumn.columnId, func: 'count', alias: `${yColumn.columnId}__count` },
      ]
      break
    }
    default: {
      throw new PlotDataError(`Aggregation not supported for plot type "${plotType}"`, 'AGGREGATION_NOT_AVAILABLE')
    }
  }

  const aggregated = await cacheService.getColumnsAggregatedData(
    datasetId,
    groupBy.map((col) => col.columnId),
    aggregations.map((agg) => ({
      columnId: agg.columnId ?? null,
      func: agg.func,
      alias: agg.alias,
    }))
  )

  const columns: PlotColumnData[] = []

  for (const groupCol of groupBy) {
    const values = aggregated[groupCol.columnId] ?? []
    columns.push({
      columnId: groupCol.columnId,
      columnName: groupCol.columnName,
      role: groupCol.role,
      inferredType: groupCol.inferredType,
      values: normalizeValues(values, groupCol.inferredType),
    })
  }

  const countValuesByAlias = new Map<string, number[]>()
  const stdValuesByAlias = new Map<string, number[]>()

  for (const agg of aggregations) {
    const values = aggregated[agg.alias] ?? []
    const role: PlotRole = (() => {
      if (agg.func === 'std') return 'std'
      if (agg.func === 'q1') return 'q1'
      if (agg.func === 'q3') return 'q3'
      if (agg.func === 'median') return 'median'
      if (agg.func === 'min') return 'min'
      if (agg.func === 'max') return 'max'
      if (agg.func === 'count' && needsSe) return 'count'
      if (primaryFunc && agg.func === primaryFunc) return valueRole
      if (agg.func === 'count') return 'count'
      if (agg.func === 'sum') return 'sum'
      return valueRole
    })()

    const displayName = (() => {
      if (!agg.columnId) return aggregationLabel(agg.func)
      const colName = columnMappings.find((c) => c.columnId === agg.columnId)?.columnName ?? agg.columnId
      return `${colName} (${aggregationLabel(agg.func)})`
    })()

    const normalized = normalizeValues(values, 'numeric')
    columns.push({
      columnId: agg.alias,
      columnName: displayName,
      role,
      inferredType: 'numeric',
      values: normalized,
    })

    if (agg.func === 'count') {
      countValuesByAlias.set(agg.alias, normalized.map((v) => (typeof v === 'number' ? v : 0)))
    }
    if (agg.func === 'std') {
      stdValuesByAlias.set(agg.alias, normalized.map((v) => (typeof v === 'number' ? v : 0)))
    }
  }

  if (needsSe) {
    const stdAlias = aggregations.find((a) => a.func === 'std')?.alias
    const countAlias = aggregations.find((a) => a.func === 'count')?.alias
    if (stdAlias && countAlias) {
      const stdVals = stdValuesByAlias.get(stdAlias) ?? []
      const countVals = countValuesByAlias.get(countAlias) ?? []
      const len = Math.min(stdVals.length, countVals.length)
      const seValues: Array<number | null> = []
      for (let i = 0; i < len; i++) {
        const std = stdVals[i] ?? 0
        const n = countVals[i] ?? 0
        if (n > 0 && std > 0) {
          seValues.push(std / Math.sqrt(n))
        } else {
          seValues.push(null)
        }
      }
      columns.push({
        columnId: `${stdAlias}__se`,
        columnName: 'Standard Error',
        role: 'error',
        inferredType: 'numeric',
        values: seValues,
      })
    }
  }

  if ((plotType === 'box' || plotType === 'violin') && yColumn) {
    const hasYRole = columns.some((col) => col.role === 'y')
    if (!hasYRole) {
      const len = columns.reduce((max, col) => Math.max(max, col.values.length), 0)
      columns.push({
        columnId: `${yColumn.columnId}__label`,
        columnName: yColumn.columnName,
        role: 'y',
        inferredType: 'numeric',
        values: Array.from({ length: len }, () => null),
      })
    }
  }

  const rowCount = columns.reduce((max, col) => Math.max(max, col.values.length), 0)
  const countColumn = columns.find((c) => c.role === 'count')
  const countValues = (countColumn?.values ?? []).map((value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  )
  const maxGroupSize = countValues.reduce((max, value) => Math.max(max, value), 0)

  return {
    type: 'aggregated',
    columns,
    rowCount,
    sampledFrom: originalRowCount,
    groupCount: groupBy.length > 0 ? rowCount : 1,
    maxGroupSize: maxGroupSize || groupInfo.maxGroupSize,
    samplingConfig: null,
    aggregationConfig: {
      groupBy: groupBy.map((c) => c.columnId),
      aggregations: aggregations.map((a) => ({
        column: a.columnId ?? '',
        function: a.func,
      })),
    },
  }
}

function normalizeValue(
  value: unknown,
  inferredType: PlotColumnMapping['inferredType']
): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null

  if (inferredType === 'numeric') {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null
    }
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  return String(value)
}

function normalizeValues(
  values: unknown[],
  inferredType: PlotColumnMapping['inferredType']
): (string | number | boolean | null)[] {
  return values.map((value) => normalizeValue(value, inferredType))
}

/**
 * Generate user-friendly cap exceeded message
 */
function getCapExceededMessage(
  exceeded: 'maxPoints' | 'maxGroups' | 'maxPointsPerGroup',
  limit: number,
  actual: { rowCount: number; groupCount: number; maxGroupSize: number }
): string {
  switch (exceeded) {
    case 'maxPoints':
      return `Dataset has ${actual.rowCount.toLocaleString()} rows, exceeding limit of ${limit.toLocaleString()}`
    case 'maxGroups':
      return `Dataset has ${actual.groupCount} groups, exceeding limit of ${limit}`
    case 'maxPointsPerGroup':
      return `Largest group has ~${actual.maxGroupSize.toLocaleString()} points, exceeding limit of ${limit.toLocaleString()}`
    default:
      return 'Data exceeds plot limits'
  }
}

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

const plotDataService = {
  getPlotData,
  evaluateCapForPlot,
  checkPlotAvailability,
}

export default plotDataService
