import type {
  BuildPayloadResult,
  ColumnClassification,
  ITestModule,
  TestValidationResult,
  ValidateOptions,
} from '../core/types'
import { ColumnDataType } from '../core/types'

type PredictorType = 'categorical' | 'continuous'
type RandomEffectsMode = 'random_intercept' | 'random_slope'
type PostHocAdjustmentMethod =
  | 'tukey'
  | 'bonferroni'
  | 'holm'
  | 'holm-sidak'
  | 'sidak'
  | 'dunnett'
  | 'fdr_bh'

interface LmmTrajectoryRolesConfig {
  treatmentFactorId: string
  timeFactorId: string
  treatmentReferenceLevel?: string
}

interface LmmPlotFacetRolesConfig {
  /** Column ID of the strata factor used as the panel/facet dimension */
  facetBy?: string
  /** Column ID of the strata factor used as the color/trace dimension */
  colorBy?: string
  /** Column ID of the single strata factor used as the title dimension (excluded from facet/color) */
  titleBy?: string
}

interface LmmConfig {
  dependentColumnId: string
  subjectColumnId: string
  predictorColumnIds: string[]
  predictorTypes: Record<string, PredictorType>
  stratified?: boolean
  stratifyBy?: string[]
  reml?: boolean
  interactionDepth?: number
  dfMethod?: 'satterthwaite' | 'kenward_roger' | 'asymptotic' | 'residual'
  randomEffectsMode?: RandomEffectsMode
  randomSlopeTarget?: string
  adjustmentMethod?: PostHocAdjustmentMethod
  controlLevels?: Record<string, string>
  posthocQ?: number
  continuousEffectsConfig?: {
    mode: 'at_values'
    groupFactorId: string
    timeFactorId: string
    timeValues: number[]
  }
  trajectoryRoles?: LmmTrajectoryRolesConfig
  plotFacetRoles?: LmmPlotFacetRolesConfig
}

interface ResolvedContinuousEffectsConfig {
  mode: 'at_values'
  group_factor: string
  time_factor: string
  time_values: number[]
  time_transform?: 'center_scale'
}

function getColumnKey(column: ColumnClassification): string {
  return column.columnId || column.columnName
}

function buildRowIndexByKey(columns: ColumnClassification[]): Map<string, number> {
  const rowIndexByKey = new Map<string, number>()
  columns.forEach((column, index) => {
    if (column.columnId) {
      rowIndexByKey.set(column.columnId, index)
    }
    rowIndexByKey.set(column.columnName, index)
  })
  return rowIndexByKey
}

function getRowValue(row: any, key: string, rowIndexByKey: Map<string, number>): unknown {
  if (Array.isArray(row)) {
    const columnIndex = rowIndexByKey.get(key)
    return columnIndex === undefined ? undefined : row[columnIndex]
  }
  if (row && typeof row === 'object') {
    return row[key]
  }
  return undefined
}

function isNumericCandidate(column: ColumnClassification): boolean {
  return (
    column.dataType === ColumnDataType.Numeric ||
    column.dataType === ColumnDataType.Ordinal ||
    (column.dataType === ColumnDataType.Binary && column.numericRatio >= 1)
  )
}

function isIdentifierCandidate(column: ColumnClassification): boolean {
  return (
    column.dataType === ColumnDataType.Categorical ||
    column.dataType === ColumnDataType.Binary ||
    column.dataType === ColumnDataType.Numeric ||
    column.dataType === ColumnDataType.Ordinal
  )
}

function buildFactorLevelLabels(
  columnsById: Map<string, ColumnClassification>,
  predictorIds: string[],
  predictorTypes: Record<string, PredictorType>
): Record<string, string[]> {
  const labels: Record<string, string[]> = {}
  for (const predictorId of predictorIds) {
    if (predictorTypes[predictorId] !== 'categorical') continue
    const column = columnsById.get(predictorId)
    if (!column) continue
    const values = Array.isArray(column.uniqueValues) ? column.uniqueValues : []
    labels[column.columnName] = values.map(String)
  }
  return labels
}

function moveLevelToFront(levels: string[] | undefined, preferredLevel: string | undefined): string[] | undefined {
  if (!levels || !preferredLevel) return levels
  const index = levels.findIndex(level => level === preferredLevel)
  if (index <= 0) return levels
  return [levels[index]!, ...levels.slice(0, index), ...levels.slice(index + 1)]
}

function buildColumnsByKey(columns: ColumnClassification[]): Map<string, ColumnClassification> {
  const columnsByKey = new Map<string, ColumnClassification>()
  for (const column of columns) {
    if (column.columnId) {
      columnsByKey.set(column.columnId, column)
    }
    columnsByKey.set(column.columnName, column)
  }
  return columnsByKey
}

function resolveControlLevelKeys(
  rawControlLevels: Record<string, string> | undefined,
  columnsByKey: Map<string, ColumnClassification>
): Record<string, string> | undefined {
  if (!rawControlLevels || Object.keys(rawControlLevels).length === 0) {
    return undefined
  }

  const resolved = Object.fromEntries(
    Object.entries(rawControlLevels).map(([key, value]) => [
      columnsByKey.get(key)?.columnName ?? key,
      value,
    ])
  )

  return Object.keys(resolved).length > 0 ? resolved : undefined
}

function resolveContinuousEffectsConfig(
  rawConfig: LmmConfig['continuousEffectsConfig'] | undefined,
  columnsById: Map<string, ColumnClassification>
) {
  if (
    !rawConfig ||
    !rawConfig.groupFactorId ||
    !rawConfig.timeFactorId ||
    !Array.isArray(rawConfig.timeValues) ||
    rawConfig.timeValues.length === 0
  ) {
    return { config: undefined as undefined, error: undefined as string | undefined }
  }

  const groupColumn = columnsById.get(rawConfig.groupFactorId)
  const timeColumn = columnsById.get(rawConfig.timeFactorId)
  if (!groupColumn || !timeColumn) {
    return {
      config: undefined as undefined,
      error:
        'The selected numeric-time follow-up factors could not be resolved. Reopen the dialog and reselect the comparison/time factors.',
    }
  }

  return {
    config: {
      mode: rawConfig.mode,
      group_factor: groupColumn.columnName,
      time_factor: timeColumn.columnName,
      time_values: rawConfig.timeValues,
    } as ResolvedContinuousEffectsConfig,
    error: undefined as string | undefined,
  }
}

function resolveTrajectoryRoles(
  rawRoles: LmmTrajectoryRolesConfig | undefined,
  columnsById: Map<string, ColumnClassification>,
  warnings: string[],
): { treatment_factor: string; time_factor: string; reference_level?: string } | undefined {
  if (!rawRoles || !rawRoles.treatmentFactorId || !rawRoles.timeFactorId) return undefined
  const treatmentColumn = columnsById.get(rawRoles.treatmentFactorId)
  const timeColumn = columnsById.get(rawRoles.timeFactorId)
  if (!treatmentColumn || !timeColumn) {
    const msg = `[lmmAnovaModule] trajectory_roles dropped: column ID lookup failed (treatmentFactorId=${rawRoles.treatmentFactorId}, timeFactorId=${rawRoles.timeFactorId}).`
    console.warn(msg, {
      treatmentResolved: Boolean(treatmentColumn),
      timeResolved: Boolean(timeColumn),
    })
    warnings.push(msg)
    return undefined
  }
  if (treatmentColumn.columnName === timeColumn.columnName) {
    const msg = `[lmmAnovaModule] trajectory_roles dropped: treatment_factor and time_factor resolve to the same column ('${treatmentColumn.columnName}').`
    console.warn(msg, { treatmentFactorId: rawRoles.treatmentFactorId, timeFactorId: rawRoles.timeFactorId })
    warnings.push(msg)
    return undefined
  }
  return {
    treatment_factor: treatmentColumn.columnName,
    time_factor: timeColumn.columnName,
    reference_level: rawRoles.treatmentReferenceLevel,
  }
}

function resolvePlotFacetRoles(
  rawRoles: LmmPlotFacetRolesConfig | undefined,
  columnsById: Map<string, ColumnClassification>,
  stratifyNames: Set<string>,
): { facet_by: string; color_by: string; title_only_factors?: string[] } | undefined {
  if (!rawRoles?.colorBy) return undefined
  const colorColumn = columnsById.get(rawRoles.colorBy)
  if (!colorColumn) return undefined
  // Stale colorBy: column exists in dataset but is no longer a strata factor.
  if (!stratifyNames.has(colorColumn.columnName)) return undefined
  // Stale facetBy (column removed from dataset): degrade gracefully — preserve colorBy,
  // emit facet_by as '' (canBuildCompoundTrajectory treats empty facet_by as "no facet assigned").
  const facetColumn = rawRoles.facetBy ? columnsById.get(rawRoles.facetBy) : undefined
  // Same-column conflict: both facetBy and colorBy resolved to the same column name.
  // Preserve colorBy but clear facetBy to '' — do not drop the entire config.
  const facetName = facetColumn?.columnName ?? ''
  const resolvedFacetName = (facetName && facetName !== colorColumn.columnName) ? facetName : ''
  // titleBy: resolve single title-only factor.
  // Drop and warn when stale, same as colorBy, or same as resolved facetBy (dual-role conflict).
  let titleOnlyFactors: string[] | undefined
  if (rawRoles.titleBy) {
    const titleColumn = columnsById.get(rawRoles.titleBy)
    if (titleColumn) {
      const titleName = titleColumn.columnName
      if (titleName === colorColumn.columnName) {
        // titleBy === colorBy: drop silently (already no warning needed — UI prevents it)
      } else if (resolvedFacetName && titleName === resolvedFacetName) {
        console.warn(
          `[lmmAnovaModule] titleBy '${titleName}' conflicts with facetBy '${resolvedFacetName}' — ` +
          `title_only_factors dropped to avoid dual-role payload.`
        )
      } else {
        titleOnlyFactors = [titleName]
      }
    }
  }
  return {
    facet_by: resolvedFacetName,
    color_by: colorColumn.columnName,
    ...(titleOnlyFactors ? { title_only_factors: titleOnlyFactors } : {}),
  }
}

export const lmmAnovaModule: ITestModule = {
  moduleId: 'lmm_anova',

  validateSelection(
    columns: ColumnClassification[],
    _options?: ValidateOptions
  ): TestValidationResult {
    if (columns.length < 3) {
      return {
        isValid: false,
        errors: [
          `Linear Mixed Model requires at least 3 columns. Selected: ${columns.length}.`,
        ],
        warnings: [],
        suggestions: [
          'Select at least 3 columns:',
          '  1. Outcome variable (numeric)',
          '  2. Sample / subject ID',
          '  3+. Predictor variables',
        ],
      }
    }

    const numericCandidates = columns.filter(isNumericCandidate)
    const identifierCandidates = columns.filter(isIdentifierCandidate)
    const warnings: string[] = []
    const suggestions: string[] = []

    if (numericCandidates.length === 0) {
      return {
        isValid: false,
        errors: ['Linear Mixed Model requires at least one numeric outcome candidate.'],
        warnings: [],
        suggestions: ['Select a numeric column to use as the outcome variable.'],
      }
    }

    if (identifierCandidates.length < 2) {
      return {
        isValid: false,
        errors: ['Linear Mixed Model requires a sample/subject column and at least one predictor.'],
        warnings: [],
        suggestions: ['Include one identifier column plus one or more predictors.'],
      }
    }

    suggestions.push(
      `Linear Mixed Model configuration: choose one numeric outcome, one sample ID column, and ${Math.max(columns.length - 2, 1)}+ predictor(s).`
    )

    const ordinalPredictors = columns.filter(
      column => column.dataType === ColumnDataType.Ordinal && !numericCandidates.includes(column)
    )
    if (ordinalPredictors.length > 0) {
      warnings.push(
        `Ordinal predictors detected (${ordinalPredictors.map(column => column.columnName).join(', ')}). Choose whether to analyze them as numeric or categorical in the LMM setup dialog.`
      )
    }

    return {
      isValid: true,
      errors: [],
      warnings,
      suggestions,
    }
  },

  buildPayload(
    columns: ColumnClassification[],
    _selectedColumnIndices: number[],
    rows: any[],
    parameters: Record<string, any>
  ): BuildPayloadResult {
    try {
      const config = parameters.lmm_config as LmmConfig | undefined
      if (!config) {
        return {
          success: false,
          error: 'LMM configuration is required before building the payload.',
        }
      }

      const columnsById = buildColumnsByKey(columns)
      const rowIndexByKey = buildRowIndexByKey(columns)

      const dependentColumn = columnsById.get(config.dependentColumnId)
      const subjectColumn = columnsById.get(config.subjectColumnId)
      if (!dependentColumn || !subjectColumn) {
        return {
          success: false,
          error: 'The selected outcome or sample ID column was not found.',
        }
      }

      if (!config.predictorColumnIds || config.predictorColumnIds.length === 0) {
        return {
          success: false,
          error: 'Select at least one predictor for Linear Mixed Model.',
        }
      }

      const formulaPredictorColumns = config.predictorColumnIds
        .map(id => columnsById.get(id))
        .filter((column): column is ColumnClassification => Boolean(column))

      if (formulaPredictorColumns.length !== config.predictorColumnIds.length) {
        return {
          success: false,
          error: 'One or more selected predictors could not be found.',
        }
      }

      const stratifyByIds = Array.isArray(config.stratifyBy) ? config.stratifyBy : []
      const stratifyColumns = config.stratified
        ? stratifyByIds
            .map(id => columnsById.get(id))
            .filter((column): column is ColumnClassification => Boolean(column))
        : []

      if (config.stratified && stratifyByIds.length === 0) {
        return {
          success: false,
          error: 'Stratified mode requires at least one stratification factor.',
        }
      }

      if (config.stratified && stratifyColumns.length !== stratifyByIds.length) {
        return {
          success: false,
          error: 'One or more selected stratification factors could not be found.',
        }
      }

      const invalidStratificationTypeColumns = stratifyColumns.filter((column) => {
        const key = getColumnKey(column)
        const roleType = config.predictorTypes[key]
        if (roleType) {
          return roleType !== 'categorical'
        }
        return !(
          column.dataType === ColumnDataType.Categorical ||
          column.dataType === ColumnDataType.Binary
        )
      })
      if (config.stratified && invalidStratificationTypeColumns.length > 0) {
        return {
          success: false,
          error: `Selected stratification factors must be categorical. Invalid: ${invalidStratificationTypeColumns
            .map(column => column.columnName)
            .join(', ')}.`,
        }
      }

      const predictorColumns = [...formulaPredictorColumns]
      const seenPredictorKeys = new Set(predictorColumns.map(getColumnKey))
      for (const stratifyColumn of stratifyColumns) {
        const stratifyKey = getColumnKey(stratifyColumn)
        if (!seenPredictorKeys.has(stratifyKey)) {
          predictorColumns.push(stratifyColumn)
          seenPredictorKeys.add(stratifyKey)
        }
      }

      const dependent: number[] = []
      const subject: string[] = []
      const predictors: Record<string, Array<string | number>> = {}
      const predictorTypes: Record<string, PredictorType> = {}

      const stratifyKeySet = new Set(stratifyByIds)
      for (const predictorColumn of predictorColumns) {
        const key = getColumnKey(predictorColumn)
        predictors[predictorColumn.columnName] = []
        predictorTypes[predictorColumn.columnName] = stratifyKeySet.has(key)
          ? 'categorical'
          : config.predictorTypes[key] ?? 'categorical'
      }

      for (const row of rows) {
        const dependentRaw = getRowValue(row, config.dependentColumnId, rowIndexByKey)
        const subjectRaw = getRowValue(row, config.subjectColumnId, rowIndexByKey)
        const dependentValue = Number(dependentRaw)

        if (!Number.isFinite(dependentValue) || subjectRaw == null || subjectRaw === '') {
          continue
        }

        const predictorValues: Array<string | number> = []
        let hasMissingPredictor = false
        for (const predictorColumn of predictorColumns) {
          const predictorKey = getColumnKey(predictorColumn)
          const predictorType = predictorTypes[predictorColumn.columnName] ?? 'categorical'
          const raw = getRowValue(row, predictorKey, rowIndexByKey)
          if (raw == null || raw === '') {
            hasMissingPredictor = true
            break
          }
          if (predictorType === 'continuous') {
            const numeric = Number(raw)
            if (!Number.isFinite(numeric)) {
              hasMissingPredictor = true
              break
            }
            predictorValues.push(numeric)
          } else {
            predictorValues.push(String(raw))
          }
        }

        if (hasMissingPredictor) continue

        dependent.push(dependentValue)
        subject.push(String(subjectRaw))
        predictorColumns.forEach((predictorColumn, index) => {
          predictors[predictorColumn.columnName]!.push(predictorValues[index]!)
        })
      }

      if (config.stratified) {
        const insufficientLevelStratificationColumns = stratifyColumns.filter((column) => {
          const values = predictors[column.columnName] ?? []
          const observedLevels = new Set<string>()
          for (const value of values) {
            if (value == null || value === '') continue
            observedLevels.add(String(value))
            if (observedLevels.size >= 2) {
              return false
            }
          }
          return true
        })
        if (insufficientLevelStratificationColumns.length > 0) {
          return {
            success: false,
            error: `Selected stratification factors must have at least two levels. Invalid: ${insufficientLevelStratificationColumns
              .map(column => column.columnName)
              .join(', ')}.`,
          }
        }
      }

      const factorLevelLabels = buildFactorLevelLabels(
        columnsById,
        predictorColumns.map(getColumnKey),
        Object.fromEntries(
          predictorColumns.map(column => [getColumnKey(column), predictorTypes[column.columnName] ?? 'categorical'])
        )
      )

      const stratifyBy = stratifyColumns.map((column) => column.columnName)

      const randomSlopeTargetId =
        config.randomEffectsMode === 'random_slope' ? config.randomSlopeTarget : undefined
      const randomSlopeTargetColumn = randomSlopeTargetId
        ? columnsById.get(randomSlopeTargetId)
        : undefined

      if (config.randomEffectsMode === 'random_slope' && !randomSlopeTargetColumn) {
        return {
          success: false,
          error: 'Random slope mode requires one numeric predictor target.',
        }
      }

      const resolvedAdjustmentMethod =
        parameters.posthoc_adjustment ?? config.adjustmentMethod ?? 'tukey'
      const resolvedControlLevels = resolveControlLevelKeys(
        parameters.control_levels ??
          (config.controlLevels && Object.keys(config.controlLevels).length > 0
            ? config.controlLevels
            : undefined),
        columnsById
      )
      const resolvedPosthocQ =
        resolvedAdjustmentMethod === 'fdr_bh'
          ? parameters.posthoc_q ??
            (config.adjustmentMethod === 'fdr_bh' ? config.posthocQ : undefined)
          : undefined
      const {
        config: continuousEffectsConfig,
        error: continuousEffectsError,
      } = resolveContinuousEffectsConfig(config.continuousEffectsConfig, columnsById)
      if (continuousEffectsError) {
        return {
          success: false,
          error: continuousEffectsError,
        }
      }
      if (config.randomEffectsMode === 'random_slope' && continuousEffectsConfig) {
        continuousEffectsConfig.time_transform = 'center_scale'
      }

      const payloadWarnings: string[] = []
      const trajectoryRoles = resolveTrajectoryRoles(config.trajectoryRoles, columnsById, payloadWarnings)
      if (trajectoryRoles?.reference_level) {
        const reorderedLevels = moveLevelToFront(
          factorLevelLabels[trajectoryRoles.treatment_factor],
          trajectoryRoles.reference_level,
        )
        if (reorderedLevels) {
          factorLevelLabels[trajectoryRoles.treatment_factor] = reorderedLevels
        }
      }
      const stratifyNameSet = new Set(stratifyBy)
      const plotFacetRoles = resolvePlotFacetRoles(config.plotFacetRoles, columnsById, stratifyNameSet)

      return {
        success: true,
        ...(payloadWarnings.length > 0 ? { warnings: payloadWarnings } : {}),
        payload: {
          test: 'lmm_anova',
          data: {
            dependent,
            subject,
            predictors,
            predictor_types: predictorTypes,
            factor_level_labels: factorLevelLabels,
            dependent_name: dependentColumn.columnName,
            value_column: dependentColumn.columnName,
          },
          parameters: {
            alpha: parameters.alpha ?? 0.05,
            reml: Boolean(config.reml ?? parameters.reml ?? false),
            interaction_depth: config.interactionDepth ?? parameters.interaction_depth ?? 2,
            df_method: config.dfMethod ?? parameters.df_method ?? 'satterthwaite',
            random_effects_config: {
              group_var: subjectColumn.columnName,
              group_values: subject,
              random_intercept: true,
              random_slopes:
                config.randomEffectsMode === 'random_slope' && randomSlopeTargetColumn
                  ? [randomSlopeTargetColumn.columnName]
                  : [],
            },
            simple_effects: parameters.simple_effects,
            posthoc_adjustment: resolvedAdjustmentMethod,
            control_levels: resolvedControlLevels,
            posthoc_q: resolvedPosthocQ,
            stratify_by: config.stratified ? stratifyBy : undefined,
            continuous_effects_config: continuousEffectsConfig,
            trajectory_roles: trajectoryRoles,
            plot_facet_roles: plotFacetRoles,
          },
        },
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  },

  defaultParameters(): Record<string, any> {
    return {
      alpha: 0.05,
      reml: false,
      interaction_depth: 2,
      df_method: 'satterthwaite',
    }
  },
}
