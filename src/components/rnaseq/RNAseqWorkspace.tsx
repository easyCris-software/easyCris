/**
 * RNAseqWorkspace Component
 *
 * Main workspace container for RNA-seq analysis.
 * Manages tab navigation and renders appropriate views.
 *
 * Features:
 * - Tab bar for navigation (Counts/Metadata/Results/Plots)
 * - Count matrix and metadata grid views
 * - Results panel with DEG tables
 * - Plot panel with interactive visualizations
 * - Action buttons (import, configure, run analysis)
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDown, Download, FolderDown, Settings2, TableOfContents, Trash2 } from 'lucide-react'
import { SortAscendingIcon } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'
import { useRNAseqStore, useActiveRNAseqProject, useRNAseqAnalysisStatus } from '@/store/rnaseq-store'
import { useDataStore } from '@/store/data-store'
import { useAppStore } from '@/store/app-store'
import { SpreadsheetView } from '@/components/data/SpreadsheetView'
import rnaseqService from '@/services/rnaseqService'
import exportService from '@/services/exportService'
import cacheService from '@/services/cacheService'
import tauriApi from '@/services/tauriApi'
import { toast } from 'sonner'
import { showAppErrorToast } from '@/lib/errors/errorToast'
import { extractAppError, extractErrorMessage } from '@/lib/errors/tauriErrorAdapter'
import { RNAseqTabBar } from './RNAseqTabBar'
import { RNAseqDataImportDialog } from './RNAseqDataImportDialog'
import {
  hasMatchableSamples,
  confirmSampleMismatch,
  getCountSampleIdsWithData,
} from '@/lib/rnaseq/sampleMatchUtils'
import { DESeq2ConfigDialog } from './DESeq2ConfigDialog'
import { DESeq2ResultsTable } from './DESeq2ResultsTable'
import { RNAseqPlotPanel } from './RNAseqPlotPanel'
import { runAnalysisBatchWithLock, type RunModelWithLockContext } from './runAnalysisBatchWithLock'
import type {
  RNAseqTab,
  RNAseqPlotType,
  DESeqModel,
  DESeqResultRun,
  DuplicateGeneLabelPolicy,
} from '@/types/rnaseq'
import { confirm } from '@tauri-apps/plugin-dialog'

type DuplicateSummaryScanMode = 'backend_full' | 'sampled_fallback' | 'scan_failed'

interface RNAseqWorkspaceProps {
  className?: string
  onCopyRequest?: (copy: (() => void | Promise<void>) | null) => void
  onCutRequest?: (cut: (() => void | Promise<void>) | null) => void
  onPasteRequest?: (paste: (() => void | Promise<void>) | null) => void
  onUndoRequest?: (undo: (() => void | Promise<void>) | null) => void
  onRedoRequest?: (redo: (() => void | Promise<void>) | null) => void
}

export function RNAseqWorkspace({
  className,
  onCopyRequest,
  onCutRequest,
  onPasteRequest,
  onUndoRequest,
  onRedoRequest,
}: RNAseqWorkspaceProps) {
  const sanitizeFilenamePart = useCallback((value: string, fallback: string): string => {
    const cleaned = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80)
    return cleaned || fallback
  }, [])

  const getDateStamp = useCallback((date: Date = new Date()): string => {
    return [
      date.getFullYear().toString(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('')
  }, [])

  // Store state
  const activeProject = useActiveRNAseqProject()
  const { isRunning, progress, stage } = useRNAseqAnalysisStatus()
  const {
    setActiveTab,
    setActivePlot,
    setActiveModel,
    setActiveResult,
    setAnalysisRunning,
    setAnalysisProgress,
    setResult,
    clearResult,
    getResult,
    resetCountsDatasetToBlank,
    resetMetadataDatasetToBlank,
  } = useRNAseqStore()
  const appOperationLock = useAppStore((state) => state.appOperationLock)
  const acquireAppOperationLock = useAppStore((state) => state.acquireAppOperationLock)
  const updateAppOperationLock = useAppStore((state) => state.updateAppOperationLock)
  const releaseAppOperationLock = useAppStore((state) => state.releaseAppOperationLock)
  const datasets = useDataStore((state) => state.datasets)
  const currentDatasetId = useDataStore((state) => state.currentDataset?.id ?? null)
  const setCurrentDataset = useDataStore((state) => state.setCurrentDataset)
  const isMutationLocked = appOperationLock.active
  const blockIfLocked = useCallback((activityLabel: string): boolean => {
    const lock = useAppStore.getState().appOperationLock
    if (!lock.active) return false
    toast.warning(`${activityLabel} is unavailable while analysis is running.`, {
      description: lock.stage || lock.operation || 'Please wait for completion.',
    })
    return true
  }, [])

  // Dialog state
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [importType, setImportType] = useState<'counts' | 'metadata'>('counts')
  const [showConfigDialog, setShowConfigDialog] = useState(false)
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null)
  // Allow manual collapse while keeping an active result for plots.
  const [suppressAutoExpand, setSuppressAutoExpand] = useState(false)
  const previousActiveResultIdRef = useRef<string | null>(null)
  const duplicatePolicyCacheRef = useRef<Map<string, DuplicateGeneLabelPolicy>>(new Map())
  const activeBatchProgressRef = useRef<{ batchIndex: number; batchTotal: number }>({
    batchIndex: 1,
    batchTotal: 1,
  })
  const DUPLICATE_SUMMARY_SAMPLE_SIZE = 5000

  // Refs for grid dialog openers (exposed by SpreadsheetView)
  const openSortDialogRef = useRef<(() => void) | null>(null)
  const openGroupDialogRef = useRef<(() => void) | null>(null)

  // Get active project data
  const countsDataset = activeProject?.countsDatasetId
    ? datasets.find((d) => d.id === activeProject.countsDatasetId)
    : null
  const metadataDataset = activeProject?.metadataDatasetId
    ? datasets.find((d) => d.id === activeProject.metadataDatasetId)
    : null

  // Legacy-safe usable row count: prefer dataRowCount (set on import), fall back to rowCount.
  // Blank scaffold datasets have dataRowCount=0, legacy datasets may lack dataRowCount.
  const getUsableRowCount = (ds: typeof countsDataset) => ds?.dataRowCount ?? ds?.rowCount ?? 0
  const countsUsableRows = getUsableRowCount(countsDataset)
  const metadataUsableRows = getUsableRowCount(metadataDataset)

  const modelNameById = useMemo(
    () => new Map((activeProject?.models ?? []).map((model) => [model.id, model.name])),
    [activeProject?.models]
  )
  const modelMainFactorById = useMemo(
    () => new Map((activeProject?.models ?? []).map((model) => [model.id, model.mainFactor])),
    [activeProject?.models]
  )

  const projectResults = activeProject?.results ?? []
  const activeResultId = activeProject?.activeResultId ?? projectResults[0]?.id ?? null
  const activeResult =
    activeProject && activeResultId ? getResult(activeProject.id, activeResultId) : null

  const clearClipboardHandlers = useCallback(() => {
    onCopyRequest?.(null)
    onCutRequest?.(null)
    onPasteRequest?.(null)
    onUndoRequest?.(null)
  }, [onCopyRequest, onCutRequest, onPasteRequest, onUndoRequest])

  useEffect(() => {
    if (!activeProject) {
      clearClipboardHandlers()
      return
    }

    const activeTab = activeProject.activeTab
    const datasetForTab =
      activeTab === 'counts'
        ? countsDataset
        : activeTab === 'metadata'
          ? metadataDataset
          : null

    if (!datasetForTab) {
      clearClipboardHandlers()
    }
  }, [
    activeProject?.id,
    activeProject?.activeTab,
    countsDataset?.id,
    metadataDataset?.id,
    clearClipboardHandlers,
  ])

  // Handlers
  const handleTabChange = useCallback((tab: RNAseqTab) => {
    if (blockIfLocked('Switching tabs')) return
    if (activeProject) {
      setActiveTab(activeProject.id, tab)
    }
  }, [activeProject, blockIfLocked, setActiveTab])

  const handlePlotTypeChange = useCallback((plotType: RNAseqPlotType) => {
    if (activeProject) {
      setActivePlot(activeProject.id, plotType)
    }
  }, [activeProject, setActivePlot])

  const handleImportCounts = useCallback(() => {
    if (blockIfLocked('Import counts')) return
    setImportType('counts')
    setShowImportDialog(true)
  }, [blockIfLocked])

  const handleImportMetadata = useCallback(() => {
    if (blockIfLocked('Import metadata')) return
    setImportType('metadata')
    setShowImportDialog(true)
  }, [blockIfLocked])

  const handleClearDataset = useCallback(async () => {
    if (blockIfLocked('Clear dataset')) return
    if (!activeProject) return

    const activeTab = activeProject.activeTab
    if (activeTab === 'counts' && countsDataset) {
      await resetCountsDatasetToBlank(activeProject.id)
      setCurrentDataset(null)
      toast.success('Count matrix cleared')
    } else if (activeTab === 'metadata' && metadataDataset) {
      await resetMetadataDatasetToBlank(activeProject.id)
      setCurrentDataset(null)
      toast.success('Metadata cleared')
    }
  }, [
    activeProject,
    countsDataset,
    metadataDataset,
    resetCountsDatasetToBlank,
    resetMetadataDatasetToBlank,
    setCurrentDataset,
    blockIfLocked,
  ])

  const getDuplicateGeneLabelSummary = useCallback(async (dataset: NonNullable<typeof countsDataset>) => {
    const firstColumn = dataset.columns[0]
    if (!firstColumn) {
      return {
        duplicateIdCount: 0,
        duplicateRowCount: 0,
        duplicateExamples: [] as string[],
        scanMode: 'backend_full' as DuplicateSummaryScanMode,
      }
    }

    try {
      const summary = await cacheService.getColumnDuplicateSummary(dataset.id, firstColumn.id, 5)
      return { ...summary, scanMode: 'backend_full' as DuplicateSummaryScanMode }
    } catch (error) {
      // Fallback to sampled scan only (avoid full-column load in renderer thread).
      console.warn('Failed to compute duplicate summary via backend; using sampled fallback.', error)
      const sampled = await cacheService.getColumnsSampledData(dataset.id, [firstColumn.id], DUPLICATE_SUMMARY_SAMPLE_SIZE)
      const values = sampled[firstColumn.id] ?? []
      const counts = new Map<string, number>()
      for (const value of values) {
        const normalized = value == null ? '' : String(value).trim()
        if (!normalized) continue
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
      }

      const duplicates = Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1])

      return {
        duplicateIdCount: duplicates.length,
        duplicateRowCount: duplicates.reduce((sum, [, count]) => sum + count - 1, 0),
        duplicateExamples: duplicates.slice(0, 5).map(([label]) => label),
        scanMode: 'sampled_fallback' as DuplicateSummaryScanMode,
      }
    }
  }, [DUPLICATE_SUMMARY_SAMPLE_SIZE, countsDataset])

  const chooseDuplicatePolicy = useCallback(async (
    duplicateIdCount: number,
    duplicateRowCount: number,
    duplicateExamples: string[],
    scanMode: DuplicateSummaryScanMode = 'backend_full'
  ): Promise<DuplicateGeneLabelPolicy | null> => {
    const preview = duplicateExamples.join(', ')
    const tail = duplicateIdCount > duplicateExamples.length ? '…' : ''
    const duplicateSummaryLine = duplicateIdCount > 0
      ? `Detected ${duplicateIdCount} duplicate gene label(s) (${duplicateRowCount} duplicate row(s)) in the first count column.`
      : 'No duplicate labels were detected in the inspected values.'
    const scanLine = scanMode === 'sampled_fallback'
      ? `Full duplicate scan was unavailable. A ${DUPLICATE_SUMMARY_SAMPLE_SIZE.toLocaleString()}-row sample was used, so rare duplicates may be missed.`
      : scanMode === 'scan_failed'
        ? 'Duplicate scan failed, so duplicate presence is unknown.'
        : ''

    const useSum = await confirm(
      `${duplicateSummaryLine}\n` +
      `${scanLine ? `${scanLine}\n` : ''}` +
      `${duplicateExamples.length > 0 ? `Examples: ${preview}${tail}\n` : ''}\n` +
      `OK: Sum duplicate labels (recommended)\n` +
      `Cancel: See other options`,
      { title: 'Duplicate Gene Labels', kind: 'warning' }
    )
    if (useSum) return 'sum_duplicates'

    const useKeepFirst = await confirm(
      `Use "keep first" for duplicate labels?\n\n` +
      `This keeps the first row for each duplicate label and ignores later duplicates.`,
      { title: 'Duplicate Gene Labels', kind: 'warning' }
    )
    if (useKeepFirst) return 'keep_first'

    return null
  }, [])

  const runAnalysisWithModel = useCallback(async (
    model: DESeqModel,
    context?: RunModelWithLockContext
  ) => {
    if (!activeProject) return

    const lock = useAppStore.getState().appOperationLock
    if (lock.active) {
      if (!context?.lockToken || lock.token !== context.lockToken) {
        const message = 'Another operation is already running. Please wait for completion.'
        toast.warning(message)
        throw new Error(message)
      }
    }

    if (!countsDataset || !metadataDataset) {
      toast.error('Load both count matrix and metadata before running RNA-seq analysis.')
      return
    }

    const toastId = `rnaseq-analysis-${Date.now()}`
    const stagePrefix =
      context && context.batchTotal > 1 ? `Model ${context.batchIndex}/${context.batchTotal}: ` : ''
    activeBatchProgressRef.current = {
      batchIndex: context?.batchIndex ?? 1,
      batchTotal: Math.max(context?.batchTotal ?? 1, 1),
    }
    if (context?.lockToken && context.batchTotal > 1) {
      updateAppOperationLock(context.lockToken, {
        stage: `Running model ${context.batchIndex} of ${context.batchTotal}`,
      })
    }
    setActiveModel(activeProject.id, model.id)
    setAnalysisRunning(true)
    setAnalysisProgress(5, `${stagePrefix}Preparing data`)
    toast.loading('Running RNA-seq analysis...', { id: toastId })

    try {
      let duplicatePolicy: DuplicateGeneLabelPolicy | undefined
      let duplicateCount = 0
      if ((model.geneLabelSource ?? 'id_lookup') === 'user_provided') {
        setAnalysisProgress(15, `${stagePrefix}Checking gene labels`)
        try {
          const duplicateSummary = await getDuplicateGeneLabelSummary(countsDataset)
          duplicateCount = duplicateSummary.duplicateIdCount
          const needsPolicySelection = (
            duplicateSummary.duplicateIdCount > 0 ||
            duplicateSummary.scanMode === 'sampled_fallback'
          )
          if (needsPolicySelection) {
            const cacheKey = `${countsDataset.id}:${duplicateSummary.scanMode}:${duplicateSummary.duplicateIdCount}:${duplicateSummary.duplicateRowCount}`
            const cachedPolicy = duplicatePolicyCacheRef.current.get(cacheKey)
            if (cachedPolicy) {
              duplicatePolicy = cachedPolicy
            } else {
                const selectedPolicy = await chooseDuplicatePolicy(
                  duplicateSummary.duplicateIdCount,
                  duplicateSummary.duplicateRowCount,
                  duplicateSummary.duplicateExamples,
                  duplicateSummary.scanMode
                )
              if (!selectedPolicy) {
                toast.dismiss(toastId)
                toast.message('RNA-seq analysis cancelled')
                return
              }
              duplicatePolicyCacheRef.current.set(cacheKey, selectedPolicy)
              duplicatePolicy = selectedPolicy
            }
          }
        } catch (error) {
          console.warn('Failed to inspect duplicate gene labels; requiring explicit policy selection.', error)
          const selectedPolicy = await chooseDuplicatePolicy(0, 0, [], 'scan_failed')
          if (!selectedPolicy) {
            toast.dismiss(toastId)
            toast.message('RNA-seq analysis cancelled')
            return
          }
          duplicatePolicy = selectedPolicy
        }
      }

      setAnalysisProgress(30, `${stagePrefix}Loading data`)
      const result = await rnaseqService.runDESeq2Analysis(
        countsDataset,
        metadataDataset,
        model,
        duplicatePolicy || duplicateCount > 0
          ? {
              duplicatePolicy,
              duplicateCount,
            }
          : undefined
      )

      setAnalysisProgress(85, `${stagePrefix}Processing results`)
      setResult(activeProject.id, model.id, result)
      setActiveTab(activeProject.id, 'results')
      if (!activeProject.activePlotType) {
        setActivePlot(activeProject.id, 'volcano')
      }

      setAnalysisProgress(100, `${stagePrefix}Complete`)
      toast.success('RNA-seq analysis complete', { id: toastId })
    } catch (error) {
      const structuredError = extractAppError(error)
      if (structuredError) {
        showAppErrorToast(structuredError, { id: toastId })
        throw error instanceof Error ? error : new Error(structuredError.message)
      }

      const message = extractErrorMessage(error, 'RNA-seq analysis failed')
      toast.error(`RNA-seq analysis failed: ${message}`, { id: toastId })
      throw error instanceof Error ? error : new Error(message)
    } finally {
      setAnalysisRunning(false)
    }
  }, [
    activeProject,
    countsDataset,
    metadataDataset,
    chooseDuplicatePolicy,
    getDuplicateGeneLabelSummary,
    setActiveModel,
    setActivePlot,
    setActiveTab,
    setAnalysisProgress,
    setAnalysisRunning,
    setResult,
    updateAppOperationLock,
  ])

  const runAnalysisBatch = useCallback(async (models: DESeqModel[]) => {
    const lock = useAppStore.getState().appOperationLock
    if (lock.active) {
      const message = 'Another operation is already running. Please wait for completion.'
      toast.warning(message)
      throw new Error(message)
    }

    await runAnalysisBatchWithLock({
      models,
      lockAdapter: {
        acquire: acquireAppOperationLock,
        update: updateAppOperationLock,
        release: releaseAppOperationLock,
      },
      runModel: runAnalysisWithModel,
    })
  }, [
    acquireAppOperationLock,
    releaseAppOperationLock,
    runAnalysisWithModel,
    updateAppOperationLock,
  ])

  const handleToggleResultRun = useCallback((run: DESeqResultRun) => {
    if (!activeProject) return
    if (expandedResultId === run.id) {
      setExpandedResultId(null)
      setSuppressAutoExpand(true)
      return
    }
    setSuppressAutoExpand(false)
    setExpandedResultId(run.id)
    setActiveResult(activeProject.id, run.id)
    setActiveModel(activeProject.id, run.modelId)
  }, [activeProject, expandedResultId, setActiveModel, setActiveResult])

  const handleDeleteResultRun = useCallback(async (run: DESeqResultRun) => {
    if (blockIfLocked('Deleting result run')) return
    if (!activeProject) return

    const isActive = activeProject.activeResultId === run.id
    const ok = await confirm(
      `Delete result run "${run.label}"?\n\n` +
        `This will remove the run and any plots derived from it.` +
        (isActive
          ? ` The Plots tab will switch to another run if available.`
          : ''),
      {
        title: 'Delete RNA-seq Result',
        kind: 'warning',
      }
    )
    if (!ok) return

    clearResult(activeProject.id, run.id)
  }, [activeProject, blockIfLocked, clearResult])

  const handleExportAllResults = useCallback(async (format: 'csv' | 'xlsx') => {
    if (!activeProject || activeProject.results.length === 0) {
      toast.error('No RNA-seq results to export.')
      return
    }

    // Helper function to sanitize nullable numeric values for export
    // Converts null, NaN, Infinity to empty string to prevent Excel corruption
    const sanitizeNumericValue = (value: number | null): number | string => {
      if (value === null || value === undefined) return ''
      if (typeof value === 'number' && (!Number.isFinite(value) || Number.isNaN(value))) return ''
      return value
    }

    const geneColumns = [
      'geneId',
      'geneSymbol',
      'baseMean',
      'log2FoldChange',
      'lfcSE',
      'stat',
      'pvalue',
      'padj',
      'significant',
      'direction',
      'sigCategory',
    ]

    const results = activeProject.results
    const extension = format
    const formatLabel = format === 'xlsx' ? 'Excel Files' : 'CSV Files'
    const getRunFactorName = (run: DESeqResultRun): string => {
      const modelFactor = modelMainFactorById.get(run.modelId)
      return sanitizeFilenamePart(modelFactor ?? 'rnaseq', 'rnaseq')
    }
    const getBatchFactorName = (runs: DESeqResultRun[]): string => {
      const factors = Array.from(new Set(runs.map((run) => getRunFactorName(run))))
      if (factors.length === 1) return factors[0] ?? 'rnaseq'
      if (factors.length > 1) return 'multi_factor'
      return 'rnaseq'
    }
    const buildDefaultFilename = (factorName: string): string =>
      `${factorName}_result_${getDateStamp()}.${extension}`

    // Single result: use simple single-sheet export
    if (results.length === 1) {
      const run = results[0]!
      const rows = run.genes.map((gene) => ({
        geneId: gene.geneId,
        geneSymbol: gene.geneSymbol,
        baseMean: sanitizeNumericValue(gene.baseMean),
        log2FoldChange: sanitizeNumericValue(gene.log2FoldChange),
        lfcSE: sanitizeNumericValue(gene.lfcSE),
        stat: sanitizeNumericValue(gene.stat),
        pvalue: sanitizeNumericValue(gene.pvalue),
        padj: sanitizeNumericValue(gene.padj),
        significant: gene.significant,
        direction: gene.direction,
        sigCategory: gene.sigCategory,
      }))

      try {
        const defaultFilename = buildDefaultFilename(getRunFactorName(run))
        const savePath = await tauriApi.saveFileDialog(defaultFilename, [
          { name: formatLabel, extensions: [extension] },
        ])
        if (!savePath) return

        const path = format === 'xlsx'
          ? await exportService.exportDataToExcel(rows, geneColumns, savePath, run.label)
          : await exportService.exportDataToCsv(rows, geneColumns, savePath)
        toast.success(`Results exported to ${path}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toast.error(`RNA-seq export failed: ${message}`)
      }
      return
    }

    // Multiple results
    if (format === 'csv') {
      // CSV: export only the most recent run (results are newest-first)
      const mostRecentRun = results[0]!
      const rows = mostRecentRun.genes.map((gene) => ({
        geneId: gene.geneId,
        geneSymbol: gene.geneSymbol,
        baseMean: sanitizeNumericValue(gene.baseMean),
        log2FoldChange: sanitizeNumericValue(gene.log2FoldChange),
        lfcSE: sanitizeNumericValue(gene.lfcSE),
        stat: sanitizeNumericValue(gene.stat),
        pvalue: sanitizeNumericValue(gene.pvalue),
        padj: sanitizeNumericValue(gene.padj),
        significant: gene.significant,
        direction: gene.direction,
        sigCategory: gene.sigCategory,
      }))

      try {
        const defaultFilename = buildDefaultFilename(getRunFactorName(mostRecentRun))
        const savePath = await tauriApi.saveFileDialog(defaultFilename, [
          { name: formatLabel, extensions: [extension] },
        ])
        if (!savePath) return

        const path = await exportService.exportDataToCsv(rows, geneColumns, savePath)
        toast.success(`Most recent run exported to ${path}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        toast.error(`RNA-seq export failed: ${message}`)
      }
      return
    }

    // XLSX with multiple results: use multi-sheet export (one sheet per run)
    // Sanitize and ensure unique sheet names (Excel 31-char limit + no invalid chars)
    const sanitizeSheetName = (name: string): string => {
      // Remove invalid characters: : \ / ? * [ ]
      let cleaned = name.replace(/[:\\\/\?\*\[\]]/g, '-')
      // Truncate to 31 characters
      if (cleaned.length > 31) {
        cleaned = cleaned.slice(0, 28) + '...'
      }
      return cleaned || 'Sheet'
    }

    const usedNames = new Set<string>()
    const makeUniqueName = (baseName: string): string => {
      const sanitized = sanitizeSheetName(baseName)
      if (!usedNames.has(sanitized)) {
        usedNames.add(sanitized)
        return sanitized
      }
      // If duplicate, append number
      for (let i = 2; i <= 999; i++) {
        const suffix = ` (${i})`
        const maxLen = 31 - suffix.length
        const truncated = sanitized.length > maxLen ? sanitized.slice(0, maxLen) : sanitized
        const candidate = `${truncated}${suffix}`
        if (!usedNames.has(candidate)) {
          usedNames.add(candidate)
          return candidate
        }
      }
      // Fallback: use UUID suffix
      const fallback = `${sanitized.slice(0, 20)}_${Date.now()}`
      usedNames.add(fallback)
      return fallback
    }

    const sheets = results.map((run) => ({
      name: makeUniqueName(run.label),
      columns: geneColumns,
      rows: run.genes.map((gene) => ({
        geneId: gene.geneId,
        geneSymbol: gene.geneSymbol,
        baseMean: sanitizeNumericValue(gene.baseMean),
        log2FoldChange: sanitizeNumericValue(gene.log2FoldChange),
        lfcSE: sanitizeNumericValue(gene.lfcSE),
        stat: sanitizeNumericValue(gene.stat),
        pvalue: sanitizeNumericValue(gene.pvalue),
        padj: sanitizeNumericValue(gene.padj),
        significant: gene.significant,
        direction: gene.direction,
        sigCategory: gene.sigCategory,
      })),
    }))

    try {
      const defaultFilename = buildDefaultFilename(getBatchFactorName(results))
      const savePath = await tauriApi.saveFileDialog(defaultFilename, [
        { name: 'Excel Files', extensions: ['xlsx'] },
      ])
      if (!savePath) return

      const path = await exportService.exportDataToExcelMulti(sheets, savePath)
      toast.success(`Results exported to ${path}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(`RNA-seq export failed: ${message}`)
    }
  }, [activeProject, getDateStamp, modelMainFactorById, sanitizeFilenamePart])

  useEffect(() => {
    let unlisten: (() => void) | null = null

    const startListener = async () => {
      unlisten = await listen<{
        type?: string
        stage?: string
        percent?: number
        message?: string
      }>('rnaseq-progress', (event) => {
        const payload = event.payload ?? {}
        const percent = typeof payload.percent === 'number' ? payload.percent : null
        if (percent === null) return
        const label = payload.message ?? payload.stage ?? ''
        setAnalysisProgress(percent, label)
        const lockState = useAppStore.getState().appOperationLock
        if (lockState.active && lockState.owner === 'rnaseq' && lockState.token) {
          const { batchIndex, batchTotal } = activeBatchProgressRef.current
          const clampedPercent = Math.max(0, Math.min(100, percent))
          const overlayProgress = batchTotal > 1
            ? (((batchIndex - 1) + clampedPercent / 100) / batchTotal) * 100
            : clampedPercent
          const overlayStage =
            batchTotal > 1
              ? `Model ${batchIndex}/${batchTotal}${label ? `: ${label}` : ''}`
              : label
          useAppStore.getState().updateAppOperationLock(lockState.token, {
            progress: overlayProgress,
            stage: overlayStage || lockState.stage,
          })
        }
      })
    }

    void startListener()
    return () => {
      if (unlisten) {
        unlisten()
      }
    }
  }, [setAnalysisProgress])

  // Auto-select first result if no valid result is active
  useEffect(() => {
    if (!activeProject) return

    // Validate that activeResultId exists in results array
    if (activeProject.activeResultId) {
      const exists = activeProject.results.some(r => r.id === activeProject.activeResultId)
      if (exists) return  // Valid ID, keep it
      // Otherwise fall through to auto-select first result
    }

    const firstResult = activeProject.results[0]
    if (!firstResult) return
    setActiveResult(activeProject.id, firstResult.id)
    setActiveModel(activeProject.id, firstResult.modelId)
  }, [activeProject, setActiveModel, setActiveResult])

  useEffect(() => {
    if (!activeProject) {
      previousActiveResultIdRef.current = null
      setExpandedResultId(null)
      setSuppressAutoExpand(false)
      return
    }
    if (!activeResultId) {
      previousActiveResultIdRef.current = null
      if (expandedResultId !== null) {
        setExpandedResultId(null)
      }
      setSuppressAutoExpand(false)
      return
    }
    if (previousActiveResultIdRef.current !== activeResultId) {
      previousActiveResultIdRef.current = activeResultId
      setSuppressAutoExpand(false)
      setExpandedResultId(activeResultId)
      return
    }
    if (!suppressAutoExpand && expandedResultId === null) {
      setExpandedResultId(activeResultId)
    }
  }, [activeProject, activeResultId, expandedResultId, suppressAutoExpand])

  // Show empty state if no project selected
  if (!activeProject) {
    return (
      <div className={cn('flex items-center justify-center h-full', className)}>
        <div className="text-center text-muted-foreground">
          <p className="text-lg font-medium">No RNA-seq project selected</p>
          <p className="text-sm mt-2">
            Create or select a project from the Navigator panel.
          </p>
        </div>
      </div>
    )
  }

  const activeTab = activeProject.activeTab
  const activeProjectId = activeProject.id
  const activeGridUsableRows =
    activeTab === 'counts'
      ? countsUsableRows
      : activeTab === 'metadata'
        ? metadataUsableRows
        : 0
  const hasActiveGridRows = activeGridUsableRows > 0
  const blockIfNoActiveGridRows = (toolName: string): boolean => {
    if (hasActiveGridRows) return false
    toast.info(`Import data first to use ${toolName}.`)
    return true
  }

  useEffect(() => {
    if (!activeProjectId) return

    let targetDataset: typeof countsDataset | typeof metadataDataset | null = null
    if (activeTab === 'counts') {
      targetDataset = countsDataset ?? null
    } else if (activeTab === 'metadata') {
      targetDataset = metadataDataset ?? null
    } else {
      targetDataset = countsDataset ?? metadataDataset ?? null
    }

    const targetId = targetDataset?.id ?? null
    if (currentDatasetId === targetId) return

    setCurrentDataset(targetDataset ?? null)
  }, [
    activeProjectId,
    activeTab,
    countsDataset?.id,
    metadataDataset?.id,
    currentDatasetId,
    setCurrentDataset,
  ])

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-background">
        <div className="flex items-center gap-2">
          {/* Configure Analysis */}
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              // Preflight: run sample-match validation only when both slots have real data.
              // Uses the same hasMatchableSamples gate and sample-ID extraction as
              // import-time validation so the two paths cannot drift.
              if (hasMatchableSamples(countsDataset) && hasMatchableSamples(metadataDataset)) {
                try {
                  const countSampleIds = await getCountSampleIdsWithData(countsDataset!)
                  const { sampleMatch } = await rnaseqService.validateSampleMatch(
                    countsDataset!,
                    metadataDataset!,
                    { countSampleIds }
                  )
                  if (sampleMatch && sampleMatch.status !== 'ok') {
                    if (!confirmSampleMismatch(sampleMatch, 'configure')) return
                  }
                } catch (error) {
                  console.warn('Configure preflight validation failed; proceeding to config dialog.', error)
                }
              }
              setShowConfigDialog(true)
            }}
            disabled={countsUsableRows === 0 || metadataUsableRows === 0 || isMutationLocked}
          >
            <Settings2 className="h-4 w-4 mr-2" />
            Configure
          </Button>

          {/* Import buttons */}
          <Button variant="outline" size="sm" onClick={handleImportCounts} disabled={isMutationLocked}>
            <FolderDown className="h-4 w-4 mr-2" />
            Import Counts
          </Button>
          <Button variant="outline" size="sm" onClick={handleImportMetadata} disabled={isMutationLocked}>
            <FolderDown className="h-4 w-4 mr-2" />
            Import Metadata
          </Button>

          {/* Grid actions - only visible on counts/metadata tabs */}
          {(activeTab === 'counts' || activeTab === 'metadata') && (countsDataset || metadataDataset) && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (blockIfNoActiveGridRows('Outline')) return
                  openGroupDialogRef.current?.()
                }}
                disabled={isMutationLocked || !hasActiveGridRows}
              >
                <TableOfContents className="h-4 w-4 mr-2" />
                Outline
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (blockIfNoActiveGridRows('Sort')) return
                  openSortDialogRef.current?.()
                }}
                disabled={isMutationLocked || !hasActiveGridRows}
              >
                <SortAscendingIcon className="h-4 w-4 mr-2" weight="regular" />
                Sort
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearDataset}
                disabled={
                  isMutationLocked ||
                  (activeTab === 'counts' && !countsDataset) ||
                  (activeTab === 'metadata' && !metadataDataset)
                }
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Clear
              </Button>
            </>
          )}
        </div>

        <h2 className="text-lg font-semibold">{activeProject.name}</h2>
      </div>

      {/* Progress bar (when running) */}
      {isRunning && (
        <div className="px-4 py-2 bg-muted/50 border-b">
          <div className="flex items-center gap-4">
            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground">{stage}</span>
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <RNAseqTabBar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        hasCountsData={countsUsableRows > 0}
        hasMetadataData={metadataUsableRows > 0}
        hasResults={projectResults.length > 0}
        isLocked={isMutationLocked}
      />

      {/* Content Area */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'counts' && (
          <>
            <RNAseqDatasetGrid
              dataset={countsDataset ?? null}
              hasDataRows={countsUsableRows > 0}
              onImport={handleImportCounts}
              importLabel="Import Counts"
              isLocked={isMutationLocked}
              emptyMessage="No count matrix loaded"
              emptyDescription="Import a count matrix (CSV/TSV) with genes as rows and samples as columns."
              viewStateKey={`rnaseq:${activeProject.id}:counts`}
              onSortDialogRequest={(open) => { openSortDialogRef.current = open }}
              onGroupDialogRequest={(open) => { openGroupDialogRef.current = open }}
              onCopyRequest={onCopyRequest}
              onCutRequest={onCutRequest}
              onPasteRequest={onPasteRequest}
              onUndoRequest={onUndoRequest}
              onRedoRequest={onRedoRequest}
            />
          </>
        )}

        {activeTab === 'metadata' && (
          <>
            <RNAseqDatasetGrid
              dataset={metadataDataset ?? null}
              hasDataRows={metadataUsableRows > 0}
              onImport={handleImportMetadata}
              importLabel="Import Metadata"
              isLocked={isMutationLocked}
              emptyMessage="No metadata loaded"
              emptyDescription="Import sample metadata (CSV/TSV) with sample IDs and experimental factors."
              viewStateKey={`rnaseq:${activeProject.id}:metadata`}
              onSortDialogRequest={(open) => { openSortDialogRef.current = open }}
              onGroupDialogRequest={(open) => { openGroupDialogRef.current = open }}
              onCopyRequest={onCopyRequest}
              onCutRequest={onCutRequest}
              onPasteRequest={onPasteRequest}
              onUndoRequest={onUndoRequest}
              onRedoRequest={onRedoRequest}
            />
          </>
        )}

        {activeTab === 'results' && (
          projectResults.length > 0 ? (
            <div className="flex flex-col h-full">
              <div className="flex items-center justify-between gap-2 px-4 py-2 border-b bg-background">
                <div className="text-sm text-muted-foreground">Run history</div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Download className="h-4 w-4 mr-2" />
                      Export
                      <ChevronDown className="h-4 w-4 ml-2" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void handleExportAllResults('csv')}>
                      Export Most Recent Run as CSV
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void handleExportAllResults('xlsx')}>
                      Export All Runs as .xlsx
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="flex-1 overflow-auto p-3">
                {projectResults.map((run) => {
                  const isExpanded = run.id === expandedResultId
                  const modelName = modelNameById.get(run.modelId) ?? 'RNA-seq Model'
                  return (
                    <RNAseqResultAccordion
                      key={run.id}
                      run={run}
                      modelName={modelName}
                      isExpanded={isExpanded}
                      onToggle={() => handleToggleResultRun(run)}
                      onDelete={() => void handleDeleteResultRun(run)}
                    />
                  )
                })}
              </div>
            </div>
          ) : (
            <EmptyState
              message="No results available"
              description="Configure and fit the RNA-seq model to see results."
            />
          )
        )}

        {activeTab === 'plots' && (
          activeResult ? (
            <RNAseqPlotPanel
              projectResults={projectResults}
              projectId={activeProject.id}
              result={activeResult}
              model={activeProject.models.find((model) => model.id === activeResult.modelId) ?? null}
              activeResultId={activeResultId}
              activePlotType={activeProject.activePlotType}
              onPlotTypeChange={handlePlotTypeChange}
              onResultChange={(resultId) => {
                setActiveResult(activeProject.id, resultId)
                // Find the model for this result and activate it
                const run = projectResults.find((r) => r.id === resultId)
                if (run) {
                  setActiveModel(activeProject.id, run.modelId)
                }
              }}
              className="h-full"
            />
          ) : (
            <EmptyState
              message="No plots available"
              description="Run analysis to generate visualizations."
            />
          )
        )}
      </div>

      {/* Dialogs */}
      <RNAseqDataImportDialog
        open={showImportDialog}
        onOpenChange={setShowImportDialog}
        projectId={activeProject.id}
        mode={importType}
      />

      <DESeq2ConfigDialog
        open={showConfigDialog}
        onOpenChange={setShowConfigDialog}
        projectId={activeProject.id}
        onSaveBatch={(models) => runAnalysisBatch(models)}
      />
    </div>
  )
}

function RNAseqDatasetGrid({
  dataset,
  hasDataRows,
  onImport,
  importLabel,
  isLocked,
  emptyMessage,
  emptyDescription,
  viewStateKey,
  onSortDialogRequest,
  onGroupDialogRequest,
  onCopyRequest,
  onCutRequest,
  onPasteRequest,
  onUndoRequest,
  onRedoRequest,
}: {
  dataset: { id: string; name: string; rowCount: number; columnCount: number } | null
  hasDataRows: boolean
  onImport: () => void
  importLabel: string
  isLocked: boolean
  emptyMessage: string
  emptyDescription: string
  viewStateKey?: string
  onSortDialogRequest?: (open: () => void) => void
  onGroupDialogRequest?: (open: () => void) => void
  onCopyRequest?: (copy: (() => void | Promise<void>) | null) => void
  onCutRequest?: (cut: (() => void | Promise<void>) | null) => void
  onPasteRequest?: (paste: (() => void | Promise<void>) | null) => void
  onUndoRequest?: (undo: (() => void | Promise<void>) | null) => void
  onRedoRequest?: (redo: (() => void | Promise<void>) | null) => void
}) {
  if (!dataset || !hasDataRows) {
    return (
      <EmptyState
        message={emptyMessage}
        description={emptyDescription}
        action={
          <Button onClick={onImport} disabled={isLocked}>
            <FolderDown className="h-4 w-4 mr-2" />
            {importLabel}
          </Button>
        }
      />
    )
  }

  return (
    <div className="h-full">
      <SpreadsheetView
        height="100%"
        width="100%"
        datasetId={dataset?.id}
        viewStateKey={viewStateKey}
        trackActiveFamilyData={false}
        onSortDialogRequest={onSortDialogRequest}
        onGroupDialogRequest={onGroupDialogRequest}
        onRequireDataRows={() => hasDataRows}
        onCopyRequest={onCopyRequest}
        onCutRequest={onCutRequest}
        onPasteRequest={onPasteRequest}
        onUndoRequest={onUndoRequest}
        onRedoRequest={onRedoRequest}
      />
    </div>
  )
}

function RNAseqResultAccordion({
  run,
  modelName,
  isExpanded,
  onToggle,
  onDelete,
}: {
  run: DESeqResultRun
  modelName: string
  isExpanded: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    <div className="mb-3 border rounded-md overflow-hidden bg-background">
      <div
        className={cn(
          'w-full flex items-center justify-between transition-colors group',
          isExpanded ? 'bg-muted/50' : 'hover:bg-muted/40'
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-controls={`rnaseq-result-${run.id}`}
          className="flex-1 flex items-center justify-between px-4 py-3 text-left"
        >
          <div className="min-w-0">
            <div className="font-medium truncate">{run.label}</div>
            <div className="text-xs text-muted-foreground">
              {modelName} | {run.executedAt.toLocaleString()}
            </div>
          </div>
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform',
              isExpanded && 'rotate-180'
            )}
          />
        </button>
        <button
          type="button"
          className="mr-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
          onClick={(event) => {
            event.stopPropagation()
            onDelete()
          }}
          aria-label="Delete result run"
          title="Delete result run"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {isExpanded && (
        <div id={`rnaseq-result-${run.id}`} className="border-t">
          <DESeq2ResultsTable
            result={run}
            className="h-auto"
          />
        </div>
      )}
    </div>
  )
}

/**
 * Empty state component
 */
function EmptyState({
  message,
  description,
  action,
}: {
  message: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center">
      <p className="text-lg font-medium text-muted-foreground">{message}</p>
      <p className="text-sm text-muted-foreground mt-2 max-w-md">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export default RNAseqWorkspace
