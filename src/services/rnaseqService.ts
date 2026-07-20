import { invoke } from '@tauri-apps/api/core'
import { confirm } from '@tauri-apps/plugin-dialog'
import type { Dataset } from '@/store/data-store'
import tauriApi from '@/services/tauriApi'
import cacheService from '@/services/cacheService'
import type {
  DESeqModel,
  DESeqResult,
  DESeqParameters,
  DESeqSummary,
  DEGeneResult,
  PCAResult,
  HeatmapImageResult,
  SampleMatchResult,
  SampleIdValidationSummary,
  PCAGeneSelectionMode,
  GeneLabelSource,
  DuplicateGeneLabelPolicy,
} from '@/types/rnaseq'

const DEFAULT_CHUNK_SIZE = 2000
const LOAD_TIMEOUT_MS = 2 * 60 * 1000
const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000
const ARROW_CELL_THRESHOLD = 2_000_000
const MAX_INLINE_CELLS = 10_000_000
const DEFAULT_GENE_LABEL_SOURCE: GeneLabelSource = 'id_lookup'
const DEFAULT_DUPLICATE_POLICY: DuplicateGeneLabelPolicy = 'sum_duplicates'

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`))
    }, ms)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

const coerceNumber = (value: unknown): number => {
  if (value == null || value === '') return 0
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

const coerceMetadataValue = (value: unknown): string | number => {
  if (value == null || value === '') return ''
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

const getRowValue = (row: Record<string, unknown>, id: string, fallbackName: string): unknown => {
  if (Object.prototype.hasOwnProperty.call(row, id)) return row[id]
  return row[fallbackName]
}

const hasStructuralValue = (value: unknown): boolean => {
  if (value == null) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

const loadAllRows = async (
  dataset: Dataset,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<Record<string, unknown>[]> => {
  const totalRows = dataset.dataRowCount ?? dataset.rowCount
  const rows: Record<string, unknown>[] = []

  for (let start = 0; start < totalRows; start += chunkSize) {
    const end = Math.min(start + chunkSize, totalRows)
    const chunk = await tauriApi.getRows(dataset.id, start, end)
    rows.push(...chunk)
  }

  return rows
}

const buildCountsPayload = (
  dataset: Dataset,
  rows: Record<string, unknown>[],
  options?: {
    duplicatePolicy?: DuplicateGeneLabelPolicy
    geneLabelSource?: GeneLabelSource
  }
): {
  counts: Record<string, Record<string, number>>
  warnings: string[]
  missingLabelRows: number
  usableLabelRows: number
  usableSampleColumnCount: number
  droppedStructurallyEmptySampleColumns: number
} => {
  const geneColumn = dataset.columns[0]
  const sampleColumns = dataset.columns.slice(1)
  const counts: Record<string, Record<string, number>> = {}
  const duplicatePolicy = options?.duplicatePolicy ?? DEFAULT_DUPLICATE_POLICY
  const geneLabelSource = options?.geneLabelSource ?? DEFAULT_GENE_LABEL_SOURCE
  const duplicateHits = new Map<string, number>()
  let missingLabelRows = 0
  let usableLabelRows = 0

  if (!geneColumn) {
    return {
      counts,
      warnings: [],
      missingLabelRows,
      usableLabelRows,
      usableSampleColumnCount: 0,
      droppedStructurallyEmptySampleColumns: 0,
    }
  }

  const sampleColumnsWithData = new Set<string>()
  if (sampleColumns.length > 0) {
    for (const row of rows) {
      const geneIdRaw = getRowValue(row, geneColumn.id, geneColumn.name)
      if (geneIdRaw == null || geneIdRaw === '') continue
      const geneId = String(geneIdRaw).trim()
      if (!geneId) continue
      for (const col of sampleColumns) {
        if (sampleColumnsWithData.has(col.id)) continue
        const rawValue = getRowValue(row, col.id, col.name)
        if (hasStructuralValue(rawValue)) {
          sampleColumnsWithData.add(col.id)
        }
      }
      if (sampleColumnsWithData.size === sampleColumns.length) {
        break
      }
    }
  }

  const activeSampleColumns = sampleColumns.filter((col) => sampleColumnsWithData.has(col.id))
  const droppedStructurallyEmptySampleColumns = sampleColumns.length - activeSampleColumns.length
  const structuralWarnings: string[] =
    droppedStructurallyEmptySampleColumns > 0
      ? [
          `Dropped ${droppedStructurallyEmptySampleColumns} structurally empty sample column(s) before sample matching.`,
        ]
      : []

  if (activeSampleColumns.length === 0) {
    return {
      counts,
      warnings: [
        ...structuralWarnings,
        'No usable count sample columns found after removing structurally empty columns.',
      ],
      missingLabelRows,
      usableLabelRows,
      usableSampleColumnCount: 0,
      droppedStructurallyEmptySampleColumns,
    }
  }

  for (const row of rows) {
    const geneIdRaw = getRowValue(row, geneColumn.id, geneColumn.name)
    if (geneIdRaw == null || geneIdRaw === '') {
      missingLabelRows += 1
      continue
    }
    const geneId = String(geneIdRaw).trim()
    if (!geneId) {
      missingLabelRows += 1
      continue
    }
    usableLabelRows += 1

    let sampleValues = counts[geneId]
    if (!sampleValues) {
      sampleValues = {}
      counts[geneId] = sampleValues
    } else {
      duplicateHits.set(geneId, (duplicateHits.get(geneId) ?? 0) + 1)
      if (duplicatePolicy === 'keep_first') {
        continue
      }
    }
    for (const col of activeSampleColumns) {
      const rawValue = getRowValue(row, col.id, col.name)
      const value = coerceNumber(rawValue)
      if (duplicatePolicy === 'keep_first') {
        sampleValues[col.name] = value
      } else {
        sampleValues[col.name] = (sampleValues[col.name] ?? 0) + value
      }
    }
  }

  if (geneLabelSource === 'user_provided' && duplicateHits.size > 0) {
    const duplicateRowCount = Array.from(duplicateHits.values()).reduce((sum, n) => sum + n, 0)
    const duplicateExamples = Array.from(duplicateHits.keys()).slice(0, 5).join(', ')
    const warnings: string[] = [
      ...structuralWarnings,
      `Detected ${duplicateHits.size} duplicate user-provided gene label(s) ` +
      `(${duplicateRowCount} duplicate row(s)). Applied duplicate policy: ${duplicatePolicy}. ` +
      `Examples: ${duplicateExamples}.`,
    ]
    if (missingLabelRows > 0) {
      const total = missingLabelRows + usableLabelRows
      const pct = total > 0 ? (missingLabelRows / total) * 100 : 0
      warnings.push(
        `Dropped ${missingLabelRows} row(s) with empty gene labels before analysis ` +
        `(${pct.toFixed(2)}% of label rows; ${usableLabelRows} usable row(s) remain).`
      )
    }
    return {
      counts,
      warnings,
      missingLabelRows,
      usableLabelRows,
      usableSampleColumnCount: activeSampleColumns.length,
      droppedStructurallyEmptySampleColumns,
    }
  }

  if (missingLabelRows > 0) {
    const total = missingLabelRows + usableLabelRows
    const pct = total > 0 ? (missingLabelRows / total) * 100 : 0
    return {
      counts,
      warnings: [
        ...structuralWarnings,
        `Dropped ${missingLabelRows} row(s) with empty gene labels before analysis ` +
        `(${pct.toFixed(2)}% of label rows; ${usableLabelRows} usable row(s) remain).`,
      ],
      missingLabelRows,
      usableLabelRows,
      usableSampleColumnCount: activeSampleColumns.length,
      droppedStructurallyEmptySampleColumns,
    }
  }

  return {
    counts,
    warnings: structuralWarnings,
    missingLabelRows,
    usableLabelRows,
    usableSampleColumnCount: activeSampleColumns.length,
    droppedStructurallyEmptySampleColumns,
  }
}

const buildMetadataPayload = (dataset: Dataset, rows: Record<string, unknown>[]) => {
  const sampleIdColumn = dataset.columns[0]
  const factorColumns = dataset.columns.slice(1)
  const metadata: Record<string, Record<string, string | number>> = {}

  if (!sampleIdColumn) return metadata

  for (const row of rows) {
    const sampleIdRaw = getRowValue(row, sampleIdColumn.id, sampleIdColumn.name)
    if (sampleIdRaw == null || sampleIdRaw === '') continue
    const sampleId = String(sampleIdRaw)

    const factors: Record<string, string | number> = {}
    for (const col of factorColumns) {
      const rawValue = getRowValue(row, col.id, col.name)
      const coerced = coerceMetadataValue(rawValue)
      if (coerced !== '') {
        factors[col.name] = coerced
      }
    }

    metadata[sampleId] = factors
  }

  return metadata
}

const getDatasetCellCount = (dataset: Dataset): number => {
  const rowCount = dataset.dataRowCount ?? dataset.rowCount ?? 0
  const valueColumns = Math.max(0, dataset.columns.length - 1)
  return rowCount * valueColumns
}

const buildArrowPayload = async (
  countsDataset: Dataset,
  metadataDataset: Dataset
): Promise<Record<string, unknown>> => {
  const [countsArrowPath, metadataArrowPath] = await Promise.all([
    cacheService.flushToArrow(countsDataset.id),
    cacheService.flushToArrow(metadataDataset.id),
  ])

  return {
    counts_arrow_path: countsArrowPath,
    metadata_arrow_path: metadataArrowPath,
    counts_columns: countsDataset.columns.map(({ id, name }) => ({ id, name })),
    metadata_columns: metadataDataset.columns.map(({ id, name }) => ({ id, name })),
  }
}


const mapGenes = (rawGenes: unknown): DEGeneResult[] => {
  if (!Array.isArray(rawGenes)) return []

  return rawGenes.map((gene) => {
    const record = gene as Record<string, unknown>
    const geneId = String(record.gene_id ?? record.geneId ?? '')
    const geneSymbol = String(record.gene_symbol ?? record.geneSymbol ?? geneId)

    return {
      geneId,
      geneSymbol,
      baseMean: typeof record.base_mean === 'number'
        ? record.base_mean
        : typeof record.baseMean === 'number'
          ? record.baseMean
          : null,
      log2FoldChange: typeof record.log2_fold_change === 'number'
        ? record.log2_fold_change
        : typeof record.log2FoldChange === 'number'
          ? record.log2FoldChange
          : null,
      lfcSE: typeof record.lfc_se === 'number'
        ? record.lfc_se
        : typeof record.lfcSE === 'number'
          ? record.lfcSE
          : null,
      stat: typeof record.stat === 'number' ? record.stat : null,
      pvalue: typeof record.pvalue === 'number' ? record.pvalue : null,
      padj: typeof record.padj === 'number' ? record.padj : null,
      significant: Boolean(record.significant),
      direction: (record.direction as DEGeneResult['direction']) ?? 'ns',
      sigCategory: (record.sig_category ?? record.sigCategory ?? 'ns') as DEGeneResult['sigCategory'],
    }
  })
}

const mapSummary = (rawSummary: unknown): DESeqSummary => {
  const record = (rawSummary ?? {}) as Record<string, unknown>

  return {
    totalGenes: Number(record.total_genes ?? record.totalGenes ?? 0),
    testedGenes: Number(record.tested_genes ?? record.testedGenes ?? 0),
    significantP05: Number(record.significant_p05 ?? record.significantP05 ?? 0),
    significantP01: Number(record.significant_p01 ?? record.significantP01 ?? 0),
    significantP001: Number(record.significant_p001 ?? record.significantP001 ?? 0),
    significantPadj05: Number(record.significant_padj05 ?? record.significantPadj05 ?? 0),
    upregulated: Number(record.upregulated ?? 0),
    downregulated: Number(record.downregulated ?? 0),
    significanceMethod: (record.significance_method ?? record.significanceMethod ?? 'padj') as DESeqSummary['significanceMethod'],
    alpha: Number(record.alpha ?? 0.05),
  }
}

const dedupeWarnings = (warnings: unknown[]): string[] => {
  const shouldSuppressWarning = (warning: string): boolean =>
    /^Dropped \d+ structurally empty sample column\(s\) before sample matching\.$/.test(warning)

  const output: string[] = []
  const seen = new Set<string>()
  for (const warning of warnings) {
    if (typeof warning !== 'string') continue
    const normalized = warning.trim()
    if (shouldSuppressWarning(normalized)) continue
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    output.push(normalized)
  }
  return output
}

const mapParameters = (rawParams: unknown, model: DESeqModel): DESeqParameters => {
  const record = (rawParams ?? {}) as Record<string, unknown>
  const pcaGeneSelectionMode =
    (record.pca_gene_selection_mode ??
      record.pcaGeneSelectionMode ??
      model.pcaGeneSelectionMode ??
      'significant_only') as PCAGeneSelectionMode

  return {
    organism: (record.organism ?? model.organism ?? 'mmusculus') as DESeqParameters['organism'],
    geneIdType: (record.gene_id_type ?? record.geneIdType ?? model.geneIdType ?? 'ensembl') as DESeqParameters['geneIdType'],
    geneLabelSource: (record.gene_label_source ??
      record.geneLabelSource ??
      model.geneLabelSource ??
      DEFAULT_GENE_LABEL_SOURCE) as DESeqParameters['geneLabelSource'],
    duplicatePolicy: (record.duplicate_policy ??
      record.duplicatePolicy ??
      DEFAULT_DUPLICATE_POLICY) as DESeqParameters['duplicatePolicy'],
    duplicateCount: Number(record.duplicate_count ?? record.duplicateCount ?? 0),
    roundCounts: Boolean(record.round_counts ?? record.roundCounts ?? false),
    roundingMethod: (record.rounding_method ?? record.roundingMethod ?? null) as DESeqParameters['roundingMethod'],
    nonIntegerSamplesDetected: Number(
      record.non_integer_samples_detected ?? record.nonIntegerSamplesDetected ?? 0
    ),
    nonIntegerCellsDetected: Number(
      record.non_integer_cells_detected ?? record.nonIntegerCellsDetected ?? 0
    ),
    missingLabelRows: Number(record.missing_label_rows ?? record.missingLabelRows ?? 0),
    usableLabelRows: Number(record.usable_label_rows ?? record.usableLabelRows ?? 0),
    missingLabelPct: Number(record.missing_label_pct ?? record.missingLabelPct ?? 0),
    alpha: Number(record.alpha ?? model.alpha),
    minCount: Number(record.min_count ?? record.minCount ?? model.minCount),
    minSamples: Number(record.min_samples ?? record.minSamples ?? model.minSamples),
    applyShrinkage: Boolean(record.apply_shrinkage ?? record.applyShrinkage ?? model.applyShrinkage),
    shrinkageMethod: (record.shrinkage_method ?? record.shrinkageMethod ?? model.shrinkageMethod ?? null) as DESeqParameters['shrinkageMethod'],
    usePadjForSignificance: Boolean(
      record.use_padj_for_significance ?? record.usePadjForSignificance ?? model.usePadjForSignificance
    ),
    subsetFilters: (record.subset_filters ?? record.subsetFilters ?? model.subsetFilters ?? null) as DESeqParameters['subsetFilters'],
    pcaTopGenes: Number(record.pca_top_genes ?? record.pcaTopGenes ?? model.pcaTopGenes ?? 500),
    pcaGeneSelectionMode,
    useNullModel: Boolean(record.use_null_model ?? record.useNullModel ?? model.useNullModel),
    vstTransform: (record.vst_transform ?? record.vstTransform ?? null) as DESeqParameters['vstTransform'],
  }
}

const mapPca = (rawPca: unknown): PCAResult | undefined => {
  if (!rawPca || typeof rawPca !== 'object') return undefined
  const record = rawPca as Record<string, unknown>
  const rawGeneSelection = (record.gene_selection ?? record.geneSelection) as Record<string, unknown> | undefined
  const mode = String(rawGeneSelection?.mode ?? '').trim().toLowerCase()
  const geneSelectionMode = (
    mode === 'significant_only' || mode === 'variable_only' || mode === 'significant_then_variable'
      ? mode
      : 'significant_only'
  ) as PCAGeneSelectionMode
  const effectiveModeRaw = String(
    rawGeneSelection?.effective_mode ?? rawGeneSelection?.effectiveMode ?? mode
  )
    .trim()
    .toLowerCase()
  const effectiveGeneSelectionMode = (
    effectiveModeRaw === 'significant_only' ||
    effectiveModeRaw === 'variable_only' ||
    effectiveModeRaw === 'significant_then_variable'
      ? effectiveModeRaw
      : geneSelectionMode
  ) as PCAGeneSelectionMode

  return {
    samples: Array.isArray(record.samples) ? (record.samples as PCAResult['samples']) : [],
    loadings: Array.isArray(record.loadings) ? (record.loadings as PCAResult['loadings']) : [],
    varianceExplained: Array.isArray(record.variance_explained)
      ? (record.variance_explained as number[])
      : Array.isArray(record.varianceExplained)
        ? (record.varianceExplained as number[])
        : [],
    genesUsed: Number(record.genes_used ?? record.genesUsed ?? 0),
    geneSelection: rawGeneSelection
      ? {
          mode: geneSelectionMode,
          effectiveMode: effectiveGeneSelectionMode,
          significantUsed: Number(
            rawGeneSelection.significant_used ?? rawGeneSelection.significantUsed ?? 0
          ),
          paddedWithVariance: Boolean(
            rawGeneSelection.padded_with_variance ?? rawGeneSelection.paddedWithVariance ?? false
          ),
          fallbackToVarianceWhenEmpty: Boolean(
            rawGeneSelection.fallback_to_variance_when_empty ??
            rawGeneSelection.fallbackToVarianceWhenEmpty ??
            false
          ),
          targetTopGenes: Number(
            rawGeneSelection.target_top_genes ?? rawGeneSelection.targetTopGenes ?? 0
          ),
          autoSwitchedToSignificantThenVariable: Boolean(
            rawGeneSelection.auto_switched_to_significant_then_variable ??
            rawGeneSelection.autoSwitchedToSignificantThenVariable ??
            false
          ),
          significantOnlyMinGenes: Number(
            rawGeneSelection.significant_only_min_genes ??
            rawGeneSelection.significantOnlyMinGenes ??
            0
          ),
        }
      : undefined,
    ellipse_metrics: (record.ellipse_metrics ?? record.ellipseMetrics) as PCAResult['ellipse_metrics'] | undefined,
  }
}

export const rnaseqService = {
  async runDESeq2Analysis(
    countsDataset: Dataset,
    metadataDataset: Dataset,
    model: DESeqModel,
    options?: {
      organism?: 'mmusculus' | 'hsapiens'
      computePca?: boolean
      computeVst?: boolean
      annotateGenes?: boolean
      duplicatePolicy?: DuplicateGeneLabelPolicy
      duplicateCount?: number
      roundCounts?: boolean
    }
  ): Promise<DESeqResult> {
    await Promise.all([
      cacheService.ensureLatestCache(countsDataset.id),
      cacheService.ensureLatestCache(metadataDataset.id),
    ])

    const countsCellCount = getDatasetCellCount(countsDataset)
    const metadataCellCount = getDatasetCellCount(metadataDataset)
    const useColumnar = countsCellCount >= ARROW_CELL_THRESHOLD || metadataCellCount >= ARROW_CELL_THRESHOLD
    const geneLabelSource = model.geneLabelSource ?? DEFAULT_GENE_LABEL_SOURCE
    const duplicatePolicy = options?.duplicatePolicy ?? DEFAULT_DUPLICATE_POLICY
    let roundCounts = Boolean(options?.roundCounts)

    let dataPayload: Record<string, unknown>
    let countWarnings: string[] = []
    let missingLabelRowsHint = 0
    let usableLabelRowsHint = 0

    if (useColumnar) {
      try {
        dataPayload = await withTimeout(
          buildArrowPayload(countsDataset, metadataDataset),
          LOAD_TIMEOUT_MS,
          'Preparing RNA-seq data'
        )
      } catch (error) {
        if (countsCellCount > MAX_INLINE_CELLS) {
          throw new Error(
            'RNA-seq analysis requires a columnar export for large datasets. ' +
            'Please retry or re-import the counts table.'
          )
        }
        console.warn('RNA-seq columnar export failed; falling back to in-memory payload.', error)
        const [safeCountRows, safeMetadataRows] = await withTimeout(
          Promise.all([loadAllRows(countsDataset), loadAllRows(metadataDataset)]),
          LOAD_TIMEOUT_MS,
          'Loading RNA-seq data'
        )

        const {
          counts,
          warnings: fallbackWarnings,
          missingLabelRows,
          usableLabelRows,
          usableSampleColumnCount,
        } = buildCountsPayload(
          countsDataset,
          safeCountRows,
          {
            duplicatePolicy,
            geneLabelSource,
          }
        )
        if (usableSampleColumnCount === 0) {
          throw new Error(
            'No usable count sample columns found after removing structurally empty columns.'
          )
        }
        const metadata = buildMetadataPayload(metadataDataset, safeMetadataRows)
        dataPayload = { counts, metadata }
        countWarnings = fallbackWarnings
        missingLabelRowsHint = missingLabelRows
        usableLabelRowsHint = usableLabelRows
      }
    } else {
      const [safeCountRows, safeMetadataRows] = await withTimeout(
        Promise.all([loadAllRows(countsDataset), loadAllRows(metadataDataset)]),
        LOAD_TIMEOUT_MS,
        'Loading RNA-seq data'
      )

      const {
        counts,
        warnings: fallbackWarnings,
        missingLabelRows,
        usableLabelRows,
        usableSampleColumnCount,
      } = buildCountsPayload(
        countsDataset,
        safeCountRows,
        {
          duplicatePolicy,
          geneLabelSource,
        }
      )
      if (usableSampleColumnCount === 0) {
        throw new Error(
          'No usable count sample columns found after removing structurally empty columns.'
        )
      }
      const metadata = buildMetadataPayload(metadataDataset, safeMetadataRows)
      dataPayload = { counts, metadata }
      countWarnings = fallbackWarnings
      missingLabelRowsHint = missingLabelRows
      usableLabelRowsHint = usableLabelRows
    }

    const hasPrimaryInteraction = Boolean(
      model.interactionFactor &&
        model.interactionFactorReference &&
        model.interactionFactorTest
    )
    const hasSecondaryInteraction = Boolean(
      model.interactionFactor2 &&
        model.interactionFactor2Reference &&
        model.interactionFactor2Test
    )
    const normalizedFormula = (model.designFormula ?? '').replace(/\s+/g, '')
    const useNullModel = Boolean(model.useNullModel || normalizedFormula === '~1')
    const useInteractionContrast = Boolean(
      !useNullModel &&
        model.contrastType === 'interaction' &&
        hasPrimaryInteraction &&
        model.mainFactorReference &&
        model.mainFactorTest &&
        (!model.interactionFactor2 || hasSecondaryInteraction)
    )

    const pcaGroupBy = useNullModel
      ? (model.pcaGroupBy || null)
      : (model.pcaGroupBy || model.mainFactor || null)

    const effectiveCovariates =
      model.includeCovariates === false ? [] : (model.covariates ?? [])
    const annotateGenes = geneLabelSource === 'user_provided'
      ? false
      : (options?.annotateGenes ?? true)

    const covariateReferenceLevels = effectiveCovariates
      .filter(
        (cov) => cov.referenceLevel && cov.kind !== 'numeric'
      )
      .reduce<Record<string, string>>((acc, cov) => {
        acc[cov.column] = cov.referenceLevel as string
        return acc
      }, {})

    const parameters = {
      design_formula: useNullModel ? '~1' : model.designFormula,
      pca_group_by: pcaGroupBy,
      contrast: useNullModel
        ? null
        : useInteractionContrast
          ? null
          : [model.mainFactor, model.mainFactorTest, model.mainFactorReference],
      interaction_contrast:
        !useNullModel && useInteractionContrast && model.interactionFactor
          ? {
              factor_a: model.mainFactor,
              test_a: model.mainFactorTest,
              reference_a: model.mainFactorReference,
              factor_b: model.interactionFactor,
              test_b: model.interactionFactorTest ?? '',
              reference_b: model.interactionFactorReference ?? '',
              ...(hasSecondaryInteraction && model.interactionFactor2
                ? {
                    factor_c: model.interactionFactor2,
                    test_c: model.interactionFactor2Test ?? '',
                    reference_c: model.interactionFactor2Reference ?? '',
                  }
                : {}),
            }
          : null,
      factor_reference_levels: useNullModel
        ? {}
        : {
            ...(model.mainFactorReference
              ? { [model.mainFactor]: model.mainFactorReference }
              : {}),
            ...(model.interactionFactor && model.interactionFactorReference
              ? { [model.interactionFactor]: model.interactionFactorReference }
              : {}),
            ...(model.interactionFactor2 && model.interactionFactor2Reference
              ? { [model.interactionFactor2]: model.interactionFactor2Reference }
              : {}),
            ...covariateReferenceLevels,
          },
      subset_filters: model.subsetFilters ?? null,
      covariates: useNullModel ? [] : effectiveCovariates,
      options: {
        apply_shrinkage: model.applyShrinkage,
        shrinkage_method: 'apeglm',
        fit_type: 'parametric',
        size_factors_fit_type: 'ratio',
        refit_cooks: true,
        min_replicates: 7,
        cooks_filter: true,
        independent_filter: true,
        alpha: model.alpha,
        min_count: model.minCount,
        min_samples: model.minSamples,
        use_padj_for_significance: model.usePadjForSignificance,
        compute_pca: options?.computePca ?? true,
        compute_vst: options?.computeVst ?? true,
        annotate_genes: annotateGenes,
        organism: options?.organism ?? model.organism ?? 'mmusculus',
        gene_id_type: model.geneIdType ?? 'ensembl',
        gene_label_source: geneLabelSource,
        duplicate_policy: duplicatePolicy,
        duplicate_count_hint: Number(options?.duplicateCount ?? 0),
        missing_label_rows_hint: missingLabelRowsHint,
        usable_label_rows_hint: usableLabelRowsHint,
        max_missing_label_pct: 5,
        pca_top_genes: model.pcaTopGenes ?? 500,
        pca_gene_selection_mode: useNullModel
          ? 'variable_only'
          : (model.pcaGeneSelectionMode ?? 'significant_only'),
        quiet: true,
        confirm_warnings: false,
        round_counts: roundCounts,
        annotation_refresh: 'auto',
        annotation_refresh_days: 30,
        annotation_allow_online: false,
      },
    }

    const invokeAnalysis = async (
      confirmWarnings: boolean,
      annotationRefresh: 'auto' | 'force' | 'skip',
      roundCountsFlag: boolean
    ) =>
      invoke<Record<string, unknown>>('run_rnaseq_analysis', {
        testName: 'rnaseq_deseq2',
        data: dataPayload,
        parameters: {
          ...parameters,
          options: {
            ...parameters.options,
            confirm_warnings: confirmWarnings,
            annotation_refresh: annotationRefresh,
            round_counts: roundCountsFlag,
          },
        },
        arrowDataPath: null,
      })

    let annotationRefreshMode: 'auto' | 'force' | 'skip' = 'auto'
    const handleGeneSymbolPrompt = async (
      result: Record<string, unknown>,
      confirmWarnings: boolean,
      roundCountsFlag: boolean
    ) => {
      if (geneLabelSource === 'user_provided') {
        return result
      }

      const confirmationType = String(
        result.confirmation_type ?? result.confirmationType ?? ''
      )
      if (confirmationType !== 'gene_symbol_refresh') {
        return result
      }

      annotationRefreshMode = 'skip'
      return withTimeout(
        invokeAnalysis(confirmWarnings, annotationRefreshMode, roundCountsFlag),
        ANALYSIS_TIMEOUT_MS,
        'RNA-seq analysis'
      )
    }

    let rawResult = await withTimeout(
      invokeAnalysis(false, annotationRefreshMode, roundCounts),
      ANALYSIS_TIMEOUT_MS,
      'RNA-seq analysis'
    )
    rawResult = await handleGeneSymbolPrompt(rawResult, false, roundCounts)
    let warningList = Array.isArray(rawResult.warnings) ? rawResult.warnings as string[] : []
    let mergedWarnings = dedupeWarnings([...countWarnings, ...warningList])

    let confirmationAttempts = 0
    while (Boolean(rawResult.requires_confirmation ?? rawResult.requiresConfirmation)) {
      confirmationAttempts += 1
      if (confirmationAttempts > 3) {
        throw new Error('RNA-seq analysis requires too many confirmation retries')
      }

      const confirmationType = String(rawResult.confirmation_type ?? rawResult.confirmationType ?? '')
      if (confirmationType === 'non_integer_counts') {
        const sampleCount = Number(
          rawResult.non_integer_samples_detected ?? rawResult.nonIntegerSamplesDetected ?? 0
        )
        const cellCount = Number(
          rawResult.non_integer_cells_detected ?? rawResult.nonIntegerCellsDetected ?? 0
        )
        const sampleExamples = Array.isArray(rawResult.non_integer_sample_examples)
          ? (rawResult.non_integer_sample_examples as unknown[])
              .filter((value): value is string => typeof value === 'string')
              .slice(0, 5)
          : []
        const sampleLine = sampleCount > 0
          ? `${sampleCount} sample(s) contain non-integer estimated counts.`
          : 'Non-integer estimated counts were detected.'
        const cellsLine = cellCount > 0
          ? `Detected ${cellCount} non-integer cell value(s).`
          : ''
        const examplesLine = sampleExamples.length > 0
          ? `Examples: ${sampleExamples.join(', ')}.`
          : ''

        const proceed = await confirm(
          `${sampleLine}\n${cellsLine ? `${cellsLine}\n` : ''}${examplesLine ? `${examplesLine}\n` : ''}\n` +
            `OK: Round estimated counts and continue.\n` +
            `Cancel: Stop analysis and re-import raw integer counts.`,
          { title: 'RNA-seq Counts Warning', kind: 'warning' }
        )
        if (!proceed) {
          throw new Error('RNA-seq analysis cancelled by user')
        }
        roundCounts = true
      } else {
        if (mergedWarnings.length === 0) {
          throw new Error('RNA-seq analysis requires confirmation but no warning details were provided')
        }
        const warningText = mergedWarnings
          .slice(0, 5)
          .map((warning) => `- ${warning}`)
          .join('\n')
        const proceed = await confirm(
          `Warnings detected:\n${warningText}\n\nContinue anyway?`,
          { title: 'RNA-seq Warnings', kind: 'warning' }
        )
        if (!proceed) {
          throw new Error('RNA-seq analysis cancelled by user')
        }
      }

      rawResult = await withTimeout(
        invokeAnalysis(true, annotationRefreshMode, roundCounts),
        ANALYSIS_TIMEOUT_MS,
        'RNA-seq analysis'
      )
      rawResult = await handleGeneSymbolPrompt(rawResult, true, roundCounts)
      warningList = Array.isArray(rawResult.warnings) ? rawResult.warnings as string[] : []
      mergedWarnings = dedupeWarnings([...countWarnings, ...warningList])
    }
    if (rawResult.success === false) {
      const rawError = rawResult.error
      let message = 'RNA-seq analysis failed'
      if (typeof rawError === 'string' && rawError.trim()) {
        message = rawError
      } else if (rawError && typeof rawError === 'object') {
        const structured = rawError as Record<string, unknown>
        const structuredMessage = structured.message
        if (typeof structuredMessage === 'string' && structuredMessage.trim()) {
          message = structuredMessage
        }
        throw structured
      }
      throw new Error(message)
    }

    const genes = mapGenes(rawResult.genes)
    const summary = mapSummary(rawResult.summary)
    const sizeFactors = (rawResult.size_factors ?? rawResult.sizeFactors ?? {}) as Record<string, number>
    const dispersions = (rawResult.dispersions ?? {}) as Record<string, number>
    const pcaData = mapPca(rawResult.pca_data ?? rawResult.pcaData)
    const normalizedCounts = (rawResult.normalized_counts ?? rawResult.normalizedCounts) as number[][] | undefined
    const sampleIds = (rawResult.sample_ids ?? rawResult.sampleIds) as string[] | undefined
    const mappedParameters = mapParameters(rawResult.parameters, model)
    const warnings = mergedWarnings.length > 0 ? mergedWarnings : undefined
    const ensemblVersion = (rawResult.ensembl_version ?? rawResult.ensemblVersion ?? null) as string | null
    const ensemblVersionSource = (rawResult.ensembl_version_source ??
      rawResult.ensemblVersionSource ??
      null) as 'cache' | 'online' | null
    const geneIdType = (rawResult.gene_id_type ?? rawResult.geneIdType ?? 'ensembl') as
      | 'ensembl'
      | 'entrez'
      | 'uniprot'
      | 'uniprot_swissprot'
    const mappedGeneLabelSource = (rawResult.gene_label_source ??
      rawResult.geneLabelSource ??
      geneLabelSource) as GeneLabelSource
    const mappedDuplicatePolicy = (rawResult.duplicate_policy ??
      rawResult.duplicatePolicy ??
      duplicatePolicy) as DuplicateGeneLabelPolicy
    const mappedDuplicateCount = Number(
      rawResult.duplicate_count ?? rawResult.duplicateCount ?? options?.duplicateCount ?? 0
    )
    const mappedRoundCounts = Boolean(
      rawResult.round_counts ?? rawResult.roundCounts ?? mappedParameters.roundCounts ?? roundCounts
    )
    const mappedRoundingMethod = (rawResult.rounding_method ??
      rawResult.roundingMethod ??
      mappedParameters.roundingMethod ??
      null) as DESeqParameters['roundingMethod']
    const mappedNonIntegerSamplesDetected = Number(
      rawResult.non_integer_samples_detected ??
      rawResult.nonIntegerSamplesDetected ??
      mappedParameters.nonIntegerSamplesDetected ??
      0
    )
    const mappedNonIntegerCellsDetected = Number(
      rawResult.non_integer_cells_detected ??
      rawResult.nonIntegerCellsDetected ??
      mappedParameters.nonIntegerCellsDetected ??
      0
    )
    const mappedMissingLabelRows = Number(
      rawResult.missing_label_rows ??
      rawResult.missingLabelRows ??
      mappedParameters.missingLabelRows ??
      0
    )
    const mappedUsableLabelRows = Number(
      rawResult.usable_label_rows ??
      rawResult.usableLabelRows ??
      mappedParameters.usableLabelRows ??
      0
    )
    const mappedMissingLabelPct = Number(
      rawResult.missing_label_pct ??
      rawResult.missingLabelPct ??
      mappedParameters.missingLabelPct ??
      0
    )
    const annotationSource = (rawResult.annotation_source ?? rawResult.annotationSource ?? 'local_cache') as string
    const annotationSourceName = (rawResult.annotation_source_name ??
      rawResult.annotationSourceName ??
      null) as string | null
    const annotationSourceVersion = (rawResult.annotation_source_version ??
      rawResult.annotationSourceVersion ??
      null) as string | null

    return {
      modelId: model.id,
      executedAt: new Date(),
      genes,
      summary,
      sizeFactors,
      dispersions,
      sampleIds,
      pcaData,
      normalizedCounts,
      warnings,
      parameters: mappedParameters,
      ensemblVersion,
      ensemblVersionSource,
      geneIdType,
      geneLabelSource: mappedGeneLabelSource,
      duplicatePolicy: mappedDuplicatePolicy,
      duplicateCount: mappedDuplicateCount,
      roundCounts: mappedRoundCounts,
      roundingMethod: mappedRoundingMethod,
      nonIntegerSamplesDetected: mappedNonIntegerSamplesDetected,
      nonIntegerCellsDetected: mappedNonIntegerCellsDetected,
      missingLabelRows: mappedMissingLabelRows,
      usableLabelRows: mappedUsableLabelRows,
      missingLabelPct: mappedMissingLabelPct,
      annotationSource,
      annotationSourceName,
      annotationSourceVersion,
    }
  },

  async renderHeatmapImage(
    genes: DEGeneResult[],
    normalizedCounts: number[][],
    sampleIds: string[],
    options: {
      nTopGenes: number
      clusterRows: boolean
      clusterCols: boolean
      usePadj: boolean
      spaceColorbar?: number
    }
  ): Promise<HeatmapImageResult> {
    const response = await invoke<Record<string, unknown>>('run_rnaseq_analysis', {
      testName: 'rnaseq_heatmap',
      data: {
        genes,
        normalized_counts: normalizedCounts,
        sample_ids: sampleIds,
      },
      parameters: {
        options: {
          n_top_genes: options.nTopGenes,
          cluster_rows: options.clusterRows,
          cluster_cols: options.clusterCols,
          use_padj: options.usePadj,
          space_colorbar: options.spaceColorbar ?? 0,
        },
      },
      arrowDataPath: null,
    })

    if (response.success === false) {
      throw new Error('RNA-seq heatmap render failed')
    }

    const result = (response.result ?? response) as Record<string, unknown>
    const image = typeof result.image === 'string' ? result.image : ''
    if (!image) {
      const errorMessage = typeof result.error === 'string' ? result.error : 'Heatmap image unavailable'
      throw new Error(errorMessage)
    }

    const width = typeof result.width === 'number' ? result.width : undefined
    const height = typeof result.height === 'number' ? result.height : undefined
    const title = typeof result.title === 'string' ? result.title : undefined
    const nGenes = typeof result.n_genes === 'number' ? result.n_genes : undefined
    const nSamples = typeof result.n_samples === 'number' ? result.n_samples : undefined
    const rowLabels = Array.isArray(result.row_labels) ? (result.row_labels as string[]) : undefined
    const colLabels = Array.isArray(result.col_labels) ? (result.col_labels as string[]) : undefined
    const zScores = Array.isArray(result.z_scores) ? (result.z_scores as number[][]) : undefined

    return {
      image,
      width,
      height,
      title,
      nGenes,
      nSamples,
      rowLabels,
      colLabels,
      zScores,
    }
  },

  async validateSampleMatch(
    countsDataset: Pick<Dataset, 'id' | 'columns' | 'rowCount'>,
    metadataDataset: Pick<Dataset, 'id' | 'columns' | 'rowCount'>,
    options?: { countSampleIds?: string[]; maxPreview?: number }
  ): Promise<{ sampleMatch?: SampleMatchResult; metadataSampleValidation?: SampleIdValidationSummary }> {
    const metadataArrowPath = await cacheService.flushToArrow(metadataDataset.id)
    const maxPreview = typeof options?.maxPreview === 'number' ? options?.maxPreview : 10

    const response = await invoke<Record<string, unknown>>('run_rnaseq_analysis', {
      testName: 'rnaseq_validate_samples',
      data: {
        counts_sample_ids: options?.countSampleIds ?? [],
        counts_columns: countsDataset.columns.map(({ id, name }) => ({ id, name })),
        metadata_arrow_path: metadataArrowPath,
        metadata_columns: metadataDataset.columns.map(({ id, name }) => ({ id, name })),
      },
      parameters: {
        options: { max_preview: maxPreview },
      },
      arrowDataPath: null,
    })

    if (response.success === false) {
      return {}
    }

    const result = (response.result ?? response) as Record<string, unknown>
    const rawMeta = result.metadata_sample_validation as Record<string, unknown> | undefined
    const metadataSampleValidation = rawMeta
      ? {
          missingCount: Number(rawMeta.missing_count ?? rawMeta.missingCount ?? 0),
          duplicateIdCount: Number(rawMeta.duplicate_id_count ?? rawMeta.duplicateIdCount ?? 0),
          duplicateRowCount: Number(rawMeta.duplicate_row_count ?? rawMeta.duplicateRowCount ?? 0),
          duplicateExamples: Array.isArray(rawMeta.duplicate_examples ?? rawMeta.duplicateExamples)
            ? (rawMeta.duplicate_examples ?? rawMeta.duplicateExamples) as string[]
            : [],
        }
      : undefined
    const rawMatch = result.sample_matching as Record<string, unknown> | undefined
    const sampleMatch = rawMatch
      ? {
          status: (rawMatch.status as SampleMatchResult['status']) ?? 'warning',
          message: typeof rawMatch.message === 'string' ? rawMatch.message : '',
          matchedSamples: Array.isArray(rawMatch.matched_samples ?? rawMatch.matchedSamples)
            ? (rawMatch.matched_samples ?? rawMatch.matchedSamples) as string[]
            : [],
          onlyInCounts: Array.isArray(rawMatch.only_in_counts ?? rawMatch.onlyInCounts)
            ? (rawMatch.only_in_counts ?? rawMatch.onlyInCounts) as string[]
            : [],
          onlyInMetadata: Array.isArray(rawMatch.only_in_metadata ?? rawMatch.onlyInMetadata)
            ? (rawMatch.only_in_metadata ?? rawMatch.onlyInMetadata) as string[]
            : [],
          matchCount: Number(rawMatch.match_count ?? rawMatch.matchCount ?? 0),
          totalCountSamples: Number(rawMatch.total_count_samples ?? rawMatch.totalCountSamples ?? 0),
          totalMetaSamples: Number(rawMatch.total_meta_samples ?? rawMatch.totalMetaSamples ?? 0),
        }
      : undefined
    return {
      sampleMatch,
      metadataSampleValidation,
    }
  },
}

export const __testHelpers = {
  buildCountsPayload,
  dedupeWarnings,
  mapParameters,
  mapPca,
}

export default rnaseqService
