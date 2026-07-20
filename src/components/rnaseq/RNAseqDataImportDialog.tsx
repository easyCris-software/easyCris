/**
 * RNAseqDataImportDialog Component
 *
 * Dialog for importing count matrix and sample metadata for RNA-seq projects.
 *
 * Features:
 * - File selection via Tauri dialog
 * - Validation specific to count matrix (integer counts, gene IDs)
 * - Validation specific to metadata (sample IDs, factor columns)
 * - Sample ID matching between counts and metadata
 * - Memory estimation for large datasets
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  AlertCircle,
  CheckCircle2,
  Upload,
  FileSpreadsheet,
  Table2,
  AlertTriangle,
  Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useRNAseqStore } from '@/store/rnaseq-store'
import { ensureProjectId } from '@/store/app-store'
import { useDataStore, type ColumnMetadata, type Dataset } from '@/store/data-store'
import tauriApi, { type DataImportResult } from '@/services/tauriApi'
import cacheService from '@/services/cacheService'
import rnaseqService from '@/services/rnaseqService'
import { toast } from 'sonner'
import type {
  CountMatrixValidation,
  MetadataValidation,
  SampleMatchResult,
  SampleIdValidationSummary,
} from '@/types/rnaseq'
import {
  type DatasetLike,
  hasMatchableSamples,
  confirmSampleMismatch,
  normalizeSampleId,
  getColumnsSampledDataSafe,
  getCountSampleIdsWithData,
} from '@/lib/rnaseq/sampleMatchUtils'

type ImportMode = 'counts' | 'metadata'

const MIN_COLUMNS = 100
const MIN_ROWS = 100
const ROW_BUFFER = 50
const DEFAULT_COLUMN_WIDTH = 88
const METADATA_SAMPLE_SIZE = 200
const SAMPLE_MATCH_SAMPLE_SIZE = 200
const SAMPLE_MATCH_FULL_SCAN_THRESHOLD = 5000

interface RNAseqDataImportDialogProps {
  open: boolean
  projectId: string
  mode: ImportMode
  onOpenChange: (open: boolean) => void
  onImportComplete?: (datasetId: string, mode: ImportMode) => void
}

interface ValidationState {
  status: 'idle' | 'validating' | 'valid' | 'warning' | 'error'
  countValidation?: CountMatrixValidation
  metadataValidation?: MetadataValidation
  sampleMatch?: SampleMatchResult
  memoryEstimate?: { totalMb: number; recommendation: string }
}

interface ImportRequestContext {
  targetProjectId: string
  targetMode: ImportMode
  requestToken: number
}


const extendColumns = (baseColumns: ColumnMetadata[]): ColumnMetadata[] => {
  const columns = [...baseColumns]
  const usedIds = new Set(columns.map((col) => col.id))
  let nextIndex = 0

  for (const col of columns) {
    const match = /^col-(\d+)$/.exec(col.id)
    if (!match) continue
    const index = Number(match[1])
    if (Number.isFinite(index)) {
      nextIndex = Math.max(nextIndex, index + 1)
    }
  }

  for (let i = columns.length; i < MIN_COLUMNS; i++) {
    while (usedIds.has(`col-${nextIndex}`)) {
      nextIndex += 1
    }
    const id = `col-${nextIndex}`
    usedIds.add(id)
    columns.push({
      id,
      name: `Column ${i + 1}`,
      type: 'text',
      width: DEFAULT_COLUMN_WIDTH,
    })
    nextIndex += 1
  }

  return columns
}

export function RNAseqDataImportDialog({
  open: dialogOpen,
  projectId,
  mode,
  onOpenChange,
  onImportComplete,
}: RNAseqDataImportDialogProps) {
  const previewResultRef = useRef<DataImportResult | null>(null)
  const autoOpenRef = useRef(false)
  const targetProjectIdRef = useRef<string>('')
  const latestImportRequestTokenRef = useRef(0)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [isImporting, setIsImporting] = useState(false)
  const [validation, setValidation] = useState<ValidationState>({ status: 'idle' })

  const { replaceCountsDataset, replaceMetadataDataset, getProject } = useRNAseqStore()
  const { addDataset, datasets } = useDataStore()

  const ensureBackendProjectContext = async (): Promise<string> => {
    return await ensureProjectId()
  }

  const isLatestImportRequest = (context: ImportRequestContext): boolean => {
    return context.requestToken === latestImportRequestTokenRef.current
  }

  const createImportRequestContext = (targetMode: ImportMode = mode): ImportRequestContext | null => {
    const targetProjectId = targetProjectIdRef.current || projectId
    if (!targetProjectId) return null
    const requestToken = latestImportRequestTokenRef.current + 1
    latestImportRequestTokenRef.current = requestToken
    return { targetProjectId, targetMode, requestToken }
  }

  const getLinkedDatasetForContext = (context: ImportRequestContext): DatasetLike | null => {
    const targetProject = getProject(context.targetProjectId)
    if (!targetProject) return null
    const linkedDatasetId =
      context.targetMode === 'counts' ? targetProject.metadataDatasetId : targetProject.countsDatasetId
    return linkedDatasetId ? datasets.find((d) => d.id === linkedDatasetId) ?? null : null
  }

  // Reset state when dialog opens/closes or mode changes
  useEffect(() => {
    if (dialogOpen) {
      // Snapshot target project at the start of this dialog session.
      if (!targetProjectIdRef.current) {
        targetProjectIdRef.current = projectId
      }
      // Invalidate any prior async request before starting a new import flow.
      latestImportRequestTokenRef.current += 1
      setSelectedFile(null)
      setFileName('')
      previewResultRef.current = null
      setIsImporting(false)
      setValidation({ status: 'idle' })
    } else {
      autoOpenRef.current = false
      targetProjectIdRef.current = ''
      // Invalidate any in-flight async work when the dialog closes.
      latestImportRequestTokenRef.current += 1
      setIsImporting(false)
    }
  }, [dialogOpen, mode, projectId])

  const validateFile = async (
    filePath: string,
    autoImport = false,
    requestContext?: ImportRequestContext
  ) => {
    const context = requestContext ?? createImportRequestContext(mode)
    if (!context) {
      toast.error('No active RNA-seq project selected for import.')
      return
    }
    if (!isLatestImportRequest(context)) {
      return
    }

    setValidation({ status: 'validating' })

    try {
      await ensureBackendProjectContext()
      if (!isLatestImportRequest(context)) {
        return
      }

      // Import the file to get a preview
      const ext = filePath.split('.').pop()?.toLowerCase()
      let result: DataImportResult

      if (ext === 'csv') {
        result = await tauriApi.importCsv(filePath)
      } else if (ext === 'tsv' || ext === 'txt') {
        result = await tauriApi.importTsv(filePath)
      } else if (ext === 'xlsx' || ext === 'xls') {
        result = await tauriApi.importExcel(filePath)
      } else {
        setValidation({
          status: 'error',
          countValidation: {
            valid: false,
            geneCount: 0,
            sampleCount: 0,
            errors: [`Unsupported file type: ${ext}`],
            warnings: [],
          },
        })
        return
      }

      if (!isLatestImportRequest(context)) {
        return
      }

      previewResultRef.current = result
      const dataset = result.dataset
      const columns = dataset.columns
      const rowCount = dataset.rowCount
      const linkedDataset = getLinkedDatasetForContext(context)

      if (context.targetMode === 'counts') {
        // Validate as count matrix
        const countValidation = validateCountMatrix(columns, rowCount, dataset)
        let sampleMatch: SampleMatchResult | undefined

        if (hasMatchableSamples(linkedDataset) && countValidation.valid) {
          const countSampleIds = await getCountSampleIdsWithData(result.dataset)
          try {
            const backendMatch = await rnaseqService.validateSampleMatch(
              result.dataset,
              linkedDataset!,
              { countSampleIds }
            )
            sampleMatch = backendMatch.sampleMatch
          } catch (error) {
            console.warn('RNA-seq backend sample validation failed; falling back to local checks.', error)
          }
          if (!sampleMatch) {
            const metadataSampleIds = await getSampleIdsFromDataset(linkedDataset!)
            sampleMatch = buildSampleMatchResult(countSampleIds, metadataSampleIds)
          }
        }

        if (!isLatestImportRequest(context)) {
          return
        }

        const memoryEstimate = estimateMemory(countValidation.geneCount, countValidation.sampleCount)
        const status = countValidation.valid
          ? countValidation.warnings.length > 0 || sampleMatch?.status !== 'ok'
            ? 'warning'
            : 'valid'
          : 'error'
        setValidation({
          status,
          countValidation,
          sampleMatch,
          memoryEstimate,
        })
        if (autoImport && status !== 'error') {
          if (memoryEstimate) {
            const message = `Estimated memory ${memoryEstimate.totalMb} MB`
            if (memoryEstimate.recommendation === 'error') {
              toast.error(message)
            } else if (memoryEstimate.recommendation === 'warning') {
              toast.warning(message)
            } else {
              toast.info(message)
            }
          }
          if (countValidation.warnings.length > 0) {
            const preview = countValidation.warnings.slice(0, 3).join(' ')
            toast.warning(preview)
          }
          if (sampleMatch && sampleMatch.status !== 'ok') {
            toast.warning(sampleMatch.message)
            if (!confirmSampleMismatch(sampleMatch)) {
              return
            }
          }
          await finalizeImport(result, filePath, context)
        }
      } else {
        // Validate as metadata
        let sampledMetadata: Record<string, unknown[]> | null = null
        try {
          sampledMetadata = await getColumnsSampledDataSafe(dataset, columns, METADATA_SAMPLE_SIZE)
        } catch (error) {
          console.warn('Failed to load sampled metadata; falling back to column types.', error)
        }

        const metadataValidation = validateMetadata(columns, rowCount, dataset, sampledMetadata)
        let sampleMatch: SampleMatchResult | undefined
        let metadataSampleValidation: SampleIdValidationSummary | undefined
        const sampleIdWarnings: string[] = []

        // Check sample matching if counts are already loaded
        if (hasMatchableSamples(linkedDataset) && metadataValidation.valid) {
          const countSampleIds = await getCountSampleIdsWithData(linkedDataset!)
          try {
            const backendMatch = await rnaseqService.validateSampleMatch(
              linkedDataset!,
              result.dataset,
              { countSampleIds }
            )
            sampleMatch = backendMatch.sampleMatch
            metadataSampleValidation = backendMatch.metadataSampleValidation
          } catch (error) {
            console.warn('RNA-seq backend sample validation failed; falling back to local checks.', error)
          }

          if (!sampleMatch) {
            const metadataSampleIds = await getSampleIdsFromDataset(result.dataset)
            sampleMatch = buildSampleMatchResult(countSampleIds, metadataSampleIds)
          }
        }

        if (metadataSampleValidation) {
          sampleIdWarnings.push(...buildSampleIdWarnings(metadataSampleValidation))
        } else {
          const sampleIdStats = await getSampleIdStats(result.dataset)
          if (sampleIdStats) {
            sampleIdWarnings.push(
              ...buildSampleIdWarnings(
                {
                  missingCount: sampleIdStats.missingCount,
                  duplicateIdCount: sampleIdStats.duplicateIdCount,
                  duplicateRowCount: sampleIdStats.duplicateRowCount,
                  duplicateExamples: sampleIdStats.duplicateExamples,
                },
                { sampled: sampleIdStats.sampled, sampledRows: sampleIdStats.sampledRows }
              )
            )
          }
        }

        if (!isLatestImportRequest(context)) {
          return
        }

        const metadataValidationWithSampleIds = sampleIdWarnings.length > 0
          ? { ...metadataValidation, warnings: [...metadataValidation.warnings, ...sampleIdWarnings] }
          : metadataValidation
        const status = metadataValidationWithSampleIds.valid
          ? metadataValidationWithSampleIds.warnings.length > 0 || sampleMatch?.status !== 'ok'
            ? 'warning'
            : 'valid'
          : 'error'
        setValidation({
          status,
          metadataValidation: metadataValidationWithSampleIds,
          sampleMatch,
        })
        if (autoImport && status !== 'error') {
          if (metadataValidationWithSampleIds.warnings.length > 0) {
            const preview = metadataValidationWithSampleIds.warnings.slice(0, 3).join(' ')
            toast.warning(preview)
          }
          if (sampleMatch && sampleMatch.status !== 'ok') {
            toast.warning(sampleMatch.message)
            if (!confirmSampleMismatch(sampleMatch)) {
              return
            }
          }
          await finalizeImport(result, filePath, context)
        }
      }
    } catch (error) {
      if (!isLatestImportRequest(context)) {
        return
      }
      console.error('Validation error:', error)
      setValidation({
        status: 'error',
        countValidation:
          context.targetMode === 'counts'
            ? {
                valid: false,
                geneCount: 0,
                sampleCount: 0,
                errors: [
                  `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ],
                warnings: [],
              }
            : undefined,
        metadataValidation:
          context.targetMode === 'metadata'
            ? {
                valid: false,
                sampleCount: 0,
                columns: [],
                errors: [
                  `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ],
                warnings: [],
              }
            : undefined,
      })
    }
  }

  const selectFile = useCallback(async (autoFlow = false) => {
    try {
      const filePath = await openDialog({
        multiple: false,
        filters: [
          {
            name: 'Data Files',
            extensions: ['csv', 'tsv', 'txt', 'xlsx', 'xls'],
          },
          { name: 'CSV Files', extensions: ['csv'] },
          { name: 'TSV Files', extensions: ['tsv', 'txt'] },
          { name: 'Excel Files', extensions: ['xlsx', 'xls'] },
        ],
      })

      if (!filePath) {
        if (autoFlow) {
          onOpenChange(false)
        }
        return
      }

      const name = filePath.split(/[\\/]/).pop() ?? 'dataset'
      setSelectedFile(filePath)
      setFileName(name)
      previewResultRef.current = null
      const requestContext = createImportRequestContext(mode)
      if (!requestContext) {
        toast.error('No active RNA-seq project selected for import.')
        return
      }

      // Validate the file
      await validateFile(filePath, autoFlow, requestContext)
    } catch (error) {
      console.error('File selection error:', error)
      toast.error('Failed to select file')
    }
  }, [onOpenChange, mode, projectId])

  const handleSelectFile = useCallback(() => {
    void selectFile(false)
  }, [selectFile])

  const validateCountMatrix = (
    columns: Array<{ id: string; name: string; type: string }>,
    rowCount: number,
    _dataset: unknown
  ): CountMatrixValidation => {
    const errors: string[] = []
    const warnings: string[] = []

    // Check for minimum columns (gene ID + at least 1 sample)
    if (columns.length < 2) {
      errors.push('Count matrix must have at least 2 columns (gene IDs + samples)')
    }

    // First column should be gene IDs (string/text/categorical type)
    const firstCol = columns[0]
    if (firstCol && firstCol.type !== 'categorical' && firstCol.type !== 'text') {
      warnings.push('First column appears to be numeric. Expected gene IDs (text).')
    }

    // Sample columns should be numeric
    const sampleCols = columns.slice(1)
    const nonNumericCols = sampleCols.filter((c) => c.type !== 'numeric')
    if (nonNumericCols.length > 0) {
      warnings.push(
        `${nonNumericCols.length} sample column(s) are not numeric: ${nonNumericCols
          .slice(0, 3)
          .map((c) => c.name)
          .join(', ')}${nonNumericCols.length > 3 ? '...' : ''}`
      )
    }

    // Check for reasonable row count (genes)
    if (rowCount < 100) {
      warnings.push(
        `Only ${rowCount} genes detected. Typical RNA-seq has 10,000-60,000 genes.`
      )
    }

    // Check sample count
    const sampleCount = sampleCols.length
    if (sampleCount < 3) {
      warnings.push(
        `Only ${sampleCount} samples. Model fitting requires at least 3 samples per group.`
      )
    }

    return {
      valid: errors.length === 0,
      geneCount: rowCount,
      sampleCount,
      errors,
      warnings,
    }
  }

  const validateMetadata = (
    columns: Array<{ id: string; name: string; type: string }>,
    rowCount: number,
    _dataset: unknown,
    sampledData?: Record<string, unknown[]> | null
  ): MetadataValidation => {
    const errors: string[] = []
    const warnings: string[] = []
    const columnAnalysis: Array<{
      name: string
      type: 'factor' | 'numeric' | 'mixed'
      uniqueValues: number
      missingCount: number
      suggestedRole: 'factor' | 'covariate' | 'identifier'
    }> = []
    const numericFactorThreshold = 10

    // Need at least sample ID column + 1 factor
    if (columns.length < 2) {
      errors.push('Metadata must have at least 2 columns (sample ID + factor)')
    }

    const normalizeValue = (value: unknown): string => {
      if (value === null || value === undefined) return ''
      return String(value).trim()
    }

    const getColumnSampleValues = (columnId: string): string[] => {
      if (!sampledData) return []
      const values = sampledData[columnId] ?? []
      return values.map(normalizeValue)
    }

    const countMissingValues = (values: string[]): number => {
      return values.filter((value) => value.length === 0).length
    }

    const countUniqueValues = (values: string[]): number => {
      const unique = new Set(values.filter((value) => value.length > 0))
      return unique.size
    }

    const countNumericUniqueValues = (values: string[]): number => {
      const numericValues = values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
      return new Set(numericValues).size
    }

    // First column should be sample IDs
    const firstCol = columns[0]
    if (firstCol) {
      const sampleValues = getColumnSampleValues(firstCol.id)
      columnAnalysis.push({
        name: firstCol.name,
        type: 'factor',
        uniqueValues: sampleValues.length > 0 ? countUniqueValues(sampleValues) : rowCount,
        missingCount: sampleValues.length > 0 ? countMissingValues(sampleValues) : 0,
        suggestedRole: 'identifier',
      })
    }

    // Analyze remaining columns
    for (const col of columns.slice(1)) {
      const isNumeric = col.type === 'numeric'
      const sampleValues = getColumnSampleValues(col.id)
      const uniqueValues = sampleValues.length > 0 ? countUniqueValues(sampleValues) : 0
      const numericUniqueValues =
        sampleValues.length > 0 ? countNumericUniqueValues(sampleValues) : 0
      const numericLooksLikeFactor =
        isNumeric && numericUniqueValues > 0 && numericUniqueValues <= numericFactorThreshold
      const suggestedRole = isNumeric
        ? numericLooksLikeFactor
          ? 'factor'
          : 'covariate'
        : 'factor'
      columnAnalysis.push({
        name: col.name,
        type: isNumeric ? (numericLooksLikeFactor ? 'mixed' : 'numeric') : 'factor',
        uniqueValues,
        missingCount: sampleValues.length > 0 ? countMissingValues(sampleValues) : 0,
        suggestedRole,
      })
    }

    // Check for factor columns
    const factorCols = columnAnalysis.filter((c) => c.suggestedRole === 'factor')
    if (factorCols.length === 0) {
      warnings.push(
        'No factor columns detected. DESeq2 requires at least one categorical variable to fit.'
      )
    }
    const numericFactorCandidates = columnAnalysis.filter(
      (c) => c.type === 'mixed' && c.suggestedRole === 'factor'
    )
    if (numericFactorCandidates.length > 0) {
      warnings.push(
        `Numeric columns with few unique values may be factors: ${numericFactorCandidates
          .slice(0, 3)
          .map((c) => c.name)
          .join(', ')}${numericFactorCandidates.length > 3 ? '...' : ''}`
      )
    }

    return {
      valid: errors.length === 0,
      sampleCount: rowCount,
      columns: columnAnalysis,
      errors,
      warnings,
    }
  }


  const getSampleIdStats = async (
    dataset: DatasetLike
  ): Promise<{
    sampled: boolean
    sampledRows: number
    missingCount: number
    duplicateIdCount: number
    duplicateRowCount: number
    duplicateExamples: string[]
    } | null> => {
    const columnId = dataset.columns[0]?.id
    if (!columnId) return null
    try {
      const useSample =
        typeof dataset.rowCount === 'number' &&
        dataset.rowCount > SAMPLE_MATCH_FULL_SCAN_THRESHOLD
      const values = useSample
        ? (await getColumnsSampledDataSafe(
            dataset,
            [{ id: columnId, name: dataset.columns[0]?.name ?? columnId }],
            SAMPLE_MATCH_SAMPLE_SIZE
          ))[columnId] ?? []
        : await cacheService.getColumnData(dataset.id, columnId)

      let missingCount = 0
      const counts = new Map<string, { count: number; example: string }>()
      for (const value of values) {
        const normalized = normalizeSampleId(value)
        if (!normalized) {
          missingCount += 1
          continue
        }
        const key = normalized.toLowerCase()
        const existing = counts.get(key) ?? { count: 0, example: normalized }
        existing.count += 1
        counts.set(key, existing)
      }

      const duplicates = Array.from(counts.values()).filter((entry) => entry.count > 1)
      const duplicateIdCount = duplicates.length
      const duplicateRowCount = duplicates.reduce((sum, entry) => sum + entry.count - 1, 0)
      const duplicateExamples = duplicates.slice(0, 5).map((entry) => entry.example)

      return {
        sampled: useSample,
        sampledRows: values.length,
        missingCount,
        duplicateIdCount,
        duplicateRowCount,
        duplicateExamples,
      }
    } catch (error) {
      console.warn('Failed to analyze sample IDs; skipping duplicate/missing checks.', error)
      return null
    }
  }

  const buildSampleIdWarnings = (
    summary: SampleIdValidationSummary,
    options?: { sampled?: boolean; sampledRows?: number }
  ): string[] => {
    const warnings: string[] = []
    const sampledSuffix =
      options?.sampled && typeof options.sampledRows === 'number'
        ? ` (sampled ${options.sampledRows} rows)`
        : ''

    if (summary.missingCount > 0) {
      warnings.push(
        `Sample ID column has ${summary.missingCount} missing value(s)${sampledSuffix}.`
      )
    }
    if (summary.duplicateIdCount > 0) {
      const preview = summary.duplicateExamples.join(', ')
      const tail = summary.duplicateIdCount > summary.duplicateExamples.length ? '…' : ''
      const duplicateLabel = summary.duplicateIdCount === 1 ? 'ID' : 'IDs'
      const rowLabel = summary.duplicateRowCount === 1 ? 'row' : 'rows'
      warnings.push(
        `Sample ID column has ${summary.duplicateIdCount} duplicate ${duplicateLabel} ` +
          `(${summary.duplicateRowCount} duplicate ${rowLabel})${sampledSuffix}: ${preview}${tail}`
      )
    }

    return warnings
  }

  const getSampleIdsFromDataset = async (dataset: DatasetLike): Promise<string[]> => {
    const columnId = dataset.columns[0]?.id
    if (!columnId) return []
    try {
      const useSample =
        typeof dataset.rowCount === 'number' &&
        dataset.rowCount > SAMPLE_MATCH_FULL_SCAN_THRESHOLD
      if (useSample) {
        const sampled = await getColumnsSampledDataSafe(
          dataset,
          [{ id: columnId, name: dataset.columns[0]?.name ?? columnId }],
          SAMPLE_MATCH_SAMPLE_SIZE
        )
        const values = sampled[columnId] ?? []
        return values.map((value) => normalizeSampleId(value)).filter((v) => v.length > 0)
      }
      const values = await cacheService.getColumnData(dataset.id, columnId)
      return values.map((value) => normalizeSampleId(value)).filter((v) => v.length > 0)
    } catch (error) {
      console.warn('Failed to load sample IDs; falling back to empty list.', error)
      return []
    }
  }

  const buildSampleMatchResult = (
    countSampleIds: string[],
    metadataSampleIds: string[]
  ): SampleMatchResult => {
    const matchedSamples: string[] = []
    const onlyInCounts: string[] = []
    const onlyInMetadata: string[] = []

    const countLowerMap = new Map<string, string[]>()
    for (const sampleId of countSampleIds) {
      const key = sampleId.toLowerCase()
      const list = countLowerMap.get(key) ?? []
      list.push(sampleId)
      countLowerMap.set(key, list)
    }

    const metaLowerMap = new Map<string, string[]>()
    for (const sampleId of metadataSampleIds) {
      const key = sampleId.toLowerCase()
      const list = metaLowerMap.get(key) ?? []
      list.push(sampleId)
      metaLowerMap.set(key, list)
    }

    const countKeys = new Set(countLowerMap.keys())
    const metaKeys = new Set(metaLowerMap.keys())

    for (const sampleId of countSampleIds) {
      const key = sampleId.toLowerCase()
      if (metaKeys.has(key)) {
        matchedSamples.push(sampleId)
      } else {
        onlyInCounts.push(sampleId)
      }
    }

    for (const sampleId of metadataSampleIds) {
      const key = sampleId.toLowerCase()
      if (!countKeys.has(key)) {
        onlyInMetadata.push(sampleId)
      }
    }

    const matchCount = matchedSamples.length
    const totalCountSamples = countSampleIds.length
    const totalMetaSamples = metadataSampleIds.length

    if (onlyInCounts.length === 0 && onlyInMetadata.length === 0) {
      return {
        status: 'ok',
        message: 'All samples matched.',
        matchedSamples,
        onlyInCounts: [],
        onlyInMetadata: [],
        matchCount,
        totalCountSamples,
        totalMetaSamples,
      }
    }

    const onlyCountsPreview = onlyInCounts.slice(0, 10).join(', ')
    const onlyMetaPreview = onlyInMetadata.slice(0, 10).join(', ')
    const onlyCountsTail = onlyInCounts.length > 10 ? '…' : ''
    const onlyMetaTail = onlyInMetadata.length > 10 ? '…' : ''

    let status: SampleMatchResult['status'] = 'warning'
    if (onlyInCounts.length > 0) {
      status = 'error'
    } else if (onlyInMetadata.length > 0) {
      status = 'warning'
    }

    const parts: string[] = ['Sample mismatch between counts and metadata.']
    if (onlyInCounts.length > 0) {
      parts.push(`Samples only in counts: ${onlyCountsPreview}${onlyCountsTail}`)
    }
    if (onlyInMetadata.length > 0) {
      parts.push(`Samples only in metadata: ${onlyMetaPreview}${onlyMetaTail}`)
    }

    return {
      status,
      message: parts.join('\n'),
      matchedSamples,
      onlyInCounts,
      onlyInMetadata,
      matchCount,
      totalCountSamples,
      totalMetaSamples,
    }
  }

  const estimateMemory = (
    geneCount: number,
    sampleCount: number
  ): { totalMb: number; recommendation: string } => {
    // Rough estimate: 8 bytes per count value + overhead
    const rawMb = (geneCount * sampleCount * 8) / (1024 * 1024)
    const analysisMb = rawMb * 3 // PCA, VST, dispersion estimates
    const totalMb = rawMb + analysisMb

    let recommendation: string
    if (totalMb < 500) {
      recommendation = 'ok'
    } else if (totalMb < 2000) {
      recommendation = 'warning'
    } else {
      recommendation = 'error'
    }

    return { totalMb: Math.round(totalMb), recommendation }
  }

  const finalizeImport = async (
    result: DataImportResult,
    filePath: string,
    context: ImportRequestContext
  ) => {
    if (!context.targetProjectId) return
    if (!isLatestImportRequest(context)) return

    let hasTerminalToast = false
    setIsImporting(true)
    const toastId = `rnaseq-import-${Date.now()}`

    try {
      toast.loading(`Importing ${context.targetMode === 'counts' ? 'count matrix' : 'metadata'}...`, {
        id: toastId,
      })

      await ensureBackendProjectContext()
      if (!isLatestImportRequest(context)) {
        return
      }
      if (!getProject(context.targetProjectId)) {
        hasTerminalToast = true
        toast.error('Import completed but target project no longer exists.', { id: toastId })
        return
      }

      // Create dataset with RNA-seq specific metadata
      const extendedColumns = extendColumns(result.dataset.columns)
      const dataRowCount = result.dataset.rowCount
      const rowCount = Math.max(dataRowCount + ROW_BUFFER, MIN_ROWS)
      const dataset: Dataset = {
        ...result.dataset,
        columns: extendedColumns,
        columnCount: extendedColumns.length,
        rowCount,
        dataRowCount,
        importedAt: new Date(result.dataset.importedAt),
        modifiedAt: new Date(result.dataset.modifiedAt),
        filePath: result.sourcePath ?? filePath,
        familyId: `rnaseq:${context.targetProjectId}`,
      }

      if (!isLatestImportRequest(context)) {
        return
      }

      // Add to data store
      addDataset(dataset)
      if (!isLatestImportRequest(context)) {
        return
      }

      // Link to RNA-seq project — replacement APIs clean up the old scaffold if unreferenced
      if (context.targetMode === 'counts') {
        await replaceCountsDataset(context.targetProjectId, dataset.id)
      } else {
        await replaceMetadataDataset(context.targetProjectId, dataset.id)
      }

      hasTerminalToast = true
      toast.success(`${context.targetMode === 'counts' ? 'Count matrix' : 'Metadata'} imported successfully`, {
        id: toastId,
      })

      onImportComplete?.(dataset.id, context.targetMode)
      onOpenChange(false)
    } catch (error) {
      console.error('Import error:', error)
      hasTerminalToast = true
      toast.error(
        `Failed to import: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { id: toastId }
      )
    } finally {
      if (!hasTerminalToast) {
        toast.dismiss(toastId)
      }
      if (isLatestImportRequest(context)) {
        setIsImporting(false)
      }
    }
  }

  const handleImport = async () => {
    if (!selectedFile) return
    const requestContext = createImportRequestContext(mode)
    if (!requestContext) {
      toast.error('No active RNA-seq project selected for import.')
      return
    }
    if (validation.sampleMatch && validation.sampleMatch.status !== 'ok') {
      if (!confirmSampleMismatch(validation.sampleMatch)) {
        return
      }
    }

    const preview = previewResultRef.current
    if (preview) {
      await finalizeImport(preview, selectedFile, requestContext)
      return
    }

    // Fallback: import again if no preview exists
    try {
      const ext = selectedFile.split('.').pop()?.toLowerCase()
      let result: DataImportResult

      if (ext === 'csv') {
        result = await tauriApi.importCsv(selectedFile)
      } else if (ext === 'tsv' || ext === 'txt') {
        result = await tauriApi.importTsv(selectedFile)
      } else if (ext === 'xlsx' || ext === 'xls') {
        result = await tauriApi.importExcel(selectedFile)
      } else {
        throw new Error(`Unsupported file type: ${ext}`)
      }

      if (!isLatestImportRequest(requestContext)) {
        return
      }

      await finalizeImport(result, selectedFile, requestContext)
    } catch (error) {
      if (!isLatestImportRequest(requestContext)) {
        return
      }
      console.error('Import error:', error)
      toast.error(
        `Failed to import: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  useEffect(() => {
    if (!dialogOpen) return
    if (autoOpenRef.current) return
    autoOpenRef.current = true
    void selectFile(true)
  }, [dialogOpen, selectFile])

  const canImport =
    selectedFile &&
    (validation.status === 'valid' || validation.status === 'warning') &&
    !isImporting

  return (
    <Dialog open={dialogOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === 'counts' ? (
              <Table2 className="h-5 w-5 text-[#2E86AB]" />
            ) : (
              <FileSpreadsheet className="h-5 w-5 text-[#F59E0B]" />
            )}
            Import {mode === 'counts' ? 'Count Matrix' : 'Sample Metadata'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'counts'
              ? 'Select a file containing raw read counts with genes as rows and samples as columns.'
              : 'Select a file containing sample information with sample IDs and experimental factors.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* File Selection */}
          <div className="space-y-2">
            <Label>Data File</Label>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 justify-start text-left"
                onClick={handleSelectFile}
              >
                <Upload className="h-4 w-4 mr-2" />
                {fileName || 'Select file...'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Supported formats: CSV, TSV, TXT, XLSX
            </p>
          </div>

          {/* Validation Status */}
          {validation.status !== 'idle' && (
            <div
              className={cn(
                'p-3 rounded-md border',
                validation.status === 'validating' && 'bg-muted border-muted',
                validation.status === 'valid' && 'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800',
                validation.status === 'warning' && 'bg-yellow-50 border-yellow-200 dark:bg-yellow-950 dark:border-yellow-800',
                validation.status === 'error' && 'bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800'
              )}
            >
              <div className="flex items-start gap-2">
                {validation.status === 'validating' && (
                  <div className="h-4 w-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                )}
                {validation.status === 'valid' && (
                  <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5" />
                )}
                {validation.status === 'warning' && (
                  <AlertTriangle className="h-4 w-4 text-yellow-600 mt-0.5" />
                )}
                {validation.status === 'error' && (
                  <AlertCircle className="h-4 w-4 text-red-600 mt-0.5" />
                )}

                <div className="flex-1 space-y-1 text-sm">
                  {validation.status === 'validating' && (
                    <p className="text-muted-foreground">Validating file...</p>
                  )}

                  {mode === 'counts' && validation.countValidation && (
                    <>
                      <p className="font-medium">
                        {validation.countValidation.geneCount.toLocaleString()} genes,{' '}
                        {validation.countValidation.sampleCount} samples
                      </p>
                      {validation.countValidation.errors.map((err, i) => (
                        <p key={i} className="text-red-600">
                          {err}
                        </p>
                      ))}
                      {validation.countValidation.warnings.map((warn, i) => (
                        <p key={i} className="text-yellow-700 dark:text-yellow-500">
                          {warn}
                        </p>
                      ))}
                    </>
                  )}

                  {mode === 'metadata' && validation.metadataValidation && (
                    <>
                      <p className="font-medium">
                        {validation.metadataValidation.sampleCount} samples,{' '}
                        {validation.metadataValidation.columns.length} columns
                      </p>
                      {validation.metadataValidation.errors.map((err, i) => (
                        <p key={i} className="text-red-600">
                          {err}
                        </p>
                      ))}
                      {validation.metadataValidation.warnings.map((warn, i) => (
                        <p key={i} className="text-yellow-700 dark:text-yellow-500">
                          {warn}
                        </p>
                      ))}
                    </>
                  )}

                  {validation.sampleMatch && validation.sampleMatch.status !== 'ok' && (
                    <p
                      className={cn(
                        validation.sampleMatch.status === 'warning'
                          ? 'text-yellow-700 dark:text-yellow-500'
                          : 'text-red-600'
                      )}
                    >
                      {validation.sampleMatch.message}
                    </p>
                  )}

                  {validation.memoryEstimate && (
                    <p className="text-muted-foreground flex items-center gap-1">
                      <Info className="h-3 w-3" />
                      Estimated memory: ~{validation.memoryEstimate.totalMb} MB
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={!canImport}>
            {isImporting ? 'Importing...' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default RNAseqDataImportDialog
