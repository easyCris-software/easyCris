/**
 * RNA-seq Module Type Definitions
 * Types for differential expression analysis with PyDESeq2.
 *
 * @module types/rnaseq
 */

// =============================================================================
// Project Types
// =============================================================================

/**
 * RNA-seq project (maps to a Navigator item)
 */
export interface RNAseqProject {
  id: string
  name: string
  createdAt: Date
  modifiedAt: Date

  // Linked datasets (stored in data-store)
  countsDatasetId: string | null
  metadataDatasetId: string | null

  // Analysis state
  models: DESeqModel[]
  results: DESeqResultRun[] // Run history across models

  // UI state
  activeTab: RNAseqTab
  activeModelId: string | null
  activeResultId: string | null
  activePlotType: RNAseqPlotType | null
}

export type RNAseqTab = 'counts' | 'metadata' | 'results' | 'plots'

// =============================================================================
// Model Configuration Types
// =============================================================================

/**
 * PyDESeq2 model configuration
 */
export interface DESeqModel {
  id: string
  name: string // User-friendly name
  designFormula: string // e.g., "~PC2 + treatment"
  groupId?: string // Links related models from the same configuration dialog

  // Main factor
  mainFactor: string // Column name
  mainFactorReference: string // Reference level
  mainFactorTest: string // Test level
  additionalFactors?: string[] // Additional categorical main effects

  // Optional interaction factors (2-way or 3-way)
  interactionFactor?: string
  interactionFactorReference?: string
  interactionFactorTest?: string
  interactionFactor2?: string
  interactionFactor2Reference?: string
  interactionFactor2Test?: string
  contrastType?: 'main' | 'interaction'
  useNullModel?: boolean // QC-only null model (~1) without contrasts
  pcaGroupBy?: string // PCA grouping factor for null model QC (optional - auto-detects if not specified)

  // Optional covariates (numeric or categorical)
  covariates: CovariateConfig[]
  includeCovariates?: boolean

  // Subset/stratification
  subsetFilters?: Record<string, string> // e.g., {sex: "female"}

  // Analysis options
  applyShrinkage: boolean
  shrinkageMethod: ShrinkageMethod
  organism: Organism
  geneIdType?: GeneIdType // Gene ID type (default 'ensembl')
  geneLabelSource?: GeneLabelSource // Label source (default 'id_lookup')
  alpha: number // Significance threshold (default 0.05)
  minCount: number // Min count filter (default 10)
  minSamples: number // Min samples with minCount (default 3)
  usePadjForSignificance: boolean // Use padj vs pvalue for significance
  pcaTopGenes: number // Top variable genes for PCA biplot (default 500)
  pcaGeneSelectionMode?: PCAGeneSelectionMode
}

export type ShrinkageMethod = 'apeglm' | 'ashr' | 'normal'

export interface CovariateConfig {
  column: string
  kind?: 'numeric' | 'categorical'
  centerAndScale: boolean
  referenceLevel?: string
}

// =============================================================================
// Result Types
// =============================================================================

/**
 * PyDESeq2 analysis result
 */
export interface DESeqResult {
  modelId: string
  executedAt: Date

  // Gene-level results
  genes: DEGeneResult[]

  // Summary statistics
  summary: DESeqSummary

  // Normalization data (for plots)
  sizeFactors: Record<string, number> // sampleId -> factor
  dispersions: Record<string, number> // geneId -> dispersion
  sampleIds?: string[] // ordered sample IDs for plotting

  // PCA data (for biplot)
  pcaData?: PCAResult

  // VST/rlog transformed data (for heatmap)
  normalizedCounts?: number[][] // genes × samples matrix

  // Analysis parameters used
  parameters: DESeqParameters

  // Ensembl version used for gene annotation (e.g., "115")
  ensemblVersion?: string | null
  ensemblVersionSource?: 'cache' | 'online' | null

  // Gene ID type and annotation source
  geneIdType?: GeneIdType
  geneLabelSource?: GeneLabelSource
  duplicatePolicy?: DuplicateGeneLabelPolicy
  duplicateCount?: number
  roundCounts?: boolean
  roundingMethod?: 'nearest' | null
  nonIntegerSamplesDetected?: number
  nonIntegerCellsDetected?: number
  missingLabelRows?: number
  usableLabelRows?: number
  missingLabelPct?: number
  annotationSource?: string // e.g., 'local_cache'
  annotationSourceName?: string | null
  annotationSourceVersion?: string | null

  // Optional warnings from validation (case mismatch, non-integer counts)
  warnings?: string[]
}

export interface DESeqResultRun extends DESeqResult {
  id: string
  label: string
  plotSettings?: RNAseqPlotSettingsByType
}

export interface DEGeneResult {
  geneId: string // Ensembl ID
  geneSymbol: string // Gene symbol (from annotation)
  baseMean: number | null
  log2FoldChange: number | null
  lfcSE: number | null // Standard error
  stat: number | null // Wald statistic
  pvalue: number | null
  padj: number | null // BH-adjusted p-value

  // Derived
  significant: boolean // padj < alpha (or pvalue depending on config)
  direction: GeneDirection
  sigCategory: SignificanceCategory
}

export type GeneDirection = 'up' | 'down' | 'ns'
export type SignificanceCategory = '***' | '**' | '*' | '.' | 'ns'

export interface DESeqSummary {
  totalGenes: number
  testedGenes: number // After filtering
  significantP05: number
  significantP01: number
  significantP001: number
  significantPadj05: number
  upregulated: number
  downregulated: number
  significanceMethod: 'pvalue' | 'padj'
  alpha: number
}

export interface DESeqParameters {
  organism: Organism
  geneIdType?: GeneIdType
  geneLabelSource?: GeneLabelSource
  duplicatePolicy?: DuplicateGeneLabelPolicy
  duplicateCount?: number
  roundCounts?: boolean
  roundingMethod?: 'nearest' | null
  nonIntegerSamplesDetected?: number
  nonIntegerCellsDetected?: number
  missingLabelRows?: number
  usableLabelRows?: number
  missingLabelPct?: number
  alpha: number
  minCount: number
  minSamples: number
  applyShrinkage: boolean
  shrinkageMethod: ShrinkageMethod | null
  usePadjForSignificance: boolean
  subsetFilters: Record<string, string> | null
  pcaTopGenes: number
  pcaGeneSelectionMode?: PCAGeneSelectionMode
  useNullModel?: boolean
  vstTransform?: 'vst' | 'log2' | null
}

export type PCAGeneSelectionMode =
  | 'significant_then_variable'
  | 'significant_only'
  | 'variable_only'

// =============================================================================
// PCA Types
// =============================================================================

export interface EllipseMetrics {
  group: string
  centerX: number
  centerY: number
  radiusX: number
  radiusY: number
  angle: number
  n: number
  path: string // SVG path from Python backend
}

export interface PCAResult {
  // Sample scores
  samples: PCASample[]

  // Gene loadings (for biplot arrows)
  loadings: PCALoading[]

  // Variance explained
  varianceExplained: number[] // Percent (0-100): [PC1%, PC2%, PC3%, ...]

  // Metadata
  genesUsed: number
  geneSelection?: {
    mode: PCAGeneSelectionMode
    effectiveMode?: PCAGeneSelectionMode
    significantUsed: number
    paddedWithVariance: boolean
    fallbackToVarianceWhenEmpty: boolean
    targetTopGenes: number
    autoSwitchedToSignificantThenVariable?: boolean
    significantOnlyMinGenes?: number
  }

  // Ellipse metrics (computed server-side)
  ellipse_metrics?: {
    t: EllipseMetrics[]
    norm: EllipseMetrics[]
    euclid: EllipseMetrics[]
  }
}

export interface PCASample {
  sampleId: string
  PC1: number
  PC2: number
  PC3?: number
  metadata: Record<string, string | number | null> // Factor values for coloring
}

export interface PCALoading {
  geneId: string
  geneSymbol: string
  PC1: number
  PC2: number
  contribution: number // sqrt(PC1² + PC2²)
  significant?: boolean
  direction?: GeneDirection
}

// =============================================================================
// Plot Types
// =============================================================================

export type RNAseqPlotType =
  | 'pca_biplot'
  | 'volcano'
  | 'heatmap'
  | 'deg_bar'
  | 'ma_plot'

/**
 * Ellipse type for confidence regions
 * - 't': Multivariate t-distribution with robust covariance estimation
 * - 'norm': Multivariate normal distribution with standard covariance
 * - 'euclid': Euclidean circle with fixed radius (level = radius)
 */
export type EllipseType = 't' | 'norm' | 'euclid'

export interface RNAseqPlotSettings {
  pvalueThreshold: number
  lfcThreshold: number
  nLabels: number
  usePadj: boolean
  showEllipses: boolean
  ellipseType: EllipseType
  nGeneArrows: number
  nTopGenes: number
  clusterRows: boolean
  clusterCols: boolean
  spaceColorbar: number
  repelForce: number // Label repulsion strength (0.5-2.5, default 1.0)
}

export type RNAseqPlotSettingsByType = Partial<Record<RNAseqPlotType, RNAseqPlotSettings>>

export interface BiplotOptions {
  colorBy: string // Factor column for color
  useContrastRoleColors?: boolean // If true, map reference/test levels to fixed role colors
  referenceLevel?: string // Main factor reference level (mapped to blue in contrast role mode)
  testLevel?: string // Main factor test level (mapped to red in contrast role mode)
  shapeBy?: string // Factor column for shape
  thirdBy?: string // Optional third factor (outline color for categorical, size for numeric)
  showEllipses: boolean // Confidence ellipses
  ellipseType: EllipseType // Ellipse distribution type (default: 't')
  ellipseLevel: number // Confidence level (0-1) or radius for 'euclid' (default: 0.95)
  showLabels: boolean // Sample labels
  nGeneArrows: number // Number of gene loading arrows (default 15)
  arrowScale: number // Scaling factor for arrows (default 1.0)
  colorArrowsByDirection: boolean // Color arrows by up/down/ns (default false = black)
  colorLabelsByDirection: boolean // Color gene label text by up/down/ns (default true)
  showLabelBackground: boolean // Show colored background on gene labels (default false = plain text)
  repelForce?: number // Label repulsion strength (0.5-2.5, default 1.0)
}

export interface VolcanoOptions {
  pvalueThreshold: number // Default 0.05
  lfcThreshold: number // Default 1.0
  nLabels: number // Top genes to label (default 10)
  usePadj: boolean // Use adjusted p-value
  repelForce?: number // Label repulsion strength (0.5-2.5, default 1.0)
}

export interface HeatmapOptions {
  nTopGenes: number // Default 50
  clusterRows: boolean
  clusterCols: boolean
  showGeneSymbols: boolean
  colorScale: 'RdYlBu' | 'RdBu' | 'viridis' | 'plasma'
  legendSpacing?: number // Gap between gene labels and legend (0-100)
}

export interface HeatmapImageResult {
  image: string
  width?: number
  height?: number
  title?: string
  nGenes?: number
  nSamples?: number
  rowLabels?: string[]
  colLabels?: string[]
  zScores?: number[][]
}

// =============================================================================
// Validation Types
// =============================================================================

export interface CountMatrixValidation {
  valid: boolean
  geneCount: number
  sampleCount: number
  errors: string[]
  warnings: string[]
  lowCountGenes?: number
  zeroGenes?: number
  suspectedNormalized?: boolean
}

export interface MetadataValidation {
  valid: boolean
  sampleCount: number
  columns: ColumnAnalysis[]
  errors: string[]
  warnings: string[]
}

export interface ColumnAnalysis {
  name: string
  type: 'factor' | 'numeric' | 'mixed'
  uniqueValues: number
  missingCount: number
  suggestedRole: 'factor' | 'covariate' | 'identifier'
}

export interface SampleMatchResult {
  status: 'ok' | 'warning' | 'error'
  message: string
  matchedSamples: string[]
  onlyInCounts: string[]
  onlyInMetadata: string[]
  matchCount: number
  totalCountSamples: number
  totalMetaSamples: number
}

export interface SampleIdValidationSummary {
  missingCount: number
  duplicateIdCount: number
  duplicateRowCount: number
  duplicateExamples: string[]
}

// =============================================================================
// Serialization Types (for project persistence)
// =============================================================================

export interface SerializedRNAseqState {
  schemaVersion: 'rnaseq_v1'
  exportedAt: string // ISO timestamp

  projects: SerializedRNAseqProject[]
  activeProjectId: string | null
}

export interface SerializedRNAseqProject {
  id: string
  name: string
  createdAt: string // ISO timestamp
  modifiedAt: string // ISO timestamp

  // Dataset references
  countsDatasetId: string | null
  metadataDatasetId: string | null

  // Analysis configuration
  models: DESeqModel[]

  // Results references (actual data stored separately)
  resultsRef: ResultReference[]

  // UI state
  activeTab: RNAseqTab
  activeModelId: string | null
  activeResultId: string | null
  activePlotType: RNAseqPlotType | null
}

export interface ResultReference {
  resultId: string
  modelId: string
  label: string
  executedAt: string
  storageKey: string // Reference to separate result file
  summary: DESeqSummary // Inline summary for quick access
}

export interface SerializedDESeqResult extends Omit<DESeqResultRun, 'executedAt'> {
  executedAt: string
}

/**
 * Serialized RNA-seq results for project persistence
 *
 * Supports two formats for backward compatibility:
 * - **New format (array)**: `{ [projectId]: SerializedDESeqResult[] }`
 *   - Used since multi-run support (January 2026)
 *   - Results stored as array, ordered newest-first
 *
 * - **Legacy format (object)**: `{ [projectId]: { [modelId]: SerializedDESeqResult } }`
 *   - Used before multi-run support
 *   - Results stored as object keyed by modelId
 *   - One result per model (old behavior)
 */
export type SerializedRNAseqResults =
  | Record<string, SerializedDESeqResult[]>  // New: array format
  | Record<string, Record<string, SerializedDESeqResult>>  // Legacy: object format

// =============================================================================
// API Request/Response Types
// =============================================================================

export interface DESeq2Request {
  counts: Record<string, Record<string, number>>
  metadata: Record<string, Record<string, string | number>>
  designFormula: string
  contrast?: [string, string, string] | null // [factor, test, reference]
  interactionContrast?: {
    factorA: string
    testA: string
    referenceA: string
    factorB: string
    testB: string
    referenceB: string
    factorC?: string
    testC?: string
    referenceC?: string
  } | null
  factorReferenceLevels?: Record<string, string>
  subsetFilters?: Record<string, string>
  covariates?: CovariateConfig[]
  options: {
    applyShrinkage: boolean
    shrinkageMethod: ShrinkageMethod
    alpha: number
    minCount: number
    minSamples: number
    usePadjForSignificance: boolean
    computePca: boolean
    computeVst: boolean
    annotateGenes: boolean
    organism: string
    geneIdType?: string
    gene_id_type?: string
    gene_label_source?: GeneLabelSource
    duplicate_policy?: DuplicateGeneLabelPolicy
    duplicate_count_hint?: number
    round_counts?: boolean
    pcaTopGenes: number
    pcaGeneSelectionMode?: PCAGeneSelectionMode
  }
}

export interface DESeq2Response {
  success: boolean
  genes?: DEGeneResult[]
  summary?: DESeqSummary
  sizeFactors?: Record<string, number>
  dispersions?: Record<string, number>
  pcaData?: PCAResult
  normalizedCounts?: number[][]
  designFormula?: string
  contrast?: string[]
  parameters?: DESeqParameters
  ensemblVersion?: string | null
  ensemblVersionSource?: 'cache' | 'online' | null
  geneIdType?: GeneIdType
  geneLabelSource?: GeneLabelSource
  duplicatePolicy?: DuplicateGeneLabelPolicy
  duplicateCount?: number
  annotationSource?: string
  annotationSourceName?: string | null
  annotationSourceVersion?: string | null
  error?: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

// =============================================================================
// Utility Types
// =============================================================================

export interface MemoryEstimate {
  rawMb: number
  analysisMb: number
  totalMb: number
  recommendation: 'ok' | 'warning' | 'error'
}

export type Organism = 'mmusculus' | 'hsapiens'
export type GeneLabelSource = 'id_lookup' | 'user_provided'
export type DuplicateGeneLabelPolicy = 'sum_duplicates' | 'keep_first'

export type GeneIdType = 'ensembl' | 'entrez' | 'uniprot' | 'uniprot_swissprot'

// Default values
export const DEFAULT_DESEQ_OPTIONS = {
  applyShrinkage: false,
  shrinkageMethod: 'apeglm' as ShrinkageMethod,
  organism: 'mmusculus' as Organism,
  geneIdType: 'ensembl' as GeneIdType,
  geneLabelSource: 'id_lookup' as GeneLabelSource,
  alpha: 0.05,
  minCount: 10,
  minSamples: 3,
  usePadjForSignificance: true,
  pcaTopGenes: 500,
  pcaGeneSelectionMode: 'significant_only' as PCAGeneSelectionMode,
}

export const DEFAULT_BIPLOT_OPTIONS: BiplotOptions = {
  colorBy: 'treatment',
  showEllipses: true,
  ellipseType: 't', // Default robust ellipse type
  ellipseLevel: 0.95, // 95% confidence
  showLabels: true,
  nGeneArrows: 5,
  arrowScale: 1.0,
  colorArrowsByDirection: false, // Default: black arrows (MDPI style)
  colorLabelsByDirection: true, // Color gene label text by direction (up/down/ns)
  showLabelBackground: false, // Default: plain text labels (no background)
  repelForce: 1.0, // Default label repulsion strength
}

export const DEFAULT_VOLCANO_OPTIONS: VolcanoOptions = {
  pvalueThreshold: 0.05,
  lfcThreshold: 1.0,
  nLabels: 10,
  usePadj: true,
  repelForce: 1.0, // Default label repulsion strength
}

export const DEFAULT_HEATMAP_OPTIONS: HeatmapOptions = {
  nTopGenes: 50,
  clusterRows: true,
  clusterCols: true,
  showGeneSymbols: true,
  colorScale: 'RdYlBu',
}
