/**
 * CreatePlotDialog Component - Phase 1 Plots Feature
 *
 * Modal dialog for creating user-derived plots.
 * - Plot type selector (tabs)
 * - Column→role dropdowns populated from current dataset
 * - Live preview updates as selections change
 *
 * Based on Data Formulator patterns with easyCris styling.
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import {
  ResizableDialog,
  ResizableDialogContent,
  ResizableDialogDescription,
  ResizableDialogFooter,
  ResizableDialogHeader,
  ResizableDialogTitle,
} from '@/components/ui/resizable-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PlotTypeSelector } from './PlotTypeSelector'
import { ColumnRoleDropdown } from './ColumnRoleDropdown'

import { useDataStore } from '@/store/data-store'
import { useResultsStore } from '@/store/results-store'
import { usePlotsStore } from '@/store/plots-store'
import { useAppStore } from '@/store/app-store'
import cacheService from '@/services/cacheService'
import plotDataService, { PlotDataError } from '@/services/plotDataService'
import {
  classifyColumnFromStats,
  classifyColumn,
  ColumnDataType,
  type ColumnClassificationStats,
  type ColumnClassification,
} from '@/services/columnDataService'
import { TYPE_CLASSIFICATION_RULES } from '@/lib/classification/typeRules'
import {
  getUserDerivablePlots,
  getPlotTemplate,
  type PlotType,
  type PlotRole,
  type PlotDataType,
} from '@/config/plotRegistry'
import { getPlotBuilder, DEFAULT_COLORS, type PlotBuilderInput } from '@/utils/plotBuilders'
import { normalizeBarSplitTraces } from '@/lib/plots/barSplitTraceNormalization'
import {
  createUserDerivedPlotSpec,
  type PlotSpec,
  type PlotColumn,
} from '@/store/plots-store'
import { toast } from 'sonner'
import { buildPlotSpecsFromResult } from '@/services/plotResultService'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// =============================================================================
// TYPES
// =============================================================================

export interface CreatePlotDialogProps {
  /** Whether dialog is open */
  open: boolean
  /** Callback when dialog should close */
  onClose: () => void
  /** Callback when plot is created */
  onCreatePlot: (plotSpec: PlotSpec) => void
}

/**
 * Column mapping state for form
 */
interface ColumnMapping {
  role: PlotRole
  columnId: string | null
  required: boolean
  label: string
}

/**
 * Column info with inferred type
 */
interface ColumnInfo {
  id: string
  name: string
  inferredType: PlotDataType
}

type PlotSource = 'user_derived' | 'test_result'
const HISTOGRAM_DEFAULT_BINS = 30

// =============================================================================
// COMPONENT
// =============================================================================

export function CreatePlotDialog({
  open,
  onClose,
  onCreatePlot,
}: CreatePlotDialogProps) {
  // Get current dataset from store
  const dataset = useDataStore((s) => s.currentDataset)
  const columns = dataset?.columns ?? []
  const resultsByFamily = useResultsStore((s) => s.resultsByFamily)
  const currentResult = useResultsStore((s) => s.currentResult)
  const activeStatisticsFamilyId = useAppStore((s) => s.activeFamilyId)

  // Local state
  const [plotSource, setPlotSource] = useState<PlotSource>('user_derived')
  const [selectedPlotType, setSelectedPlotType] = useState<PlotType>('box')
  const [columnMappings, setColumnMappings] = useState<Map<PlotRole, string | null>>(new Map())
  const [plotTitle, setPlotTitle] = useState('')
  const [histogramBins, setHistogramBins] = useState(HISTOGRAM_DEFAULT_BINS)
  const [errorBarType, setErrorBarType] = useState<'se' | 'sd' | 'ci' | 'iqr'>('se')
  const [columnStats, setColumnStats] = useState<ColumnClassificationStats[]>([])
  const [columnClassifications, setColumnClassifications] = useState<ColumnClassification[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null)
  const setPlotStats = usePlotsStore((state) => state.setPlotStats)
  const getPlotsByResult = usePlotsStore((state) => state.getPlotsByResult)
  const setActivePlot = usePlotsStore((state) => state.setActivePlot)
  const updatePlot = usePlotsStore((state) => state.updatePlot)

  // Get user-derivable plot types
  const availablePlotTypes = useMemo(() => {
    const templates = getUserDerivablePlots()
    return templates.map((t) => t.id)
  }, [])

  const familyResults = useMemo(() => {
    const familyId = activeStatisticsFamilyId ?? 'statistics-1'
    return resultsByFamily[familyId] ?? []
  }, [resultsByFamily, activeStatisticsFamilyId])

  const sortedResults = useMemo(() => {
    return [...familyResults].sort(
      (a, b) => b.executedAt.getTime() - a.executedAt.getTime()
    )
  }, [familyResults])

  const selectedResult = useMemo(() => {
    if (!selectedResultId) return null
    return sortedResults.find((result) => result.id === selectedResultId) ?? null
  }, [sortedResults, selectedResultId])

  const testResultPayloads = useMemo(() => {
    if (plotSource !== 'test_result' || !selectedResult) return []
    return buildPlotSpecsFromResult(selectedResult)
  }, [plotSource, selectedResult])

  const isPlaceholderPlot = useCallback((plot: PlotSpec): boolean => {
    const data = plot.plotlyData
    if (Array.isArray(data)) {
      for (const trace of data) {
        if (trace && typeof trace === 'object') {
          const name = (trace as { name?: unknown }).name
          if (typeof name === 'string' && name.includes('(placeholder)')) {
            return true
          }
        }
      }
    }

    const layout = plot.plotlyLayout as { annotations?: Array<{ text?: unknown }> } | undefined
    if (layout?.annotations && Array.isArray(layout.annotations)) {
      for (const annotation of layout.annotations) {
        if (
          annotation &&
          typeof annotation.text === 'string' &&
          annotation.text.toLowerCase().includes('builder not yet implemented')
        ) {
          return true
        }
      }
    }

    return false
  }, [])

  // Build column info with inferred types
  const columnInfoList = useMemo<ColumnInfo[]>(() => {
    return columns.map((col) => {
      const classification = columnClassifications.find((c) => c.columnId === col.id)
      const stats = columnStats.find((s) => s.columnId === col.id)
      let inferredType: PlotDataType = 'any'

      if (classification) {
        if (classification.dataType === ColumnDataType.Numeric) {
          inferredType = 'numeric'
        } else if (
          classification.dataType === ColumnDataType.Categorical ||
          classification.dataType === ColumnDataType.Binary ||
          classification.dataType === ColumnDataType.Ordinal
        ) {
          inferredType = 'categorical'
        }
      } else if (stats) {
        const classification = classifyColumnFromStats(col.id, col.name, stats)
        // Check numeric ratio to determine type
        if (
          classification.numericRatio >= TYPE_CLASSIFICATION_RULES.mixedRatioForPlotNumericFallback ||
          classification.dataType === ColumnDataType.Numeric
        ) {
          inferredType = 'numeric'
        } else if (
          classification.dataType === ColumnDataType.Categorical ||
          classification.dataType === ColumnDataType.Binary ||
          classification.dataType === ColumnDataType.Ordinal
        ) {
          inferredType = 'categorical'
        }
        // Note: datetime is not a separate type in ColumnDataType enum
        // Mixed and Empty types fall through to 'any'
      }

      return {
        id: col.id,
        name: col.name,
        inferredType,
      }
    })
  }, [columns, columnStats, columnClassifications])

  const hasTypeInfo = useMemo(() => {
    return columnStats.length > 0 || columnClassifications.length > 0
  }, [columnStats.length, columnClassifications.length])

  const loadSampleClassifications = useCallback(
    async (datasetId: string) => {
      if (columns.length === 0) {
        setColumnClassifications([])
        return
      }

      try {
        try {
          await cacheService.ensureLatestCache(datasetId)
        } catch (err) {
          console.error('Failed to flush pending edits before sampling:', err)
        }
        const columnIds = columns.map((col) => col.id)
        const sampled = await cacheService.getColumnsSampledData(datasetId, columnIds, 500, 42)
        const rowCount = columnIds.reduce((max, colId) => {
          const values = sampled[colId] ?? []
          return Math.max(max, values.length)
        }, 0)

        const rowData = new Map<number, Record<string, unknown>>()
        for (let i = 0; i < rowCount; i++) {
          const row: Record<string, unknown> = {}
          for (const colId of columnIds) {
            row[colId] = sampled[colId]?.[i]
          }
          rowData.set(i, row)
        }

        const classifications = columns.map((col) => classifyColumn(col.id, col.name, rowData))
        setColumnClassifications(classifications)
      } catch (err) {
        console.error('Failed to classify columns from sample:', err)
        setColumnClassifications([])
      }
    },
    [columns]
  )

  // Get field requirements for selected plot type
  const fieldRequirements = useMemo(() => {
    const template = getPlotTemplate(selectedPlotType)
    if (!template) return []

    const fields: ColumnMapping[] = [
      ...template.requiredFields.map((f) => ({
        role: f.role,
        columnId: columnMappings.get(f.role) ?? null,
        required: true,
        label: f.label,
      })),
      ...template.optionalFields.map((f) => ({
        role: f.role,
        columnId: columnMappings.get(f.role) ?? null,
        required: false,
        label: f.label,
      })),
    ]

    return fields
  }, [selectedPlotType, columnMappings])

  // Load column stats when dialog opens
  useEffect(() => {
    if (open && dataset?.id && plotSource === 'user_derived') {
      let cancelled = false
      setIsLoading(true)
      cacheService
        .ensureLatestCache(dataset.id)
        .catch((err) => {
          console.error('Failed to flush pending edits before loading stats:', err)
        })
        .then(() => cacheService.getAllColumnStats(dataset.id))
        .then((stats) => {
          if (cancelled) return
          setColumnStats(stats)
          if (stats.length === 0) {
            return loadSampleClassifications(dataset.id)
          }
          setColumnClassifications([])
        })
        .catch(async (err) => {
          if (cancelled) return
          console.error('Failed to load column stats:', err)
          await loadSampleClassifications(dataset.id)
        })
        .finally(() => {
          if (!cancelled) {
            setIsLoading(false)
          }
        })
      return () => {
        cancelled = true
      }
    }
  }, [open, dataset?.id, plotSource, loadSampleClassifications])

  // Reset state when plot type changes
  useEffect(() => {
    if (plotSource === 'user_derived') {
      setColumnMappings(new Map())
      const template = getPlotTemplate(selectedPlotType)
      if (template) {
        setPlotTitle(`${template.displayName}`)
      }
    }
  }, [plotSource, selectedPlotType])

  useEffect(() => {
    if (plotSource === 'user_derived' && selectedPlotType === 'histogram') {
      setHistogramBins(HISTOGRAM_DEFAULT_BINS)
    }
  }, [plotSource, selectedPlotType])

  useEffect(() => {
    if (selectedPlotType === 'column_scatter' && errorBarType === 'iqr') {
      setErrorBarType('se')
    }
  }, [selectedPlotType, errorBarType])

  useEffect(() => {
    if (!open || plotSource !== 'test_result') return
    const familyId = activeStatisticsFamilyId ?? 'statistics-1'
    const currentIsInFamily =
      currentResult &&
      (currentResult.statisticsFamilyId ?? familyId) === familyId
    const defaultResult = currentIsInFamily ? currentResult : sortedResults[0] ?? null
    setSelectedResultId(defaultResult?.id ?? null)
    if (defaultResult) {
      setPlotTitle(defaultResult.testName)
    }
  }, [open, plotSource, currentResult, sortedResults, activeStatisticsFamilyId])

  // Handle column assignment
  const handleColumnChange = useCallback((role: PlotRole, columnId: string | null) => {
    setColumnMappings((prev) => {
      const next = new Map(prev)
      if (columnId) {
        next.set(role, columnId)
      } else {
        next.delete(role)
      }
      return next
    })
  }, [])

  // Check if form is valid
  const isFormValid = useMemo(() => {
    if (plotSource === 'test_result') {
      return testResultPayloads.length > 0
    }
    const template = getPlotTemplate(selectedPlotType)
    if (!template) return false

    // All required fields must have a value
    for (const field of template.requiredFields) {
      const value = columnMappings.get(field.role)
      if (!value) return false
    }

    return true
  }, [plotSource, selectedPlotType, columnMappings, testResultPayloads])

  // Handle create plot
  const handleCreate = useCallback(async () => {
    if (!isFormValid) return

    if (plotSource === 'test_result') {
      if (testResultPayloads.length === 0) {
        toast.error('No plot data available for this result')
        return
      }

      // Check if plots already exist for this result
      const firstResultId = testResultPayloads[0]?.plot.resultId
      if (!firstResultId) {
        toast.error('Invalid plot data')
        return
      }
      const existing = getPlotsByResult(firstResultId)
      if (existing.length > 0) {
        const existingByKey = new Map(
          existing.map((plot) => [`${plot.type}|${plot.title ?? ''}`, plot])
        )
        let replaced = 0
        for (const payload of testResultPayloads) {
          const key = `${payload.plot.type}|${payload.plot.title ?? ''}`
          const existingPlot = existingByKey.get(key)
          if (!existingPlot || !isPlaceholderPlot(existingPlot)) continue
          const { id: _id, sourceType: _sourceType, createdAt: _createdAt, ...updates } =
            payload.plot
          updatePlot(existingPlot.id, updates)
          setPlotStats(existingPlot.id, payload.stats)
          replaced += 1
        }
        if (replaced > 0) {
          setActivePlot(existing[0]?.id ?? null)
          toast.info('Updated existing plot for this result')
          onClose()
          return
        }
        setActivePlot(existing[0]?.id ?? null)
        toast.info('Plot already saved for this result')
        onClose()
        return
      }

      // Create all plots from recipe/builder
      for (const payload of testResultPayloads) {
        const title = plotTitle || payload.plot.title
        const currentLayout = (payload.plot.plotlyLayout ?? {}) as {
          title?: string | { text?: string }
        }
        const layoutTitle =
          typeof currentLayout.title === 'object' && currentLayout.title !== null
            ? { ...currentLayout.title, text: title }
            : { text: title }
        const plotSpec = {
          ...payload.plot,
          title,
          plotlyLayout: {
            ...currentLayout,
            title: layoutTitle,
          },
          updatedAt: new Date().toISOString(),
          statisticsFamilyId:
            payload.plot.statisticsFamilyId ??
            activeStatisticsFamilyId ??
            'statistics-1',
        }
        onCreatePlot(plotSpec)
        setPlotStats(plotSpec.id, payload.stats)
      }

      // Set first plot as active
      if (testResultPayloads[0]) {
        setActivePlot(testResultPayloads[0].plot.id)
      }

      onClose()
      return
    }

    if (!dataset) return

    setIsLoading(true)

    try {
      // Build PlotColumn placeholders (values filled after data fetch)
      const plotColumns: PlotColumn[] = []
      for (const [role, columnId] of columnMappings) {
        if (!columnId) continue
        const colInfo = columnInfoList.find((c) => c.id === columnId)
        if (!colInfo) continue
        plotColumns.push({
          role,
          columnId,
          columnName: colInfo.name,
          values: [],
          inferredType: colInfo.inferredType,
        })
      }

      // Temporary spec for cap evaluation + data fetch
      const tempSpec = createUserDerivedPlotSpec({
        id: `plot-preview-${Date.now()}`,
        type: selectedPlotType,
        title: plotTitle,
        statisticsFamilyId: activeStatisticsFamilyId ?? 'statistics-1',
        datasetId: dataset.id,
        columns: plotColumns,
        totalRows: 0,
        sampledRows: 0,
        plotlyData: [],
        plotlyLayout: {},
        plotlyConfig: {},
        dataPolicy: 'raw',
        samplingConfig: null,
        aggregationConfig: null,
      })

      const plotData = await plotDataService.getPlotData(tempSpec, dataset.id)

      const filledColumns: PlotColumn[] =
        plotData.type === 'aggregated'
          ? plotData.columns.map((col) => ({
              role: col.role,
              columnId: col.columnId,
              columnName: col.columnName,
              values: col.values,
              inferredType: col.inferredType,
            }))
          : (() => {
              const columnsData = new Map(plotData.columns.map((c) => [c.columnId, c.values]))
              return plotColumns.map((col) => ({
                ...col,
                values: columnsData.get(col.columnId) ?? [],
              }))
            })()

      // Build plot
      const builder = getPlotBuilder(selectedPlotType)
      const input: PlotBuilderInput = {
        source: 'user_derived',
        testResult: null,
        columns: filledColumns,
        dataPolicy: plotData.type,
        samplingConfig: plotData.samplingConfig,
        aggregationConfig: plotData.aggregationConfig,
        options: {
          title: plotTitle,
          showLegend: true,
          showGrid: true,
          colorPalette: DEFAULT_COLORS,
          histogramBins: selectedPlotType === 'histogram' ? histogramBins : undefined,
          errorBarType,
          splitTraces: selectedPlotType === 'bar',
        },
      }
      const output = builder(input)
      const normalizedOutputData =
        selectedPlotType === 'bar'
          ? normalizeBarSplitTraces(output.data).data
          : output.data

      // Create PlotSpec
      const plotSpec = createUserDerivedPlotSpec({
        id: `plot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: selectedPlotType,
        title: plotTitle,
        statisticsFamilyId: activeStatisticsFamilyId ?? 'statistics-1',
        datasetId: dataset.id,
        columns: filledColumns,
        totalRows: plotData.sampledFrom ?? plotData.rowCount,
        sampledRows: plotData.rowCount,
        plotlyData: normalizedOutputData,
        plotlyLayout: output.layout,
        plotlyConfig: output.config,
        dataPolicy: output.dataPolicy,
        samplingConfig: output.samplingConfig,
        aggregationConfig: output.aggregationConfig,
      })

      onCreatePlot(plotSpec)
      setPlotStats(plotSpec.id, output.stats)
      onClose()
    } catch (err) {
      if (err instanceof PlotDataError) {
        toast.error(err.message)
      } else {
        console.error('Failed to create plot:', err)
        toast.error('Failed to create plot')
      }
    } finally {
      setIsLoading(false)
    }
  }, [
    isFormValid,
    dataset,
    plotSource,
    testResultPayloads,
    getPlotsByResult,
    setActivePlot,
    columnMappings,
    columnInfoList,
    selectedPlotType,
    plotTitle,
    histogramBins,
    errorBarType,
    activeStatisticsFamilyId,
    onCreatePlot,
    onClose,
    setPlotStats,
  ])

  // Filter columns based on field requirements
  const getColumnsForRole = useCallback(
    (role: PlotRole): ColumnInfo[] => {
      const template = getPlotTemplate(selectedPlotType)
      if (!template) return columnInfoList
      if (!hasTypeInfo) return columnInfoList

      // Find the field definition
      const field = [...template.requiredFields, ...template.optionalFields].find((f) => f.role === role)
      if (!field) return columnInfoList

      // Filter by data type if specified
      if (field.dataType === 'any') {
        return columnInfoList
      }

      return columnInfoList.filter((col) => {
        if (field.dataType === 'numeric') return col.inferredType === 'numeric'
        if (field.dataType === 'categorical') return col.inferredType === 'categorical'
        if (field.dataType === 'datetime') return col.inferredType === 'datetime'
        return true
      })
    },
    [selectedPlotType, columnInfoList]
  )

  return (
    <ResizableDialog
      open={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      defaultWidth={750}
      defaultHeight={700}
      minWidth={600}
      minHeight={500}
      persistKey="create-plot"
    >
      <ResizableDialogContent className="flex flex-col p-0">
        <ResizableDialogHeader className="px-6 pt-6 pb-4 border-b flex-shrink-0">
          <ResizableDialogTitle>Create New Plot</ResizableDialogTitle>
          <ResizableDialogDescription>
            {plotSource === 'test_result'
              ? 'Select a test result to generate a plot.'
              : 'Select a plot type and assign columns from your data.'}
          </ResizableDialogDescription>
        </ResizableDialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6">
          <div className="space-y-6 py-4">
            {/* Plot Source */}
            <div className="space-y-2">
              <Label>Plot Source</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={plotSource === 'user_derived' ? 'default' : 'outline'}
                  onClick={() => setPlotSource('user_derived')}
                >
                  From Data
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={plotSource === 'test_result' ? 'default' : 'outline'}
                  onClick={() => setPlotSource('test_result')}
                  disabled={sortedResults.length === 0}
                >
                  From Test Results
                </Button>
              </div>
              {sortedResults.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Run a statistical test to enable test result plots.
                </p>
              )}
            </div>

            {plotSource === 'test_result' ? (
              <div className="space-y-2">
                <Label>Test Result</Label>
                <Select
                  value={selectedResultId ?? ''}
                  onValueChange={(value) => setSelectedResultId(value)}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select a test result" />
                  </SelectTrigger>
                  <SelectContent>
                    {sortedResults.map((result) => (
                      <SelectItem key={result.id} value={result.id}>
                        {result.testName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedResult && (
                  <p className="text-xs text-muted-foreground">
                    {selectedResult.family} • {selectedResult.executedAt.toLocaleString()}
                  </p>
                )}
              </div>
            ) : (
              <>
                {/* Plot Type Selector */}
                <div className="space-y-2">
                  <Label>Plot Type</Label>
                  <PlotTypeSelector
                    plotTypes={availablePlotTypes}
                    selected={selectedPlotType}
                    onSelect={setSelectedPlotType}
                  />
                </div>

                {/* Column Assignments */}
                <div className="space-y-4">
                  <Label>Column Assignments</Label>
                  <div className="grid gap-3">
                    {fieldRequirements.map((field) => {
                      const filteredColumns = getColumnsForRole(field.role)
                      return (
                        <ColumnRoleDropdown
                          key={field.role}
                          role={field.role}
                          label={field.label}
                          required={field.required}
                          value={field.columnId}
                          columns={filteredColumns}
                          onChange={handleColumnChange}
                        />
                      )
                    })}
                  </div>
                </div>

                {selectedPlotType === 'histogram' && (
                  <div className="space-y-2">
                    <Label htmlFor="histogram-bins">Bins</Label>
                    <Input
                      id="histogram-bins"
                      type="number"
                      min={1}
                      step={1}
                      value={histogramBins}
                      onChange={(e) => {
                        const next = Number(e.target.value)
                        setHistogramBins(
                          Number.isFinite(next) && next > 0
                            ? Math.floor(next)
                            : HISTOGRAM_DEFAULT_BINS
                        )
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Default is {HISTOGRAM_DEFAULT_BINS} bins.
                    </p>
                  </div>
                )}

                {(selectedPlotType === 'bar' || selectedPlotType === 'grouped_bar' || selectedPlotType === 'line' || selectedPlotType === 'column_scatter') && (
                  <div className="space-y-2">
                    <Label htmlFor="error-bar-type">Error Bars</Label>
                    <Select
                      value={errorBarType}
                      onValueChange={(value) => setErrorBarType(value as 'se' | 'sd' | 'ci' | 'iqr')}
                    >
                      <SelectTrigger id="error-bar-type" className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="se">Standard Error (SE)</SelectItem>
                        <SelectItem value="sd">Standard Deviation (SD)</SelectItem>
                        <SelectItem value="ci">95% Confidence Interval</SelectItem>
                        {selectedPlotType !== 'column_scatter' && (
                          <SelectItem value="iqr">Interquartile Range (IQR)</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}

            {/* Title */}
            <div className="space-y-2">
              <Label htmlFor="plot-title">Title</Label>
              <Input
                id="plot-title"
                value={plotTitle}
                onChange={(e) => setPlotTitle(e.target.value)}
                placeholder="Enter plot title..."
              />
            </div>
          </div>
        </div>

        <ResizableDialogFooter className="px-6 py-4 border-t flex-shrink-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!isFormValid || isLoading}
          >
            {isLoading ? 'Creating...' : 'Create Plot'}
          </Button>
        </ResizableDialogFooter>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}

export default CreatePlotDialog
