/**
 * PyDESeq2ConfigDialog Component
 *
 * Configuration dialog for PyDESeq2 differential expression analysis.
 *
 * Features:
 * - Design formula builder with main factor + interaction terms
 * - Reference and test level selection for main factor
 * - Covariate configuration (continuous variables)
 * - Analysis options (shrinkage, alpha, count thresholds)
 * - Model name and description
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { message } from '@tauri-apps/plugin-dialog'
import {
  ResizableDialog,
  ResizableDialogContent,
  ResizableDialogDescription,
  ResizableDialogFooter,
  ResizableDialogHeader,
  ResizableDialogTitle,
} from '@/components/ui/resizable-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { FlaskConical, AlertCircle, Plus, X } from 'lucide-react'
import { useRNAseqStore } from '@/store/rnaseq-store'
import { useDataStore } from '@/store/data-store'
import cacheService from '@/services/cacheService'
import type {
  DESeqModel,
  ShrinkageMethod,
  CovariateConfig,
  Organism,
  GeneIdType,
  GeneLabelSource,
  PCAGeneSelectionMode,
} from '@/types/rnaseq'
import { DEFAULT_DESEQ_OPTIONS } from '@/types/rnaseq'
import { buildMainEffectContrastSummary } from './contrastSummary'

interface DESeq2ConfigDialogProps {
  open: boolean
  projectId: string
  existingModel?: DESeqModel // For editing existing model
  onOpenChange: (open: boolean) => void
  onSave?: (model: DESeqModel) => void | Promise<void>
  onSaveBatch?: (models: DESeqModel[]) => void | Promise<void>
}

interface FactorColumn {
  id: string
  name: string
  type: 'factor' | 'numeric'
}

interface AdditionalMainEffect {
  factor: string
  reference: string
  test: string
}

interface AdditionalInteraction {
  factor1: string // First factor in this interaction (from main effects)
  factor2: string // Second factor in this interaction (from main effects)
  factor3?: string // Optional third factor for 3-way interaction
}

interface StratifiedRun {
  id: string
  filters: Array<{ factor: string; level: string }>
  selectedModelKeys: string[]
}

interface CandidateModel {
  key: string
  type: 'main' | 'interaction'
  label: string
  factors: string[]
  formula: string
  configured: boolean
  note?: string
}

/**
 * Check if a column name is safe for use in R/Python formula syntax.
 * Formula-safe names must start with a letter or underscore and contain
 * only letters, numbers, and underscores.
 */
function isFormulaSafeName(name: string): boolean {
  if (!name || name.length === 0) return false
  // Must start with letter or underscore, followed by letters, numbers, or underscores
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/**
 * Get a human-readable description of why a name is formula-unsafe.
 */
function getFormulaUnsafeReason(name: string): string {
  if (!name || name.length === 0) return 'empty'
  if (/^\d/.test(name)) return 'starts with a number'
  if (/\s/.test(name)) return 'contains spaces'
  if (/[+\-*/:^()[\]{}|&<>=!@#$%,."'`~]/.test(name)) return 'contains special characters'
  return 'contains invalid characters'
}

function modelHasInteraction(model: DESeqModel): boolean {
  if (model.contrastType === 'interaction') return true
  if (model.interactionFactor || model.interactionFactor2) return true
  const formula = String(model.designFormula ?? '').replace(/\s+/g, '')
  return formula.includes('*') || formula.includes(':')
}

export function DESeq2ConfigDialog({
  open: dialogOpen,
  projectId,
  existingModel,
  onOpenChange,
  onSave,
  onSaveBatch,
}: DESeq2ConfigDialogProps) {
  const factorLoadDebounceMs = 250
  const typeLoadDebounceMs = 400
  // Form state
  const [mainFactor, setMainFactor] = useState('')
  const [mainFactorReference, setMainFactorReference] = useState('')
  const [mainFactorTest, setMainFactorTest] = useState('')
  const [additionalMainEffects, setAdditionalMainEffects] = useState<AdditionalMainEffect[]>([])
  const [interactionFactor1, setInteractionFactor1] = useState<string | undefined>()
  const [interactionFactor, setInteractionFactor] = useState<string | undefined>()
  const [interactionFactorReference, setInteractionFactorReference] = useState('')
  const [interactionFactorTest, setInteractionFactorTest] = useState('')
  const [interactionFactor2, setInteractionFactor2] = useState<string | undefined>()
  const [interactionFactor2Reference, setInteractionFactor2Reference] = useState('')
  const [interactionFactor2Test, setInteractionFactor2Test] = useState('')
  const [additionalInteractions, setAdditionalInteractions] = useState<AdditionalInteraction[]>([])
  const [covariates, setCovariates] = useState<CovariateConfig[]>([])
  const [includeCovariates, setIncludeCovariates] = useState(true)
  const [factorLevels, setFactorLevels] = useState<Record<string, string[]>>({})
  const [metadataColumnValues, setMetadataColumnValues] = useState<Record<string, string[]>>({})
  const [columnsWithData, setColumnsWithData] = useState<string[] | null>(null)
  const [numericColumnNames, setNumericColumnNames] = useState<string[]>([])
  const [discreteColumnNames, setDiscreteColumnNames] = useState<string[]>([])
  const [levelsLoading, setLevelsLoading] = useState(false)
  const [levelsError, setLevelsError] = useState<string | null>(null)
  const loadLevelsRequestRef = useRef(0)
  const lastLevelsDatasetIdRef = useRef<string | null>(null)
  const [useNullModel, setUseNullModel] = useState(false)
  const [pcaGroupBy, setPcaGroupBy] = useState<string>('')

  // Analysis options
  const [applyShrinkage, setApplyShrinkage] = useState(DEFAULT_DESEQ_OPTIONS.applyShrinkage)
  const shrinkageMethod: ShrinkageMethod = 'apeglm'
  const [organism, setOrganism] = useState<Organism>(DEFAULT_DESEQ_OPTIONS.organism)
  const [geneIdType, setGeneIdType] = useState<GeneIdType>(DEFAULT_DESEQ_OPTIONS.geneIdType)
  const [geneLabelSource, setGeneLabelSource] = useState<GeneLabelSource>(
    DEFAULT_DESEQ_OPTIONS.geneLabelSource
  )
  const [alpha, setAlpha] = useState(DEFAULT_DESEQ_OPTIONS.alpha)
  const [minCount, setMinCount] = useState(DEFAULT_DESEQ_OPTIONS.minCount)
  const [minSamples, setMinSamples] = useState(DEFAULT_DESEQ_OPTIONS.minSamples)
  const [pcaTopGenes, setPcaTopGenes] = useState(DEFAULT_DESEQ_OPTIONS.pcaTopGenes)
  const [pcaGeneSelectionMode, setPcaGeneSelectionMode] = useState<PCAGeneSelectionMode>(
    DEFAULT_DESEQ_OPTIONS.pcaGeneSelectionMode
  )
  const [usePadjForSignificance, setUsePadjForSignificance] = useState(
    DEFAULT_DESEQ_OPTIONS.usePadjForSignificance
  )
  const [stratifiedRuns, setStratifiedRuns] = useState<StratifiedRun[]>([])
  const hasInitializedRef = useRef(false)
  const isUserProvidedGeneLabels = geneLabelSource === 'user_provided'

  // Store hooks
  const { getProject, addModel, updateModel, deleteModel } = useRNAseqStore()
  const { datasets } = useDataStore()

  const project = getProject(projectId)
  const metadataDataset = project?.metadataDatasetId
    ? datasets.find((d) => d.id === project.metadataDatasetId)
    : null

  // Extract factor columns and levels from metadata
  const factorColumns = useMemo<FactorColumn[]>(() => {
    if (!metadataDataset) return []

    const numericOverrides = new Set(numericColumnNames)
    const discreteOverrides = new Set(discreteColumnNames)
    const dataColumnSet = columnsWithData ? new Set(columnsWithData) : null
    const factors: FactorColumn[] = []

    // Get column metadata - skip first column (sample ID)
    for (const col of metadataDataset.columns.slice(1)) {
      if (dataColumnSet && !dataColumnSet.has(col.name)) {
        continue
      }
      const isDiscrete = discreteOverrides.has(col.name)
      const isNumeric =
        (col.type === 'numeric' || numericOverrides.has(col.name)) && !isDiscrete

      factors.push({
        id: col.id,
        name: col.name,
        type: isNumeric ? 'numeric' : 'factor',
      })
    }

    return factors
  }, [metadataDataset, numericColumnNames, discreteColumnNames, columnsWithData])

  const normalizeOptionalFactor = useCallback((value?: string | null) => {
    if (!value) return undefined
    const trimmed = value.trim()
    return trimmed ? trimmed : undefined
  }, [])

  const serializeSubsetFilters = useCallback((filters?: Record<string, string> | null) => {
    if (!filters) return ''
    const entries = Object.entries(filters).filter(([factor, level]) => factor && level)
    if (entries.length === 0) return ''
    return entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([factor, level]) => `${factor}=${level}`)
      .join('|')
  }, [])

  const formatSubsetLabel = useCallback((filters: Array<{ factor: string; level: string }>) => {
    if (!filters.length) return 'Full dataset'
    return filters
      .filter((filter) => filter.factor && filter.level)
      .map((filter) => `${filter.factor}=${filter.level}`)
      .join(', ')
  }, [])

  const inferCovariateKind = useCallback(
    (columnName: string) => {
      const column = factorColumns.find((col) => col.name === columnName)
      return column?.type === 'numeric' ? 'numeric' : 'categorical'
    },
    [factorColumns]
  )

  const isNumericColumn = useCallback(
    (columnName: string) => factorColumns.find((col) => col.name === columnName)?.type === 'numeric',
    [factorColumns]
  )

  const columnByName = useMemo(
    () => new Map(factorColumns.map((col) => [col.name, col])),
    [factorColumns]
  )

  const withCurrentOption = useCallback(
    (options: FactorColumn[], current?: string) => {
      if (!current) return options
      if (options.some((option) => option.name === current)) return options
      const fallback = columnByName.get(current) ?? {
        id: current,
        name: current,
        type: 'numeric' as const,
      }
      return [...options, fallback]
    },
    [columnByName]
  )

  const noneSentinel = useMemo(() => {
    const names = new Set(factorColumns.map((col) => col.name))
    let sentinel = '__none__'
    while (names.has(sentinel)) {
      sentinel = `${sentinel}_`
    }
    return sentinel
  }, [factorColumns])

  const loadFactorLevels = useCallback(async () => {
    const requestId = ++loadLevelsRequestRef.current
    if (!metadataDataset) {
      setLevelsLoading(false)
      setLevelsError(null)
      setFactorLevels({})
      setMetadataColumnValues({})
      setColumnsWithData(null)
      return
    }

    // Load levels for all metadata columns up front to avoid cascading re-renders
    // when selection state changes (fixes flicker on dialog open/add main effect).
    const factorCols = metadataDataset.columns.slice(1)
    let candidateCols = factorCols

    if (factorCols.length === 0) {
      setLevelsLoading(false)
      setLevelsError(null)
      setFactorLevels({})
      setMetadataColumnValues({})
      setColumnsWithData([])
      return
    }

    setLevelsLoading(true)
    setLevelsError(null)

    try {
      try {
        const stats = await cacheService.getAllColumnStats(metadataDataset.id)
        if (stats.length > 0) {
          const statsById = new Map(stats.map((stat) => [stat.columnId, stat]))
          candidateCols = factorCols.filter((col) => {
            const stat = statsById.get(col.id)
            return stat ? stat.nonNullCount > 0 : false
          })
        }
      } catch (error) {
        console.warn('Failed to load column stats, falling back to full scan:', error)
      }

      if (candidateCols.length === 0) {
        setFactorLevels({})
        setMetadataColumnValues({})
        setColumnsWithData([])
        return
      }

      const data = await cacheService.getColumnsData(
        metadataDataset.id,
        candidateCols.map((col) => col.id)
      )

      if (requestId !== loadLevelsRequestRef.current) return

      const levelsByName: Record<string, string[]> = {}
      const valuesByName: Record<string, string[]> = {}
      const nonEmptyColumns: string[] = []
      for (const col of candidateCols) {
        const values = data[col.id] ?? []
        const seen = new Set<string>()
        const levels: string[] = []
        const normalizedValues: string[] = []
        for (const value of values) {
          const normalized = value == null ? '' : String(value).trim()
          normalizedValues.push(normalized)
          if (!normalized || seen.has(normalized)) continue
          seen.add(normalized)
          levels.push(normalized)
        }
        levelsByName[col.name] = levels
        valuesByName[col.name] = normalizedValues
        if (normalizedValues.some((value) => value !== '')) {
          nonEmptyColumns.push(col.name)
        }
      }

      setFactorLevels(levelsByName)
      setMetadataColumnValues(valuesByName)
      setColumnsWithData(nonEmptyColumns)
    } catch (error) {
      if (requestId !== loadLevelsRequestRef.current) return
      console.error('Failed to load metadata levels:', error)
      setLevelsError('Failed to load metadata levels')
      setFactorLevels({})
      setMetadataColumnValues({})
      setColumnsWithData(null)
    } finally {
      if (requestId === loadLevelsRequestRef.current) {
        setLevelsLoading(false)
      }
    }
  }, [metadataDataset])

  const loadNumericColumnTypes = useCallback(async () => {
    if (!metadataDataset) {
      setNumericColumnNames([])
      setDiscreteColumnNames([])
      return
    }

    const dataColumnSet = columnsWithData ? new Set(columnsWithData) : null
    const candidateCols = metadataDataset.columns
      .slice(1)
      .filter((col) => !dataColumnSet || dataColumnSet.has(col.name))
    if (candidateCols.length === 0) {
      setNumericColumnNames([])
      setDiscreteColumnNames([])
      return
    }

    try {
      const data = await cacheService.getColumnsData(
        metadataDataset.id,
        candidateCols.map((col) => col.id)
      )

      const numericNames: string[] = []
      const discreteNames: string[] = []
      for (const col of candidateCols) {
        const values = data[col.id] ?? []
        const cleaned = values
          .map((value) => (value == null ? '' : String(value).trim()))
          .filter((value) => value !== '')
        if (cleaned.length === 0) continue

        let numericCount = 0
        let integerCount = 0
        const uniqueValues = new Set<string>()
        for (const value of cleaned) {
          const parsed = Number(value)
          if (Number.isFinite(parsed)) {
            numericCount += 1
            if (Number.isInteger(parsed)) {
              integerCount += 1
            }
          }
          uniqueValues.add(value)
        }

        const numericRatio = numericCount / cleaned.length
        if (numericRatio >= 0.9) {
          const integerRatio = integerCount / cleaned.length
          const uniqueCount = uniqueValues.size
          const isDiscrete = integerRatio >= 0.9 && uniqueCount <= 12
          if (isDiscrete) {
            discreteNames.push(col.name)
          } else {
            numericNames.push(col.name)
          }
        }
      }

      setNumericColumnNames(numericNames)
      setDiscreteColumnNames(discreteNames)
    } catch (error) {
      console.error('Failed to infer numeric columns:', error)
      setNumericColumnNames([])
      setDiscreteColumnNames([])
    }
  }, [metadataDataset, columnsWithData])

  useEffect(() => {
    if (!dialogOpen) {
      lastLevelsDatasetIdRef.current = null
      return
    }
    if (!metadataDataset) return
    if (lastLevelsDatasetIdRef.current === metadataDataset.id) return
    lastLevelsDatasetIdRef.current = metadataDataset.id
    const timer = setTimeout(() => {
      void loadFactorLevels()
    }, factorLoadDebounceMs)
    return () => clearTimeout(timer)
  }, [dialogOpen, metadataDataset, loadFactorLevels, factorLoadDebounceMs])

  useEffect(() => {
    if (!dialogOpen || !metadataDataset) return
    const timer = setTimeout(() => {
      void loadNumericColumnTypes()
    }, typeLoadDebounceMs)
    return () => clearTimeout(timer)
  }, [dialogOpen, metadataDataset, loadNumericColumnTypes, typeLoadDebounceMs])

  // Get available levels for selected main factor
  const mainFactorLevels = useMemo(
    () => (mainFactor ? factorLevels[mainFactor] ?? [] : []),
    [mainFactor, factorLevels]
  )

  const mainEffectByFactor = useMemo(() => {
    const map = new Map<string, { reference: string; test: string }>()
    if (mainFactor) {
      map.set(mainFactor, { reference: mainFactorReference, test: mainFactorTest })
    }
    for (const effect of additionalMainEffects) {
      if (!effect.factor) continue
      map.set(effect.factor, { reference: effect.reference, test: effect.test })
    }
    return map
  }, [mainFactor, mainFactorReference, mainFactorTest, additionalMainEffects])

  const canConfigureInteraction = Boolean(
    !useNullModel && mainFactor && additionalMainEffects.some((effect) => effect.factor)
  )

  const getInteractionKey = useCallback((factors: Array<string | undefined>) => {
    const sorted = factors.filter(Boolean).sort() as string[]
    return `interaction:${sorted.join(':')}`
  }, [])

  useEffect(() => {
    if (!mainFactor) {
      setMainFactorReference('')
      setMainFactorTest('')
      return
    }

    if (mainFactorLevels.length === 0) return

    if (!mainFactorLevels.includes(mainFactorReference)) {
      setMainFactorReference(mainFactorLevels[0] ?? '')
    }

    if (
      !mainFactorLevels.includes(mainFactorTest) ||
      mainFactorTest === mainFactorReference
    ) {
      const fallback = mainFactorLevels.find((level) => level !== mainFactorReference)
      setMainFactorTest(fallback ?? mainFactorLevels[0] ?? '')
    }
  }, [mainFactor, mainFactorLevels, mainFactorReference, mainFactorTest])

  useEffect(() => {
    if (!canConfigureInteraction) {
      setInteractionFactor1(undefined)
      setInteractionFactor(undefined)
      setInteractionFactorReference('')
      setInteractionFactorTest('')
      setInteractionFactor2(undefined)
      setInteractionFactor2Reference('')
      setInteractionFactor2Test('')
      return
    }

    const validFactors = [mainFactor, ...additionalMainEffects.map((effect) => effect.factor)].filter(
      (factor): factor is string => Boolean(factor)
    )
    const fallbackFactor = validFactors[0]
    if (interactionFactor1 && !validFactors.includes(interactionFactor1)) {
      setInteractionFactor1(fallbackFactor)
    } else if (!interactionFactor1 && interactionFactor) {
      setInteractionFactor1(fallbackFactor)
    }

    if (!interactionFactor) {
      setInteractionFactorReference('')
      setInteractionFactorTest('')
      setInteractionFactor2(undefined)
      setInteractionFactor2Reference('')
      setInteractionFactor2Test('')
      return
    }

    const levels = mainEffectByFactor.get(interactionFactor)
    if (!levels) {
      setInteractionFactor(undefined)
      setInteractionFactorReference('')
      setInteractionFactorTest('')
      return
    }

    if (interactionFactorReference !== levels.reference) {
      setInteractionFactorReference(levels.reference)
    }
    if (interactionFactorTest !== levels.test) {
      setInteractionFactorTest(levels.test)
    }
  }, [
    canConfigureInteraction,
    mainFactor,
    additionalMainEffects,
    interactionFactor1,
    interactionFactor,
    interactionFactorReference,
    interactionFactorTest,
    mainEffectByFactor,
  ])

  useEffect(() => {
    if (!interactionFactor2) {
      setInteractionFactor2Reference('')
      setInteractionFactor2Test('')
      return
    }

    const levels = mainEffectByFactor.get(interactionFactor2)
    if (!levels) {
      setInteractionFactor2(undefined)
      setInteractionFactor2Reference('')
      setInteractionFactor2Test('')
      return
    }

    if (interactionFactor2Reference !== levels.reference) {
      setInteractionFactor2Reference(levels.reference)
    }
    if (interactionFactor2Test !== levels.test) {
      setInteractionFactor2Test(levels.test)
    }
  }, [
    interactionFactor2,
    interactionFactor2Reference,
    interactionFactor2Test,
    mainEffectByFactor,
  ])

  useEffect(() => {
    if (
      interactionFactor2 &&
      (interactionFactor2 === interactionFactor1 || interactionFactor2 === interactionFactor)
    ) {
      setInteractionFactor2(undefined)
      setInteractionFactor2Reference('')
      setInteractionFactor2Test('')
    }
  }, [interactionFactor2, interactionFactor1, interactionFactor])

  useEffect(() => {
    if (!useNullModel) {
      setPcaGroupBy('')
    }
  }, [useNullModel])

  // Reset form when dialog opens
  useEffect(() => {
    if (!dialogOpen) {
      hasInitializedRef.current = false
      return
    }

    if (hasInitializedRef.current) return
    hasInitializedRef.current = true

    if (existingModel) {
        // Populate form from existing model
        const groupId = existingModel.groupId ?? existingModel.id
        const groupModels =
          project?.models.filter((model) => (model.groupId ?? model.id) === groupId) ?? []
        const interactionModels = groupModels.filter(
          (model) => modelHasInteraction(model) && model.interactionFactor
        )
        const primaryInteraction =
          modelHasInteraction(existingModel)
            ? existingModel
            : interactionModels[0]

        setMainFactor(existingModel.mainFactor)
        setMainFactorReference(existingModel.mainFactorReference)
        setMainFactorTest(existingModel.mainFactorTest)
        const mainModels = groupModels.filter((model) => !modelHasInteraction(model))
        const additionalFromModel = mainModels
          .filter((model) => model.mainFactor && model.mainFactor !== existingModel.mainFactor)
          .map((model) => ({
            factor: model.mainFactor,
            reference: model.mainFactorReference ?? '',
            test: model.mainFactorTest ?? '',
          }))
        const interactionFactors = primaryInteraction
          ? [primaryInteraction.interactionFactor, primaryInteraction.interactionFactor2]
              .filter(
                (factor): factor is string =>
                  Boolean(factor) && factor !== primaryInteraction.mainFactor
              )
              .map((factor) => ({
                factor,
                reference:
                  factor === primaryInteraction.interactionFactor
                    ? primaryInteraction.interactionFactorReference ?? ''
                    : primaryInteraction.interactionFactor2Reference ?? '',
                test:
                  factor === primaryInteraction.interactionFactor
                    ? primaryInteraction.interactionFactorTest ?? ''
                    : primaryInteraction.interactionFactor2Test ?? '',
              }))
          : []
        const mergedAdditional = [...additionalFromModel]
        for (const entry of interactionFactors) {
          if (!mergedAdditional.some((effect) => effect.factor === entry.factor)) {
            mergedAdditional.push(entry)
          }
        }
        setAdditionalMainEffects(mergedAdditional)
        if (primaryInteraction) {
          setInteractionFactor1(normalizeOptionalFactor(primaryInteraction.mainFactor))
          setInteractionFactor(normalizeOptionalFactor(primaryInteraction.interactionFactor))
          setInteractionFactorReference(primaryInteraction.interactionFactorReference ?? '')
          setInteractionFactorTest(primaryInteraction.interactionFactorTest ?? '')
          setInteractionFactor2(normalizeOptionalFactor(primaryInteraction.interactionFactor2))
          setInteractionFactor2Reference(primaryInteraction.interactionFactor2Reference ?? '')
          setInteractionFactor2Test(primaryInteraction.interactionFactor2Test ?? '')
        } else {
          setInteractionFactor1(undefined)
          setInteractionFactor(undefined)
          setInteractionFactorReference('')
          setInteractionFactorTest('')
          setInteractionFactor2(undefined)
          setInteractionFactor2Reference('')
          setInteractionFactor2Test('')
        }
        const primaryKey = primaryInteraction
          ? getInteractionKey([
              primaryInteraction.mainFactor,
              primaryInteraction.interactionFactor,
              primaryInteraction.interactionFactor2,
            ])
          : ''
        const nextAdditional = new Map<string, AdditionalInteraction>()
        for (const model of interactionModels) {
          const key = getInteractionKey([
            model.mainFactor,
            model.interactionFactor,
            model.interactionFactor2,
          ])
          if (!key || key === primaryKey) continue
          if (nextAdditional.has(key)) continue
          nextAdditional.set(key, {
            factor1: model.mainFactor,
            factor2: model.interactionFactor ?? '',
            factor3: model.interactionFactor2 ?? undefined,
          })
        }
        setAdditionalInteractions(Array.from(nextAdditional.values()))
        setCovariates(
          (existingModel.covariates ?? []).map((cov) => {
            const kind = cov.kind ?? inferCovariateKind(cov.column)
            return {
              ...cov,
              kind,
              referenceLevel: cov.referenceLevel ?? '',
              centerAndScale:
                cov.centerAndScale ?? (kind === 'numeric'),
            }
          })
        )
        setIncludeCovariates(existingModel.includeCovariates ?? true)
        setUseNullModel(existingModel.useNullModel ?? false)
        setPcaGroupBy(existingModel.pcaGroupBy ?? '')
        setApplyShrinkage(existingModel.applyShrinkage)
        setOrganism(existingModel.organism ?? DEFAULT_DESEQ_OPTIONS.organism)
        setGeneIdType(existingModel.geneIdType ?? DEFAULT_DESEQ_OPTIONS.geneIdType)
        setGeneLabelSource(existingModel.geneLabelSource ?? DEFAULT_DESEQ_OPTIONS.geneLabelSource)
        setAlpha(existingModel.alpha)
        setMinCount(existingModel.minCount)
        setMinSamples(existingModel.minSamples)
        setPcaTopGenes(existingModel.pcaTopGenes ?? DEFAULT_DESEQ_OPTIONS.pcaTopGenes)
        setPcaGeneSelectionMode(
          existingModel.pcaGeneSelectionMode ?? DEFAULT_DESEQ_OPTIONS.pcaGeneSelectionMode
        )
        setUsePadjForSignificance(existingModel.usePadjForSignificance)
        const stratifiedByKey = new Map<string, StratifiedRun>()
        for (const model of groupModels) {
          const subsetKey = serializeSubsetFilters(model.subsetFilters ?? null)
          if (!subsetKey) continue
          if (!stratifiedByKey.has(subsetKey)) {
            const filters = Object.entries(model.subsetFilters ?? {}).map(([factor, level]) => ({
              factor,
              level,
            }))
            stratifiedByKey.set(subsetKey, {
              id: `subset_${subsetKey}_${Math.random().toString(36).slice(2, 6)}`,
              filters,
              selectedModelKeys: [],
            })
          }
          const run = stratifiedByKey.get(subsetKey)
          if (run) {
            const key =
              modelHasInteraction(model) && model.interactionFactor
                ? getInteractionKey([model.mainFactor, model.interactionFactor, model.interactionFactor2])
                : `main:${model.mainFactor}`
            if (key && !run.selectedModelKeys.includes(key)) {
              run.selectedModelKeys.push(key)
            }
          }
        }
        setStratifiedRuns(Array.from(stratifiedByKey.values()))
      } else {
        // Reset to defaults for new model
        setMainFactor('')
        setMainFactorReference('')
        setMainFactorTest('')
        setAdditionalMainEffects([])
        setInteractionFactor1(undefined)
        setInteractionFactor(undefined)
        setInteractionFactorReference('')
        setInteractionFactorTest('')
        setInteractionFactor2(undefined)
        setInteractionFactor2Reference('')
        setInteractionFactor2Test('')
        setAdditionalInteractions([])
        setCovariates([])
        setIncludeCovariates(true)
        setUseNullModel(false)
        setPcaGroupBy('')
        setApplyShrinkage(DEFAULT_DESEQ_OPTIONS.applyShrinkage)
        setOrganism(DEFAULT_DESEQ_OPTIONS.organism)
        setGeneIdType(DEFAULT_DESEQ_OPTIONS.geneIdType)
        setGeneLabelSource(DEFAULT_DESEQ_OPTIONS.geneLabelSource)
        setAlpha(DEFAULT_DESEQ_OPTIONS.alpha)
        setMinCount(DEFAULT_DESEQ_OPTIONS.minCount)
        setMinSamples(DEFAULT_DESEQ_OPTIONS.minSamples)
        setPcaTopGenes(DEFAULT_DESEQ_OPTIONS.pcaTopGenes)
        setPcaGeneSelectionMode(DEFAULT_DESEQ_OPTIONS.pcaGeneSelectionMode)
        setUsePadjForSignificance(DEFAULT_DESEQ_OPTIONS.usePadjForSignificance)
        setStratifiedRuns([])
      }
  }, [
    dialogOpen,
    existingModel,
    project,
    normalizeOptionalFactor,
    inferCovariateKind,
    getInteractionKey,
    serializeSubsetFilters,
  ])

  // Add covariate
  const handleAddCovariate = () => {
    if (covariates.length >= 2) return
    const availableColumns = factorColumns.filter(
      (f) => !covariates.some((c) => c.column === f.name)
    )

    if (availableColumns.length > 0 && availableColumns[0]) {
      const kind = inferCovariateKind(availableColumns[0].name)
      const levels = factorLevels[availableColumns[0].name] ?? []
      const referenceLevel =
        kind === 'categorical' ? levels[0] ?? '' : ''
      setCovariates([
        ...covariates,
        {
          column: availableColumns[0].name,
          kind,
          centerAndScale: kind === 'numeric',
          referenceLevel,
        },
      ])
    }
  }

  // Remove covariate
  const handleRemoveCovariate = (index: number) => {
    setCovariates(covariates.filter((_, i) => i !== index))
  }

  const handleAddMainEffect = () => {
    if (additionalMainEffects.length >= 2) return
    const availableFactors = factorColumns.filter(
      (f) =>
        f.type === 'factor' &&
        f.name !== mainFactor &&
        f.name !== interactionFactor &&
        f.name !== interactionFactor2 &&
        !additionalMainEffects.some((effect) => effect.factor === f.name)
    )

    if (availableFactors.length > 0 && availableFactors[0]) {
      const levels = factorLevels[availableFactors[0].name] ?? []
      const reference = levels[0] ?? ''
      const test = levels.find((level) => level !== reference) ?? levels[1] ?? ''
      setAdditionalMainEffects([
        ...additionalMainEffects,
        { factor: availableFactors[0].name, reference, test },
      ])
    }
  }

  const handleRemoveMainEffect = (index: number) => {
    setAdditionalMainEffects(additionalMainEffects.filter((_, i) => i !== index))
  }

  const createStratifiedRun = () => ({
    id: `subset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    filters: [],
    selectedModelKeys: [],
  })

  const handleAddStratifiedRun = () => {
    setStratifiedRuns((prev) => [...prev, createStratifiedRun()])
  }

  const handleRemoveStratifiedRun = (runId: string) => {
    setStratifiedRuns((prev) => prev.filter((run) => run.id !== runId))
  }

  const handleAddRunFilter = (runId: string) => {
    setStratifiedRuns((prev) =>
      prev.map((run) => {
        if (run.id !== runId) return run
        const usedFactors = new Set(run.filters.map((filter) => filter.factor))
        const available = availableSubsetFactors.filter((factor) => !usedFactors.has(factor.name))
        if (available.length === 0 || !available[0]) return run
        const factorName = available[0].name
        const levels = factorLevels[factorName] ?? []
        return {
          ...run,
          filters: [...run.filters, { factor: factorName, level: levels[0] ?? '' }],
        }
      })
    )
  }

  const handleRemoveRunFilter = (runId: string, index: number) => {
    setStratifiedRuns((prev) =>
      prev.map((run) =>
        run.id === runId
          ? { ...run, filters: run.filters.filter((_, i) => i !== index) }
          : run
      )
    )
  }

  const handleAddInteraction = () => {
    // Get available factors for interactions (main factor + additional main effects)
    const allMainEffectFactors = mainEffectFactors
    if (allMainEffectFactors.length < 2) return
    if (additionalInteractions.length >= 2) return // Max 3 total (primary + 2 additional)

    // Find unused factor combinations
    const usedPairs = new Set<string>()
    // Primary interaction
    if (interactionFactor1 && interactionFactor) {
      usedPairs.add(
        getInteractionKey([interactionFactor1, interactionFactor, interactionFactor2])
      )
    }
    // Additional interactions
    for (const interaction of additionalInteractions) {
      usedPairs.add(
        getInteractionKey([interaction.factor1, interaction.factor2, interaction.factor3])
      )
    }

    // Find first unused pair
    for (let i = 0; i < allMainEffectFactors.length; i++) {
      for (let j = i + 1; j < allMainEffectFactors.length; j++) {
        const f1 = allMainEffectFactors[i]
        const f2 = allMainEffectFactors[j]
        if (!f1 || !f2) continue
        const key = getInteractionKey([f1, f2])
        if (!usedPairs.has(key)) {
          setAdditionalInteractions([...additionalInteractions, { factor1: f1, factor2: f2 }])
          return
        }
      }
    }
  }

  const handleRemoveInteraction = (index: number) => {
    setAdditionalInteractions(additionalInteractions.filter((_, i) => i !== index))
  }

  useEffect(() => {
    setAdditionalMainEffects((prev) =>
      prev.filter(
        (effect) =>
          effect.factor !== mainFactor
      )
    )
  }, [mainFactor])

  useEffect(() => {
    if (!canConfigureInteraction) return
    const validFactors = new Set(
      [mainFactor, ...additionalMainEffects.map((effect) => effect.factor)].filter(Boolean)
    )
    if (interactionFactor && !validFactors.has(interactionFactor)) {
      setInteractionFactor(undefined)
      setInteractionFactorReference('')
      setInteractionFactorTest('')
    }
    if (interactionFactor2 && !validFactors.has(interactionFactor2)) {
      setInteractionFactor2(undefined)
      setInteractionFactor2Reference('')
      setInteractionFactor2Test('')
    }
  }, [
    additionalMainEffects,
    canConfigureInteraction,
    interactionFactor,
    interactionFactor1,
    interactionFactor2,
    mainFactor,
  ])

  // Clean up additional interactions when main effects change
  useEffect(() => {
    const validFactors = new Set([mainFactor, ...additionalMainEffects.map(e => e.factor)].filter(Boolean))
    const primaryKey = interactionFactor1 && interactionFactor
      ? getInteractionKey([interactionFactor1, interactionFactor, interactionFactor2])
      : ''
    const seen = new Set<string>()
    setAdditionalInteractions((prev) => {
      const next = prev.filter((interaction) => {
        if (
          !validFactors.has(interaction.factor1) ||
          !validFactors.has(interaction.factor2) ||
          (interaction.factor3 && !validFactors.has(interaction.factor3))
        ) {
          return false
        }
        const key = getInteractionKey([
          interaction.factor1,
          interaction.factor2,
          interaction.factor3,
        ])
        if (!key || key === primaryKey || seen.has(key)) {
          return false
        }
        seen.add(key)
        return true
      })
      if (next.length === prev.length) {
        let unchanged = true
        for (let i = 0; i < prev.length; i += 1) {
          const prevItem = prev[i]
          const nextItem = next[i]
          if (
            prevItem?.factor1 !== nextItem?.factor1 ||
            prevItem?.factor2 !== nextItem?.factor2 ||
            prevItem?.factor3 !== nextItem?.factor3
          ) {
            unchanged = false
            break
          }
        }
        if (unchanged) return prev
      }
      return next
    })
  }, [
    mainFactor,
    additionalMainEffects,
    interactionFactor1,
    interactionFactor,
    interactionFactor2,
    additionalInteractions,
    getInteractionKey,
  ])

  useEffect(() => {
    setStratifiedRuns((prev) => {
      let changed = false
      const next = prev.map((run) => {
        let runChanged = false
        const updatedFilters = run.filters.map((filter) => {
          if (!filter.factor) return filter
          const levels = factorLevels[filter.factor] ?? []
          if (levels.length === 0) {
            if (filter.level !== '') {
              runChanged = true
              return { ...filter, level: '' }
            }
            return filter
          }
          if (!levels.includes(filter.level)) {
            runChanged = true
            return { ...filter, level: levels[0] ?? '' }
          }
          return filter
        })
        if (runChanged) {
          changed = true
          return { ...run, filters: updatedFilters }
        }
        return run
      })
      return changed ? next : prev
    })
  }, [factorLevels])

  useEffect(() => {
    setAdditionalMainEffects((prev) => {
      let didChange = false
      const next = prev.map((effect) => {
        if (!effect.factor) return effect
        const levels = factorLevels[effect.factor] ?? []
        if (levels.length === 0) return effect

        let reference = effect.reference
        let test = effect.test
        let changed = false

        if (!levels.includes(reference)) {
          reference = levels[0] ?? ''
          changed = true
        }
        if (!levels.includes(test) || test === reference) {
          test = levels.find((level) => level !== reference) ?? levels[1] ?? ''
          changed = true
        }

        if (changed) {
          didChange = true
          return { ...effect, reference, test }
        }
        return effect
      })

      return didChange ? next : prev
    })
  }, [factorLevels])

  useEffect(() => {
    setCovariates((prev) => {
      let didChange = false
      const next = prev.map((cov) => {
        const resolvedKind = cov.kind ?? inferCovariateKind(cov.column)
        let updated = cov

        if (!cov.kind && resolvedKind) {
          updated = { ...updated, kind: resolvedKind }
          didChange = true
        }

        if (resolvedKind === 'categorical') {
          const levels = factorLevels[cov.column] ?? []
          if (levels.length > 0 && !levels.includes(cov.referenceLevel ?? '')) {
            updated = { ...updated, referenceLevel: levels[0] ?? '' }
            didChange = true
          }
        }

        return updated
      })
      return didChange ? next : prev
    })
  }, [factorLevels, inferCovariateKind])

  // Validation
  const validationErrors = useMemo(() => {
    const errors: string[] = []

    if (!useNullModel) {
      if (!mainFactor) {
        errors.push('Main factor is required')
      }

      if (mainFactor && isNumericColumn(mainFactor)) {
        errors.push('Main factor must be categorical')
      }

      if (mainFactor && !mainFactorReference) {
        errors.push('Reference level is required')
      }

      if (mainFactor && !mainFactorTest) {
        errors.push('Test level is required')
      }

      if (mainFactorReference && mainFactorTest && mainFactorReference === mainFactorTest) {
        errors.push('Reference and test levels must be different')
      }

      const hasPrimaryInteraction = Boolean(interactionFactor)
      const hasAnyInteraction = hasPrimaryInteraction || additionalInteractions.length > 0
      if (hasAnyInteraction) {
        if (!canConfigureInteraction) {
          errors.push('Interaction requires at least two main effects (main factor + additional)')
        }
        if (interactionFactor2 && !interactionFactor) {
          errors.push('Second interaction factor requires a primary interaction factor')
        }
        if (hasPrimaryInteraction) {
          if (!interactionFactor1) {
            errors.push('Primary interaction factor is required')
          }
          if (
            interactionFactor1 &&
            ![mainFactor, ...additionalMainEffects.map((effect) => effect.factor)].includes(interactionFactor1)
          ) {
            errors.push('Primary interaction factor must be selected from the main effects')
          }
          if (interactionFactor1 && isNumericColumn(interactionFactor1)) {
            errors.push('Primary interaction factor must be categorical')
          }
          if (
            interactionFactor &&
            ![mainFactor, ...additionalMainEffects.map((effect) => effect.factor)].includes(interactionFactor)
          ) {
            errors.push('Interaction factor must be selected from the main effects')
          }
          if (interactionFactor1 && interactionFactor1 === interactionFactor) {
            errors.push('Primary interaction factor must be different from the second factor')
          }
          if (interactionFactor && isNumericColumn(interactionFactor)) {
            errors.push('Interaction factor must be categorical')
          }
          if (interactionFactor && !interactionFactorReference) {
            errors.push('Interaction reference level is required')
          }
          if (interactionFactor && !interactionFactorTest) {
            errors.push('Interaction test level is required')
          }
          if (
            interactionFactorReference &&
            interactionFactorTest &&
            interactionFactorReference === interactionFactorTest
          ) {
            errors.push('Interaction reference and test levels must be different')
          }
          if (interactionFactor2) {
            if (isNumericColumn(interactionFactor2)) {
              errors.push('Second interaction factor must be categorical')
            }
            if (!interactionFactor2Reference) {
              errors.push('Second interaction reference level is required')
            }
            if (!interactionFactor2Test) {
              errors.push('Second interaction test level is required')
            }
            if (
              interactionFactor2Reference &&
              interactionFactor2Test &&
              interactionFactor2Reference === interactionFactor2Test
            ) {
              errors.push('Second interaction reference and test levels must be different')
            }
          }
        }
        const validFactors = new Set(
          [mainFactor, ...additionalMainEffects.map((effect) => effect.factor)].filter(Boolean)
        )
        const seen = new Set<string>()
        if (hasPrimaryInteraction && interactionFactor1) {
          seen.add(getInteractionKey([interactionFactor1, interactionFactor, interactionFactor2]))
        }
        additionalInteractions.forEach((interaction, index) => {
          const label = `Interaction ${index + 1}`
          if (!interaction.factor1 || !interaction.factor2) {
            errors.push(`${label} requires at least two factors`)
            return
          }
          if (!validFactors.has(interaction.factor1) || !validFactors.has(interaction.factor2)) {
            errors.push(`${label} must use factors from the main effects`)
          }
          if (interaction.factor1 === interaction.factor2) {
            errors.push(`${label} must use two different factors`)
          }
          if (
            interaction.factor3 &&
            (interaction.factor3 === interaction.factor1 ||
              interaction.factor3 === interaction.factor2)
          ) {
            errors.push(`${label} third factor must be different`)
          }
          if (interaction.factor3 && !validFactors.has(interaction.factor3)) {
            errors.push(`${label} third factor must use a main-effect factor`)
          }
          const key = getInteractionKey([interaction.factor1, interaction.factor2, interaction.factor3])
          if (seen.has(key)) {
            errors.push(`${label} duplicates an existing interaction`)
          } else {
            seen.add(key)
          }
          if (isNumericColumn(interaction.factor1) || isNumericColumn(interaction.factor2)) {
            errors.push(`${label} factors must be categorical`)
          }
          if (interaction.factor3 && isNumericColumn(interaction.factor3)) {
            errors.push(`${label} third factor must be categorical`)
          }
        })
      }
    }

    if (!useNullModel) {
      for (const effect of additionalMainEffects) {
        if (!effect.factor) {
          errors.push('Additional main effect factor is required')
          continue
        }
        if (isNumericColumn(effect.factor)) {
          errors.push(`Additional main effect "${effect.factor}" must be categorical`)
        }
        const levels = factorLevels[effect.factor] ?? []
        if (levels.length < 2) {
          errors.push(`Additional main effect "${effect.factor}" must have at least 2 levels`)
        }
        if (!effect.reference || !effect.test) {
          errors.push(`Additional main effect "${effect.factor}" requires reference and test levels`)
        } else if (effect.reference === effect.test) {
          errors.push(
            `Additional main effect "${effect.factor}" reference and test levels must differ`
          )
        }
      }
    }

    if (!metadataDataset) {
      errors.push('Sample metadata must be loaded first')
    }

    // Validate formula-safe column names (Issue 7)
    // Column names with spaces or special characters will cause Python/R formula parsing errors
    const formulaColumns: Array<{ name: string; role: string }> = []
    if (mainFactor && !useNullModel) {
      formulaColumns.push({ name: mainFactor, role: 'Main factor' })
    }
    if (interactionFactor1 && !useNullModel) {
      formulaColumns.push({ name: interactionFactor1, role: 'Primary interaction factor' })
    }
    if (interactionFactor && !useNullModel) {
      formulaColumns.push({ name: interactionFactor, role: 'Interaction factor' })
    }
    if (interactionFactor2 && !useNullModel) {
      formulaColumns.push({ name: interactionFactor2, role: 'Second interaction factor' })
    }
    if (!useNullModel) {
      for (const effect of additionalMainEffects) {
        if (effect.factor) {
          formulaColumns.push({ name: effect.factor, role: `Additional main effect "${effect.factor}"` })
        }
      }
    }
    if (!useNullModel && includeCovariates) {
      for (const cov of covariates) {
        if (cov.column) {
          formulaColumns.push({ name: cov.column, role: `Covariate "${cov.column}"` })
        }
      }
    }

    for (const { name, role } of formulaColumns) {
      if (!isFormulaSafeName(name)) {
        const reason = getFormulaUnsafeReason(name)
        errors.push(
          `${role} "${name}" ${reason}. Column names must start with a letter and contain only letters, numbers, or underscores. Please check your metadata columns.`
        )
      }
    }

    if (covariates.length > 2) {
      errors.push('At most 2 covariates are supported')
    }

    if (additionalMainEffects.length > 2) {
      errors.push('At most 3 total main-effect runs are supported')
    }

    if (includeCovariates) {
      for (const cov of covariates) {
        if (!cov.column) {
          errors.push('Covariate column is required')
          continue
        }
        const kind = cov.kind ?? inferCovariateKind(cov.column)
        if (kind === 'categorical') {
          const levels = factorLevels[cov.column] ?? []
          if (levels.length < 2) {
            errors.push(`Covariate "${cov.column}" must have at least 2 levels`)
          }
          if (!cov.referenceLevel) {
            errors.push(`Covariate "${cov.column}" requires a reference level`)
          } else if (!levels.includes(cov.referenceLevel)) {
            errors.push(`Covariate "${cov.column}" reference level is invalid`)
          }
        }
      }
    }

    if (!useNullModel) {
      stratifiedRuns.forEach((run, index) => {
        const label = `Stratified run ${index + 1}`
        if (run.filters.length === 0) {
          errors.push(`${label} must include at least one filter`)
        }
        const hasIncomplete = run.filters.some((filter) => !filter.factor || !filter.level)
        if (hasIncomplete) {
          errors.push(`${label} filters must include both factor and level`)
        }
        if (run.selectedModelKeys.length === 0) {
          errors.push(`${label} must include at least one eligible model`)
        }
      })
    }

    return errors
  }, [
    mainFactor,
    mainFactorReference,
    mainFactorTest,
    canConfigureInteraction,
    interactionFactor1,
    interactionFactor,
    interactionFactorReference,
    interactionFactorTest,
    interactionFactor2,
    interactionFactor2Reference,
    interactionFactor2Test,
    additionalMainEffects,
    additionalInteractions,
    factorLevels,
    covariates,
    inferCovariateKind,
    includeCovariates,
    isNumericColumn,
    metadataDataset,
    stratifiedRuns,
    useNullModel,
    getInteractionKey,
  ])

  const canSave = validationErrors.length === 0

  const getMainEffectContrastSummary = useCallback(
    (factor: string, referenceLevel?: string, testLevel?: string) =>
      buildMainEffectContrastSummary({
        referenceLevel,
        testLevel,
        levels: factor ? factorLevels[factor] ?? [] : [],
      }),
    [factorLevels]
  )

  const buildModelName = useCallback(() => {
    if (useNullModel) return 'RNA-seq QC (null model ~1)'
    if (!mainFactor) return 'RNA-seq Model'

    const mainLabel = `${mainFactor} ${mainFactorTest || 'test'} vs ${mainFactorReference || 'ref'}`
    if (!interactionFactor) {
      return mainLabel
    }

    const interactionLabels = [
      `${interactionFactor} ${interactionFactorTest || 'test'} vs ${interactionFactorReference || 'ref'}`,
    ]

    if (interactionFactor2) {
      interactionLabels.push(
        `${interactionFactor2} ${interactionFactor2Test || 'test'} vs ${interactionFactor2Reference || 'ref'}`
      )
    }

    const interactionName = [mainFactor, interactionFactor, interactionFactor2]
      .filter(Boolean)
      .join(' x ')

    return `${interactionName} (${mainLabel}; ${interactionLabels.join('; ')})`
  }, [
    mainFactor,
    mainFactorTest,
    mainFactorReference,
    interactionFactor,
    interactionFactorTest,
    interactionFactorReference,
    interactionFactor2,
    interactionFactor2Test,
    interactionFactor2Reference,
    useNullModel,
  ])

  const getDefaultLevelsForFactor = useCallback(
    (factor: string) => {
      const levels = factorLevels[factor] ?? []
      const reference = levels[0] ?? ''
      const test = levels.find((level) => level !== reference) ?? levels[1] ?? ''
      return { reference, test }
    },
    [factorLevels]
  )

  const buildDesignFormulaForFactor = useCallback(
    (factor: string, includeInteraction: boolean) => {
      const terms: string[] = []

      if (includeCovariates) {
        for (const cov of covariates) {
          terms.push(cov.column)
        }
      }

      if (includeInteraction && interactionFactor1 && interactionFactor) {
        if (interactionFactor2) {
          terms.push(`${interactionFactor1} * ${interactionFactor} * ${interactionFactor2}`)
        } else {
          terms.push(`${interactionFactor1} * ${interactionFactor}`)
        }
      } else if (factor) {
        terms.push(factor)
      }

      return terms.length > 0 ? `~${terms.join(' + ')}` : '~1'
    },
    [covariates, includeCovariates, interactionFactor1, interactionFactor, interactionFactor2]
  )

  // Build formula for display (for a specific main effect run)
  const getDisplayFormulaForMainEffect = useCallback(
    (factor: string) => {
      if (useNullModel) return '~1'
      const terms: string[] = []
      if (includeCovariates) {
        for (const cov of covariates) {
          terms.push(cov.column)
        }
      }
      if (factor) {
        terms.push(factor)
      }
      return terms.length > 0 ? `~${terms.join(' + ')}` : '~1'
    },
    [covariates, includeCovariates, useNullModel]
  )

  // Build formula for an interaction run
  const getDisplayFormulaForInteraction = useCallback(
    (factors: string[]) => {
      if (factors.length < 2) return '~1'
      const terms: string[] = []
      if (includeCovariates) {
        for (const cov of covariates) {
          terms.push(cov.column)
        }
      }
      terms.push(factors.filter(Boolean).join(' * '))
      return terms.length > 0 ? `~${terms.join(' + ')}` : '~1'
    },
    [covariates, includeCovariates]
  )

  // Handle save
  const handleSave = async () => {
    if (!canSave) return

    const uniqueAdditionalFactors = Array.from(
      new Set(
        additionalMainEffects
          .map((effect) => effect.factor)
          .filter((factor) => factor && factor !== mainFactor)
      )
    )

    const makeModelId = () => `model_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const makeGroupId = () => `group_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const groupId = existingModel?.groupId ?? existingModel?.id ?? makeGroupId()
    const commonFields = {
      groupId,
      covariates,
      includeCovariates,
      applyShrinkage,
      shrinkageMethod,
      organism,
      geneIdType,
      geneLabelSource,
      alpha,
      minCount,
      minSamples,
      pcaTopGenes: Math.max(1, Math.floor(pcaTopGenes)),
      pcaGeneSelectionMode: useNullModel ? 'variable_only' : pcaGeneSelectionMode,
      usePadjForSignificance,
    }

    const modelsToRun: DESeqModel[] = []
    const baselineByKey = new Map<string, DESeqModel>()
    const desiredFactors = useNullModel
      ? [mainFactor]
      : [mainFactor, ...uniqueAdditionalFactors].filter(Boolean)
    const factorsToRun = Array.from(new Set(desiredFactors))
    const shouldRunInteraction = Boolean(
      !useNullModel && canConfigureInteraction && interactionFactor1 && interactionFactor
    )
    const existingGroupModels = project?.models.filter((model) => model.groupId === groupId) ?? []
    const modelKey = (model: DESeqModel) => {
      const isInteractionModel = modelHasInteraction(model) && Boolean(model.interactionFactor)
      const baseKey =
        isInteractionModel
          ? getInteractionKey([
              model.mainFactor,
              model.interactionFactor,
              model.interactionFactor2,
            ])
          : `main:${model.mainFactor}`
      const subsetKey = serializeSubsetFilters(model.subsetFilters ?? null)
      return subsetKey ? `${baseKey}|subset:${subsetKey}` : baseKey
    }
    const existingByKey = new Map(existingGroupModels.map((model) => [modelKey(model), model]))
    if (existingModel && !existingModel.groupId) {
      existingByKey.set(modelKey(existingModel), existingModel)
    }

    const additionalByFactor = new Map(
      additionalMainEffects.map((effect) => [effect.factor, effect])
    )

    const getLevelsForFactor = (factor: string) => {
      if (factor === mainFactor) {
        return { reference: mainFactorReference, test: mainFactorTest }
      }
      const additional = additionalByFactor.get(factor)
      return additional
        ? { reference: additional.reference, test: additional.test }
        : getDefaultLevelsForFactor(factor)
    }

    for (const factor of factorsToRun) {
      const isMain = factor === mainFactor
      const includeInteraction = false
      const additional = additionalByFactor.get(factor)
      const { reference, test } = isMain
        ? { reference: mainFactorReference, test: mainFactorTest }
        : {
            reference: additional?.reference ?? '',
            test: additional?.test ?? '',
          }
      const resolvedLevels =
        !useNullModel && !isMain && (!reference || !test || reference === test)
          ? getDefaultLevelsForFactor(factor)
          : { reference, test }
      const labelReference = resolvedLevels.reference || reference
      const labelTest = resolvedLevels.test || test
      const modelLabel = `${factor} ${labelTest || 'test'} vs ${labelReference || 'ref'}`
      const existing = existingByKey.get(`main:${factor}`)
      const modelId = existing?.id ?? makeModelId()
      const model: DESeqModel = {
        id: modelId,
        name: useNullModel ? buildModelName() : modelLabel,
        designFormula: useNullModel
          ? '~1'
          : buildDesignFormulaForFactor(factor, includeInteraction),
        mainFactor: factor,
        mainFactorReference: resolvedLevels.reference,
        mainFactorTest: resolvedLevels.test,
        additionalFactors: [],
        interactionFactor: undefined,
        interactionFactorReference: undefined,
        interactionFactorTest: undefined,
        interactionFactor2: undefined,
        interactionFactor2Reference: undefined,
        interactionFactor2Test: undefined,
        contrastType: 'main',
        useNullModel: Boolean(useNullModel && isMain),
        pcaGroupBy: useNullModel && isMain ? pcaGroupBy || undefined : undefined,
        ...commonFields,
      }

      if (existing) {
        updateModel(projectId, modelId, model)
      } else {
        addModel(projectId, model)
      }
      modelsToRun.push(model)
      baselineByKey.set(modelKey(model), model)
    }

    const primaryInteractionFactors =
      interactionFactor1 && interactionFactor
        ? [interactionFactor1, interactionFactor, interactionFactor2].filter(Boolean) as string[]
        : []
    const primaryInteractionKey =
      shouldRunInteraction && primaryInteractionFactors.length >= 2
        ? getInteractionKey(primaryInteractionFactors)
        : ''

    if (shouldRunInteraction && primaryInteractionFactors.length >= 2) {
      const interactionKey = primaryInteractionKey
      const existing = existingByKey.get(interactionKey)
      const modelId = existing?.id ?? makeModelId()

      const f1Levels = getLevelsForFactor(primaryInteractionFactors[0]!)
      const f2Levels = getLevelsForFactor(primaryInteractionFactors[1]!)
      const f3Levels = primaryInteractionFactors[2]
        ? getLevelsForFactor(primaryInteractionFactors[2]!)
        : null

      const terms: string[] = []
      if (includeCovariates) {
        for (const cov of covariates) {
          terms.push(cov.column)
        }
      }
      terms.push(primaryInteractionFactors.join(' * '))
      const formula = `~${terms.join(' + ')}`

      const interactionLabel = primaryInteractionFactors.join(' x ')
      const contrastLabels = primaryInteractionFactors
        .map((factor) => {
          const lvls = getLevelsForFactor(factor)
          return `${factor}: ${lvls.test} vs ${lvls.reference}`
        })
        .join('; ')
      const modelName = `${interactionLabel} (${contrastLabels})`

      const interactionModel: DESeqModel = {
        id: modelId,
        name: modelName,
        designFormula: formula,
        mainFactor: primaryInteractionFactors[0]!,
        mainFactorReference: f1Levels.reference,
        mainFactorTest: f1Levels.test,
        additionalFactors: [],
        interactionFactor: primaryInteractionFactors[1],
        interactionFactorReference: f2Levels.reference,
        interactionFactorTest: f2Levels.test,
        interactionFactor2: primaryInteractionFactors[2],
        interactionFactor2Reference: f3Levels?.reference,
        interactionFactor2Test: f3Levels?.test,
        contrastType: 'interaction',
        useNullModel: false,
        pcaGroupBy: undefined,
        ...commonFields,
      }

      if (existing) {
        updateModel(projectId, modelId, interactionModel)
      } else {
        addModel(projectId, interactionModel)
      }
      modelsToRun.push(interactionModel)
      baselineByKey.set(modelKey(interactionModel), interactionModel)
    }

    // Add additional interactions as separate runs
    if (!useNullModel) {
      for (const interaction of additionalInteractions) {
        const factors = [interaction.factor1, interaction.factor2, interaction.factor3].filter(Boolean) as string[]
        if (factors.length < 2) continue

        const interactionKey = getInteractionKey(factors)
        if (interactionKey === primaryInteractionKey) continue
        const existing = existingByKey.get(interactionKey)
        const modelId = existing?.id ?? makeModelId()

        const f1Levels = getLevelsForFactor(interaction.factor1)
        const f2Levels = getLevelsForFactor(interaction.factor2)
        const f3Levels = interaction.factor3 ? getLevelsForFactor(interaction.factor3) : null

        // Build formula with interaction term
        const terms: string[] = []
        if (includeCovariates) {
          for (const cov of covariates) {
            terms.push(cov.column)
          }
        }
        terms.push(factors.join(' * '))
        const formula = `~${terms.join(' + ')}`

        // Build name
        const interactionLabel = factors.join(' x ')
        const contrastLabels = factors
          .map((f) => {
            const lvls = getLevelsForFactor(f)
            return `${f}: ${lvls.test} vs ${lvls.reference}`
          })
          .join('; ')
        const modelName = `${interactionLabel} (${contrastLabels})`

        const interactionModel: DESeqModel = {
          id: modelId,
          name: modelName,
          designFormula: formula,
          mainFactor: interaction.factor1,
          mainFactorReference: f1Levels.reference,
          mainFactorTest: f1Levels.test,
          additionalFactors: [],
          interactionFactor: interaction.factor2,
          interactionFactorReference: f2Levels.reference,
          interactionFactorTest: f2Levels.test,
          interactionFactor2: interaction.factor3,
          interactionFactor2Reference: f3Levels?.reference,
          interactionFactor2Test: f3Levels?.test,
          contrastType: 'interaction',
          useNullModel: false,
          pcaGroupBy: undefined,
          ...commonFields,
        }

        if (existing) {
          updateModel(projectId, modelId, interactionModel)
        } else {
          addModel(projectId, interactionModel)
        }
        modelsToRun.push(interactionModel)
        baselineByKey.set(modelKey(interactionModel), interactionModel)
      }
    }

    if (!useNullModel && stratifiedRuns.length > 0) {
      for (const run of stratifiedRuns) {
        const subsetFilters = buildSubsetRecord(run.filters)
        const subsetKey = serializeSubsetFilters(subsetFilters)
        if (!subsetKey) continue

        const eligibility = getStratifiedRunEligibility(run)
        if (eligibility.sampleCount > 0 && eligibility.sampleCount < 4) continue
        const subsetSummary = getSubsetSummary(run.filters)
        const subsetLevelsByFactor = subsetSummary?.levelsByFactor ?? {}

        const selectedKeys = run.selectedModelKeys.filter((key) =>
          eligibility.eligibleModelKeys.has(key)
        )
        for (const key of selectedKeys) {
          const stratifiedKey = `${key}|subset:${subsetKey}`
          const existing = existingByKey.get(stratifiedKey)
          const modelId = existing?.id ?? makeModelId()
          const subsetLabel = formatSubsetLabel(run.filters)

          const resolveSubsetLevels = (
            factor: string,
            preferred?: { reference?: string; test?: string }
          ) => {
            const subsetLevels = subsetLevelsByFactor[factor] ?? []
            const reference = preferred?.reference ?? ''
            const test = preferred?.test ?? ''
            if (
              reference &&
              test &&
              reference !== test &&
              subsetLevels.includes(reference) &&
              subsetLevels.includes(test)
            ) {
              return { reference, test }
            }
            if (subsetLevels.length >= 2) {
              const fallbackRef = subsetLevels[0] ?? ''
              const fallbackTest =
                subsetLevels.find((level) => level !== fallbackRef) ?? subsetLevels[1] ?? ''
              return { reference: fallbackRef, test: fallbackTest }
            }
            return { reference, test }
          }

          let stratifiedModel: DESeqModel | null = null
          const baseModel = baselineByKey.get(key)
          if (baseModel) {
            const f1 = resolveSubsetLevels(baseModel.mainFactor, {
              reference: baseModel.mainFactorReference,
              test: baseModel.mainFactorTest,
            })
            const f2 =
              baseModel.interactionFactor
                ? resolveSubsetLevels(baseModel.interactionFactor, {
                    reference: baseModel.interactionFactorReference,
                    test: baseModel.interactionFactorTest,
                  })
                : null
            const f3 =
              baseModel.interactionFactor2
                ? resolveSubsetLevels(baseModel.interactionFactor2, {
                    reference: baseModel.interactionFactor2Reference,
                    test: baseModel.interactionFactor2Test,
                  })
                : null
            const factors = [
              baseModel.mainFactor,
              baseModel.interactionFactor,
              baseModel.interactionFactor2,
            ].filter(Boolean) as string[]
            const nameLabel =
              modelHasInteraction(baseModel) && Boolean(baseModel.interactionFactor)
                ? `${factors.join(' x ')} (${factors
                    .map((factor) => {
                      const levels = resolveSubsetLevels(factor, {
                        reference:
                          factor === baseModel.mainFactor
                            ? baseModel.mainFactorReference
                            : factor === baseModel.interactionFactor
                              ? baseModel.interactionFactorReference
                              : baseModel.interactionFactor2Reference,
                        test:
                          factor === baseModel.mainFactor
                            ? baseModel.mainFactorTest
                            : factor === baseModel.interactionFactor
                              ? baseModel.interactionFactorTest
                              : baseModel.interactionFactor2Test,
                      })
                      return `${factor}: ${levels.test || 'test'} vs ${levels.reference || 'ref'}`
                    })
                    .join('; ')})`
                : `${baseModel.mainFactor} ${f1.test || 'test'} vs ${f1.reference || 'ref'}`
            stratifiedModel = {
              ...baseModel,
              id: modelId,
              name: `${nameLabel} (subset: ${subsetLabel})`,
              mainFactorReference: f1.reference,
              mainFactorTest: f1.test,
              interactionFactorReference: f2?.reference,
              interactionFactorTest: f2?.test,
              interactionFactor2Reference: f3?.reference,
              interactionFactor2Test: f3?.test,
              subsetFilters,
              useNullModel: false,
              pcaGroupBy: undefined,
            }
          } else if (key.startsWith('main:')) {
            const factor = key.replace('main:', '')
            const preferredLevels = getLevelsForFactor(factor)
            const levels = resolveSubsetLevels(factor, preferredLevels)
            const modelLabel = `${factor} ${levels.test || 'test'} vs ${levels.reference || 'ref'}`
            stratifiedModel = {
              id: modelId,
              name: `${modelLabel} (subset: ${subsetLabel})`,
              designFormula: getDisplayFormulaForMainEffect(factor),
              mainFactor: factor,
              mainFactorReference: levels.reference,
              mainFactorTest: levels.test,
              additionalFactors: [],
              interactionFactor: undefined,
              interactionFactorReference: undefined,
              interactionFactorTest: undefined,
              interactionFactor2: undefined,
              interactionFactor2Reference: undefined,
              interactionFactor2Test: undefined,
              contrastType: 'main',
              useNullModel: false,
              pcaGroupBy: undefined,
              subsetFilters,
              ...commonFields,
            }
          }

          if (!stratifiedModel) continue

          if (existing) {
            updateModel(projectId, modelId, stratifiedModel)
          } else {
            addModel(projectId, stratifiedModel)
          }
          modelsToRun.push(stratifiedModel)
        }
      }
    }

    if (existingGroupModels.length > 0) {
      const desiredKeys = new Set<string>([
        ...factorsToRun.map((factor) => `main:${factor ?? ''}`),
      ])
      if (shouldRunInteraction && primaryInteractionKey) {
        desiredKeys.add(primaryInteractionKey)
      }
      // Add additional interaction keys
      if (!useNullModel) {
        for (const interaction of additionalInteractions) {
          const factors = [interaction.factor1, interaction.factor2, interaction.factor3].filter(Boolean) as string[]
          if (factors.length >= 2) {
            desiredKeys.add(getInteractionKey(factors))
          }
        }
      }
      if (!useNullModel) {
        for (const run of stratifiedRuns) {
          const subsetFilters = buildSubsetRecord(run.filters)
          const subsetKey = serializeSubsetFilters(subsetFilters)
          if (!subsetKey) continue
          const eligibility = getStratifiedRunEligibility(run)
          const selectedKeys = run.selectedModelKeys.filter((key) =>
            eligibility.eligibleModelKeys.has(key)
          )
          for (const key of selectedKeys) {
            desiredKeys.add(`${key}|subset:${subsetKey}`)
          }
        }
      }
      for (const model of existingGroupModels) {
        if (!desiredKeys.has(modelKey(model))) {
          deleteModel(projectId, model.id)
        }
      }
    }

    onOpenChange(false)

    let completedRuns = 0
    try {
      if (onSaveBatch) {
        await onSaveBatch(modelsToRun)
        completedRuns = modelsToRun.length
      } else {
        for (const model of modelsToRun) {
          await onSave?.(model)
          completedRuns += 1
        }
      }
    } catch (error) {
      const completedFromError = Number((error as { completedRuns?: unknown })?.completedRuns)
      if (Number.isFinite(completedFromError) && completedFromError >= 0) {
        completedRuns = Math.max(completedRuns, Math.floor(completedFromError))
      }
      const messageText = error instanceof Error ? error.message : String(error)
      await message(
        `Stopped after ${completedRuns} of ${modelsToRun.length} run(s).\n${messageText}`,
        {
          title: 'RNA-seq Analysis',
          kind: 'error',
        }
      )
      throw error instanceof Error ? error : new Error(messageText)
    }
  }

  const categoricalColumns = factorColumns.filter((f) => f.type === 'factor')
  const covariateColumns = factorColumns

  const mainFactorOptions = useMemo(
    () => withCurrentOption(categoricalColumns, mainFactor),
    [categoricalColumns, mainFactor, withCurrentOption]
  )

  const mainEffectFactors = useMemo(
    () =>
      [mainFactor, ...additionalMainEffects.map((effect) => effect.factor)].filter(
        (factor): factor is string => Boolean(factor)
      ),
    [mainFactor, additionalMainEffects]
  )

  const candidateModels = useMemo<CandidateModel[]>(() => {
    if (useNullModel) return []
    const models: CandidateModel[] = []

    const mainEffectCandidates = Array.from(new Set(mainEffectFactors))

    for (const factor of mainEffectCandidates) {
      const configured = mainEffectFactors.includes(factor)
      const selectedLevels =
        factor === mainFactor
          ? { reference: mainFactorReference, test: mainFactorTest }
          : additionalMainEffects.find((effect) => effect.factor === factor) ??
            getDefaultLevelsForFactor(factor)
      const contrastSummary = getMainEffectContrastSummary(
        factor,
        selectedLevels.reference,
        selectedLevels.test
      )
      models.push({
        key: `main:${factor}`,
        type: 'main',
        label: `${factor} main effect`,
        factors: [factor],
        formula: getDisplayFormulaForMainEffect(factor),
        configured,
        note:
          contrastSummary.count > 0
            ? `Available contrasts: ${contrastSummary.summary}`
            : 'Available contrasts: none',
      })
    }

    if (interactionFactor1 && interactionFactor) {
      const factors = [interactionFactor1, interactionFactor, interactionFactor2].filter(Boolean) as string[]
      if (factors.length >= 2) {
        models.push({
          key: getInteractionKey(factors),
          type: 'interaction',
          label: `${factors.join(' x ')} interaction`,
          factors,
          formula: getDisplayFormulaForInteraction(factors),
          configured: true,
        })
      }
    }

    for (const interaction of additionalInteractions) {
      const factors = [interaction.factor1, interaction.factor2, interaction.factor3].filter(Boolean) as string[]
      if (factors.length < 2) continue
      models.push({
        key: getInteractionKey(factors),
        type: 'interaction',
        label: `${factors.join(' x ')} interaction`,
        factors,
        formula: getDisplayFormulaForInteraction(factors),
        configured: true,
      })
    }

    return models
  }, [
    additionalInteractions,
    getDisplayFormulaForInteraction,
    getDisplayFormulaForMainEffect,
    getInteractionKey,
    interactionFactor,
    interactionFactor1,
    interactionFactor2,
    getDefaultLevelsForFactor,
    getMainEffectContrastSummary,
    mainFactor,
    mainFactorReference,
    mainFactorTest,
    mainEffectFactors,
    additionalMainEffects,
    useNullModel,
  ])

  const configuredModelKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const factor of mainEffectFactors) {
      keys.add(`main:${factor}`)
    }
    if (interactionFactor1 && interactionFactor) {
      keys.add(getInteractionKey([interactionFactor1, interactionFactor, interactionFactor2]))
    }
    for (const interaction of additionalInteractions) {
      const factors = [interaction.factor1, interaction.factor2, interaction.factor3].filter(Boolean) as string[]
      if (factors.length >= 2) {
        keys.add(getInteractionKey(factors))
      }
    }
    return keys
  }, [
    additionalInteractions,
    getInteractionKey,
    interactionFactor,
    interactionFactor1,
    interactionFactor2,
    mainEffectFactors,
  ])

  const buildSubsetRecord = useCallback(
    (filters: Array<{ factor: string; level: string }>) =>
      filters
        .filter((filter) => filter.factor && filter.level)
        .reduce<Record<string, string>>((acc, filter) => {
          acc[filter.factor] = filter.level
          return acc
        }, {}),
    []
  )

  const getSubsetMask = useCallback(
    (filters: Array<{ factor: string; level: string }>) => {
      if (!metadataDataset || Object.keys(metadataColumnValues).length === 0) return null
      const totalRows = Object.values(metadataColumnValues)[0]?.length ?? 0
      if (totalRows === 0) return []
      const mask = new Array<boolean>(totalRows).fill(true)
      for (const filter of filters) {
        if (!filter.factor || !filter.level) continue
        const values = metadataColumnValues[filter.factor]
        if (!values) continue
        for (let i = 0; i < totalRows; i += 1) {
          if (!mask[i]) continue
          if (values[i] !== filter.level) {
            mask[i] = false
          }
        }
      }
      return mask
    },
    [metadataColumnValues, metadataDataset]
  )

  const getLevelsForFactorWithMask = useCallback(
    (factor: string, mask: boolean[]) => {
      const values = metadataColumnValues[factor] ?? []
      const seen = new Set<string>()
      const levels: string[] = []
      for (let i = 0; i < mask.length && i < values.length; i += 1) {
        if (!mask[i]) continue
        const value = values[i]
        if (!value || seen.has(value)) continue
        seen.add(value)
        levels.push(value)
      }
      return levels
    },
    [metadataColumnValues]
  )

  const candidateFactorNames = useMemo(() => {
    const names = new Set<string>()
    for (const model of candidateModels) {
      for (const factor of model.factors) {
        names.add(factor)
      }
    }
    if (includeCovariates) {
      for (const cov of covariates) {
        if (cov.column) {
          names.add(cov.column)
        }
      }
    }
    return Array.from(names)
  }, [candidateModels, covariates, includeCovariates])

  const getSubsetSummary = useCallback(
    (filters: Array<{ factor: string; level: string }>) => {
      const mask = getSubsetMask(filters)
      if (!mask) return null
      const sampleCount = mask.reduce((acc, value) => acc + (value ? 1 : 0), 0)
      const levelsByFactor: Record<string, string[]> = {}
      for (const factor of candidateFactorNames) {
        levelsByFactor[factor] = getLevelsForFactorWithMask(factor, mask)
      }
      return { sampleCount, levelsByFactor }
    },
    [candidateFactorNames, getLevelsForFactorWithMask, getSubsetMask]
  )

  const getStratifiedRunEligibility = useCallback(
    (run: StratifiedRun) => {
      const summary = getSubsetSummary(run.filters)
      if (!summary) {
        return {
          sampleCount: 0,
          eligibleModelKeys: new Set<string>(),
          ineligibleReasons: new Map<string, string>(),
          invalidCovariates: [] as string[],
        }
      }

      const { sampleCount, levelsByFactor } = summary
      const invalidCovariates: string[] = []
      if (includeCovariates) {
        for (const cov of covariates) {
          const kind = cov.kind ?? inferCovariateKind(cov.column)
          if (kind === 'categorical') {
            const levels = levelsByFactor[cov.column] ?? []
            if (levels.length < 2) {
              invalidCovariates.push(cov.column)
            }
          }
        }
      }

      const eligibleModelKeys = new Set<string>()
      const ineligibleReasons = new Map<string, string>()

      for (const model of candidateModels) {
        if (sampleCount < 4) {
          ineligibleReasons.set(model.key, 'Needs at least 4 samples after subsetting')
          continue
        }
        if (invalidCovariates.length > 0) {
          ineligibleReasons.set(
            model.key,
            `Covariate(s) ${invalidCovariates.join(', ')} have <2 levels after subsetting`
          )
          continue
        }
        const collapsed = model.factors.filter(
          (factor) => (levelsByFactor[factor]?.length ?? 0) < 2
        )
        if (collapsed.length > 0) {
          ineligibleReasons.set(
            model.key,
            `${collapsed.join(', ')} has <2 levels after subsetting`
          )
          continue
        }
        eligibleModelKeys.add(model.key)
      }

      return { sampleCount, eligibleModelKeys, ineligibleReasons, invalidCovariates }
    },
    [candidateModels, covariates, getSubsetSummary, includeCovariates, inferCovariateKind]
  )

  const stratifiedRunEligibility = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getStratifiedRunEligibility>>()
    for (const run of stratifiedRuns) {
      map.set(run.id, getStratifiedRunEligibility(run))
    }
    return map
  }, [getStratifiedRunEligibility, stratifiedRuns])

  useEffect(() => {
    if (stratifiedRuns.length === 0) return
    setStratifiedRuns((prev) => {
      let changed = false
      const next = prev.map((run) => {
        const eligibility = getStratifiedRunEligibility(run)
        const eligibleKeys = candidateModels
          .map((model) => model.key)
          .filter((key) => eligibility.eligibleModelKeys.has(key))
        const preferredKeys = eligibleKeys.filter((key) => configuredModelKeys.has(key))
        let selected = run.selectedModelKeys.filter((key) =>
          eligibility.eligibleModelKeys.has(key)
        )
        if (selected.length === 0 && preferredKeys.length > 0) {
          selected = preferredKeys
        }
        const isSame =
          selected.length === run.selectedModelKeys.length &&
          selected.every((value, index) => value === run.selectedModelKeys[index])
        if (isSame) return run
        changed = true
        return { ...run, selectedModelKeys: selected }
      })
      return changed ? next : prev
    })
  }, [candidateModels, configuredModelKeys, getStratifiedRunEligibility, stratifiedRuns])

  const buildInteractionOptions = useCallback(
    (factors: string[], current?: string) =>
      withCurrentOption(
        factors.map(
          (factor) =>
            columnByName.get(factor) ?? { id: factor, name: factor, type: 'factor' as const }
        ),
        current
      ),
    [columnByName, withCurrentOption]
  )

  const availableInteractionFactor1Options = useMemo(
    () =>
      buildInteractionOptions(
        mainEffectFactors.filter(
          (factor) => factor !== interactionFactor && factor !== interactionFactor2
        ),
        interactionFactor1
      ),
    [
      buildInteractionOptions,
      interactionFactor,
      interactionFactor1,
      interactionFactor2,
      mainEffectFactors,
    ]
  )

  const availableInteractionFactors = useMemo(
    () =>
      buildInteractionOptions(
        mainEffectFactors.filter(
          (factor) => factor !== interactionFactor1 && factor !== interactionFactor2
        ),
        interactionFactor
      ),
    [
      buildInteractionOptions,
      interactionFactor,
      interactionFactor1,
      interactionFactor2,
      mainEffectFactors,
    ]
  )

  const availableInteractionFactors2 = useMemo(
    () =>
      buildInteractionOptions(
        mainEffectFactors.filter(
          (factor) => factor !== interactionFactor1 && factor !== interactionFactor
        ),
        interactionFactor2
      ),
    [
      buildInteractionOptions,
      interactionFactor,
      interactionFactor1,
      interactionFactor2,
      mainEffectFactors,
    ]
  )

  const availableSubsetFactors = categoricalColumns

  const availableAdditionalFactors = categoricalColumns.filter(
    (f) =>
      f.name !== mainFactor &&
      !additionalMainEffects.some((effect) => effect.factor === f.name)
  )

  // Available columns for covariates
  const availableCovariates = covariateColumns.filter(
    (f) => !covariates.some((c) => c.column === f.name)
  )

  const mainFactorContrastSummary =
    mainFactor && !useNullModel
      ? getMainEffectContrastSummary(mainFactor, mainFactorReference, mainFactorTest)
      : null

  return (
    <ResizableDialog
      open={dialogOpen}
      onOpenChange={onOpenChange}
      defaultWidth={600}
      defaultHeight={800}
      minWidth={500}
      minHeight={400}
      persistKey="deseq2-config"
    >
      <ResizableDialogContent className="flex flex-col p-0">
        <ResizableDialogHeader className="px-6 pt-6 pb-4 border-b">
          <ResizableDialogTitle className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-[#8B5CF6]" />
            Configure RNA-seq Model
          </ResizableDialogTitle>
          <ResizableDialogDescription>
            Set factors, contrasts, and analysis options.
          </ResizableDialogDescription>
        </ResizableDialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 pt-4">
            <div className="space-y-6">
              <div
                className={`space-y-3 p-4 border rounded-lg ${useNullModel ? 'opacity-50 pointer-events-none' : ''}`}
                aria-disabled={useNullModel}
              >
                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-end">
                  <div className="space-y-2">
                    <Label>Organism</Label>
                    <Select
                      value={organism}
                      onValueChange={(value) => setOrganism(value as Organism)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mmusculus">Mouse (Mus musculus)</SelectItem>
                        <SelectItem value="hsapiens">Human (Homo sapiens)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Gene Label Source</Label>
                    <Select
                      value={geneLabelSource}
                      onValueChange={(value) => setGeneLabelSource(value as GeneLabelSource)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="id_lookup">Gene ID lookup (gene annotation)</SelectItem>
                        <SelectItem value="user_provided">User Gene Symbols</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-1 md:items-end">
                  <div className="space-y-2">
                    <Label>Gene ID Type</Label>
                    <Select
                      value={geneIdType}
                      onValueChange={(value) => setGeneIdType(value as GeneIdType)}
                      disabled={isUserProvidedGeneLabels}
                    >
                      <SelectTrigger disabled={isUserProvidedGeneLabels}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ensembl">Ensembl Gene ID</SelectItem>
                        <SelectItem value="entrez">Entrez Gene ID</SelectItem>
                        <SelectItem value="uniprot">UniProt ID</SelectItem>
                        <SelectItem value="uniprot_swissprot">UniProt Swiss-Prot</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  {isUserProvidedGeneLabels
                    ? 'Using first-column labels directly. Gene annotation lookup controls are disabled.'
                    : 'Used for gene symbol annotation. Gene ID type should match your count matrix.'}
                </p>
              </div>

              {/* Main Factor */}
              <div className="space-y-4 p-4 border rounded-lg">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3 className="font-medium">Main Factor</h3>
                {!useNullModel && (
                  <span className="text-xs text-muted-foreground">(Required)</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">QC null model (~1)</span>
                <Switch checked={useNullModel} onCheckedChange={setUseNullModel} />
              </div>
            </div>
            {useNullModel && (
              <p className="text-xs text-muted-foreground">
                Runs an intercept-only model for QC (no differential testing). Main factor is
                optional and used for PCA grouping only.
              </p>
            )}

            {useNullModel && (
              <div className="space-y-2 pt-2">
                <Label htmlFor="pca-group-by" className="text-sm font-medium">
                  PCA Grouping Factor
                </Label>
                <Select
                  value={pcaGroupBy || noneSentinel}
                  onValueChange={(value) => {
                    if (value === noneSentinel) {
                      setPcaGroupBy('')
                      return
                    }
                    setPcaGroupBy(value)
                  }}
                >
                  <SelectTrigger id="pca-group-by">
                    <SelectValue placeholder="Auto-detect first categorical column" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={noneSentinel}>Auto-detect</SelectItem>
                    {factorColumns
                      .filter((col) => col.type === 'factor')
                      .map((col) => (
                        <SelectItem key={col.id} value={col.name}>
                          {col.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Metadata column to color PCA samples by. If not specified, uses first categorical
                  column with ≥2 levels.
                </p>
              </div>
            )}

            <div
              className={`space-y-4 ${useNullModel ? 'opacity-50 pointer-events-none' : ''}`}
              aria-disabled={useNullModel}
            >
              <div className="space-y-3">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Factor Column</Label>
                    <Select value={mainFactor} onValueChange={setMainFactor}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select factor..." />
                      </SelectTrigger>
                      <SelectContent>
                        {mainFactorOptions.map((factor) => (
                          <SelectItem key={factor.name} value={factor.name}>
                            {factor.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Reference Level</Label>
                    <Select
                      value={mainFactorReference}
                      onValueChange={setMainFactorReference}
                      disabled={!mainFactor || useNullModel}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {mainFactorLevels.map((level) => (
                          <SelectItem key={level} value={level}>
                            {level}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Test Level</Label>
                    <Select
                      value={mainFactorTest}
                      onValueChange={setMainFactorTest}
                      disabled={!mainFactor || useNullModel}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {mainFactorLevels.map((level) => (
                          <SelectItem key={level} value={level}>
                            {level}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Formula display inline with main factor */}
                {mainFactor && !useNullModel && (
                  <div className="flex flex-wrap items-center gap-3 px-3 py-2 bg-muted/50 rounded-md">
                    <span className="text-xs text-muted-foreground">Formula:</span>
                    <code className="text-sm font-mono text-foreground">
                      {getDisplayFormulaForMainEffect(mainFactor)}
                    </code>
                    <span className="text-xs text-muted-foreground ml-auto text-right">
                      Available contrasts: {mainFactorContrastSummary?.summary ?? 'No valid contrast yet'}
                    </span>
                  </div>
                )}
              </div>

              <div className="min-h-[1rem]">
                {levelsLoading && (
                  <p className="text-xs text-muted-foreground">Loading factor levels...</p>
                )}
                {levelsError && (
                  <p className="text-xs text-destructive">{levelsError}</p>
                )}
              </div>

              <div className="space-y-3">
                <Label>Additional Main Effect Runs</Label>
                <div className="space-y-3">
                  {additionalMainEffects.map((effect, index) => {
                    const levels = effect.factor ? factorLevels[effect.factor] ?? [] : []
                    const options = withCurrentOption(
                      categoricalColumns.filter(
                        (f) =>
                          f.name !== mainFactor &&
                          f.name !== interactionFactor &&
                          f.name !== interactionFactor2 &&
                          (f.name === effect.factor ||
                            !additionalMainEffects.some(
                              (entry, entryIndex) =>
                                entryIndex !== index && entry.factor === f.name
                            ))
                      ),
                      effect.factor
                    )
                    return (
                      <div
                        key={`${effect.factor}-${index}`}
                        className="space-y-2 p-3 border rounded-md bg-muted/30"
                      >
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto] lg:items-center">
                          <Select
                            value={effect.factor}
                            onValueChange={(value) => {
                              const next = [...additionalMainEffects]
                              const nextLevels = factorLevels[value] ?? []
                              const reference = nextLevels[0] ?? ''
                              const test =
                                nextLevels.find((level) => level !== reference) ??
                                nextLevels[1] ??
                                ''
                              next[index] = { factor: value, reference, test }
                              setAdditionalMainEffects(next)
                            }}
                            disabled={useNullModel}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select factor..." />
                            </SelectTrigger>
                            <SelectContent>
                              {options.map((option) => (
                                <SelectItem key={option.name} value={option.name}>
                                  {option.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          <Select
                            value={effect.reference}
                            onValueChange={(value) => {
                              const next = [...additionalMainEffects]
                              next[index] = { ...effect, reference: value }
                              setAdditionalMainEffects(next)
                            }}
                            disabled={!effect.factor || useNullModel}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Reference..." />
                            </SelectTrigger>
                            <SelectContent>
                              {levels.map((level) => (
                                <SelectItem key={level} value={level}>
                                  {level}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          <Select
                            value={effect.test}
                            onValueChange={(value) => {
                              const next = [...additionalMainEffects]
                              next[index] = { ...effect, test: value }
                              setAdditionalMainEffects(next)
                            }}
                            disabled={!effect.factor || useNullModel}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Test..." />
                            </SelectTrigger>
                            <SelectContent>
                              {levels.map((level) => (
                                <SelectItem key={level} value={level}>
                                  {level}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>

                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleRemoveMainEffect(index)}
                            disabled={useNullModel}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>

                        {/* Formula display for this additional main effect */}
                        {effect.factor && !useNullModel && (
                          <div className="flex flex-wrap items-center gap-3 px-2 py-1.5 bg-background/50 rounded text-xs">
                            <span className="text-muted-foreground">Formula:</span>
                            <code className="font-mono text-foreground">
                              {getDisplayFormulaForMainEffect(effect.factor)}
                            </code>
                            <span className="text-muted-foreground ml-auto text-right">
                              Available contrasts: {getMainEffectContrastSummary(effect.factor, effect.reference, effect.test).summary}
                            </span>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
                {availableAdditionalFactors.length > 0 && additionalMainEffects.length < 2 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddMainEffect}
                    className="w-full"
                    disabled={useNullModel}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Main Effect Run
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  Each selected factor creates its own run. Up to 3 total main-effect runs.
                  Interactions are available once you add a second main effect.
                </p>
              </div>
            </div>
          </div>

          <div>
          {/* Advanced Options */}
          <Accordion
            type="single"
            collapsible
            className={`w-full ${useNullModel ? 'opacity-50 pointer-events-none' : ''}`}
            aria-disabled={useNullModel}
          >
            {/* Interaction Term */}
            {!useNullModel && (
            <AccordionItem value="interaction">
              <AccordionTrigger>
                Interaction Runs {(interactionFactor && interactionFactor1) || additionalInteractions.length > 0
                  ? `(${(interactionFactor && interactionFactor1 ? 1 : 0) + additionalInteractions.length})`
                  : ''}
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pt-2">
                {!canConfigureInteraction && (
                  <p className="text-xs text-muted-foreground">
                    Add at least one additional main-effect run to enable interactions.
                    Interactions are built from the main effects.
                  </p>
                )}

                {canConfigureInteraction && (
                  <div className="space-y-3">
                    {/* Primary Interaction */}
                    <div className="space-y-2 p-3 border rounded-md bg-muted/30">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-xs font-medium text-muted-foreground">Primary Interaction</span>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Factor 1</Label>
                          <Select
                            value={interactionFactor1 ?? noneSentinel}
                            onValueChange={(v) => setInteractionFactor1(v === noneSentinel ? undefined : v)}
                            disabled={!canConfigureInteraction}
                          >
                            <SelectTrigger className="h-9">
                              <SelectValue placeholder="Select..." />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={noneSentinel}>None</SelectItem>
                              {availableInteractionFactor1Options.map((factor) => (
                                <SelectItem key={factor.name} value={factor.name}>
                                  {factor.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs">Factor 2</Label>
                          <Select
                            value={interactionFactor ?? noneSentinel}
                            onValueChange={(v) => setInteractionFactor(v === noneSentinel ? undefined : v)}
                            disabled={!canConfigureInteraction}
                          >
                            <SelectTrigger className="h-9">
                              <SelectValue placeholder="Select..." />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={noneSentinel}>None</SelectItem>
                              {availableInteractionFactors.map((factor) => (
                                <SelectItem key={factor.name} value={factor.name}>
                                  {factor.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs">Factor 3</Label>
                          <Select
                            value={interactionFactor2 ?? noneSentinel}
                            onValueChange={(v) => setInteractionFactor2(v === noneSentinel ? undefined : v)}
                            disabled={!interactionFactor || availableInteractionFactors2.length === 0}
                          >
                            <SelectTrigger className="h-9">
                              <SelectValue placeholder="None" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={noneSentinel}>None</SelectItem>
                              {availableInteractionFactors2.map((factor) => (
                                <SelectItem key={factor.name} value={factor.name}>
                                  {factor.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {/* Formula inline */}
                      {interactionFactor && interactionFactor1 && (
                        <div className="flex items-center gap-2 mt-2 px-2 py-1 bg-background/50 rounded text-xs">
                          <span className="text-muted-foreground">Formula:</span>
                          <code className="font-mono text-foreground">
                            {getDisplayFormulaForInteraction(
                              [interactionFactor1, interactionFactor, interactionFactor2].filter(Boolean) as string[]
                            )}
                          </code>
                        </div>
                      )}
                    </div>

                    {/* Additional Interactions */}
                    {additionalInteractions.map((interaction, index) => {
                      const allMainFactors = mainEffectFactors
                      const availableFor1 = allMainFactors.filter(f => f !== interaction.factor2 && f !== interaction.factor3)
                      const availableFor2 = allMainFactors.filter(f => f !== interaction.factor1 && f !== interaction.factor3)
                      const availableFor3 = allMainFactors.filter(f => f !== interaction.factor1 && f !== interaction.factor2)

                      return (
                        <div
                          key={`interaction-${index}`}
                          className="space-y-2 p-3 border rounded-md bg-muted/30"
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-medium text-muted-foreground">
                              Additional Interaction {index + 1}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleRemoveInteraction(index)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            <div className="space-y-1">
                              <Label className="text-xs">Factor 1</Label>
                              <Select
                                value={interaction.factor1}
                                onValueChange={(v) => {
                                  const next = [...additionalInteractions]
                                  next[index] = { ...interaction, factor1: v }
                                  setAdditionalInteractions(next)
                                }}
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {availableFor1.map((f) => (
                                    <SelectItem key={f} value={f}>{f}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">Factor 2</Label>
                              <Select
                                value={interaction.factor2}
                                onValueChange={(v) => {
                                  const next = [...additionalInteractions]
                                  next[index] = { ...interaction, factor2: v }
                                  setAdditionalInteractions(next)
                                }}
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {availableFor2.map((f) => (
                                    <SelectItem key={f} value={f}>{f}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">Factor 3</Label>
                              <Select
                                value={interaction.factor3 ?? noneSentinel}
                                onValueChange={(v) => {
                                  const next = [...additionalInteractions]
                                  next[index] = { ...interaction, factor3: v === noneSentinel ? undefined : v }
                                  setAdditionalInteractions(next)
                                }}
                                disabled={availableFor3.length === 0}
                              >
                                <SelectTrigger className="h-9">
                                  <SelectValue placeholder="None" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={noneSentinel}>None</SelectItem>
                                  {availableFor3.map((f) => (
                                    <SelectItem key={f} value={f}>{f}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>

                          {/* Formula display */}
                          <div className="flex items-center gap-2 px-2 py-1 bg-background/50 rounded text-xs">
                            <span className="text-muted-foreground">Formula:</span>
                            <code className="font-mono text-foreground">
                              {getDisplayFormulaForInteraction(
                                [interaction.factor1, interaction.factor2, interaction.factor3].filter(Boolean) as string[]
                              )}
                            </code>
                          </div>
                        </div>
                      )
                    })}

                    {/* Add interaction button */}
                    {(() => {
                      const allMainFactors = [mainFactor, ...additionalMainEffects.map(e => e.factor)].filter(Boolean)
                      const maxInteractions = Math.floor((allMainFactors.length * (allMainFactors.length - 1)) / 2)
                      const currentCount =
                        (interactionFactor && interactionFactor1 ? 1 : 0) + additionalInteractions.length
                      const canAddMore = currentCount < maxInteractions && additionalInteractions.length < 2
                      return canAddMore ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleAddInteraction}
                          className="w-full"
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Add Interaction Run
                        </Button>
                      ) : null
                    })()}

                    <p className="text-xs text-muted-foreground">
                      Each interaction creates a separate run. Uses reference/test levels from main effects.
                    </p>
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
            )}

            {/* Covariates */}
            {!useNullModel && (
            <AccordionItem value="covariates">
              <AccordionTrigger>Covariates ({covariates.length})</AccordionTrigger>
              <AccordionContent className="space-y-4 pt-2">
                <div className="space-y-4">
                  {covariates.map((cov, index) => {
                    const kind = cov.kind ?? inferCovariateKind(cov.column)
                    const levels = cov.column ? factorLevels[cov.column] ?? [] : []
                    return (
                      <div
                        key={`${cov.column}-${index}`}
                        className="p-3 border rounded-md bg-muted/30 space-y-3"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-muted-foreground">
                            Covariate {index + 1}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => handleRemoveCovariate(index)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Column</Label>
                            <Select
                              value={cov.column}
                              onValueChange={(value) => {
                                const inferred = inferCovariateKind(value)
                                const nextLevels = factorLevels[value] ?? []
                                const referenceLevel =
                                  inferred === 'categorical' ? nextLevels[0] ?? '' : ''
                                const next = [...covariates]
                                next[index] = {
                                  ...cov,
                                  column: value,
                                  kind: inferred,
                                  referenceLevel,
                                  centerAndScale: inferred === 'numeric' ? cov.centerAndScale : false,
                                }
                                setCovariates(next)
                              }}
                            >
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Select column..." />
                              </SelectTrigger>
                              <SelectContent>
                                {covariateColumns.map((factor) => (
                                  <SelectItem key={factor.name} value={factor.name}>
                                    {factor.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="space-y-1">
                            <Label className="text-xs">Type</Label>
                            <Select
                              value={kind}
                              onValueChange={(value) => {
                                const next = [...covariates]
                                const nextKind = value as 'numeric' | 'categorical'
                                const nextLevels = factorLevels[cov.column] ?? []
                                next[index] = {
                                  ...cov,
                                  kind: nextKind,
                                  referenceLevel:
                                    nextKind === 'categorical'
                                      ? cov.referenceLevel || nextLevels[0] || ''
                                      : '',
                                  centerAndScale:
                                    nextKind === 'numeric' ? cov.centerAndScale : false,
                                }
                                setCovariates(next)
                              }}
                            >
                              <SelectTrigger className="h-9">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="numeric">Numeric</SelectItem>
                                <SelectItem value="categorical">Categorical</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {kind === 'categorical' ? (
                          <div className="space-y-1">
                            <Label className="text-xs">Reference Level</Label>
                            <Select
                              value={cov.referenceLevel ?? ''}
                              onValueChange={(value) => {
                                const next = [...covariates]
                                next[index] = { ...cov, referenceLevel: value }
                                setCovariates(next)
                              }}
                              disabled={!cov.column}
                            >
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Reference..." />
                              </SelectTrigger>
                              <SelectContent>
                                {levels.map((level) => (
                                  <SelectItem key={level} value={level}>
                                    {level}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2 pt-1">
                            <Switch
                              checked={cov.centerAndScale}
                              onCheckedChange={(checked) => {
                                const next = [...covariates]
                                next[index] = { ...cov, centerAndScale: checked }
                                setCovariates(next)
                              }}
                            />
                            <span className="text-sm">Center & Scale</span>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {covariateColumns.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddCovariate}
                    className="w-full"
                    disabled={covariates.length >= 2 || availableCovariates.length === 0}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Covariate
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No metadata columns detected.
                  </p>
                )}

                {covariates.length > 0 && (
                  <div className="flex items-center gap-2 pt-2">
                    <Switch
                      checked={includeCovariates}
                      onCheckedChange={setIncludeCovariates}
                    />
                    <span className="text-sm">
                      Include covariates in model formulas
                    </span>
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  Add numeric or categorical covariates to adjust for confounding. Max 2 covariates.
                </p>
              </AccordionContent>
            </AccordionItem>
            )}

            {/* Stratified Runs */}
            <AccordionItem value="subset">
              <AccordionTrigger>
                Stratified Runs {stratifiedRuns.length ? `(${stratifiedRuns.length})` : ''}
              </AccordionTrigger>
              <AccordionContent className="space-y-4 pt-2">
                {stratifiedRuns.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Add stratified runs to repeat selected models on subsetted samples.
                  </p>
                )}

                {stratifiedRuns.map((run, runIndex) => {
                  const runEligibility = stratifiedRunEligibility.get(run.id)
                  const usedFactors = new Set(run.filters.map((filter) => filter.factor))
                  return (
                    <div
                      key={run.id}
                      className="space-y-3 p-3 border rounded-md bg-muted/30"
                    >
                      <div className="flex items-center justify-between">
                        <div className="space-y-1">
                          <span className="text-xs font-medium text-muted-foreground">
                            Stratified Run {runIndex + 1}
                          </span>
                          <div className="text-xs text-muted-foreground">
                            {formatSubsetLabel(run.filters)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => handleRemoveStratifiedRun(run.id)}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>

                      {runEligibility && (
                        <div className="text-xs text-muted-foreground">
                          Samples after filter: {runEligibility.sampleCount}
                        </div>
                      )}
                      {runEligibility &&
                        runEligibility.sampleCount > 0 &&
                        runEligibility.sampleCount < 4 && (
                          <p className="text-xs text-destructive">
                            Needs at least 4 samples after filtering.
                          </p>
                        )}
                      {runEligibility && runEligibility.invalidCovariates.length > 0 && (
                        <p className="text-xs text-destructive">
                          Covariate(s) {runEligibility.invalidCovariates.join(', ')} have fewer than 2 levels.
                        </p>
                      )}

                      <div className="space-y-2">
                        {run.filters.map((filter, filterIndex) => {
                          const levels = filter.factor ? factorLevels[filter.factor] ?? [] : []
                          const options = withCurrentOption(
                            availableSubsetFactors.filter(
                              (factor) =>
                                factor.name === filter.factor || !usedFactors.has(factor.name)
                            ),
                            filter.factor
                          )
                          return (
                            <div
                              key={`${filter.factor}-${filterIndex}`}
                              className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center"
                            >
                              <Select
                                value={filter.factor}
                                onValueChange={(value) => {
                                  setStratifiedRuns((prev) =>
                                    prev.map((entry) => {
                                      if (entry.id !== run.id) return entry
                                      const nextFilters = [...entry.filters]
                                      const nextLevels = factorLevels[value] ?? []
                                      nextFilters[filterIndex] = {
                                        factor: value,
                                        level: nextLevels[0] ?? '',
                                      }
                                      return { ...entry, filters: nextFilters }
                                    })
                                  )
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Select factor..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {options.map((factor) => (
                                    <SelectItem key={factor.name} value={factor.name}>
                                      {factor.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>

                              <Select
                                value={filter.level}
                                onValueChange={(value) => {
                                  setStratifiedRuns((prev) =>
                                    prev.map((entry) => {
                                      if (entry.id !== run.id) return entry
                                      const nextFilters = [...entry.filters]
                                      nextFilters[filterIndex] = { ...filter, level: value }
                                      return { ...entry, filters: nextFilters }
                                    })
                                  )
                                }}
                                disabled={!filter.factor}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Select level..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {levels.map((level) => (
                                    <SelectItem key={level} value={level}>
                                      {level}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>

                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => handleRemoveRunFilter(run.id, filterIndex)}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          )
                        })}

                        {availableSubsetFactors.some((factor) => !usedFactors.has(factor.name)) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleAddRunFilter(run.id)}
                            className="w-full"
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Add Filter
                          </Button>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label className="text-xs font-medium">Models to run</Label>
                        {candidateModels.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            Configure main effects or interactions to enable models.
                          </p>
                        )}
                        <div className="space-y-2">
                          {candidateModels.map((model) => {
                            const eligible = runEligibility?.eligibleModelKeys.has(model.key) ?? false
                            const checked = run.selectedModelKeys.includes(model.key)
                            const reason = runEligibility?.ineligibleReasons.get(model.key)
                            return (
                              <label
                                key={`${run.id}-${model.key}`}
                                className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                                  eligible ? 'bg-background' : 'bg-muted/40 text-muted-foreground'
                                }`}
                              >
                                <Checkbox
                                  checked={checked && eligible}
                                  disabled={!eligible}
                                  onCheckedChange={(value) => {
                                    setStratifiedRuns((prev) =>
                                      prev.map((entry) => {
                                        if (entry.id !== run.id) return entry
                                        const nextSelected = new Set(entry.selectedModelKeys)
                                        if (value) {
                                          nextSelected.add(model.key)
                                        } else {
                                          nextSelected.delete(model.key)
                                        }
                                        return {
                                          ...entry,
                                          selectedModelKeys: Array.from(nextSelected),
                                        }
                                      })
                                    )
                                  }}
                                />
                                <div className="space-y-1">
                                  <div className="text-sm font-medium">{model.label}</div>
                                  <div className="text-xs text-muted-foreground">
                                    {model.formula}
                                  </div>
                                  {model.note && (
                                    <div className="text-xs text-muted-foreground">{model.note}</div>
                                  )}
                                  {!eligible && reason && (
                                    <div className="text-xs text-destructive">{reason}</div>
                                  )}
                                </div>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  )
                })}

                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddStratifiedRun}
                  className="w-full"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Stratified Run
                </Button>

                <p className="text-xs text-muted-foreground">
                  Stratified runs execute after baseline models. Factors with fewer than two levels
                  after filtering are automatically excluded.
                </p>
              </AccordionContent>
            </AccordionItem>

          </Accordion>

          {/* Analysis Options - Always Visible */}
          <div className="space-y-4 p-4 border rounded-lg">
            <h3 className="font-medium">Analysis Options</h3>

            <div
              className={`space-y-4 ${useNullModel ? 'opacity-50 pointer-events-none' : ''}`}
              aria-disabled={useNullModel}
            >
              {/* Shrinkage */}
              <div className="flex items-center justify-between">
                <div>
                  <Label>Apply LFC Shrinkage</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Shrinks noisy LFC estimates
                  </p>
                </div>
                <Switch checked={applyShrinkage} onCheckedChange={setApplyShrinkage} />
              </div>

              {/* Significance Settings */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Significance Threshold (alpha)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0.001"
                    max="0.1"
                    value={alpha}
                    onChange={(e) => setAlpha(parseFloat(e.target.value) || 0.05)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>Use for Significance</Label>
                  <Select
                    value={usePadjForSignificance ? 'padj' : 'pvalue'}
                    onValueChange={(v) => setUsePadjForSignificance(v === 'padj')}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="padj">Adjusted p-value (FDR)</SelectItem>
                      <SelectItem value="pvalue">Raw p-value</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Count Filters */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Minimum Count</Label>
                  <Input
                    type="number"
                    min="0"
                    value={minCount}
                    onChange={(e) => setMinCount(parseInt(e.target.value) || 10)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Filter genes with counts below this
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label>Minimum Samples</Label>
                  <Input
                    type="number"
                    min="1"
                    value={minSamples}
                    onChange={(e) => setMinSamples(parseInt(e.target.value) || 3)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Required samples meeting min count
                  </p>
                </div>
              </div>
            </div>

            {/* PCA Settings */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>PCA Gene Selection</Label>
                <Select
                  value={useNullModel ? 'variable_only' : pcaGeneSelectionMode}
                  onValueChange={(value) =>
                    setPcaGeneSelectionMode(value as PCAGeneSelectionMode)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      value="significant_then_variable"
                      disabled={useNullModel}
                    >
                      Significant first, then top variable genes (default)
                    </SelectItem>
                    <SelectItem value="significant_only" disabled={useNullModel}>
                      Significant genes only
                    </SelectItem>
                    <SelectItem value="variable_only">
                      Top variable genes only
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {useNullModel
                    ? 'Null model uses top variable genes only.'
                    : 'How PCA genes are selected for non-null models.'}
                </p>
              </div>

              <div className="space-y-1.5">
              <Label>Max PCA Genes</Label>
              <Input
                type="number"
                min="10"
                value={pcaTopGenes}
                onChange={(e) => setPcaTopGenes(parseInt(e.target.value) || 500)}
                disabled={!useNullModel && pcaGeneSelectionMode === 'significant_only'}
              />
              <p className="text-xs text-muted-foreground">
                {useNullModel
                  ? 'Maximum top variable genes used for PCA in null model (default 500).'
                  : pcaGeneSelectionMode === 'significant_only'
                    ? 'Uses all significant genes from the model. If too few are detected, the analysis automatically transitions to hybrid selection for PCA stability.'
                  : pcaGeneSelectionMode === 'significant_then_variable'
                      ? 'Maximum genes after taking significant genes first, then supplementing with high-variance genes (default 500).'
                      : 'Maximum top variable genes used for PCA (default 500).'}
              </p>
              </div>
            </div>
          </div>
          </div>

            {/* Validation Errors */}
            {validationErrors.length > 0 && (
              <div className="p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg">
                <div className="flex items-start gap-2 text-red-600">
                  <AlertCircle className="h-4 w-4 mt-0.5" />
                  <div className="space-y-1 text-sm">
                    {validationErrors.map((error, i) => (
                      <p key={i}>{error}</p>
                    ))}
                  </div>
                </div>
              </div>
            )}
            </div>
          </div>

        <ResizableDialogFooter className="px-6 py-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            Perform Analysis
          </Button>
        </ResizableDialogFooter>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}

export default DESeq2ConfigDialog
