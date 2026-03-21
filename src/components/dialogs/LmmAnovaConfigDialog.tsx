import { useEffect, useMemo, useState } from 'react'
import {
  ResizableDialog,
  ResizableDialogContent,
  ResizableDialogDescription,
  ResizableDialogFooter,
  ResizableDialogHeader,
  ResizableDialogTitle,
} from '@/components/ui/resizable-dialog'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { Button } from '@/components/ui/button'
import { LineChart } from 'lucide-react'
import type { ColumnClassification } from '@/lib/modules/core/types'
import { ColumnDataType } from '@/lib/modules/core/types'
import {
  buildCappedCartesianPreview,
  MAX_PREVIEW_ROWS,
  parseContinuousTimeValues,
} from './lmmDialogUtils'

export type LmmPredictorType = 'categorical' | 'continuous'
export type LmmRandomEffectsMode = 'random_intercept' | 'random_slope'
export type LmmDfMethod = 'satterthwaite' | 'kenward_roger' | 'asymptotic' | 'residual'
export type LmmPostHocAdjustmentMethod =
  | 'tukey'
  | 'bonferroni'
  | 'holm'
  | 'holm-sidak'
  | 'sidak'
  | 'dunnett'
  | 'fdr_bh'

const POST_HOC_METHODS: Array<{ value: LmmPostHocAdjustmentMethod; label: string }> = [
  { value: 'tukey', label: 'Tukey' },
  { value: 'bonferroni', label: 'Bonferroni' },
  { value: 'holm', label: 'Holm' },
  { value: 'holm-sidak', label: 'Holm-Sidak' },
  { value: 'sidak', label: 'Sidak' },
  { value: 'dunnett', label: 'Dunnett' },
  { value: 'fdr_bh', label: 'FDR (Benjamini-Hochberg)' },
]

export interface LmmContinuousEffectsConfig {
  mode: 'at_values'
  groupFactorId: string
  timeFactorId: string
  timeValues: number[]
}

export interface LmmAnovaConfig {
  dependentColumnId: string
  subjectColumnId: string
  predictorColumnIds: string[]
  predictorTypes: Record<string, LmmPredictorType>
  stratified: boolean
  stratifyBy: string[]
  reml: boolean
  interactionDepth: number
  dfMethod: LmmDfMethod
  randomEffectsMode: LmmRandomEffectsMode
  randomSlopeTarget?: string
  adjustmentMethod: LmmPostHocAdjustmentMethod
  controlLevels: Record<string, string>
  posthocQ?: number
  simpleEffects?: Array<{ factor: string; within: string }>
  continuousEffectsConfig?: LmmContinuousEffectsConfig
}

export interface LmmAnovaConfigDialogResult {
  cancelled: boolean
  config: LmmAnovaConfig
}

interface LmmAnovaConfigDialogProps {
  open: boolean
  columns: ColumnClassification[]
  onConfirm: (result: LmmAnovaConfigDialogResult) => void
  onCancel: () => void
}

// Columns whose names suggest they define subgroups to stratify over
const GROUPING_PATTERN =
  /\b(strain|sex|gender|race|ethnicity|genotype|group|batch|cohort|site|center|location|tissue|background|lineage|region|ancestry|arm)\b/i
// Columns whose names suggest they are the comparison / treatment axis — excluded from auto-selection
const COMPARISON_PATTERN =
  /\b(treatment|condition|drug|dose|intervention|therapy|control|stimulus|vehicle|placebo|trt|diet|group)\b/i
const TIME_LIKE_TOKENS = new Set([
  'day',
  'time',
  'timepoint',
  'week',
  'visit',
  'session',
  'trial',
  'month',
  'hour',
  'minute',
  'min',
  'second',
  'sec',
])

function isLikelyGroupingFactor(name: string): boolean {
  return GROUPING_PATTERN.test(name) && !COMPARISON_PATTERN.test(name)
}

function getColumnKey(column: ColumnClassification): string {
  return column.columnId || column.columnName
}

function normalizeNameTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function isTimeLikePredictor(column: ColumnClassification): boolean {
  const tokens = new Set([
    ...normalizeNameTokens(column.columnName),
    ...normalizeNameTokens(getColumnKey(column)),
  ])
  return Array.from(tokens).some(token => TIME_LIKE_TOKENS.has(token))
}

function defaultPredictorType(column: ColumnClassification): LmmPredictorType {
  if (column.dataType === ColumnDataType.Numeric || column.dataType === ColumnDataType.Ordinal) {
    if (isTimeLikePredictor(column)) {
      return 'categorical'
    }
    return 'continuous'
  }
  return 'categorical'
}

function buildOmnibusTerms(predictorNames: string[], interactionDepth: number): string[] {
  if (predictorNames.length === 0) return []
  const depth = Math.min(Math.max(interactionDepth, 1), predictorNames.length)
  const terms: string[] = []

  const walk = (start: number, picks: string[]) => {
    if (picks.length > 0) {
      terms.push(picks.join(' x '))
    }
    if (picks.length === depth) return
    for (let i = start; i < predictorNames.length; i += 1) {
      walk(i + 1, [...picks, predictorNames[i]!])
    }
  }

  walk(0, [])
  return terms
}

function buildFixedFormulaString(predictorNames: string[], interactionDepth: number): string {
  if (predictorNames.length === 0) return '1'
  if (predictorNames.length === 1 || interactionDepth < 2) {
    return predictorNames.join(' + ')
  }

  if (predictorNames.length === 2 && interactionDepth >= 2) {
    return `(${predictorNames[0]} * ${predictorNames[1]})`
  }

  return buildOmnibusTerms(predictorNames, interactionDepth)
    .map(term => term.replace(/ x /g, ':'))
    .join(' + ')
}

function getSimpleEffectPairKey(factorId: string, withinId: string): string {
  return `${factorId}|${withinId}`
}

export function LmmAnovaConfigDialog({
  open,
  columns,
  onConfirm,
  onCancel,
}: LmmAnovaConfigDialogProps) {
  const numericColumns = useMemo(
    () =>
      columns.filter(
        c => c.dataType === ColumnDataType.Numeric || c.dataType === ColumnDataType.Ordinal
      ),
    [columns]
  )

  const [dependentColumnId, setDependentColumnId] = useState('')
  const [subjectColumnId, setSubjectColumnId] = useState('')
  const [selectedPredictorIds, setSelectedPredictorIds] = useState<string[]>([])
  const [predictorTypes, setPredictorTypes] = useState<Record<string, LmmPredictorType>>({})
  const [selectedStratifyIds, setSelectedStratifyIds] = useState<string[]>([])
  const [reml, setReml] = useState(false)
  const [interactionDepth, setInteractionDepth] = useState<number>(2)
  const [dfMethod, setDfMethod] = useState<LmmDfMethod>('satterthwaite')
  const [randomEffectsMode, setRandomEffectsMode] = useState<LmmRandomEffectsMode>('random_intercept')
  const [randomSlopeTarget, setRandomSlopeTarget] = useState('')
  const [adjustmentMethod, setAdjustmentMethod] = useState<LmmPostHocAdjustmentMethod>('tukey')
  const [controlLevels, setControlLevels] = useState<Record<string, string>>({})
  const [posthocQInput, setPosthocQInput] = useState('0.05')
  const [selectedSimpleEffectKeys, setSelectedSimpleEffectKeys] = useState<Set<string>>(new Set())
  const [enableContinuousFollowup, setEnableContinuousFollowup] = useState(false)
  const [continuousGroupFactorId, setContinuousGroupFactorId] = useState('')
  const [continuousTimeValuesInput, setContinuousTimeValuesInput] = useState('')

  useEffect(() => {
    if (!open) return
    if (columns.length === 0) {
      setDependentColumnId('')
      setSubjectColumnId('')
      setSelectedPredictorIds([])
      setPredictorTypes({})
      setSelectedStratifyIds([])
      setReml(false)
      setInteractionDepth(2)
      setDfMethod('satterthwaite')
      setRandomEffectsMode('random_intercept')
      setRandomSlopeTarget('')
      setAdjustmentMethod('tukey')
      setControlLevels({})
      setPosthocQInput('0.05')
      setSelectedSimpleEffectKeys(new Set())
      setEnableContinuousFollowup(false)
      setContinuousGroupFactorId('')
      setContinuousTimeValuesInput('')
      return
    }

    const defaultDependent = getColumnKey(numericColumns[0] ?? columns[0]!)
    const defaultSubject = getColumnKey(
      columns.find(c => getColumnKey(c) !== defaultDependent) ?? columns[1] ?? columns[0]!
    )
    const defaultPredictors = columns
      .filter(c => {
        const key = getColumnKey(c)
        return key !== defaultDependent && key !== defaultSubject
      })
      .map(getColumnKey)

    const nextTypes: Record<string, LmmPredictorType> = {}
    for (const c of columns) {
      nextTypes[getColumnKey(c)] = defaultPredictorType(c)
    }

    // Auto-select grouping factors: categorical/binary predictors whose names look like
    // subgroup dimensions (gender, race, batch…) rather than comparison axes (treatment, drug…).
    const catPredictors = columns.filter(c => {
      const key = getColumnKey(c)
      return (
        defaultPredictors.includes(key) &&
        (c.dataType === ColumnDataType.Categorical || c.dataType === ColumnDataType.Binary)
      )
    })
    const groupingFactors = catPredictors.filter(c => isLikelyGroupingFactor(c.columnName))
    const defaultStratifyIds =
      groupingFactors.length > 0 ? groupingFactors.slice(0, 1).map(getColumnKey) : []

    const modelPredictors = defaultPredictors.filter(id => !defaultStratifyIds.includes(id))
    const firstContinuous = modelPredictors.find(id => nextTypes[id] === 'continuous') ?? ''

    setDependentColumnId(defaultDependent)
    setSubjectColumnId(defaultSubject)
    setSelectedPredictorIds(modelPredictors)
    setPredictorTypes(nextTypes)
    setSelectedStratifyIds(defaultStratifyIds)
    setReml(false)
    setInteractionDepth(2)
    setDfMethod('satterthwaite')
    setRandomEffectsMode('random_intercept')
    setRandomSlopeTarget(firstContinuous)
    setAdjustmentMethod('tukey')
    setControlLevels({})
    setPosthocQInput('0.05')
    setSelectedSimpleEffectKeys(new Set())
    setEnableContinuousFollowup(false)
    const defaultCategoricalForContinuous = modelPredictors.find(id => nextTypes[id] === 'categorical') ?? ''
    setContinuousGroupFactorId(defaultCategoricalForContinuous)
    setContinuousTimeValuesInput('')
  }, [open, columns, numericColumns])

  const availablePredictors = useMemo(
    () =>
      columns.filter(c => {
        const key = getColumnKey(c)
        return key !== dependentColumnId && key !== subjectColumnId
      }),
    [columns, dependentColumnId, subjectColumnId]
  )

  useEffect(() => {
    const allowedIds = new Set(availablePredictors.map(getColumnKey))
    setSelectedPredictorIds(prev => prev.filter(id => allowedIds.has(id)))
  }, [availablePredictors])

  const stratifyEligiblePredictors = useMemo(
    () =>
      availablePredictors.filter(c => {
        const key = getColumnKey(c)
        return predictorTypes[key] === 'categorical' && !selectedPredictorIds.includes(key)
      }),
    [availablePredictors, predictorTypes, selectedPredictorIds]
  )

  // Derive effective strata IDs by filtering raw selections against current eligibility.
  // Using a memo avoids a separate cleanup effect that would race with the init effect on open.
  const effectiveStratifyIds = useMemo(() => {
    const eligibleSet = new Set(stratifyEligiblePredictors.map(getColumnKey))
    return selectedStratifyIds.filter(id => eligibleSet.has(id))
  }, [stratifyEligiblePredictors, selectedStratifyIds])

  useEffect(() => {
    if (!open || !dependentColumnId || !subjectColumnId) return
    const eligibleSet = new Set(stratifyEligiblePredictors.map(getColumnKey))
    setSelectedStratifyIds(prev => {
      const next = prev.filter(id => eligibleSet.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [open, dependentColumnId, subjectColumnId, stratifyEligiblePredictors])

  const slopeEligiblePredictors = useMemo(
    () =>
      availablePredictors.filter(c => {
        const key = getColumnKey(c)
        return selectedPredictorIds.includes(key) && predictorTypes[key] === 'continuous'
      }),
    [availablePredictors, predictorTypes, selectedPredictorIds]
  )

  const withinModelPredictorIds = selectedPredictorIds

  const withinModelPredictorCount = withinModelPredictorIds.length
  const maxInteractionDepth = Math.max(1, withinModelPredictorCount)
  const effectiveInteractionDepth = Math.min(Math.max(interactionDepth, 1), maxInteractionDepth)

  const withinModelCategoricalPredictors = useMemo(
    () =>
      availablePredictors.filter(c => {
        const key = getColumnKey(c)
        return withinModelPredictorIds.includes(key) && predictorTypes[key] === 'categorical'
      }),
    [availablePredictors, predictorTypes, withinModelPredictorIds]
  )

  const subjectLabel = useMemo(() => {
    const c = columns.find(c => getColumnKey(c) === subjectColumnId)
    return c?.columnName ?? 'Subject'
  }, [columns, subjectColumnId])

  const randomSlopeLabel = useMemo(() => {
    const c = columns.find(c => getColumnKey(c) === randomSlopeTarget)
    return c?.columnName ?? 'slope'
  }, [columns, randomSlopeTarget])

  // Columns selected as stratification factors and eligible for subgroup splitting
  const activeStrataCols = useMemo(
    () => stratifyEligiblePredictors.filter(c => effectiveStratifyIds.includes(getColumnKey(c))),
    [stratifyEligiblePredictors, effectiveStratifyIds]
  )

  // Live strata preview: Cartesian product of uniqueValues for each active strata column.
  // Returns empty rows when level data is unavailable for any column.
  const strataPreview = useMemo(() => {
    if (activeStrataCols.length === 0) {
      return { rows: [], totalCount: 0, isTotalCountCapped: false }
    }
    const valueSets = activeStrataCols.map(c => c.uniqueValues)
    if (valueSets.some(s => s.length === 0)) {
      return { rows: [], totalCount: 0, isTotalCountCapped: false }
    }
    return buildCappedCartesianPreview(valueSets, MAX_PREVIEW_ROWS)
  }, [activeStrataCols])

  const hasLevelData =
    activeStrataCols.length > 0 && activeStrataCols.every(c => c.uniqueValues.length > 0)
  const previewRows = strataPreview.rows
  const previewOverflow = Math.max(0, strataPreview.totalCount - previewRows.length)
  const trivialStrataCols = useMemo(
    () => activeStrataCols.filter(c => c.uniqueValues.length === 1),
    [activeStrataCols]
  )
  const outcomeLabel = useMemo(() => {
    const c = columns.find(c => getColumnKey(c) === dependentColumnId)
    return c?.columnName ?? 'Outcome'
  }, [columns, dependentColumnId])

  const formulaString = useMemo(() => {
    const predNames = withinModelPredictorIds.map(
      id => availablePredictors.find(c => getColumnKey(c) === id)?.columnName ?? id
    )
    const fixedPart = buildFixedFormulaString(predNames, effectiveInteractionDepth)
    const randomPart =
      randomEffectsMode === 'random_slope' && randomSlopeTarget
        ? `(1 + ${randomSlopeLabel} | ${subjectLabel})`
        : `(1 | ${subjectLabel})`
    return `${outcomeLabel} ~ ${fixedPart} + ${randomPart}`
  }, [
    withinModelPredictorIds,
    availablePredictors,
    effectiveInteractionDepth,
    randomEffectsMode,
    randomSlopeTarget,
    randomSlopeLabel,
    subjectLabel,
    outcomeLabel,
  ])

  const omnibusTerms = useMemo(() => {
    const predictorNames = withinModelPredictorIds.map(
      id => availablePredictors.find(c => getColumnKey(c) === id)?.columnName ?? id
    )
    return buildOmnibusTerms(predictorNames, effectiveInteractionDepth)
  }, [availablePredictors, effectiveInteractionDepth, withinModelPredictorIds])

  const followUpModelScopeLabel = 'inside each subgroup model'
  const simpleEffectsFollowUpAvailable = withinModelCategoricalPredictors.length >= 2
  const simpleEffectPairs = useMemo(
    () =>
      withinModelCategoricalPredictors.flatMap(factor =>
        withinModelCategoricalPredictors
          .filter(within => getColumnKey(within) !== getColumnKey(factor))
          .map(within => ({
            factorId: getColumnKey(factor),
            factorLabel: factor.columnName,
            withinId: getColumnKey(within),
            withinLabel: within.columnName,
          }))
      ),
    [withinModelCategoricalPredictors]
  )
  const selectedSimpleEffects = useMemo(
    () =>
      simpleEffectPairs
        .filter(pair => selectedSimpleEffectKeys.has(getSimpleEffectPairKey(pair.factorId, pair.withinId)))
        .map(pair => ({ factor: pair.factorLabel, within: pair.withinLabel })),
    [selectedSimpleEffectKeys, simpleEffectPairs]
  )
  const selectedSimpleEffectsCount = selectedSimpleEffects.length
  const simpleEffectsSkipMessage = useMemo(() => {
    if (simpleEffectsFollowUpAvailable) return null

    const reasonParts: string[] = []
    if (randomEffectsMode === 'random_slope' && randomSlopeTarget) {
      reasonParts.push(
        `${randomSlopeLabel} is treated as numeric for the varying-change predictor`
      )
    }

    const remainingLabels = withinModelCategoricalPredictors.map(c => c.columnName)
    if (remainingLabels.length === 1) {
      reasonParts.push(
        `only ${remainingLabels[0]} remains categorical ${followUpModelScopeLabel}`
      )
    }

    const detail =
      reasonParts.length > 0 ? ` ${reasonParts.join('; ')}.` : ''

    return `Simple-effects follow-up will be skipped because fewer than two categorical predictors remain ${followUpModelScopeLabel}.${detail}`
  }, [
    followUpModelScopeLabel,
    randomEffectsMode,
    randomSlopeLabel,
    randomSlopeTarget,
    simpleEffectsFollowUpAvailable,
    withinModelCategoricalPredictors,
  ])

  useEffect(() => {
    const allowedKeys = new Set(
      simpleEffectPairs.map(pair => getSimpleEffectPairKey(pair.factorId, pair.withinId))
    )
    setSelectedSimpleEffectKeys(prev => {
      const next = new Set(Array.from(prev).filter(key => allowedKeys.has(key)))
      if (next.size === prev.size) {
        let same = true
        for (const key of next) {
          if (!prev.has(key)) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })
  }, [simpleEffectPairs])

  const continuousGroupFactorOptions = withinModelCategoricalPredictors
  const continuousTimeFactorId = randomEffectsMode === 'random_slope' ? randomSlopeTarget : ''
  const continuousTimeFactorLabel = randomSlopeLabel
  const continuousFollowupEligible =
    randomEffectsMode === 'random_slope' &&
    Boolean(randomSlopeTarget) &&
    continuousGroupFactorOptions.length > 0
  const continuousFollowupAvailable =
    randomEffectsMode === 'random_slope' && Boolean(randomSlopeTarget)
  const continuousFollowupExperimentalWarning =
    randomEffectsMode === 'random_slope' && Boolean(randomSlopeTarget)

  useEffect(() => {
    if (!continuousFollowupEligible) {
      setEnableContinuousFollowup(false)
      return
    }
    const allowed = new Set(continuousGroupFactorOptions.map(getColumnKey))
    if (!allowed.has(continuousGroupFactorId)) {
      setContinuousGroupFactorId(getColumnKey(continuousGroupFactorOptions[0]!) || '')
    }
  }, [continuousFollowupEligible, continuousGroupFactorId, continuousGroupFactorOptions])

  const parsedContinuousTime = useMemo(
    () => parseContinuousTimeValues(continuousTimeValuesInput),
    [continuousTimeValuesInput]
  )
  const parsedContinuousTimeValues = parsedContinuousTime.values
  const invalidContinuousTimeTokens = parsedContinuousTime.invalidTokens

  const continuousFollowupError = useMemo(() => {
    if (!enableContinuousFollowup) return null
    if (!continuousFollowupEligible) {
      return 'Choose at least one categorical factor to compare at selected numeric time values.'
    }
    if (!continuousGroupFactorId) {
      return 'Choose the categorical factor to compare at selected time values.'
    }
    if (invalidContinuousTimeTokens.length > 0) {
      return `Invalid numeric value(s): ${invalidContinuousTimeTokens.join(', ')}.`
    }
    if (parsedContinuousTimeValues.length === 0) {
      return 'Enter one or more numeric time values separated by commas.'
    }
    return null
  }, [
    continuousFollowupEligible,
    continuousGroupFactorId,
    enableContinuousFollowup,
    invalidContinuousTimeTokens,
    parsedContinuousTimeValues.length,
  ])

  const unavailableStratifyFactors = useMemo(
    () => activeStrataCols.filter(c => COMPARISON_PATTERN.test(c.columnName)),
    [activeStrataCols]
  )

  const isFdr = adjustmentMethod === 'fdr_bh'
  const isDunnett = adjustmentMethod === 'dunnett'
  const posthocQValue = useMemo(() => {
    const parsed = Number.parseFloat(posthocQInput)
    return Number.isFinite(parsed) ? parsed : null
  }, [posthocQInput])
  const posthocQError = useMemo(() => {
    if (!isFdr) return null
    if (posthocQValue === null) return 'Enter a q-value between 0 and 1.'
    if (posthocQValue <= 0 || posthocQValue > 1) return 'q-value must be greater than 0 and at most 1.'
    return null
  }, [isFdr, posthocQValue])
  const dunnettValidationError = useMemo(() => {
    if (!isDunnett) return null
    const missing = withinModelCategoricalPredictors.find(c => !controlLevels[getColumnKey(c)])
    if (missing) {
      return `Choose a control level for ${missing.columnName}.`
    }
    return null
  }, [controlLevels, isDunnett, withinModelCategoricalPredictors])

  const showSlopeSelector =
    randomEffectsMode === 'random_slope' && slopeEligiblePredictors.length > 0
  const showSlopeHelper =
    randomEffectsMode === 'random_slope' && slopeEligiblePredictors.length === 0
  const krSupportedForCurrentConfig = randomEffectsMode === 'random_intercept'
  const showKrHelper = dfMethod === 'kenward_roger' && krSupportedForCurrentConfig
  const showKrUnsupportedHelper = !krSupportedForCurrentConfig

  useEffect(() => {
    if (krSupportedForCurrentConfig) return
    if (dfMethod === 'kenward_roger') setDfMethod('satterthwaite')
  }, [dfMethod, krSupportedForCurrentConfig])

  useEffect(() => {
    if (randomEffectsMode !== 'random_slope') return
    const eligibleIds = slopeEligiblePredictors.map(getColumnKey)
    if (eligibleIds.length === 0) {
      setRandomSlopeTarget('')
      return
    }
    if (!eligibleIds.includes(randomSlopeTarget)) {
      setRandomSlopeTarget(eligibleIds[0]!)
    }
  }, [randomEffectsMode, slopeEligiblePredictors, randomSlopeTarget])

  useEffect(() => {
    if (withinModelPredictorCount === 0) return
    if (interactionDepth > maxInteractionDepth) {
      setInteractionDepth(maxInteractionDepth)
    }
  }, [interactionDepth, maxInteractionDepth, withinModelPredictorCount])

  useEffect(() => {
    const eligible = new Set(withinModelCategoricalPredictors.map(getColumnKey))
    setControlLevels(prev =>
      Object.fromEntries(Object.entries(prev).filter(([key]) => eligible.has(key)))
    )
  }, [withinModelCategoricalPredictors])

  const validationMessage = useMemo(() => {
    if (!dependentColumnId) return 'Choose an outcome variable.'
    if (!subjectColumnId) return 'Choose a sample / subject ID column.'
    if (dependentColumnId === subjectColumnId) return 'Outcome and sample ID must be different columns.'
    if (selectedPredictorIds.length === 0) return 'Select at least one predictor.'
    if (effectiveStratifyIds.length === 0) {
      return 'Choose at least one subgroup factor.'
    }
    if (trivialStrataCols.length > 0) {
      const labels = trivialStrataCols.map(c => c.columnName).join(', ')
      return `${labels} must have at least two profiled levels to run stratified models.`
    }
    if (interactionDepth < 1) {
      return `Interaction depth must be between 1 and ${maxInteractionDepth} for the predictors inside the model.`
    }
    if (randomEffectsMode === 'random_slope' && slopeEligiblePredictors.length === 0) {
      return 'Random slope mode requires one selected predictor treated as numeric.'
    }
    if (randomEffectsMode === 'random_slope' && !randomSlopeTarget) {
      return 'Choose the numeric predictor that should vary by sample.'
    }
    if (continuousFollowupError) return continuousFollowupError
    if (posthocQError) return posthocQError
    if (dunnettValidationError) return dunnettValidationError
    return null
  }, [
    continuousFollowupError,
    dunnettValidationError,
    dependentColumnId,
    interactionDepth,
    maxInteractionDepth,
    subjectColumnId,
    posthocQError,
    selectedPredictorIds,
    randomEffectsMode,
    slopeEligiblePredictors,
    randomSlopeTarget,
    effectiveStratifyIds,
    trivialStrataCols,
  ])

  const handlePredictorToggle = (id: string, checked: boolean) => {
    setSelectedPredictorIds(prev => (checked ? [...prev, id] : prev.filter(p => p !== id)))
    if (checked) {
      setSelectedStratifyIds(prev => prev.filter(s => s !== id))
    }
  }

  const handlePredictorTypeChange = (id: string, value: LmmPredictorType) => {
    if (effectiveStratifyIds.includes(id)) {
      setPredictorTypes(prev => ({ ...prev, [id]: 'categorical' }))
      return
    }
    setPredictorTypes(prev => ({ ...prev, [id]: value }))
  }

  const handleStratifyToggle = (id: string, checked: boolean) => {
    setSelectedStratifyIds(prev => (checked ? [...prev, id] : prev.filter(s => s !== id)))
    if (checked) {
      setSelectedPredictorIds(prev => prev.filter(p => p !== id))
      setPredictorTypes(prev => ({ ...prev, [id]: 'categorical' }))
    }
  }

  const handleConfirm = () => {
    if (validationMessage) return
    const effectiveDfMethod =
      !krSupportedForCurrentConfig && dfMethod === 'kenward_roger' ? 'satterthwaite' : dfMethod
    const submittedPredictorTypeIds = Array.from(
      new Set([...selectedPredictorIds, ...effectiveStratifyIds])
    )
    onConfirm({
      cancelled: false,
      config: {
        dependentColumnId,
        subjectColumnId,
        predictorColumnIds: selectedPredictorIds,
        predictorTypes: Object.fromEntries(
          submittedPredictorTypeIds.map(id => [id, predictorTypes[id] ?? 'categorical'])
        ),
        stratified: true,
        stratifyBy: effectiveStratifyIds,
        reml,
        interactionDepth: effectiveInteractionDepth,
        dfMethod: effectiveDfMethod,
        randomEffectsMode,
        randomSlopeTarget: randomEffectsMode === 'random_slope' ? randomSlopeTarget : undefined,
        adjustmentMethod,
        controlLevels,
        posthocQ: isFdr ? posthocQValue ?? undefined : undefined,
        simpleEffects: selectedSimpleEffects,
        continuousEffectsConfig:
          enableContinuousFollowup && continuousFollowupEligible && continuousGroupFactorId
            ? {
                mode: 'at_values',
                groupFactorId: continuousGroupFactorId,
                timeFactorId: continuousTimeFactorId,
                timeValues: parsedContinuousTimeValues,
              }
            : undefined,
      },
    })
  }

  const selectCls =
    'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors'
  const inputCls =
    'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors'
  const labelCapCls = 'text-[10px] font-semibold text-zinc-400 uppercase tracking-widest'
  const stepBadge = (n: string) => (
    <span className="text-[10px] font-mono font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded shrink-0">
      {n}
    </span>
  )
  const sectionHead = (n: string, label: string, right?: React.ReactNode) => (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2.5">
        {stepBadge(n)}
        <h3 className="text-sm font-semibold text-zinc-800 tracking-tight">{label}</h3>
      </div>
      {right}
    </div>
  )

  return (
    <ResizableDialog
      open={open}
      onOpenChange={next => { if (!next) onCancel() }}
      defaultWidth={1020}
      defaultHeight={740}
      minWidth={680}
      minHeight={480}
      persistKey="lmm-anova-config"
    >
      <ResizableDialogContent
        className="flex flex-col p-0"
        data-testid="lmm-anova-dialog"
      >
        {/* ── HEADER ── */}
        <ResizableDialogHeader className="px-7 pt-5 pb-4 border-b border-zinc-100">
          <div className="flex items-center gap-3 pr-8">
            <div
              className="h-8 w-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0"
              data-testid="lmm-dialog-header-icon"
            >
              <LineChart className="w-4 h-4 text-white" />
            </div>
            <div>
              <ResizableDialogTitle className="text-base font-semibold tracking-tight text-zinc-900 leading-none">
                Linear Mixed Model
              </ResizableDialogTitle>
              <ResizableDialogDescription className="text-xs text-zinc-400 mt-1">
                Configure outcome, predictors, random effects, and follow-up comparisons
              </ResizableDialogDescription>
            </div>
          </div>
        </ResizableDialogHeader>

        {/* ── BODY ── */}
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-zinc-100">

          {/* 01 — Outcome */}
          <section className="px-7 py-5">
            {sectionHead('01', 'Outcome')}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="flex flex-col gap-1.5">
                <label className={labelCapCls} htmlFor="lmm-dv-select-input">Outcome variable</label>
                <select
                  id="lmm-dv-select-input"
                  className={selectCls}
                  data-testid="lmm-dv-select"
                  value={dependentColumnId}
                  onChange={e => setDependentColumnId(e.target.value)}
                >
                  {numericColumns.map(c => (
                    <option key={getColumnKey(c)} value={getColumnKey(c)}>{c.columnName}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className={labelCapCls} htmlFor="lmm-group-select-input">Sample / subject ID</label>
                <select
                  id="lmm-group-select-input"
                  className={selectCls}
                  data-testid="lmm-group-select"
                  value={subjectColumnId}
                  onChange={e => setSubjectColumnId(e.target.value)}
                >
                  {columns
                    .filter(c => getColumnKey(c) !== dependentColumnId)
                    .map(c => (
                      <option key={getColumnKey(c)} value={getColumnKey(c)}>{c.columnName}</option>
                    ))}
                </select>
              </div>
            </div>
          </section>

          {/* 02 — Model Predictors */}
          <section className="px-7 py-5">
            {sectionHead('02', 'Tested Predictors')}
            <div className="rounded-xl border border-zinc-200 overflow-hidden">
              <div className="grid grid-cols-[1fr_164px] bg-zinc-50 border-b border-zinc-200 px-3.5 py-2">
                <span className={labelCapCls}>Column</span>
                <span className={labelCapCls}>Role</span>
              </div>
              {availablePredictors.map((c, i) => {
                const key = getColumnKey(c)
                const checked = selectedPredictorIds.includes(key)
                return (
                  <div
                    key={key}
                    className={`grid grid-cols-[1fr_164px] items-center px-3.5 py-2.5 gap-3 transition-colors ${
                      i < availablePredictors.length - 1 ? 'border-b border-zinc-100' : ''
                    } bg-white`}
                  >
                    <label className="flex items-center gap-2.5 text-sm cursor-pointer min-w-0">
                      <input
                        type="checkbox"
                        checked={checked}
                        data-testid={`lmm-predictor-toggle-${key}`}
                        onChange={e => handlePredictorToggle(key, e.target.checked)}
                        className="rounded border-zinc-300 text-blue-600 focus:ring-blue-500/20 shrink-0"
                      />
                      <span
                        className="truncate font-medium text-zinc-800"
                        data-testid={`lmm-predictor-label-${key}`}
                      >
                        {c.columnName}
                      </span>
                    </label>
                    <label htmlFor={`lmm-predictor-type-select-${key}`} className="sr-only">
                      {`Role for ${c.columnName}`}
                    </label>
                    <select
                      id={`lmm-predictor-type-select-${key}`}
                      className="w-full rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors"
                      value={predictorTypes[key] ?? 'categorical'}
                      data-testid={`lmm-predictor-type-${key}`}
                      onChange={e => handlePredictorTypeChange(key, e.target.value as LmmPredictorType)}
                    >
                      <option value="categorical">Categorical</option>
                      <option value="continuous">Numeric</option>
                    </select>
                  </div>
                )
              })}
            </div>
          </section>

          {/* 03 — Stratification Factors */}
          <section className="px-7 py-5">
            {sectionHead('03', 'Stratification Factors')}

            <div className="space-y-3">
              <p className="text-xs text-zinc-400">
                Data is split by the selected stratification factors. The tested predictors are fit within each subgroup.
              </p>
              {stratifyEligiblePredictors.length === 0 ? (
                <p className="text-xs text-zinc-400">
                  No eligible stratification factors are available for the current predictor selections.
                </p>
              ) : (
                <div className="rounded-xl border border-zinc-200 overflow-hidden" style={{ height: 260 }}>
                  <ResizablePanelGroup direction="horizontal">

                      {/* Factor checkboxes */}
                      <ResizablePanel defaultSize={24} minSize={16}>
                        <div className="h-full overflow-y-auto p-3 space-y-1.5">
                          <p className={`${labelCapCls} mb-2.5`}>Stratify by</p>
                          {stratifyEligiblePredictors.map(c => {
                            const key = getColumnKey(c)
                            const checked = effectiveStratifyIds.includes(key)
                            return (
                              <label
                                key={key}
                                className="flex items-center gap-2 text-xs cursor-pointer select-none py-0.5"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  data-testid={`lmm-stratify-factor-${key}`}
                                  onChange={e => handleStratifyToggle(key, e.target.checked)}
                                  className="rounded border-zinc-300 text-blue-600 focus:ring-blue-500/20"
                                />
                                <span className={`truncate ${checked ? 'text-zinc-800 font-medium' : 'text-zinc-500'}`}>
                                  {c.columnName}
                                </span>
                                {c.uniqueValues.length > 0 && (
                                  <span className="text-[10px] text-zinc-400 ml-auto tabular-nums shrink-0">
                                    {c.uniqueValues.length}
                                  </span>
                                )}
                              </label>
                            )
                          })}
                        </div>
                      </ResizablePanel>

                      <ResizableHandle withHandle />

                      {/* Strata preview */}
                      <ResizablePanel defaultSize={40} minSize={25}>
                        <div className="h-full flex flex-col overflow-hidden">
                          <div className="px-3 pt-3 pb-2 shrink-0">
                            <p className={labelCapCls}>Possible subgroups</p>
                            <p className="text-[10px] text-zinc-400 mt-0.5">Derived from profiled levels</p>
                          </div>
                          {effectiveStratifyIds.length === 0 ? (
                            <p className="text-xs text-zinc-400 italic px-3">Check factors on the left to preview.</p>
                          ) : !hasLevelData ? (
                            <p className="text-xs text-zinc-400 italic px-3">Level data unavailable.</p>
                          ) : (
                            <div className="flex-1 min-h-0 overflow-y-auto" data-testid="lmm-strata-preview">
                              <table className="w-full text-xs table-fixed">
                                <thead className="sticky top-0">
                                  <tr className="bg-zinc-100 border-b border-zinc-200">
                                    {activeStrataCols.map(c => (
                                      <th key={getColumnKey(c)} className="px-2.5 py-1.5 text-left font-semibold text-zinc-500 text-[10px] uppercase tracking-wide">
                                        {c.columnName}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {previewRows.map((combo, i) => (
                                    <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-zinc-50'} data-testid={`lmm-stratum-row-${i}`}>
                                      {combo.map((value, j) => (
                                        <td key={j} className="px-2.5 py-1 text-zinc-600 truncate">{value}</td>
                                      ))}
                                    </tr>
                                  ))}
                                  {previewOverflow > 0 && (
                                    <tr>
                                      <td colSpan={activeStrataCols.length} className="px-2.5 py-1 text-zinc-400 italic">
                                        +{previewOverflow} more
                                      </td>
                                    </tr>
                                  )}
                                </tbody>
                              </table>
                              <div className="px-2.5 py-1.5 bg-zinc-50 border-t border-zinc-200 flex items-center gap-1.5 text-[10px] sticky bottom-0" data-testid="lmm-strata-count">
                                <span className="font-bold text-zinc-600 tabular-nums">
                                  {strataPreview.isTotalCountCapped
                                    ? `>= ${Number.MAX_SAFE_INTEGER}`
                                    : strataPreview.totalCount}
                                </span>
                                <span className="text-zinc-400">
                                  {strataPreview.totalCount === 1 ? 'possible combination' : 'possible combinations'}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      </ResizablePanel>

                      <ResizableHandle withHandle />

                      {/* What will be tested */}
                      <ResizablePanel defaultSize={36} minSize={22}>
                        <div className="h-full flex flex-col overflow-hidden">
                          <p className={`${labelCapCls} px-3 pt-3 pb-2 shrink-0`}>What will be tested</p>
                          <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-3">
                            {activeStrataCols.length > 0 && (
                              <div>
                                <p className="text-[10px] text-zinc-400 uppercase tracking-wider mb-1">Separate models within</p>
                                <p className="text-xs font-semibold text-zinc-700">
                                  {activeStrataCols.map(c => c.columnName).join(' \u00d7 ')}
                                </p>
                              </div>
                            )}
                            <div>
                              <p className="text-[10px] text-zinc-400 uppercase tracking-wider mb-1.5">Formula</p>
                              <code
                                className="text-[11px] bg-zinc-900 text-emerald-400 rounded-lg px-2.5 py-2 block break-all font-mono leading-relaxed"
                                data-testid="lmm-formula-preview"
                              >
                                {formulaString}
                              </code>
                            </div>
                            <div data-testid="lmm-omnibus-terms-preview">
                              <p className="text-[10px] text-zinc-400 uppercase tracking-wider mb-1.5">Omnibus terms</p>
                              {omnibusTerms.length > 0 ? (
                                <ul className="space-y-1">
                                  {omnibusTerms.map(term => (
                                    <li key={term} className="text-xs font-medium text-zinc-700 flex items-center gap-1.5">
                                      <span className="w-1 h-1 rounded-full bg-blue-400 shrink-0" />
                                      {term}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="text-xs text-zinc-500">Intercept only</p>
                              )}
                            </div>
                            {activeStrataCols.length > 0 && (
                              <div data-testid="lmm-subgrouped-away-preview">
                                <p className="text-[10px] text-zinc-400 uppercase tracking-wider mb-1">Removed from each subgroup model</p>
                                <p className="text-xs text-zinc-500">{activeStrataCols.map(c => c.columnName).join(', ')}</p>
                              </div>
                            )}
                            {unavailableStratifyFactors.length > 0 && (
                              <div className="border-l-2 border-amber-400 bg-amber-50 pl-2.5 py-1.5 rounded-r-md flex items-start gap-1.5" data-testid="lmm-comparison-warning">
                                <span className="text-amber-500 shrink-0 text-xs mt-px">⚠</span>
                                <p className="text-[10px] text-amber-700 leading-relaxed">
                                  <span className="font-semibold">{unavailableStratifyFactors.map(c => c.columnName).join(', ')}</span>{' '}
                                  comparisons will not be available inside each subgroup model.
                                </p>
                              </div>
                            )}
                            {trivialStrataCols.length > 0 && (
                              <div
                                className="border-l-2 border-amber-400 bg-amber-50 pl-2.5 py-1.5 rounded-r-md flex items-start gap-1.5"
                                data-testid="lmm-trivial-strata-warning"
                              >
                                <span className="text-amber-500 shrink-0 text-xs mt-px">⚠</span>
                                <p className="text-[10px] text-amber-700 leading-relaxed">
                                  <span className="font-semibold">{trivialStrataCols.map(c => c.columnName).join(', ')}</span>{' '}
                                  has only one profiled level; this subgroup split may be equivalent to pooled fitting.
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      </ResizablePanel>

                  </ResizablePanelGroup>
                </div>
              )}
            </div>
          </section>

          {/* 04 — Random Effects */}
          <section className="px-7 py-5">
            {sectionHead('04', 'Random Effects')}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label
                className={`rounded-xl border-2 p-4 cursor-pointer transition-all select-none ${
                  randomEffectsMode === 'random_intercept'
                    ? 'border-blue-500 bg-blue-50/40'
                    : 'border-zinc-200 bg-white hover:border-zinc-300'
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="lmm-random-structure"
                    checked={randomEffectsMode === 'random_intercept'}
                    data-testid="lmm-random-structure-intercept"
                    onChange={() => setRandomEffectsMode('random_intercept')}
                    className="mt-0.5 text-blue-600 border-zinc-300 focus:ring-blue-500/20 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-zinc-800">Random intercept</p>
                    <p className="text-xs text-zinc-400 mt-0.5">Each subject has its own baseline level</p>
                    <code className={`text-[11px] font-mono mt-2.5 block px-2 py-1 rounded-md ${
                      randomEffectsMode === 'random_intercept' ? 'bg-blue-100 text-blue-700' : 'bg-zinc-100 text-zinc-500'
                    }`}>
                      {`(1 | ${subjectLabel})`}
                    </code>
                  </div>
                </div>
              </label>

              <label
                className={`rounded-xl border-2 p-4 cursor-pointer transition-all select-none ${
                  randomEffectsMode === 'random_slope'
                    ? 'border-blue-500 bg-blue-50/40'
                    : 'border-zinc-200 bg-white hover:border-zinc-300'
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="lmm-random-structure"
                    checked={randomEffectsMode === 'random_slope'}
                    data-testid="lmm-random-structure-slope"
                    onChange={() => setRandomEffectsMode('random_slope')}
                    className="mt-0.5 text-blue-600 border-zinc-300 focus:ring-blue-500/20 shrink-0"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-zinc-800">Random slope</p>
                    <p className="text-xs text-zinc-400 mt-0.5">Each subject has its own baseline and rate of change</p>
                    <code className={`text-[11px] font-mono mt-2.5 block px-2 py-1 rounded-md ${
                      randomEffectsMode === 'random_slope' ? 'bg-blue-100 text-blue-700' : 'bg-zinc-100 text-zinc-500'
                    }`}>
                      {`(1 + ${randomSlopeLabel} | ${subjectLabel})`}
                    </code>
                  </div>
                </div>
              </label>
            </div>

            {showSlopeSelector && (
              <div className="mt-3 flex flex-col gap-1.5">
                <label className={labelCapCls}>Varying-change predictor</label>
                <select
                  className={selectCls}
                  data-testid="lmm-random-slope-select"
                  value={randomSlopeTarget}
                  onChange={e => setRandomSlopeTarget(e.target.value)}
                >
                  <option value="">Select a numeric predictor...</option>
                  {slopeEligiblePredictors.map(c => (
                    <option key={getColumnKey(c)} value={getColumnKey(c)}>{c.columnName}</option>
                  ))}
                </select>
              </div>
            )}

            {showSlopeHelper && (
              <div className="mt-3 border-l-2 border-amber-400 bg-amber-50 pl-3 py-2 rounded-r-lg">
                <p className="text-xs text-amber-700">
                  Select at least one predictor and treat it as Numeric to enable a varying-change predictor.
                </p>
              </div>
            )}
          </section>

          {/* 05 — Model Behavior */}
          <section className="px-7 py-5">
            {sectionHead('05', 'Model Behavior')}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div className="flex flex-col gap-1.5">
                <label className={labelCapCls} htmlFor="lmm-interaction-depth-input">Interaction depth</label>
                <input
                  id="lmm-interaction-depth-input"
                  className={inputCls}
                  data-testid="lmm-interaction-depth"
                  type="number"
                  min={1}
                  max={maxInteractionDepth}
                  value={interactionDepth}
                  onChange={e => {
                    const v = e.target.value
                    setInteractionDepth(v === '' ? 0 : Number(v))
                  }}
                />
                <p className="text-[11px] text-zinc-400">Max {maxInteractionDepth} for current predictors</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className={labelCapCls} htmlFor="lmm-df-method-input">DF method</label>
                <select
                  id="lmm-df-method-input"
                  className={selectCls}
                  data-testid="lmm-df-method"
                  value={dfMethod}
                  onChange={e => setDfMethod(e.target.value as LmmDfMethod)}
                >
                  <option value="satterthwaite">Satterthwaite</option>
                  <option value="kenward_roger" disabled={!krSupportedForCurrentConfig}>Kenward-Roger</option>
                  <option value="asymptotic">Asymptotic (z)</option>
                  <option value="residual">Residual (t)</option>
                </select>
                {showKrHelper && (
                  <p className="text-[11px] text-amber-600">
                    Kenward-Roger uses REML-based inference. If REML estimation is off, the model
                    may be internally refit with REML for inference.
                  </p>
                )}
                {showKrUnsupportedHelper && (
                  <p className="text-[11px] text-zinc-400">
                    Kenward-Roger currently supports only random-intercept models.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <span className={labelCapCls}>Estimation</span>
                <label className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2.5 cursor-pointer transition-all ${
                  reml ? 'border-blue-500 bg-blue-50/40' : 'border-zinc-200 bg-white hover:border-zinc-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={reml}
                    data-testid="lmm-reml-toggle"
                    onChange={e => setReml(e.target.checked)}
                    className="text-blue-600 border-zinc-300 focus:ring-blue-500/20 rounded"
                  />
                  <span className="text-sm text-zinc-700">Use REML</span>
                </label>
              </div>
            </div>
          </section>

          {/* 06 — Follow-Up Comparisons */}
          <section className="px-7 py-5">
            {sectionHead('06', 'Follow-Up Comparisons')}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="flex flex-col gap-1.5">
                <label className={labelCapCls} htmlFor="lmm-adjustment-method-input">Adjustment method</label>
                <select
                  id="lmm-adjustment-method-input"
                  className={selectCls}
                  data-testid="lmm-adjustment-method"
                  value={adjustmentMethod}
                  onChange={e => setAdjustmentMethod(e.target.value as LmmPostHocAdjustmentMethod)}
                >
                  {POST_HOC_METHODS.map(method => (
                    <option key={method.value} value={method.value}>{method.label}</option>
                  ))}
                </select>
                <p className="text-[11px] text-zinc-400">Applies to pairwise and simple-effect comparisons.</p>
              </div>

              {isFdr ? (
                <div className="flex flex-col gap-1.5">
                  <label className={labelCapCls} htmlFor="lmm-posthoc-q-input">FDR q-value</label>
                  <input
                    id="lmm-posthoc-q-input"
                    className={inputCls}
                    data-testid="lmm-posthoc-q"
                    inputMode="decimal"
                    value={posthocQInput}
                    onChange={e => setPosthocQInput(e.target.value)}
                  />
                  <p className="text-[11px] text-zinc-400">False discovery rate threshold, e.g. 0.05.</p>
                </div>
              ) : (
                <div className="flex items-center rounded-xl border border-dashed border-zinc-200 px-3.5 py-2.5 text-xs text-zinc-400">
                  {isDunnett
                    ? 'Select a control level for each categorical predictor below.'
                    : 'No additional parameters required for this method.'}
                </div>
              )}
            </div>

            {isDunnett && withinModelCategoricalPredictors.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-4">
                {withinModelCategoricalPredictors.map(c => {
                  const key = getColumnKey(c)
                  return (
                    <div key={key} className="flex flex-col gap-1.5">
                      <label className={labelCapCls}>Control · {c.columnName}</label>
                      <select
                        className={selectCls}
                        data-testid={`lmm-dunnett-control-${key}`}
                        value={controlLevels[key] ?? ''}
                        onChange={e => setControlLevels(prev => ({ ...prev, [key]: e.target.value }))}
                      >
                        <option value="">Select control level...</option>
                        {c.uniqueValues.map(level => (
                          <option key={level} value={level}>{level}</option>
                        ))}
                      </select>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* 07 — Simple Effects */}
          <section className="px-7 py-5">
            {sectionHead('07', 'Simple Effects')}
            <div className="space-y-4">
              <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4">
                <p className="text-sm font-semibold text-blue-900">What are simple effects in mixed models?</p>
                <p className="mt-2 text-xs leading-relaxed text-blue-900">
                  Simple effects test one predictor while holding another constant inside the same
                  mixed model. For example, “Treatment within Day” tests whether Drug A vs Control
                  differs at each Day level. Use this to follow up significant interactions found
                  in your mixed model. The post-hoc adjustment method selected above applies to
                  these comparisons.
                </p>
              </div>

              {simpleEffectsFollowUpAvailable ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-zinc-800">Select simple effects to analyze</p>
                    <p className="text-xs text-zinc-500">
                      {selectedSimpleEffectsCount} {selectedSimpleEffectsCount === 1 ? 'effect' : 'effects'} selected
                    </p>
                  </div>

                  <div className="rounded-xl border border-zinc-200 overflow-hidden">
                    <div className="grid grid-cols-[1fr_1fr_88px] bg-zinc-50 border-b border-zinc-200 px-3.5 py-2">
                      <span className={labelCapCls}>Main factor</span>
                      <span className={labelCapCls}>Within factor</span>
                      <span className={`${labelCapCls} text-center`}>Enable</span>
                    </div>
                    {simpleEffectPairs.map((pair, index) => {
                      const pairKey = getSimpleEffectPairKey(pair.factorId, pair.withinId)
                      const enabled = selectedSimpleEffectKeys.has(pairKey)
                      return (
                        <div
                          key={pairKey}
                          className={`grid grid-cols-[1fr_1fr_88px] items-center px-3.5 py-3 ${
                            index < simpleEffectPairs.length - 1 ? 'border-b border-zinc-100' : ''
                          } ${enabled ? 'bg-blue-50/50' : 'bg-white'}`}
                        >
                          <div className="text-sm font-medium text-blue-700">{pair.factorLabel}</div>
                          <div className="text-sm text-violet-700">{pair.withinLabel}</div>
                          <div className="flex justify-center">
                            <input
                              type="checkbox"
                              checked={enabled}
                              data-testid={`lmm-simple-effect-toggle-${pair.factorId}-within-${pair.withinId}`}
                              onChange={() =>
                                setSelectedSimpleEffectKeys(prev => {
                                  const next = new Set(prev)
                                  if (next.has(pairKey)) {
                                    next.delete(pairKey)
                                  } else {
                                    next.add(pairKey)
                                  }
                                  return next
                                })
                              }
                              className="rounded border-zinc-300 text-blue-600 focus:ring-blue-500/20"
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <div
                  className="border-l-2 border-amber-400 bg-amber-50 pl-3 py-2 rounded-r-lg"
                  data-testid="lmm-simple-effects-skip-note"
                >
                  <p className="text-xs text-amber-700 leading-relaxed">{simpleEffectsSkipMessage}</p>
                </div>
              )}
            </div>
          </section>

          {/* 08 — Numeric-Time Follow-Up */}
          {(continuousFollowupAvailable || enableContinuousFollowup) && (
            <section className="px-7 py-5">
              {sectionHead('08', 'Numeric-Time Follow-Up',
                <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                  Experimental
                </span>
              )}
              <div className="rounded-xl border border-zinc-200 p-4 space-y-3">
                <p className="text-xs text-zinc-400">
                  Estimates treatment contrasts at specific {continuousTimeFactorLabel} values using a numeric-time mixed model, rather than categorical simple effects within time levels.
                </p>
                {continuousFollowupExperimentalWarning ? (
                  <div className="border-l-2 border-amber-400 bg-amber-50 pl-3 py-2 rounded-r-md" data-testid="lmm-continuous-followup-note">
                    <p className="text-xs text-amber-700">
                      Random-slope numeric-time follow-up is experimental. EasyCris applies an internal centered/scaled fit for stability and may still fall back to asymptotic inference on some datasets.
                    </p>
                  </div>
                ) : null}
                <label className="flex items-center gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableContinuousFollowup}
                    disabled={!continuousFollowupEligible}
                    data-testid="lmm-enable-continuous-followup"
                    onChange={e => setEnableContinuousFollowup(e.target.checked)}
                    className="text-blue-600 border-zinc-300 focus:ring-blue-500/20 rounded"
                  />
                  <span className={enableContinuousFollowup ? 'text-zinc-700' : 'text-zinc-600'}>
                    Compare groups at selected {continuousTimeFactorLabel} values
                  </span>
                </label>
                {enableContinuousFollowup && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <label className={labelCapCls}>Factor to compare</label>
                      <select
                        className={selectCls}
                        data-testid="lmm-continuous-group-factor"
                        value={continuousGroupFactorId}
                        onChange={e => setContinuousGroupFactorId(e.target.value)}
                      >
                        <option value="">Select a categorical factor...</option>
                        {continuousGroupFactorOptions.map(c => (
                          <option key={getColumnKey(c)} value={getColumnKey(c)}>{c.columnName}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className={labelCapCls}>{continuousTimeFactorLabel} values</label>
                      <input
                        className={inputCls}
                        data-testid="lmm-continuous-time-values"
                        value={continuousTimeValuesInput}
                        onChange={e => setContinuousTimeValuesInput(e.target.value)}
                        placeholder="0, 2, 4"
                      />
                      {invalidContinuousTimeTokens.length > 0 ? (
                        <p
                          className="text-[11px] text-red-600"
                          data-testid="lmm-continuous-time-invalid"
                        >
                          Invalid numeric value(s): {invalidContinuousTimeTokens.join(', ')}
                        </p>
                      ) : null}
                      <p className="text-[11px] text-zinc-400">Comma-separated numeric values</p>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

        </div>

        {/* ── VALIDATION MESSAGE ── */}
        {validationMessage && (
          <div className="mx-6 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900 flex items-center gap-2">
            <span className="shrink-0 text-amber-500 text-sm">⚠</span>
            {validationMessage}
          </div>
        )}

        {/* ── FOOTER ── */}
        <ResizableDialogFooter className="px-7 py-4 border-t border-zinc-100">
          <Button variant="outline" onClick={onCancel} className="text-sm">
            Cancel
          </Button>
          <Button
            data-testid="lmm-next-button"
            onClick={handleConfirm}
            disabled={Boolean(validationMessage)}
            className="text-sm bg-blue-600 hover:bg-blue-700 text-white"
          >
            Continue
          </Button>
        </ResizableDialogFooter>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}

export default LmmAnovaConfigDialog
