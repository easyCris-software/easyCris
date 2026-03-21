/**
 * Column Selection Dialog - Enhanced column picker with 6-type classification
 *
 * Features:
 * - Automatic column type detection (Numeric, Categorical, Binary, Ordinal, Mixed, Empty)
 * - Visual type badges and data quality indicators
 * - Context-aware validation messages and test suggestions
 * - Multi-column selection with drag-and-drop
 * - Real-time classification using columnDataService
 *
 * Based on Avalonia's ColumnSelectionDialog (easyCris.Avalonia/Views/Dialogs/)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDataStore, type ColumnTypeOverride } from '@/store/data-store'
import { ensureProjectId } from '@/store/app-store'
import { useAnalysisStore } from '@/store/analysis-store'
import {
  applyColumnTypeOverride,
  classifyColumn,
  classifyColumnFromStats,
  type ColumnClassification,
  ColumnDataType,
  type ColumnClassificationStats,
} from '@/services/columnDataService'
import { mapPersistedOverrideToUi } from '@/lib/classification/typeBridge'
import { ValidationError } from '@/services/validationService'
import { getTestDefinition, getRequiredColumnCount } from '@/config/testRegistry'
import cacheService from '@/services/cacheService'
import {
  ResizableDialog,
  ResizableDialogContent,
  ResizableDialogHeader,
  ResizableDialogTitle,
} from '@/components/ui/resizable-dialog'

// Stable empty array to prevent infinite re-renders (fix for crash-1765693495537)
const EMPTY_VALIDATION_ERRORS: ValidationError[] = []

const SAMPLE_ROWS_PER_CHUNK = 200
const SAMPLE_CHUNK_COUNT = 5
const PREWARM_ROW_THRESHOLD = 1_000_000

function buildSampleRanges(rowCount: number): Array<{ start: number; end: number }> {
  if (rowCount <= 0) return []

  const chunkSize = Math.min(SAMPLE_ROWS_PER_CHUNK, rowCount)
  const maxStart = Math.max(0, rowCount - chunkSize)
  const starts = new Set<number>()

  if (rowCount <= chunkSize * SAMPLE_CHUNK_COUNT) {
    for (let start = 0; start <= maxStart; start += chunkSize) {
      starts.add(start)
    }
  } else {
    const steps = SAMPLE_CHUNK_COUNT - 1
    for (let i = 0; i <= steps; i++) {
      const ratio = steps === 0 ? 0 : i / steps
      const start = Math.round(maxStart * ratio)
      starts.add(start)
    }
  }

  return Array.from(starts)
    .sort((a, b) => a - b)
    .map(start => ({ start, end: Math.min(start + chunkSize, rowCount) }))
}

/**
 * Get column classification with caching and invalidation support
 * Uses the data-store's classification cache to avoid re-classifying unchanged columns
 */
function getOrClassifyColumn(
  columnId: string,
  columnName: string,
  rowData: Map<number, Record<string, unknown>>,
  shouldReclassify: (colId: string) => boolean,
  getCache: (colId: string) => { classification: unknown } | undefined,
  setCache: (colId: string, data: { classification: unknown }) => void,
  clearInvalidation: (colId: string) => void
): ColumnClassification {
  // Check if we need to reclassify
  if (!shouldReclassify(columnId)) {
    const cached = getCache(columnId)
    if (cached) {
      return cached.classification as ColumnClassification
    }
  }

  // Classify the column
  const classification = classifyColumn(columnId, columnName, rowData)

  // Cache the result with current version
  setCache(columnId, { classification })

  // Clear from invalidated set (classification is now fresh)
  clearInvalidation(columnId)

  return classification
}

/**
 * Get column classification from backend stats with caching/invalidation support
 */
function getOrClassifyColumnFromStats(
  columnId: string,
  columnName: string,
  stats: ColumnClassificationStats,
  shouldReclassify: (colId: string) => boolean,
  getCache: (colId: string) => { classification: unknown } | undefined,
  setCache: (colId: string, data: { classification: unknown }) => void,
  clearInvalidation: (colId: string) => void
): ColumnClassification {
  if (!shouldReclassify(columnId)) {
    const cached = getCache(columnId)
    if (cached) {
      return cached.classification as ColumnClassification
    }
  }

  const classification = classifyColumnFromStats(columnId, columnName, stats)
  setCache(columnId, { classification })
  clearInvalidation(columnId)
  return classification
}

/**
 * Column selection mode
 */
export type SelectionMode = 'single' | 'multiple' | 'paired'

/**
 * Props for ColumnSelectionDialog
 */
export interface SelectedColumnInfo {
  id: string
  name: string
  detectedType?: ColumnDataType
  overrideType?: ColumnDataType
  effectiveType?: ColumnDataType
}

interface ColumnSelectionDialogProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (columns: SelectedColumnInfo[]) => void
  title?: string
  mode?: SelectionMode
  requiredType?: ColumnDataType
  validationErrors?: ValidationError[]
}

/**
 * Column item with classification metadata
 */
interface ColumnItem {
  id: string
  name: string
  classification: ColumnClassification
  isSelected: boolean
  validationErrors: ValidationError[]
}

const AUTO_TYPE_VALUE = '__auto__'
const TYPE_OVERRIDE_OPTIONS: ReadonlyArray<{ value: ColumnDataType; label: string }> = [
  { value: ColumnDataType.Numeric, label: 'Numeric' },
  { value: ColumnDataType.Categorical, label: 'Categorical' },
  { value: ColumnDataType.Binary, label: 'Binary' },
  { value: ColumnDataType.Ordinal, label: 'Ordinal' },
  { value: ColumnDataType.Mixed, label: 'Mixed' },
  { value: ColumnDataType.Empty, label: 'Empty' },
]

/**
 * Get badge color for column type
 */
function getTypeBadgeColor(dataType: ColumnDataType): string {
  switch (dataType) {
    case ColumnDataType.Numeric:
      return '#2563eb' // Blue
    case ColumnDataType.Categorical:
      return '#f59e0b' // Orange
    case ColumnDataType.Binary:
      return '#8b5cf6' // Purple
    case ColumnDataType.Ordinal:
      return '#10b981' // Green
    case ColumnDataType.Mixed:
      return '#ef4444' // Red
    case ColumnDataType.Empty:
      return '#6b7280' // Gray
    default:
      return '#6b7280'
  }
}

/**
 * Get data quality color (green → yellow → red)
 */
// Note: We intentionally do not show percentage-based "data quality" in the UI.
// Missing values are reported as a simple count of gaps within the effective data window.

/**
 * ColumnSelectionDialog Component
 */
export function ColumnSelectionDialog({
  isOpen,
  onClose,
  onSelect,
  title = 'Select Columns',
  mode = 'single',
  requiredType,
  validationErrors = EMPTY_VALIDATION_ERRORS,
}: ColumnSelectionDialogProps) {
  const {
    currentDataset,
    // dataCache removed - streaming row provider now loads data via cacheService
    shouldReclassifyColumn,
    isColumnInvalidated,
    getColumnClassification,
    setColumnClassification,
    clearInvalidation,
    getColumnTypeOverride,
    setColumnTypeOverride,
  } = useDataStore()
  const selectedTest = useAnalysisStore(state => state.selectedTest)
  const [selectedColumns, setSelectedColumns] = useState<string[]>([])
  const [columnItems, setColumnItems] = useState<ColumnItem[]>([])
  const [isSampledRowData, setIsSampledRowData] = useState(false)
  const [isLoadingColumns, setIsLoadingColumns] = useState(false)
  const [columnStats, setColumnStats] = useState<Map<string, ColumnClassificationStats> | null>(null)

  // Phase 4 Fix: Reset selection when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedColumns([])
    }
  }, [isOpen])

  // Get test definition for column requirements
  const testDef = useMemo(() => {
    return selectedTest ? getTestDefinition(selectedTest.id) : null
  }, [selectedTest])

  const isVariableColumnCount = useMemo(() => {
    if (!selectedTest) return false
    if (testDef?.family === 'survival') return true
    if (testDef?.requiredDataFields?.some((field) => field.multiple)) return true
    return getRequiredColumnCount(selectedTest.id) === 0
  }, [selectedTest, testDef])
  const isSurvivalTest = testDef?.family === 'survival'

  // Get required column count from registry
  const requiredColumnCount = useMemo(() => {
    if (!selectedTest) return 1
    if (testDef?.family === 'survival') return 2
    const count = getRequiredColumnCount(selectedTest.id)
    if (count === 0 && testDef?.family === 'regression') return 2
    return count === 0 ? 1 : count
  }, [selectedTest, testDef])

  // Row data state - fetched from backend cache when dialog opens
  const [rowData, setRowData] = useState<Map<number, Record<string, unknown>>>(new Map())

  // Fetch row data from backend cache when dialog opens
  useEffect(() => {
    if (!currentDataset || !isOpen) {
      setRowData(new Map())
      setIsSampledRowData(false)
      setIsLoadingColumns(false)
      setColumnStats(null)
      return
    }

    setIsLoadingColumns(true)
    setRowData(new Map())
    setColumnStats(null)
    let cancelled = false
    const datasetId = currentDataset.id
    const isStale = () => cancelled || currentDataset.id !== datasetId
    const effectiveRowCount =
      typeof currentDataset.dataRowCount === 'number' && currentDataset.dataRowCount > 0
        ? currentDataset.dataRowCount
        : currentDataset.rowCount

    // Fetch all column data from backend cache
    const columnIds = currentDataset.columns.map(col => col.id)
    const columnKeyToId = new Map<string, string>()
    currentDataset.columns.forEach((col) => {
      columnKeyToId.set(col.id, col.id)
      if (col.name) {
        columnKeyToId.set(col.name, col.id)
        columnKeyToId.set(col.name.toLowerCase(), col.id)
      }
      columnKeyToId.set(col.id.toLowerCase(), col.id)
    })
    console.log('[ColumnSelection] Loading data', {
      datasetId: currentDataset.id,
      columnCount: columnIds.length,
      effectiveRowCount,
      dataRowCount: currentDataset.dataRowCount,
      rowCount: currentDataset.rowCount,
    })

    const loadSampleRows = async () => {
      const ranges = buildSampleRanges(effectiveRowCount)
      console.log('[ColumnSelection] Sample ranges:', ranges)
      if (ranges.length === 0) {
        console.warn('[ColumnSelection] No sample ranges - effectiveRowCount may be 0')
        setRowData(new Map())
        setIsSampledRowData(true)
        setIsLoadingColumns(false)
        return
      }

      try {
        const rangeResults = await Promise.all(
          ranges.map(range => cacheService.getRowsHybrid(currentDataset.id, range.start, range.end))
        )

        const dataMap = new Map<number, Record<string, unknown>>()
        ranges.forEach((range, idx) => {
          const rows = rangeResults[idx] ?? []
          rows.forEach((row, offset) => {
            const normalized: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(row)) {
              const mapped = columnKeyToId.get(key) ?? columnKeyToId.get(key.toLowerCase())
              if (mapped) {
                normalized[mapped] = value
              }
            }
            dataMap.set(range.start + offset, normalized)
          })
        })

        if (isStale()) return

        console.log('[ColumnSelection] Sampled rows loaded:', {
          totalRows: dataMap.size,
          ranges: ranges.length,
          firstRowKeys: dataMap.size > 0 ? Object.keys(dataMap.values().next().value ?? {}).length : 0,
        })
        if (dataMap.size > 0) {
          const firstRow = dataMap.values().next().value ?? {}
          const keyCount = Object.keys(firstRow).length
          if (keyCount > 0 && keyCount < currentDataset.columns.length) {
            console.warn('[ColumnSelection] Sampled rows returned fewer columns than dataset metadata', {
              keyCount,
              datasetColumns: currentDataset.columns.length,
            })
          }
        }
        setRowData(dataMap)
        setIsSampledRowData(true)
        setIsLoadingColumns(false)
      } catch (error) {
        console.error('[ColumnSelection] Failed to fetch sampled rows for classification:', error)
        if (isStale()) return
        setRowData(new Map())
        setIsSampledRowData(true)
        setIsLoadingColumns(false)
      }
    }

    const loadColumnData = async () => {
      try {
        await ensureProjectId()
        const shouldPrewarm = effectiveRowCount >= PREWARM_ROW_THRESHOLD
        if (shouldPrewarm) {
          void loadSampleRows()
        }
        await cacheService.ensureLatestCache(currentDataset.id)
        const storageInfo = await cacheService.getDatasetStorageInfo(currentDataset.id)
        const usesDuckDb = !!storageInfo.duckdbPath

        if (storageInfo.isLarge) {
          const hasInvalidatedColumns = currentDataset.columns.some(col => isColumnInvalidated(col.id))
          if (hasInvalidatedColumns) {
            await loadSampleRows()
            return
          }

          try {
            // Large datasets: render quickly from samples, then hydrate stats in background.
            void loadSampleRows()
            const stats = await cacheService.getAllColumnStats(currentDataset.id)
            const statsMap = new Map<string, ColumnClassificationStats>()
            for (const stat of stats) {
              statsMap.set(stat.columnId, stat)
            }
            if (isStale()) return
            setColumnStats(statsMap)
            setIsSampledRowData(false)
            setIsLoadingColumns(false)
            return
          } catch (error) {
            console.error('Failed to fetch column stats:', error)
          }

          await loadSampleRows()
          return
        }

        if (usesDuckDb) {
          try {
            const stats = await cacheService.getAllColumnStats(currentDataset.id)
            const statsMap = new Map<string, ColumnClassificationStats>()
            for (const stat of stats) {
              statsMap.set(stat.columnId, stat)
            }
            if (isStale()) return
            setColumnStats(statsMap)
            setIsSampledRowData(false)
            setIsLoadingColumns(false)
            return
          } catch (error) {
            console.error('Failed to fetch column stats:', error)
          }
        }

        const columnsData = await cacheService.getColumnsData(currentDataset.id, columnIds)
        if (isStale()) return
        // Convert column-oriented data to row-oriented Map for classification
        const dataMap = new Map<number, Record<string, unknown>>()
        for (let rowIdx = 0; rowIdx < effectiveRowCount; rowIdx++) {
          const row: Record<string, unknown> = {}
          for (const colId of columnIds) {
            row[colId] = columnsData[colId]?.[rowIdx]
          }
          dataMap.set(rowIdx, row)
        }
        setRowData(dataMap)
        setIsSampledRowData(false)
        setIsLoadingColumns(false)
      } catch (error) {
        console.error('Failed to fetch column data for classification:', error)
        await loadSampleRows()
      }
    }

    void loadColumnData()
    return () => {
      cancelled = true
    }
  }, [currentDataset, isOpen])

  // Classify all columns when dialog opens (with caching and invalidation support)
  // Phase 4 Fix: Filter out placeholder/empty columns
  // Phase 5: Uses shouldReclassifyColumn() to check if reclassification is needed
  useEffect(() => {
    if (!currentDataset || !isOpen) {
      setColumnItems([])
      return
    }

    if (isLoadingColumns) {
      setColumnItems([])
      return
    }

    if (!columnStats && rowData.size === 0) {
      console.warn('[ColumnSelection] No column stats or row data available for classification yet', {
        columnStatsNull: columnStats === null,
        rowDataSize: rowData.size,
        datasetColumns: currentDataset.columns.length,
        datasetRowCount: currentDataset.rowCount,
        datasetDataRowCount: currentDataset.dataRowCount,
      })
      setColumnItems([])
      return
    }

    console.log('[ColumnSelection] Starting column classification', {
      hasColumnStats: !!columnStats,
      columnStatsSize: columnStats?.size ?? 0,
      rowDataSize: rowData.size,
      columnCount: currentDataset.columns.length,
      isSampledRowData,
    })

    const items: ColumnItem[] = []

    for (const col of currentDataset.columns) {
      const stats = columnStats?.get(col.id)
      const detectedClassification = stats
        ? getOrClassifyColumnFromStats(
          col.id,
          col.name,
          stats,
          shouldReclassifyColumn,
          getColumnClassification,
          setColumnClassification,
          clearInvalidation
        )
        : getOrClassifyColumn(
          col.id,
          col.name,
          rowData,
          shouldReclassifyColumn,
          getColumnClassification,
          setColumnClassification,
          clearInvalidation
        )
      const overrideType = getColumnTypeOverride(currentDataset.id, col.id)
      const classification = applyColumnTypeOverride(
        detectedClassification,
        mapPersistedOverrideToUi(overrideType)
      )

      // Skip placeholder columns (empty or no valid data)
      // These are extended columns with no real data
      if (!isSampledRowData && detectedClassification.dataType === ColumnDataType.Empty) {
        continue
      }

      // Also skip columns with generic placeholder names that are empty
      // e.g., "Column 1", "Column 2" with no data
      const isPlaceholderName = /^Column \d+$/i.test(col.name)
      if (!isSampledRowData && isPlaceholderName && classification.numericValues === 0 && classification.categoricalValues === 0) {
        continue
      }

      // Validation errors for this column
      const colErrors = validationErrors.filter(
        err => err.field === col.name || err.message.includes(col.name)
      )

      items.push({
        id: col.id,
        name: col.name,
        classification,
        isSelected: false,
        validationErrors: colErrors,
      })
    }

    setColumnItems(items)
  }, [
    currentDataset,
    isOpen,
    rowData,
    columnStats,
    isLoadingColumns,
    isSampledRowData,
    validationErrors,
    shouldReclassifyColumn,
    getColumnClassification,
    setColumnClassification,
    clearInvalidation,
    getColumnTypeOverride,
    currentDataset,
  ])

  const handleColumnTypeChange = useCallback(
    (columnId: string, selectedValue: string) => {
      if (!currentDataset) return
      const overrideType: ColumnTypeOverride | null =
        selectedValue === AUTO_TYPE_VALUE ? null : (selectedValue as ColumnTypeOverride)
      setColumnTypeOverride(currentDataset.id, columnId, overrideType)
      setColumnItems((prev) =>
        prev.map((item) => {
          if (item.id !== columnId) return item
          const detectedType = item.classification.detectedType ?? item.classification.dataType
          const baseClassification: ColumnClassification = {
            ...item.classification,
            dataType: detectedType,
            effectiveType: detectedType,
            overrideType: undefined,
          }
          return {
            ...item,
            classification: applyColumnTypeOverride(
              baseClassification,
              mapPersistedOverrideToUi(overrideType)
            ),
          }
        })
      )
    },
    [currentDataset, setColumnTypeOverride]
  )

  // Handle column selection
  const handleColumnClick = useCallback(
    (columnId: string) => {
      setSelectedColumns(prev => {
        if (mode === 'single') {
          return [columnId]
        } else if (mode === 'multiple') {
          return prev.includes(columnId)
            ? prev.filter(id => id !== columnId)
            : [...prev, columnId]
        } else if (mode === 'paired') {
          // Paired mode: max 2 columns
          if (prev.includes(columnId)) {
            return prev.filter(id => id !== columnId)
          } else if (prev.length < 2) {
            return [...prev, columnId]
          } else {
            // Replace the oldest selection with the latest column
            const replacement = prev[1]
            return replacement ? [replacement, columnId] : [columnId]
          }
        }
        return prev
      })
    },
    [mode]
  )

  // Handle select all toggle
  const handleSelectAll = useCallback(() => {
    if (mode !== 'multiple') return

    const allSelected = columnItems.length > 0 && selectedColumns.length === columnItems.length
    setSelectedColumns(allSelected ? [] : columnItems.map(item => item.id))
  }, [mode, columnItems, selectedColumns.length])

  // Handle confirm
  const handleConfirm = useCallback(() => {
    if (selectedColumns.length === 0) return

    // Map column IDs to names
    const selectedInfo: SelectedColumnInfo[] = columnItems
      .filter(item => selectedColumns.includes(item.id))
      .map(item => ({
        id: item.id,
        name: item.name,
        detectedType: item.classification.detectedType ?? item.classification.dataType,
        overrideType: item.classification.overrideType,
        effectiveType: item.classification.effectiveType ?? item.classification.dataType,
      }))

    onSelect(selectedInfo)
    onClose()
  }, [selectedColumns, columnItems, onSelect, onClose])

  // Get suggested tests for selected columns
  const suggestedTests = useMemo(() => {
    if (selectedColumns.length === 0) return []

    const selectedItems = columnItems.filter(item => selectedColumns.includes(item.id))

    // Aggregate suggested tests from all selected columns
    const allSuggestions = new Set<string>()
    selectedItems.forEach(item => {
      item.classification.suggestedTests.forEach(test => allSuggestions.add(test))
    })

    return Array.from(allSuggestions)
  }, [selectedColumns, columnItems])

  const allColumnsSelected = columnItems.length > 0 && selectedColumns.length === columnItems.length

  if (!isOpen || !currentDataset) return null

  return (
    <ResizableDialog
      open={isOpen}
      onOpenChange={(open) => !open && onClose()}
      defaultWidth={850}
      defaultHeight={700}
      minWidth={650}
      minHeight={500}
      persistKey="column-selection-dialog"
    >
      <ResizableDialogContent className="flex flex-col p-0">
        {/* Header */}
        <ResizableDialogHeader className="px-6 pt-4 pb-3">
          <ResizableDialogTitle>{title}</ResizableDialogTitle>
        </ResizableDialogHeader>

        {/* Description - shows requirements */}
        <div
          style={{
            padding: '1rem 1.5rem',
            backgroundColor: 'var(--background-secondary)',
            fontSize: '0.875rem',
            color: 'var(--text-muted)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          {testDef ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <div>
                <strong>{testDef.displayName}</strong>
              </div>
              <div style={{ fontSize: '0.8rem' }}>
                {testDef.id === 'independent_ttest' ? (
                  'Pick a categorical variable and numeric variable'
                ) : testDef.id === 'paired_ttest' ? (
                  'Pick a time/condition variable (2 values) and numeric variable (equal n required)'
                ) : testDef.id === 'wilcoxon' ? (
                  'Pick a time/condition variable (2 values) and numeric variable (equal n required)'
                ) : testDef.id === 'mann_whitney' ? (
                  'Pick a categorical variable and numeric variable'
                ) : (
                  'Select every column you\'ll need for this test. The next dialog will ask you which one is the dependent variable and which columns act as factors/baselines.'
                )}
              </div>
              {testDef.id !== 'independent_ttest' && testDef.id !== 'paired_ttest' && testDef.id !== 'wilcoxon' && testDef.id !== 'mann_whitney' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                  {(testDef.id.startsWith('synergy_')
                    ? testDef.requiredDataFields
                    : testDef.requiredDataFields.filter(f => f.required !== false)
                  ).map(field => {
                      const minColumns = field.multiple ? field.minColumns ?? 2 : 1
                      const requirement =
                        field.required === false
                          ? 'Optional'
                          : field.multiple
                            ? `≥${minColumns}`
                            : '1'
                      return (
                        <div key={field.name} style={{ fontSize: '0.8rem' }}>
                          <span style={{ fontWeight: 600 }}>{requirement}</span>{' '}
                          {field.type ? field.type.toUpperCase() : 'COLUMN'} - {field.label}
                          {field.multiple ? ' (pooled selection)' : ''}
                          {field.required === false ? ' (optional)' : ''}
                        </div>
                      )
                    })}
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.75rem' }}>
                <span aria-live="polite" aria-atomic="true">
                  {isVariableColumnCount ? (
                    isSurvivalTest ? (
                      <>Selected: {selectedColumns.length} cols</>
                    ) : (
                      <>Selected: {selectedColumns.length} (min {requiredColumnCount})</>
                    )
                  ) : (
                    <>Selected: {selectedColumns.length} / {requiredColumnCount} required</>
                  )}
                </span>
                {mode === 'multiple' && columnItems.length > 0 && !isLoadingColumns && (
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    aria-pressed={allColumnsSelected}
                    aria-label={allColumnsSelected ? 'Deselect all columns' : 'Select all columns'}
                    style={{
                      padding: '0.25rem 0.625rem',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      border: '1px solid var(--border)',
                      borderRadius: '4px',
                      backgroundColor: 'var(--background)',
                      color: 'var(--text)',
                    }}
                  >
                    {allColumnsSelected ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </div>
              {testDef.id !== 'independent_ttest' && testDef.id !== 'paired_ttest' && testDef.id !== 'wilcoxon' && testDef.id !== 'mann_whitney' && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Choose the dependent variable and factor roles.
                </span>
              )}
            </div>
          ) : requiredType ? (
            <>
              Select {mode === 'single' ? 'a' : mode === 'paired' ? 'two' : ''} {requiredType} column
              {mode !== 'single' ? 's' : ''} for this test.
            </>
          ) : (
            'Select columns for analysis'
          )}
        </div>

        {/* Column list */}
        <div
          role="region"
          aria-label="Available columns"
          aria-busy={isLoadingColumns}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '1rem 1.5rem',
          }}
        >
          {isLoadingColumns && (
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '2rem',
                color: 'var(--text-muted)',
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  width: '24px',
                  height: '24px',
                  border: '3px solid var(--border)',
                  borderTopColor: 'var(--accent)',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                  marginBottom: '0.75rem',
                }}
              />
              <span style={{ fontSize: '0.875rem' }}>Detecting columns...</span>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}
          {!isLoadingColumns && isSampledRowData && (
            <div
              style={{
                padding: '0.5rem',
                marginBottom: '0.5rem',
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                backgroundColor: 'var(--background-secondary)',
                borderRadius: '4px',
              }}
            >
              Column detection uses sampled rows for this dataset. If a column looks empty, it may contain data outside the sample.
            </div>
          )}
          {!isLoadingColumns && columnItems.map(item => {
            const isSelected = selectedColumns.includes(item.id)
            const hasErrors = item.validationErrors.some(err => err.severity === 'error')

            return (
              <button
                type="button"
                key={item.id}
                onClick={() => handleColumnClick(item.id)}
                aria-pressed={isSelected}
                aria-label={`${item.name}, ${item.classification.effectiveType ?? item.classification.dataType}${isSelected ? ', selected' : ''}`}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  font: 'inherit',
                  padding: '0.75rem',
                  marginBottom: '0.5rem',
                  border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: '4px',
                  cursor: 'pointer',
                  backgroundColor: isSelected
                    ? 'var(--background-tertiary)'
                    : 'var(--background)',
                  transition: 'all 0.15s ease',
                }}
              >
                {/* Column name and type badge */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <strong style={{ fontSize: '1rem' }}>{item.name}</strong>
                    <span
                      style={{
                        padding: '0.125rem 0.5rem',
                        borderRadius: '12px',
                        backgroundColor: getTypeBadgeColor(item.classification.dataType),
                        color: 'white',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                      }}
                    >
                      {item.classification.effectiveType ?? item.classification.dataType}
                    </span>
                    {item.classification.overrideType && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          color: 'var(--text-muted)',
                          fontStyle: 'italic',
                        }}
                      >
                        manual
                      </span>
                    )}
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                      }}
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => event.stopPropagation()}
                    >
                      Type
                      <select
                        value={item.classification.overrideType ?? AUTO_TYPE_VALUE}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => handleColumnTypeChange(item.id, event.target.value)}
                        style={{
                          fontSize: '0.75rem',
                          border: '1px solid var(--border)',
                          borderRadius: '4px',
                          backgroundColor: 'var(--background)',
                          color: 'var(--text)',
                          padding: '0.125rem 0.35rem',
                        }}
                      >
                        <option value={AUTO_TYPE_VALUE}>
                          Auto ({item.classification.detectedType ?? item.classification.dataType})
                        </option>
                        {TYPE_OVERRIDE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  {/* Quality indicator removed (percent-based) */}
                </div>

                {/* Stats row */}
                <div
                  style={{
                    display: 'flex',
                    gap: '1rem',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    marginBottom: '0.5rem',
                  }}
                >
                  <span>
                    {item.classification.uniqueValueCount} unique value
                    {item.classification.uniqueValueCount !== 1 ? 's' : ''}
                  </span>
                  {item.classification.hasMissingData && (
                    <span style={{ color: '#f59e0b' }}>
                      {item.classification.missingValues} missing value
                      {item.classification.missingValues !== 1 ? 's' : ''}
                    </span>
                  )}
                  {item.classification.minNumericValue !== undefined && (
                    <span>
                      Range: {item.classification.minNumericValue.toFixed(2)} -{' '}
                      {item.classification.maxNumericValue?.toFixed(2)}
                    </span>
                  )}
                </div>

                {/* Validation errors/warnings */}
                {item.validationErrors.map((err, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '0.5rem',
                      marginTop: '0.5rem',
                      borderRadius: '4px',
                      backgroundColor:
                        err.severity === 'error'
                          ? 'rgba(239, 68, 68, 0.1)'
                          : 'rgba(245, 158, 11, 0.1)',
                      borderLeft: `3px solid ${err.severity === 'error' ? '#ef4444' : '#f59e0b'}`,
                      fontSize: '0.75rem',
                      color: err.severity === 'error' ? '#ef4444' : '#f59e0b',
                    }}
                  >
                    {err.message}
                  </div>
                ))}

                {/* Suggested tests (if no errors) */}
                {!hasErrors && item.classification.suggestedTests.length > 0 && (
                  <div
                    style={{
                      marginTop: '0.5rem',
                      fontSize: '0.75rem',
                      color: 'var(--text-muted)',
                    }}
                  >
                    Suggested: {item.classification.suggestedTests.slice(0, 3).join(', ')}
                  </div>
                )}
              </button>
            )
          })}
        </div>

        {/* Suggested tests for selection */}
        {suggestedTests.length > 0 && (
          <div
            style={{
              padding: '0.75rem 1.5rem',
              backgroundColor: 'var(--background-secondary)',
              fontSize: '0.875rem',
            }}
          >
            <strong>Suggested tests:</strong> {suggestedTests.join(', ')}
          </div>
        )}

        {/* Footer buttons - validates column count from registry */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.5rem',
            alignItems: 'center',
            padding: '1rem 1.5rem',
            borderTop: '1px solid var(--border)',
          }}
        >
          {/* Validation message */}
          {selectedColumns.length > 0 && selectedColumns.length < requiredColumnCount && (
            <span style={{ fontSize: '0.75rem', color: '#f59e0b', marginRight: 'auto' }}>
              Need {requiredColumnCount - selectedColumns.length} more column(s)
            </span>
          )}
          <button
            onClick={onClose}
            style={{
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              cursor: 'pointer',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              backgroundColor: 'var(--background)',
              color: 'var(--text)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={selectedColumns.length < requiredColumnCount}
            style={{
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              cursor: selectedColumns.length < requiredColumnCount ? 'not-allowed' : 'pointer',
              border: 'none',
              borderRadius: '4px',
              backgroundColor: selectedColumns.length < requiredColumnCount ? 'var(--border)' : 'var(--accent)',
              color: 'white',
              opacity: selectedColumns.length < requiredColumnCount ? 0.5 : 1,
            }}
          >
            {isVariableColumnCount
              ? `Run Analysis (${selectedColumns.length} cols)`
              : `Run Analysis (${selectedColumns.length}/${requiredColumnCount})`}
          </button>
        </div>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}

export default ColumnSelectionDialog
