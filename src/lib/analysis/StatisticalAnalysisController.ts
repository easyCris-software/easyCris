/**
 * Statistical Analysis Controller
 *
 * Replicates Avalonia's StatisticalAnalysisViewModel.RunAnalysis() orchestration pattern.
 * Coordinates multi-step configuration workflow:
 * 1. Test selection detection
 * 2. Column selection
 * 3. Conditional dialogs (DV selection, encoding, factor config)
 * 4. Context management (per-test state)
 * 5. Execution with collected configuration
 *
 * Reference: C:\Users\RajLord_new\Desktop\Bmad_project\easyCris.Avalonia\ViewModels\StatisticalAnalysisViewModel.cs
 * Lines: 1586-4376 (~2800 lines of orchestration logic)
 */

import type { ColumnClassification, BuildPayloadResult } from '@/lib/modules/core/types'
import { ColumnDataType } from '@/lib/modules/core/types'
import { moduleRegistry } from '@/lib/modules/core/ModuleRegistry'
import { invoke } from '@tauri-apps/api/core'
// useDataStore removed - streaming row provider now uses cacheService for data access
import { useAppStore, ensureProjectId } from '@/store/app-store'
import { useResultsStore } from '@/store/results-store'
import { usePlotsStore } from '@/store/plots-store'
import { buildPlotSpecsFromResult } from '@/services/plotResultService'
import { useAnalysisStore } from '@/store/analysis-store'
import { toast } from 'sonner'
import { getTestDefinition } from '@/config/testRegistry'
import { parseTestResults } from '@/lib/analysis/resultParser'
import { buildECPTables } from '@/utils/ecpTableBuilders'
import { createLogger } from '@/utils/logger'
import cacheService from '@/services/cacheService'
import { showAppErrorToast } from '@/lib/errors/errorToast'
import type { LmmAnovaConfig, LmmAnovaConfigDialogResult } from '@/components/dialogs/LmmAnovaConfigDialog'
import {
  extractAppError,
  extractErrorMessage,
  markErrorToastShown,
  wasErrorToastShown,
} from '@/lib/errors/tauriErrorAdapter'

export type { LmmAnovaConfig, LmmAnovaConfigDialogResult } from '@/components/dialogs/LmmAnovaConfigDialog'

// Initialize logger for this module
const logger = createLogger('StatisticalAnalysisController')

const GROUP1_PLOT_PAYLOAD_TESTS = new Set([
  'independent_ttest',
  'paired_ttest',
  'one_sample_ttest',
  'one_way_anova',
  'two_way_anova',
  'lmm_anova',
  'multifactorial_anova',
  'mann_whitney',
  'wilcoxon',
  'kruskal_wallis',
  'scheirer_ray_hare',
  'friedman',
  // Group 3: correlation + simple linear regression need raw x/y for plots
  'correlation_pearson',
  'correlation_spearman',
  'correlation_kendall',
  'linear_regression',
  // Group 4: categorical tests need payload labels for plots
  'chi_square',
  'chi_square_gof',
  'fishers_exact',
  'mcnemar',
  // Group 5: distribution/descriptive tests need raw values for plots
  'normality_all',
  'normality_shapiro',
  'normality_ks',
  'normality_ad',
  'normality_cvm',
  'normality_jb',
  'normality_tests',
  'descriptive_stats',
  'outlier_detection',
])

const PLACEHOLDER_MARKER = 'builder not yet implemented'

function isPlaceholderPlot(plot: { plotlyData?: unknown; plotlyLayout?: unknown }): boolean {
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
      if (annotation && typeof annotation.text === 'string' &&
        annotation.text.toLowerCase().includes(PLACEHOLDER_MARKER)) {
        return true
      }
    }
  }

  return false
}

// ============================================
// Dialog Service Interface
// ============================================

/**
 * Dialog context update interface
 */
export interface DialogContextUpdate {
  columns?: ColumnClassification[]
  selectedTests?: string[]
}

/**
 * Dialog service for showing configuration dialogs
 * Implemented by React hooks to integrate with component state
 */
export interface IDialogService {
  /**
   * Show dependent variable selection dialog
   * @returns Promise resolving to dialog result
   */
  showDVSelectionDialog(): Promise<DependentVariableDialogResult>

  /**
   * Show dependent variable encoding dialog (for logistic regression)
   * @returns Promise resolving to dialog result
   */
  showDVEncodingDialog(): Promise<EncodingDialogResult>

  /**
   * Show factor encoding dialog (for categorical predictors in REGRESSION ONLY)
   * NOT used for ANOVA - ANOVA uses automatic effect coding
   * @returns Promise resolving to dialog result
   */
  showFactorEncodingDialog(): Promise<FactorEncodingDialogResult>

  /**
   * Show simple effects dialog (for 2-factor ANOVA: Two-Way ANOVA, Scheirer-Ray-Hare)
   * Allows user to request simple effects analysis for interaction interpretation
   * @returns Promise resolving to dialog result
   */
  showSimpleEffectsDialog(): Promise<SimpleEffectsDialogResult>

  /**
   * Show multi-factorial simple effects dialog (for 3+ factor ANOVA)
   * Allows user to select which simple effects to analyze
   * @param factorNames - Array of categorical factor names (3+)
   * @returns Promise resolving to dialog result
   */
  showMultiFactorialSimpleEffectsDialog(
    factorNames: string[],
    testIdPrefix?: string
  ): Promise<MultiFactorialSimpleEffectsDialogResult>

  /**
   * Show Linear Mixed Model configuration dialog
   * Allows user to pick outcome, grouping, predictors, predictor typing, random effects, and model options.
   * @returns Promise resolving to dialog result
   */
  showLmmAnovaConfigDialog(): Promise<LmmAnovaConfigDialogResult>

  /**
   * Show dose-response column mapper dialog
   * Allows user to map columns to dose-response analysis fields:
   * Dose (concentration) and Response (effect)
   * @param testName - Display name of the dose-response test
   * @returns Promise resolving to dialog result
   */
  showDoseResponseColumnMapperDialog(testName: string): Promise<DoseResponseColumnMapperDialogResult>

  /**
   * Show synergy column mapper dialog
   * Allows user to map columns to synergy analysis fields:
   * Drug A Dose, Drug B Dose, Drug A Response, Drug B Response, Combined Response
   * @param testName - Display name of the synergy test
   * @returns Promise resolving to dialog result
   */
  showSynergyColumnMapperDialog(testName: string): Promise<SynergyColumnMapperDialogResult>

  /**
   * Show Chi-Square GOF column mapper dialog
   * Allows user to map columns to category, observed counts, and expected proportions.
   * @param testName - Display name of the GOF test
   * @returns Promise resolving to dialog result
   */
  showChiSquareGofColumnMapperDialog(testName: string): Promise<ChiSquareGofColumnMapperDialogResult>

  /**
   * Show Chi-Square Independence column mapper dialog
   * Allows user to map row/column variables for the contingency table.
   * @param testName - Display name of the chi-square test
   * @returns Promise resolving to dialog result
   */
  showChiSquareColumnMapperDialog(testName: string): Promise<ChiSquareColumnMapperDialogResult>

  /**
   * Show Fisher's Exact column mapper dialog
   * Allows user to map group/outcome variables for the 2x2 contingency table.
   * @param testName - Display name of the Fisher's Exact test
   * @returns Promise resolving to dialog result
   */
  showFisherExactColumnMapperDialog(testName: string): Promise<FisherExactColumnMapperDialogResult>

  /**
   * Show McNemar column mapper dialog
   * @param testName - Display name of the McNemar's test
   * @returns Promise resolving to dialog result
   */
  showMcNemarColumnMapperDialog(testName: string): Promise<McNemarColumnMapperDialogResult>

  /**
   * Show Independent T-Test column mapper dialog
   * Allows user to map group (categorical) and outcome (numeric) variables.
   * @param testName - Display name of the T-Test
   * @returns Promise resolving to dialog result
   */
  showIndependentTTestColumnMapperDialog(testName: string): Promise<IndependentTTestColumnMapperDialogResult>

  /**
   * Show Mann-Whitney U column mapper dialog
   * Allows user to map group (categorical) and outcome (numeric) variables.
   * @param testName - Display name of the Mann-Whitney U test
   * @returns Promise resolving to dialog result
   */
  showMannWhitneyColumnMapperDialog(testName: string): Promise<MannWhitneyColumnMapperDialogResult>

  /**
   * Show Paired T-Test column mapper dialog
   * Allows user to map time/condition (categorical) and outcome (numeric) variables.
   * @param testName - Display name of the T-Test
   * @returns Promise resolving to dialog result
   */
  showPairedTTestColumnMapperDialog(testName: string): Promise<PairedTTestColumnMapperDialogResult>

  /**
   * Show Wilcoxon Signed-Rank Test column mapper dialog
   * Allows user to map time/condition (categorical, 2 groups) and outcome (numeric) variables.
   * @param testName - Display name of the Wilcoxon test
   * @returns Promise resolving to dialog result
   */
  showWilcoxonColumnMapperDialog(testName: string): Promise<WilcoxonColumnMapperDialogResult>

  /**
   * Show One-Way ANOVA column mapper dialog
   * Allows user to map group (categorical) and outcome (numeric) variables for long format.
   * @param testName - Display name of the ANOVA test
   * @param groupLevels - Optional group levels for Dunnett control selection
   * @returns Promise resolving to dialog result
   */
  showOneWayAnovaColumnMapperDialog(testName: string, groupLevels?: string[]): Promise<OneWayAnovaColumnMapperDialogResult>

  /**
   * Show Kruskal-Wallis Test column mapper dialog
   * Allows user to map group (categorical) and outcome (numeric) variables for long format.
   * @param testName - Display name of the Kruskal-Wallis test
   * @returns Promise resolving to dialog result
   */
  showKruskalWallisColumnMapperDialog(testName: string): Promise<KruskalWallisColumnMapperDialogResult>

  /**
   * Show Two-Way ANOVA factor mapper dialog
   * Allows user to explicitly assign factor roles (Factor A primary, Factor B secondary).
   * @returns Promise resolving to dialog result
   */
  showTwoWayFactorMapperDialog(): Promise<TwoWayFactorMapperDialogResult>

  /**
   * Show Multifactorial ANOVA factor mapper dialog
   * Allows user to explicitly assign factor roles (Primary, Secondary, Facets).
   * @returns Promise resolving to dialog result
   */
  showMultifactorialFactorMapperDialog(): Promise<MultifactorialFactorMapperDialogResult>

  /**
   * Show survival analysis dialog (Kaplan-Meier, Cox, Nelson-Aalen)
   */
  showSurvivalAnalysisDialog(options: {
    columns: ColumnClassification[]
    analysisType: 'kaplan_meier' | 'cox_regression' | 'nelson_aalen'
  }): Promise<SurvivalAnalysisDialogResult>

  /**
   * Show mediation analysis dialog (Model 4)
   */
  showMediationAnalysisDialog(options: {
    columns: ColumnClassification[]
  }): Promise<MediationAnalysisDialogResult>

  /**
   * Show moderation analysis dialog (Model 1)
   */
  showModerationAnalysisDialog(options: {
    columns: ColumnClassification[]
  }): Promise<ModerationAnalysisDialogResult>

  /**
   * Show moderated mediation analysis dialog (Model 7)
   */
  showModeratedMediationAnalysisDialog(options: {
    columns: ColumnClassification[]
  }): Promise<ModeratedMediationAnalysisDialogResult>

  /**
   * Update dialog context between steps
   * @param updates - Partial context updates
   */
  updateDialogContext(updates: DialogContextUpdate): void

  /**
   * Show a confirmation dialog with custom message and options
   * @param title - Dialog title
   * @param message - Dialog message
   * @param confirmLabel - Label for confirm button
   * @param cancelLabel - Label for cancel button
   * @returns Promise resolving to true if confirmed, false if cancelled
   */
  showConfirmDialog(
    title: string,
    message: string,
    confirmLabel: string,
    cancelLabel: string
  ): Promise<boolean>

  /**
   * Show execution mode dialog for large datasets
   * Allows user to choose between exact (RAM-heavy) and large-mode (streaming)
   * @param testName - Name of the test being run
   * @param rowCount - Approximate row count of the dataset
   * @returns Promise resolving to selected mode, or null if cancelled
   */
  showExecutionModeDialog(testName: string, rowCount: number): Promise<ExecutionModeDialogResult>
}


// ============================================
// Context Interfaces (State Containers)
// ============================================

/**
 * Regression analysis context
 * Stores DV, predictors, and outcome encoding for a single regression test
 */
export interface RegressionContext {
  dependentVariable: string | null
  predictors: string[]
  outcomeEncoding: Map<string, number> | null

  reset(): void
}

/**
 * Two-Way ANOVA context
 * Stores simple effects configuration for 2-factor ANOVA tests
 */
export interface TwoWayAnovaContext {
  factorAWithinB: boolean
  factorBWithinA: boolean
  adjustmentMethod: PostHocAdjustmentMethod
  controlLevels: Record<string, string>
  posthocQ: number | null
  reset(): void
}

/**
 * Multi-Factorial ANOVA context
 * Stores simple effects configuration for 3+ factor ANOVA tests
 */
export interface MultiFactorialContext {
  simpleEffects: SimpleEffectConfig[]
  adjustmentMethod: PostHocAdjustmentMethod
  controlLevels: Record<string, string>
  posthocQ: number | null
  reset(): void
}

/**
 * Linear Mixed Model context
 * Stores model configuration and optional simple-effects configuration
 */
export interface LmmAnovaContext {
  config: LmmAnovaConfig | null
  simpleEffects: SimpleEffectConfig[]
  adjustmentMethod: PostHocAdjustmentMethod
  controlLevels: Record<string, string>
  posthocQ: number | null
  reset(): void
}

/**
 * Scheirer-Ray-Hare context
 * Tracks simple effects independently from parametric ANOVA contexts
 */
export interface ScheirerSimpleEffectsContext {
  factorAWithinB: boolean
  factorBWithinA: boolean
  multiFactorEffects: SimpleEffectConfig[]
  reset(): void
}

/**
 * Kaplan-Meier survival analysis context
 * Stores configuration for Kaplan-Meier survival curves
 */
export interface KaplanMeierContext {
  timeVariable: string | null
  eventVariable: string | null
  groupVariable: string | null  // Optional stratification
  eventEncoding?: {              // CRITICAL: Required for non-numeric binary
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  reset(): void
}

/**
 * Cox regression survival analysis context
 * Stores configuration for Cox proportional hazards model
 */
export interface CoxRegressionContext {
  timeVariable: string | null
  eventVariable: string | null
  covariates: string[]           // Required: at least 1
  eventEncoding?: {              // CRITICAL: Required for non-numeric binary
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  covariateEncodings?: Record<string, { trueValue: string; falseValue: string; wasEncoded: boolean }>
  reset(): void
}

/**
 * Nelson-Aalen survival analysis context
 * Stores configuration for Nelson-Aalen cumulative hazard estimator
 */
export interface NelsonAalenContext {
  timeVariable: string | null
  eventVariable: string | null
  groupVariable: string | null  // Optional stratification
  customTimePoints: number[]     // Fixed time points (max 5) - ONLY NA supports this
  eventEncoding?: {              // CRITICAL: Required for non-numeric binary
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  reset(): void
}

/**
 * Mediation Analysis context (Model 4)
 * Stores configuration for mediation analysis
 */
export interface MediationContext {
  independentVariable: string | null
  mediator: string | null
  dependentVariable: string | null
  covariates: string[]
  nBootstrap: number
  confidenceLevel: number
  seed: number
  ivEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  mediatorEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  dvEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  covariateEncodings?: Record<string, {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }>
  reset(): void
}

/**
 * Moderation Analysis context (Model 1)
 * Stores configuration for moderation analysis
 */
export interface ModerationContext {
  independentVariable: string | null
  moderator: string | null
  dependentVariable: string | null
  covariates: string[]
  centerPredictor: boolean
  centerModerator: boolean
  probeValues: number[] | null
  confidenceLevel: number
  seed: number
  ivEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  moderatorEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  dvEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  covariateEncodings?: Record<string, {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }>
  reset(): void
}

/**
 * Moderated Mediation Analysis context (Model 7)
 * Stores configuration for moderated mediation analysis
 */
export interface ModeratedMediationContext {
  independentVariable: string | null
  mediator: string | null
  moderator: string | null
  dependentVariable: string | null
  covariates: string[]
  centerPredictor: boolean
  centerModerator: boolean
  probeValues: number[] | null
  nBootstrap: number
  confidenceLevel: number
  seed: number
  ivEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  mediatorEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  moderatorEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  dvEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  covariateEncodings?: Record<string, {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }>
  reset(): void
}

/**
 * Dialog result types
 */
export interface SurvivalAnalysisDialogResult {
  timeVariable: string
  eventVariable: string
  groupVariable: string | null
  covariates: string[]
  customTimePoints: number[]
  eventEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  covariateEncodings?: Record<string, { trueValue: string; falseValue: string; wasEncoded: boolean }>
  cancelled: boolean
}

export interface MediationAnalysisDialogResult {
  independentVariable: string
  mediator: string
  dependentVariable: string
  covariates: string[]
  nBootstrap: number
  confidenceLevel: number
  seed: number
  ivEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  mediatorEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  dvEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  covariateEncodings?: Record<string, {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }>
  cancelled: boolean
}

export interface ModerationAnalysisDialogResult {
  independentVariable: string
  moderator: string
  dependentVariable: string
  covariates: string[]
  centerPredictor: boolean
  centerModerator: boolean
  probeMode: 'default' | 'custom'
  customProbeValues: number[] | null
  confidenceLevel: number
  seed: number
  ivEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  moderatorEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  dvEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  covariateEncodings?: Record<string, {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }>
  cancelled: boolean
}

export interface ModeratedMediationAnalysisDialogResult {
  independentVariable: string
  mediator: string
  moderator: string
  dependentVariable: string
  covariates: string[]
  centerPredictor: boolean
  centerModerator: boolean
  probeMode: 'default' | 'custom'
  customProbeValues: number[] | null
  nBootstrap: number
  confidenceLevel: number
  seed: number
  ivEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  mediatorEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  moderatorEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  dvEncoding?: {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }
  covariateEncodings?: Record<string, {
    eventValue: string
    censoredValue: string
    wasEncoded: boolean
  }>
  cancelled: boolean
}

export interface DependentVariableDialogResult {
  selectedVariable: string
  cancelled: boolean
}

export interface EncodingDialogResult {
  encodingMapping: Map<string, number>
  cancelled: boolean
}

export interface FactorEncodingDialogResult {
  encodingMappings: Map<string, Map<string, number>> // factor name -> (level -> code)
  cancelled: boolean
  // REMOVED: simpleEffects - ANOVA concept, not needed for regression
}

/**
 * Simple effects dialog result (for 2-factor ANOVA)
 */
export interface SimpleEffectsDialogResult {
  factorAWithinB: boolean // Analyze Factor A within each level of Factor B
  factorBWithinA: boolean // Analyze Factor B within each level of Factor A
  adjustmentMethod?: PostHocAdjustmentMethod
  controlLevels?: Record<string, string>
  posthocQ?: number
  cancelled: boolean
}

/**
 * Post-hoc adjustment methods supported for ANOVA
 */
export type PostHocAdjustmentMethod =
  | 'tukey'
  | 'bonferroni'
  | 'holm'
  | 'holm-sidak'
  | 'sidak'
  | 'dunnett'
  | 'fdr_bh'

/**
 * Simple effect configuration (for multi-factorial ANOVA)
 */
export interface SimpleEffectConfig {
  factor: string // Factor to analyze
  within: string // Factor within which to analyze
}

/**
 * Multi-factorial simple effects dialog result (for 3+ factor ANOVA)
 */
export interface MultiFactorialSimpleEffectsDialogResult {
  simpleEffects: SimpleEffectConfig[]
  adjustmentMethod?: PostHocAdjustmentMethod
  controlLevels?: Record<string, string>
  posthocQ?: number
  cancelled: boolean
}

/**
 * Synergy column mapping (result from synergy column mapper dialog)
 */
export interface SynergyColumnMapping {
  doseA: string // columnId for Drug A dose
  doseB: string // columnId for Drug B dose
  responseA: string // columnId for Drug A single-agent response
  responseB: string // columnId for Drug B single-agent response
  responseCombined: string // columnId for combination response
}

const SYNERGY_BOUNDARY_ROWS_SENTINEL = '__BOUNDARY_ROWS__'

/**
 * Dose-response column mapping
 */
export interface DoseResponseColumnMapping {
  dose: string // columnId for dose/concentration
  response: string // columnId for response/effect
}

/**
 * Chi-square GOF column mapping
 */
export interface ChiSquareGofColumnMapping {
  category: string | null // columnId for category labels (optional)
  observed: string // columnId for observed counts or sentinel
  expected: string | null // columnId for expected proportions (optional)
}

/**
 * Chi-square independence column mapping
 */
export interface ChiSquareColumnMapping {
  group: string // columnId for row variable
  outcome: string // columnId for column variable
}

/**
 * Dose-response column mapper dialog result
 */
export interface DoseResponseColumnMapperDialogResult {
  mapping: DoseResponseColumnMapping
  cancelled: boolean
}

/**
 * Synergy column mapper dialog result
 */
export interface SynergyColumnMapperDialogResult {
  mapping: SynergyColumnMapping
  cancelled: boolean
}

/**
 * Chi-square GOF column mapper dialog result
 */
export interface ChiSquareGofColumnMapperDialogResult {
  mapping: ChiSquareGofColumnMapping
  cancelled: boolean
}

/**
 * Chi-square independence column mapper dialog result
 */
export interface ChiSquareColumnMapperDialogResult {
  mapping: ChiSquareColumnMapping
  cancelled: boolean
}

/**
 * Fisher's Exact column mapping
 */
export interface FisherExactColumnMapping {
  group: string // columnId for group/row variable
  outcome: string // columnId for outcome/column variable
}

/**
 * Fisher's Exact column mapper dialog result
 */
export interface FisherExactColumnMapperDialogResult {
  mapping: FisherExactColumnMapping
  cancelled: boolean
}

/**
 * McNemar column mapping
 */
export interface McNemarColumnMapping {
  before: string // columnId for before/pre-treatment variable
  after: string // columnId for after/post-treatment variable
}

/**
 * McNemar column mapper dialog result
 */
export interface McNemarColumnMapperDialogResult {
  mapping: McNemarColumnMapping
  cancelled: boolean
}

/**
 * Independent T-Test column mapping
 */
export interface IndependentTTestColumnMapping {
  group: string // columnId for group/categorical variable
  outcome: string // columnId for outcome/numeric variable
}

/**
 * Independent T-Test column mapper dialog result
 */
export interface IndependentTTestColumnMapperDialogResult {
  mapping: IndependentTTestColumnMapping
  cancelled: boolean
}

/**
 * Mann-Whitney U column mapping
 */
export interface MannWhitneyColumnMapping {
  group: string // columnId for group/categorical variable
  outcome: string // columnId for outcome/numeric variable
}

/**
 * Mann-Whitney U column mapper dialog result
 */
export interface MannWhitneyColumnMapperDialogResult {
  mapping: MannWhitneyColumnMapping
  cancelled: boolean
}

/**
 * Paired T-Test column mapping for explicit user selection
 */
export interface PairedTTestColumnMapping {
  group: string // columnId for time/condition variable
  outcome: string // columnId for outcome/numeric variable
  pair_id?: string // columnId for pair/subject identifier (optional for wide format)
}

/**
 * Paired T-Test column mapper dialog result
 */
export interface PairedTTestColumnMapperDialogResult {
  mapping: PairedTTestColumnMapping
  cancelled: boolean
}

/**
 * Wilcoxon Signed-Rank Test column mapping for explicit user selection
 */
export interface WilcoxonColumnMapping {
  group: string // columnId for time/condition variable (2 time points)
  outcome: string // columnId for outcome/numeric variable
  pair_id?: string // columnId for pair/subject identifier (optional for wide format)
}

/**
 * Wilcoxon Signed-Rank Test column mapper dialog result
 */
export interface WilcoxonColumnMapperDialogResult {
  mapping: WilcoxonColumnMapping
  cancelled: boolean
}

/**
 * One-Way ANOVA column mapping for explicit user selection (long format)
 */
export interface OneWayAnovaColumnMapping {
  group?: string // columnId for grouping variable (categorical, long format)
  outcome?: string // columnId for outcome/numeric variable (long format)
  posthoc_adjustment?: string // Post-hoc adjustment method
  control_level?: string // Control level for Dunnett (required when posthoc_adjustment='dunnett')
  posthoc_q?: number // FDR q-value (only used when posthoc_adjustment='fdr_bh')
}

/**
 * One-Way ANOVA column mapper dialog result
 */
export interface OneWayAnovaColumnMapperDialogResult {
  mapping: OneWayAnovaColumnMapping
  cancelled: boolean
}

/**
 * Kruskal-Wallis Test column mapping for explicit user selection (long format)
 */
export interface KruskalWallisColumnMapping {
  group?: string // columnId for grouping variable (categorical)
  outcome?: string // columnId for outcome/numeric variable
  posthoc_adjustment?: string // Post-hoc adjustment method
  posthoc_q?: number // FDR q-value (only used when posthoc_adjustment='fdr_bh')
}

/**
 * Kruskal-Wallis Test column mapper dialog result
 */
export interface KruskalWallisColumnMapperDialogResult {
  mapping: KruskalWallisColumnMapping
  cancelled: boolean
}

/**
 * Two-Way ANOVA factor role mapping
 */
export interface TwoWayFactorMapping {
  factorA: string // columnId for primary factor (x-axis)
  factorB: string // columnId for secondary factor (grouping)
}

/**
 * Two-Way ANOVA factor mapper dialog result
 */
export interface TwoWayFactorMapperDialogResult {
  mapping: TwoWayFactorMapping
  cancelled: boolean
}

/**
 * Multifactorial ANOVA factor role mapping
 */
export interface MultifactorialFactorMapping {
  primary: string // columnId for primary factor (x-axis)
  secondary: string // columnId for secondary factor (grouping/series)
  facets: string[] // columnIds for facet factors (ordered)
}

/**
 * Multifactorial ANOVA factor mapper dialog result
 */
export interface MultifactorialFactorMapperDialogResult {
  mapping: MultifactorialFactorMapping
  cancelled: boolean
}

/**
 * Execution mode for large datasets
 * - 'exact': Full materialization, validated results, RAM-heavy
 * - 'large': Streaming/out-of-core, faster, may be approximate
 */
export type ExecutionMode = 'exact' | 'large'

/**
 * Test families that require exact mode only (no large-mode streaming support)
 * These tests involve complex iterative algorithms, bootstrapping, or full-data operations
 * that cannot be performed via SQL aggregates or streaming:
 * - Regression: Iterative optimization (logistic), matrix operations
 * - Survival: Event-time processing, hazard calculations
 * - Mediation: Bootstrap confidence intervals
 * - Moderation: Interaction effects, Johnson-Neyman calculations
 */
export const EXACT_MODE_ONLY_FAMILIES: ReadonlySet<string> = new Set([
  'regression',
  'survival',
  'mediation',
  'moderation',
])

const AGGREGATE_FASTPATH_TESTS: ReadonlySet<string> = new Set([
  'descriptive_stats',
  'independent_ttest',
  'one_sample_ttest',
  'paired_ttest',
  'correlation_pearson',
  'correlation_spearman',
  'one_way_anova',
])

const RUST_AGGREGATE_TESTS: ReadonlySet<string> = new Set([
  'one_sample_ttest',
  'independent_ttest',
  't_test_two_sample',
  'paired_ttest',
  't_test_paired',
  'correlation_pearson',
  'correlation_spearman',
  'one_way_anova',
  'descriptive_stats',
])

/**
 * Execution mode dialog result
 */
export interface ExecutionModeDialogResult {
  mode: ExecutionMode | null  // null = cancelled
}

// ============================================
// Controller Class
// ============================================

export class StatisticalAnalysisController {
  // Selected tests and columns (from UI)
  private selectedTests: string[] = []
  private selectedColumns: ColumnClassification[] = []

  // Per-family column selections (prevents cross-contamination between Statistics Family tabs)
  private selectedColumnsByFamily: Map<string, ColumnClassification[]> = new Map()
  private _currentFamilyId: string | null = null // Stored for future use (debugging, context tracking)

  // Per-test contexts (prevent cross-contamination)
  private linearRegressionContext: RegressionContext
  private binaryLogisticRegressionContext: RegressionContext
  private multinomialLogisticRegressionContext: RegressionContext

  // ANOVA contexts (simple effects configuration)
  private twoWayAnovaContext: TwoWayAnovaContext
  private multiFactorialContext: MultiFactorialContext
  private lmmAnovaContext: LmmAnovaContext
  private scheirerRayHareContext: ScheirerSimpleEffectsContext

  // Survival analysis contexts
  private kaplanMeierContext: KaplanMeierContext
  private coxRegressionContext: CoxRegressionContext
  private nelsonAalenContext: NelsonAalenContext

  // Mediation & Moderation contexts
  private mediationContext: MediationContext
  private moderationContext: ModerationContext
  private moderatedMediationContext: ModeratedMediationContext

  // Chi-square GOF column mapping (explicit user mapping)
  private chiSquareGofMapping: ChiSquareGofColumnMapping | null = null

  // Chi-square independence column mapping (explicit user mapping)
  private chiSquareMapping: ChiSquareColumnMapping | null = null

  // Fisher's Exact column mapping (explicit user mapping)
  private fisherExactMapping: FisherExactColumnMapping | null = null

  // McNemar column mapping (explicit user mapping)
  private mcnemarMapping: McNemarColumnMapping | null = null

  // Independent T-Test column mapping (explicit user mapping)
  private independentTTestMapping: IndependentTTestColumnMapping | null = null

  // Mann-Whitney U column mapping (explicit user mapping)
  private mannWhitneyMapping: MannWhitneyColumnMapping | null = null

  // Paired T-Test column mapping (explicit user mapping)
  private pairedTTestMapping: PairedTTestColumnMapping | null = null

  // Wilcoxon Signed-Rank Test column mapping (explicit user mapping)
  private wilcoxonMapping: WilcoxonColumnMapping | null = null

  // One-Way ANOVA column mapping (explicit user mapping for long format)
  private oneWayAnovaMapping: OneWayAnovaColumnMapping | null = null

  // Kruskal-Wallis Test column mapping (explicit user mapping for long format)
  private kruskalWallisMapping: KruskalWallisColumnMapping | null = null

  // Two-Way ANOVA factor role mapping (explicit user mapping for factor roles)
  private twoWayFactorMapping: TwoWayFactorMapping | null = null

  // Multifactorial ANOVA factor role mapping (explicit user mapping for factor roles)
  private multifactorialFactorMapping: MultifactorialFactorMapping | null = null

  // Scheirer-Ray-Hare factor role mapping (explicit user mapping for factor roles)
  private scheirerRayHareFactorMapping: TwoWayFactorMapping | MultifactorialFactorMapping | null = null

  // Encoding mappings (column name -> level -> code)
  // ONLY used for regression tests (dummy variable creation)
  private columnEncodingMappings: Map<string, Map<string, number>> = new Map()

  // Dataset reference (used in executeTest implementation)
  private _currentDataset: any // TODO: Type this properly

  // Dialog service for showing configuration dialogs
  private dialogService: IDialogService | null = null

  constructor(dialogService?: IDialogService) {
    // Initialize regression contexts
    this.linearRegressionContext = this.createRegressionContext()
    this.binaryLogisticRegressionContext = this.createRegressionContext()
    this.multinomialLogisticRegressionContext = this.createRegressionContext()

    // Initialize ANOVA contexts
    this.twoWayAnovaContext = this.createTwoWayAnovaContext()
    this.multiFactorialContext = this.createMultiFactorialContext()
    this.lmmAnovaContext = this.createLmmAnovaContext()
    this.scheirerRayHareContext = this.createScheirerContext()

    // Initialize survival contexts
    this.kaplanMeierContext = this.createKaplanMeierContext()
    this.coxRegressionContext = this.createCoxRegressionContext()
    this.nelsonAalenContext = this.createNelsonAalenContext()

    // Initialize mediation & moderation contexts
    this.mediationContext = this.createMediationContext()
    this.moderationContext = this.createModerationContext()
    this.moderatedMediationContext = this.createModeratedMediationContext()

    // Store dialog service (optional for testing)
    this.dialogService = dialogService ?? null
  }

  /**
   * Set dialog service after construction
   * Used by hooks to inject dialog display logic
   */
  public setDialogService(service: IDialogService): void {
    this.dialogService = service
  }

  /**
   * Get the current family ID (for debugging and context tracking)
   * @returns Current family ID or null if not set
   */
  public getCurrentFamilyId(): string | null {
    return this._currentFamilyId
  }

  // ============================================
  // Per-Family Column Selection Helpers
  // ============================================

  /**
   * Deep clone ColumnClassification array to prevent mutation leakage
   * Arrays like uniqueValues and suggestedTests are also cloned
   */
  private cloneColumns(columns: ColumnClassification[]): ColumnClassification[] {
    return columns.map(col => ({
      ...col,
      uniqueValues: [...col.uniqueValues],
      suggestedTests: [...col.suggestedTests],
    }))
  }

  /**
   * Store column selections for a specific family (with deep clone)
   */
  private setSelectedColumnsForFamily(familyId: string, columns: ColumnClassification[]): void {
    this.selectedColumnsByFamily.set(familyId, this.cloneColumns(columns))
  }

  /**
   * Get column selections for a specific family (returns cloned copy)
   * Returns undefined if family has no stored selections
   */
  private getSelectedColumnsForFamily(familyId: string): ColumnClassification[] | undefined {
    const stored = this.selectedColumnsByFamily.get(familyId)
    return stored ? this.cloneColumns(stored) : undefined
  }

  // ============================================
  // Context Factory Methods
  // ============================================

  private createRegressionContext(): RegressionContext {
    return {
      dependentVariable: null,
      predictors: [],
      outcomeEncoding: null,
      reset() {
        this.dependentVariable = null
        this.predictors = []
        this.outcomeEncoding = null
      },
    }
  }

  private createTwoWayAnovaContext(): TwoWayAnovaContext {
    return {
      factorAWithinB: false,
      factorBWithinA: false,
      adjustmentMethod: 'tukey',
      controlLevels: {},
      posthocQ: 0.05,
      reset() {
        this.factorAWithinB = false
        this.factorBWithinA = false
        this.adjustmentMethod = 'tukey'
        this.controlLevels = {}
        this.posthocQ = 0.05
      },
    }
  }

  private createMultiFactorialContext(): MultiFactorialContext {
    return {
      simpleEffects: [],
      adjustmentMethod: 'tukey',
      controlLevels: {},
      posthocQ: 0.05,
      reset() {
        this.simpleEffects = []
        this.adjustmentMethod = 'tukey'
        this.controlLevels = {}
        this.posthocQ = 0.05
      },
    }
  }

  private createLmmAnovaContext(): LmmAnovaContext {
    return {
      config: null,
      simpleEffects: [],
      adjustmentMethod: 'tukey',
      controlLevels: {},
      posthocQ: 0.05,
      reset() {
        this.config = null
        this.simpleEffects = []
        this.adjustmentMethod = 'tukey'
        this.controlLevels = {}
        this.posthocQ = 0.05
      },
    }
  }

  private createScheirerContext(): ScheirerSimpleEffectsContext {
    return {
      factorAWithinB: false,
      factorBWithinA: false,
      multiFactorEffects: [],
      reset() {
        this.factorAWithinB = false
        this.factorBWithinA = false
        this.multiFactorEffects = []
      },
    }
  }

  private createKaplanMeierContext(): KaplanMeierContext {
    return {
      timeVariable: null,
      eventVariable: null,
      groupVariable: null,
      eventEncoding: undefined,
      reset() {
        this.timeVariable = null
        this.eventVariable = null
        this.groupVariable = null
        this.eventEncoding = undefined
      },
    }
  }

  private createCoxRegressionContext(): CoxRegressionContext {
    return {
      timeVariable: null,
      eventVariable: null,
      covariates: [],
      eventEncoding: undefined,
      covariateEncodings: undefined,
      reset() {
        this.timeVariable = null
        this.eventVariable = null
        this.covariates = []
        this.eventEncoding = undefined
        this.covariateEncodings = undefined
      },
    }
  }

  private createNelsonAalenContext(): NelsonAalenContext {
    return {
      timeVariable: null,
      eventVariable: null,
      groupVariable: null,
      customTimePoints: [],
      eventEncoding: undefined,
      reset() {
        this.timeVariable = null
        this.eventVariable = null
        this.groupVariable = null
        this.customTimePoints = []
        this.eventEncoding = undefined
      },
    }
  }

  private createMediationContext(): MediationContext {
    return {
      independentVariable: null,
      mediator: null,
      dependentVariable: null,
      covariates: [],
      nBootstrap: 5000,
      confidenceLevel: 0.95,
      seed: 12345,
      ivEncoding: undefined,
      mediatorEncoding: undefined,
      dvEncoding: undefined,
      covariateEncodings: undefined,
      reset() {
        this.independentVariable = null
        this.mediator = null
        this.dependentVariable = null
        this.covariates = []
        this.nBootstrap = 5000
        this.confidenceLevel = 0.95
        this.seed = 12345
        this.ivEncoding = undefined
        this.mediatorEncoding = undefined
        this.dvEncoding = undefined
        this.covariateEncodings = undefined
      },
    }
  }

  private createModerationContext(): ModerationContext {
    return {
      independentVariable: null,
      moderator: null,
      dependentVariable: null,
      covariates: [],
      centerPredictor: false, // Default: no centering
      centerModerator: false, // Default: no centering
      probeValues: null,
      confidenceLevel: 0.95,
      seed: 12345,
      ivEncoding: undefined,
      moderatorEncoding: undefined,
      dvEncoding: undefined,
      covariateEncodings: undefined,
      reset() {
        this.independentVariable = null
        this.moderator = null
        this.dependentVariable = null
        this.covariates = []
        this.centerPredictor = false
        this.centerModerator = false
        this.probeValues = null
        this.confidenceLevel = 0.95
        this.seed = 12345
        this.ivEncoding = undefined
        this.moderatorEncoding = undefined
        this.dvEncoding = undefined
        this.covariateEncodings = undefined
      },
    }
  }

  private createModeratedMediationContext(): ModeratedMediationContext {
    return {
      independentVariable: null,
      mediator: null,
      moderator: null,
      dependentVariable: null,
      covariates: [],
      centerPredictor: false, // Default: no centering
      centerModerator: false, // Default: no centering
      probeValues: null,
      nBootstrap: 5000,
      confidenceLevel: 0.95,
      seed: 12345,
      ivEncoding: undefined,
      mediatorEncoding: undefined,
      moderatorEncoding: undefined,
      dvEncoding: undefined,
      covariateEncodings: undefined,
      reset() {
        this.independentVariable = null
        this.mediator = null
        this.moderator = null
        this.dependentVariable = null
        this.covariates = []
        this.centerPredictor = false // Default: no centering
        this.centerModerator = false // Default: no centering
        this.probeValues = null
        this.nBootstrap = 5000
        this.confidenceLevel = 0.95
        this.seed = 12345
        this.ivEncoding = undefined
        this.mediatorEncoding = undefined
        this.moderatorEncoding = undefined
        this.dvEncoding = undefined
        this.covariateEncodings = undefined
      },
    }
  }

  // ============================================
  // Test Detection Methods (Context-Aware Flow Control)
  // ============================================

  /**
   * Normalize test names (handles underscores/dashes)
   * Used by groupTestsByFamily() for test classification
   */
  private normalizeTestName(name: string): string {
    return name.toLowerCase().replace(/[_-]+/g, ' ').trim()
  }

  /**
   * Detect if linear regression tests are selected
   * Matches Avalonia: hasLinearRegressionSimple || hasLinearRegressionMultiple
   */
  private hasLinearRegression(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return normalized.includes('linear regression') || normalized.includes('simple linear')
    })
  }

  /**
   * Detect if logistic regression tests are selected
   */
  private hasLogisticRegression(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return (
        normalized.includes('logistic regression') ||
        normalized.includes('binary logistic') ||
        normalized.includes('multinomial logistic')
      )
    })
  }

  /**
   * Detect if binary logistic regression is selected
   */
  private hasBinaryLogistic(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return (
        normalized.includes('binary logistic') ||
        (normalized.includes('logistic regression') && !normalized.includes('multinomial'))
      )
    })
  }

  /**
   * Detect if multinomial logistic regression is selected
   */
  private hasMultinomialLogistic(): boolean {
    return this.selectedTests.some(test => this.normalizeTestName(test).includes('multinomial'))
  }

  /**
   * Detect if correlation tests are selected
   * Uses registry-driven family tag (NOT string matching)
   */
  private hasCorrelation(): boolean {
    return this.selectedTests.some(test => {
      const testDef = getTestDefinition(test)
      return testDef?.family === 'correlation'
    })
  }

  /**
   * Detect if any ANOVA is selected (one-way, two-way, multi-factorial)
   */
  private hasAnyANOVA(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return (
        normalized.includes('anova') ||
        normalized.includes('one way') ||
        normalized.includes('one-way')
      )
    })
  }

  /**
   * Detect if one-way ANOVA is selected
   */
  private hasOneWayANOVA(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return normalized.includes('one way') || normalized.includes('one-way')
    })
  }

  /**
   * Detect if two-way ANOVA is selected
   */
  private hasTwoWayANOVA(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return normalized.includes('two way') || normalized.includes('two-way')
    })
  }

  /**
   * Detect if multi-factorial ANOVA is selected (3+ factors)
   */
  private hasMultifactorialANOVA(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return (
        normalized.includes('multi factorial') ||
        normalized.includes('multifactorial') ||
        normalized.includes('multi-factorial')
      )
    })
  }

  /**
   * Detect if Linear Mixed Model is selected
   */
  private hasLmmAnova(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      const testDef = getTestDefinition(test)
      return testDef?.id === 'lmm_anova' || normalized.includes('linear mixed model')
    })
  }

  /**
   * Detect if independent samples t-test is selected
   */
  private hasIndependentTTest(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return (
        normalized.includes('independent') &&
        (normalized.includes('t test') || normalized.includes('ttest'))
      )
    })
  }

  /**
   * Detect if paired samples t-test is selected
   */
  private hasPairedTTest(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return (
        normalized.includes('paired') &&
        (normalized.includes('t test') || normalized.includes('ttest'))
      )
    })
  }

  /**
   * Detect if Wilcoxon Signed-Rank test is selected
   */
  private hasWilcoxon(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return normalized.includes('wilcoxon')
    })
  }

  /**
   * Detect if Mann-Whitney U test is selected
   */
  private hasMannWhitney(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return normalized.includes('mann') && normalized.includes('whitney')
    })
  }

  /**
   * Detect if one-sample t-test is selected
   */
  private hasOneSampleTTest(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return (
        normalized.includes('one sample') &&
        (normalized.includes('t test') || normalized.includes('ttest'))
      )
    })
  }

  /**
   * Detect if Friedman test is selected
   */
  private hasFriedman(): boolean {
    return this.selectedTests.some(test => this.normalizeTestName(test).includes('friedman'))
  }

  /**
   * Detect if Kruskal-Wallis test is selected
   */
  private hasKruskalWallis(): boolean {
    return this.selectedTests.some(test => this.normalizeTestName(test).includes('kruskal'))
  }

  /**
   * Detect if Scheirer-Ray-Hare is selected
   */
  private hasScheirerRayHare(): boolean {
    return this.selectedTests.some(test => this.normalizeTestName(test).includes('scheirer'))
  }

  /**
   * Detect if any dose-response test is selected
   */
  private hasDoseResponse(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return normalized.includes('dose response') || normalized.includes('dose-response')
    })
  }

  /**
   * Detect if any synergy test is selected
   */
  private hasSynergy(): boolean {
    return this.selectedTests.some(test => {
      const normalized = this.normalizeTestName(test)
      return normalized.includes('synergy')
    })
  }

  /**
   * Detect if any categorical predictors/factors exist in selected columns
   */
  private hasCategoricalPredictors(): boolean {
    return this.selectedColumns.some(
      column => column.dataType === ColumnDataType.Categorical || column.dataType === ColumnDataType.Binary
    )
  }

  /**
   * Detect if DV selection dialog is needed
   * Needed for: ANOVA, Friedman, Scheirer-Ray-Hare, Regression (multiple columns)
   */
  private needsDVSelectionDialog(): boolean {
    const hasANOVA =
      this.hasAnyANOVA() ||
      this.hasTwoWayANOVA() ||
      this.hasMultifactorialANOVA() ||
      this.hasFriedman() ||
      this.hasScheirerRayHare()

    const hasRegression = this.hasLinearRegression() || this.hasLogisticRegression()

    // Need DV dialog if ANOVA or regression with 2+ columns
    return hasANOVA || (hasRegression && this.selectedColumns.length >= 2)
  }

  // ============================================
  // Main Orchestration Method
  // ============================================

  /**
   * Main orchestration method - replicates Avalonia's RunAnalysis()
   * Coordinates multi-step configuration workflow
   *
   * Flow:
   * 1. Reset contexts
   * 2. Conditional DV selection dialog
   * 3. Conditional DV encoding dialog (logistic regression)
   * 4. Conditional factor encoding dialog (categorical predictors)
   * 5. Conditional multi-factorial config dialog (3+ factors)
   * 6. Execute all tests with collected configuration
   *
   * @param tests - Selected test names
   * @param columns - Selected columns (classifications)
   * @param dataset - Current dataset
   */
  /**
   * Main orchestration entry point
   * Replicates Avalonia's per-family orchestration approach
   * Reference: StatisticalAnalysisViewModel.cs lines 1586-2120
   */
  public async runAnalysisWithTests(
    tests: string[],
    columns: ColumnClassification[],
    dataset: any,
    familyId?: string | null
  ): Promise<void> {
    const { execution, startExecution, completeExecution } = useAnalysisStore.getState()
    if (execution.status === 'running' || execution.status === 'validating') {
      toast.warning('A test is already running. Please wait for it to complete.')
      return
    }

    const appStore = useAppStore.getState()
    if (appStore.appOperationLock.active) {
      toast.warning('Another operation is already running. Please wait for it to complete.')
      return
    }
    const appLockToken = appStore.acquireAppOperationLock({
      owner: 'statistics',
      operation: 'statistics_analysis',
      stage: tests.length > 1 ? `Running ${tests.length} statistical tests` : 'Running statistical analysis',
      progress: 0,
    })
    if (!appLockToken) {
      toast.warning('Another operation is already running. Please wait for it to complete.')
      return
    }

    let executionSucceeded = false
    let executionStarted = false

    try {
      startExecution()
      executionStarted = true

      // Store inputs
      this.selectedTests = tests
      this._currentDataset = dataset
      await ensureProjectId()

      // Store family-scoped columns with deep clone to prevent mutation leakage
      if (familyId) {
        this._currentFamilyId = familyId
        this.setSelectedColumnsForFamily(familyId, columns)
        // Use cloned copy for execution (prevents in-place mutations from affecting stored state)
        this.selectedColumns = this.getSelectedColumnsForFamily(familyId) || this.cloneColumns(columns)
      } else {
        // Fallback: clone columns for execution (backward compatibility)
        this.selectedColumns = this.cloneColumns(columns)
      }

      // Determine if any of the selected tests require DV selection (mirrors Avalonia)
      this.needsDVSelectionDialog()

      // Reset all contexts
      this.resetAllContexts()

      // Group tests by family
      const testsByFamily = this.groupTestsByFamily(tests)

      // Run each family's orchestration independently
      // Matches Avalonia's separate orchestration blocks

      if (testsByFamily.twoWayAnova.length > 0) {
        await this.orchestrateTwoWayAnova(testsByFamily.twoWayAnova)
      }

      if (testsByFamily.oneWayAnova.length > 0) {
        await this.orchestrateOneWayAnova(testsByFamily.oneWayAnova)
      }

      if (testsByFamily.kruskalWallis.length > 0) {
        await this.orchestrateKruskalWallis(testsByFamily.kruskalWallis)
      }

      if (testsByFamily.independentTTest.length > 0) {
        await this.orchestrateIndependentTTest(testsByFamily.independentTTest)
      }

      if (testsByFamily.pairedTTest.length > 0) {
        await this.orchestratePairedTTest(testsByFamily.pairedTTest)
      }

      if (testsByFamily.wilcoxon.length > 0) {
        await this.orchestrateWilcoxon(testsByFamily.wilcoxon)
      }

      if (testsByFamily.mannWhitney.length > 0) {
        await this.orchestrateMannWhitney(testsByFamily.mannWhitney)
      }

      if (testsByFamily.oneSampleTTest.length > 0) {
        await this.orchestrateOneSampleTTest(testsByFamily.oneSampleTTest)
      }

      if (testsByFamily.scheirerRayHare.length > 0) {
        await this.orchestrateScheirerRayHare(testsByFamily.scheirerRayHare)
      }

      if (testsByFamily.multifactorialAnova.length > 0) {
        await this.orchestrateMultifactorialAnova(testsByFamily.multifactorialAnova)
      }

      if (testsByFamily.lmmAnova.length > 0) {
        await this.orchestrateLmmAnova(testsByFamily.lmmAnova)
      }

      if (testsByFamily.friedman.length > 0) {
        await this.orchestrateFriedman(testsByFamily.friedman)
      }

      if (testsByFamily.binaryLogistic.length > 0) {
        await this.orchestrateBinaryLogistic(testsByFamily.binaryLogistic)
      }

      if (testsByFamily.multinomialLogistic.length > 0) {
        await this.orchestrateMultinomialLogistic(testsByFamily.multinomialLogistic)
      }

      if (testsByFamily.linearRegression.length > 0) {
        await this.orchestrateLinearRegression(testsByFamily.linearRegression)
      }

      // Pharmacology tests (no dialogs needed - direct execution)
      if (testsByFamily.doseResponse.length > 0) {
        await this.orchestrateDoseResponse(testsByFamily.doseResponse)
      }

      if (testsByFamily.synergy.length > 0) {
        await this.orchestrateSynergy(testsByFamily.synergy)
      }

      // Correlation tests (no dialogs needed - direct execution)
      if (testsByFamily.correlation.length > 0) {
        await this.orchestrateCorrelation(testsByFamily.correlation)
      }

      // Categorical tests (no dialogs needed - direct execution)
      if (testsByFamily.categorical.length > 0) {
        await this.orchestrateCategorical(testsByFamily.categorical)
      }

      // Descriptive tests (no dialogs needed - direct execution)
      if (testsByFamily.descriptive.length > 0) {
        await this.orchestrateDescriptive(testsByFamily.descriptive)
      }

      // Distribution tests (no dialogs needed - direct execution)
      if (testsByFamily.distribution.length > 0) {
        await this.orchestrateDistribution(testsByFamily.distribution)
      }

      // Survival tests (dialog needed for variable selection and event encoding)
      if (testsByFamily.survival.length > 0) {
        await this.orchestrateSurvival(testsByFamily.survival)
      }

      // Mediation tests (Model 4)
      if (testsByFamily.mediation.length > 0) {
        await this.orchestrateMediation(testsByFamily.mediation)
      }

      // Moderation tests (Models 1 & 7)
      if (testsByFamily.moderation.length > 0) {
        // Separate Model 1 (simple moderation) from Model 7 (moderated mediation)
        const model1Tests = testsByFamily.moderation.filter((t: string) => t.includes('model1'))
        const model7Tests = testsByFamily.moderation.filter((t: string) => t.includes('model7'))

        if (model1Tests.length > 0) {
          await this.orchestrateModeration(model1Tests)
        }
        if (model7Tests.length > 0) {
          await this.orchestrateModeratedMediation(model7Tests)
        }
      }

      executionSucceeded = true
    } catch (error) {
      console.error('Error during analysis orchestration:', error)
      if (!wasErrorToastShown(error)) {
        const structuredError = extractAppError(error)
        if (structuredError) {
          showAppErrorToast(structuredError)
          markErrorToastShown(error)
        } else {
          toast.error(`Analysis failed: ${extractErrorMessage(error, 'Analysis failed')}`)
          markErrorToastShown(error)
        }
      }
      throw error
    } finally {
      if (executionStarted) {
        completeExecution(executionSucceeded)
      }
      useAppStore.getState().releaseAppOperationLock(appLockToken)
    }
  }

  // ============================================
  // Helper Methods (To Be Implemented)
  // ============================================

  private resetAllContexts(): void {
    // Reset regression contexts
    this.linearRegressionContext.reset()
    this.binaryLogisticRegressionContext.reset()
    this.multinomialLogisticRegressionContext.reset()

    // Reset ANOVA contexts
    this.twoWayAnovaContext.reset()
    this.multiFactorialContext.reset()
    this.lmmAnovaContext.reset()
    this.scheirerRayHareContext.reset()

    // Reset survival contexts
    this.kaplanMeierContext.reset()
    this.coxRegressionContext.reset()
    this.nelsonAalenContext.reset()

    // Reset mediation & moderation contexts
    this.mediationContext.reset()
    this.moderationContext.reset()
    this.moderatedMediationContext.reset()

    // Clear encoding mappings (used only for regression)
    this.columnEncodingMappings.clear()
  }

  private async promptForDependentVariable(): Promise<DependentVariableDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showDVSelectionDialog()
  }

  private async showDVEncodingDialog(): Promise<EncodingDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showDVEncodingDialog()
  }

  private async showFactorEncodingDialog(): Promise<FactorEncodingDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showFactorEncodingDialog()
  }

  private async showSimpleEffectsDialog(): Promise<SimpleEffectsDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showSimpleEffectsDialog()
  }

  private async showMultiFactorialSimpleEffectsDialog(
    factorNames: string[],
    testIdPrefix?: string
  ): Promise<MultiFactorialSimpleEffectsDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showMultiFactorialSimpleEffectsDialog(
      factorNames,
      testIdPrefix
    )
  }

  private async showLmmAnovaConfigDialog(): Promise<LmmAnovaConfigDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showLmmAnovaConfigDialog()
  }

  /**
   * Show dose-response column mapper dialog
   * @param testName - Display name of the dose-response test (e.g., "3PL Dose-Response", "4PL Dose-Response")
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showDoseResponseColumnMapperDialogForTest(testName: string): Promise<DoseResponseColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showDoseResponseColumnMapperDialog(testName)
  }

  /**
   * Show synergy column mapper dialog
   * @param testName - Display name of the synergy test (e.g., "Bliss Independence")
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showSynergyColumnMapperDialogForTest(testName: string): Promise<SynergyColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showSynergyColumnMapperDialog(testName)
  }

  /**
   * Show chi-square GOF column mapper dialog
   * @param testName - Display name of the GOF test
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showChiSquareGofColumnMapperDialogForTest(
    testName: string
  ): Promise<ChiSquareGofColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showChiSquareGofColumnMapperDialog(testName)
  }

  /**
   * Show chi-square independence column mapper dialog
   * @param testName - Display name of the chi-square test
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showChiSquareColumnMapperDialogForTest(
    testName: string
  ): Promise<ChiSquareColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showChiSquareColumnMapperDialog(testName)
  }

  /**
   * Show Fisher's Exact column mapper dialog
   * @param testName - Display name of the Fisher's Exact test
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showFisherExactColumnMapperDialogForTest(
    testName: string
  ): Promise<FisherExactColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showFisherExactColumnMapperDialog(testName)
  }

  /**
   * Show McNemar column mapper dialog for a specific test
   *
   * @param testName - Display name of the McNemar's test
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showMcNemarColumnMapperDialogForTest(
    testName: string
  ): Promise<McNemarColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showMcNemarColumnMapperDialog(testName)
  }

  /**
   * Show Independent T-Test column mapper dialog for a specific test
   *
   * @param testName - Display name of the T-Test
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showIndependentTTestColumnMapperDialogForTest(
    testName: string
  ): Promise<IndependentTTestColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showIndependentTTestColumnMapperDialog(testName)
  }

  private async showMannWhitneyColumnMapperDialogForTest(
    testName: string
  ): Promise<MannWhitneyColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showMannWhitneyColumnMapperDialog(testName)
  }

  /**
   * Show Paired T-Test column mapper dialog for a specific test
   *
   * @param testName - Display name of the T-Test
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showPairedTTestColumnMapperDialogForTest(
    testName: string
  ): Promise<PairedTTestColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showPairedTTestColumnMapperDialog(testName)
  }

  /**
   * Show Wilcoxon Signed-Rank Test column mapper dialog for a specific test
   *
   * @param testName - Display name of the Wilcoxon test
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showWilcoxonColumnMapperDialogForTest(
    testName: string
  ): Promise<WilcoxonColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showWilcoxonColumnMapperDialog(testName)
  }

  /**
   * Show One-Way ANOVA column mapper dialog for a specific test
   *
   * @param testName - Display name of the ANOVA test
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showOneWayAnovaColumnMapperDialogForTest(
    testName: string
  ): Promise<OneWayAnovaColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showOneWayAnovaColumnMapperDialog(testName)
  }

  /**
   * Show Kruskal-Wallis Test column mapper dialog for a specific test
   *
   * @param testName - Display name of the Kruskal-Wallis test
   * @returns Promise resolving to dialog result with column mapping
   */
  private async showKruskalWallisColumnMapperDialogForTest(
    testName: string
  ): Promise<KruskalWallisColumnMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showKruskalWallisColumnMapperDialog(testName)
  }

  /**
   * Show Two-Way ANOVA factor mapper dialog
   * @returns Promise resolving to dialog result with factor role mapping
   */
  private async showTwoWayFactorMapperDialog(): Promise<TwoWayFactorMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showTwoWayFactorMapperDialog()
  }

  /**
   * Show Multifactorial ANOVA factor mapper dialog
   * @returns Promise resolving to dialog result with factor role mapping
   */
  private async showMultifactorialFactorMapperDialog(): Promise<MultifactorialFactorMapperDialogResult> {
    if (!this.dialogService) {
      throw new Error('Dialog service not initialized. Call setDialogService() first.')
    }
    return await this.dialogService.showMultifactorialFactorMapperDialog()
  }

  // ============================================
  // Helper Methods (Phase 1: Per-Family Orchestration)
  // ============================================

  /**
   * Reorder columns to put DV first (modules assume columns[0] is DV)
   */
  private reorderColumnsDVFirst(dvName: string): void {
    const dvColumn = this.selectedColumns.find(col => col.columnName === dvName)
    if (dvColumn) {
      this.selectedColumns = [
        dvColumn,
        ...this.selectedColumns.filter(col => col.columnName !== dvName)
      ]
    }
  }

  /**
   * Get categorical factors excluding DV
   */
  private getCategoricalFactorsExcludingDV(dvName: string): ColumnClassification[] {
    return this.selectedColumns.filter(
      col =>
        (col.dataType === ColumnDataType.Categorical ||
         col.dataType === ColumnDataType.Binary) &&
        col.columnName !== dvName
    )
  }

  /**
   * Update dialog context to include only numeric columns for DV selection.
   * Returns false if no numeric columns are available.
   */
  private prepareNumericDVContext(tests: string[], errorMessage: string): boolean {
    // Include both Numeric and Ordinal columns as valid DV candidates
    // (Ordinal can be treated as continuous for ANOVA when appropriate)
    const numericColumns = this.selectedColumns.filter(
      col => col.dataType === ColumnDataType.Numeric ||
             col.dataType === ColumnDataType.Ordinal
    )

    if (numericColumns.length === 0) {
      toast.error(errorMessage)
      return false
    }

    this.dialogService?.updateDialogContext({
      columns: numericColumns,
      selectedTests: tests,
    })
    return true
  }

  /**
   * Find column by name
   */
  private findColumn(columnName: string): ColumnClassification | undefined {
    return this.selectedColumns.find(
      col => col.columnName === columnName || col.columnId === columnName
    )
  }

  /**
   * Group tests by family for per-family orchestration
   * Matches Avalonia's approach of separate orchestration blocks
   */
  private groupTestsByFamily(tests: string[]): {
    twoWayAnova: string[]
    oneWayAnova: string[]
    kruskalWallis: string[]
    scheirerRayHare: string[]
    multifactorialAnova: string[]
    lmmAnova: string[]
    independentTTest: string[]
    pairedTTest: string[]
    wilcoxon: string[]
    mannWhitney: string[]
    oneSampleTTest: string[]
    friedman: string[]
    binaryLogistic: string[]
    multinomialLogistic: string[]
    linearRegression: string[]
    doseResponse: string[]
    synergy: string[]
    correlation: string[] // Registry-driven family
    categorical: string[] // Registry-driven family (chi-square, Fisher's, McNemar)
    descriptive: string[] // Registry-driven family (descriptive stats, outlier detection)
    distribution: string[] // Registry-driven family (normality tests)
    survival: string[] // Registry-driven family (Kaplan-Meier, Cox, Nelson-Aalen)
    mediation: string[] // Registry-driven family (Model 4)
    moderation: string[] // Registry-driven family (Models 1, 7)
  } {
    const families = {
      twoWayAnova: [] as string[],
      oneWayAnova: [] as string[],
      kruskalWallis: [] as string[],
      scheirerRayHare: [] as string[],
      multifactorialAnova: [] as string[],
      lmmAnova: [] as string[],
      independentTTest: [] as string[],
      pairedTTest: [] as string[],
      wilcoxon: [] as string[],
      mannWhitney: [] as string[],
      oneSampleTTest: [] as string[],
      friedman: [] as string[],
      binaryLogistic: [] as string[],
      multinomialLogistic: [] as string[],
      linearRegression: [] as string[],
      doseResponse: [] as string[],
      synergy: [] as string[],
      correlation: [] as string[], // Registry-driven family
      categorical: [] as string[], // Registry-driven family (chi-square, Fisher's, McNemar)
      descriptive: [] as string[], // Registry-driven family (descriptive stats, outlier detection)
      distribution: [] as string[], // Registry-driven family (normality tests)
      survival: [] as string[], // Registry-driven family (Kaplan-Meier, Cox, Nelson-Aalen)
      mediation: [] as string[], // Registry-driven family (Model 4)
      moderation: [] as string[], // Registry-driven family (Models 1, 7)
    }

    for (const test of tests) {
      // PREFER registry-driven family tag over string matching
      const testDef = getTestDefinition(test)
      if (testDef?.family === 'correlation') {
        families.correlation.push(test)
        continue // Skip string-based matching
      }
      if (testDef?.family === 'categorical') {
        families.categorical.push(test)
        continue // Skip string-based matching
      }
      if (testDef?.family === 'descriptive') {
        families.descriptive.push(test)
        continue // Skip string-based matching
      }
      if (testDef?.family === 'distribution') {
        families.distribution.push(test)
        continue // Skip string-based matching
      }
      if (testDef?.family === 'survival') {
        families.survival.push(test)
        continue // Skip string-based matching
      }
      if (testDef?.family === 'mediation') {
        families.mediation.push(test)
        continue // Skip string-based matching
      }
      if (testDef?.family === 'moderation') {
        families.moderation.push(test)
        continue // Skip string-based matching
      }
      if (testDef?.id === 'lmm_anova') {
        families.lmmAnova.push(test)
        continue
      }

      const normalized = this.normalizeTestName(test)

      if (normalized.includes('two way') || normalized.includes('two-way')) {
        families.twoWayAnova.push(test)
      } else if (normalized.includes('one way') || normalized.includes('one-way')) {
        families.oneWayAnova.push(test)
      } else if (normalized.includes('kruskal')) {
        families.kruskalWallis.push(test)
      } else if (
        normalized.includes('independent') &&
        (normalized.includes('t test') || normalized.includes('ttest'))
      ) {
        families.independentTTest.push(test)
      } else if (
        normalized.includes('paired') &&
        (normalized.includes('t test') || normalized.includes('ttest'))
      ) {
        families.pairedTTest.push(test)
      } else if (normalized.includes('wilcoxon')) {
        families.wilcoxon.push(test)
      } else if (normalized.includes('mann') && normalized.includes('whitney')) {
        families.mannWhitney.push(test)
      } else if (
        normalized.includes('one sample') &&
        (normalized.includes('t test') || normalized.includes('ttest'))
      ) {
        families.oneSampleTTest.push(test)
      } else if (normalized.includes('scheirer')) {
        families.scheirerRayHare.push(test)
      } else if (normalized.includes('multi factorial') || normalized.includes('multifactorial')) {
        families.multifactorialAnova.push(test)
      } else if (normalized.includes('linear mixed model')) {
        families.lmmAnova.push(test)
      } else if (normalized.includes('friedman')) {
        families.friedman.push(test)
      } else if (
        normalized.includes('binary logistic') ||
        (normalized.includes('logistic regression') && !normalized.includes('multinomial'))
      ) {
        families.binaryLogistic.push(test)
      } else if (normalized.includes('multinomial')) {
        families.multinomialLogistic.push(test)
      } else if (normalized.includes('linear regression')) {
        families.linearRegression.push(test)
      } else if (normalized.includes('dose response') || normalized.includes('dose-response')) {
        families.doseResponse.push(test)
      } else if (normalized.includes('synergy')) {
        families.synergy.push(test)
      }
    }

    return families
  }

  // ============================================
  // Per-Family Orchestration Methods
  // ============================================

  /**
   * Orchestrate Two-Way ANOVA
   * Flow: DV selection → Execute (NO factor encoding for ANOVA)
   *
   * ANOVA uses effect coding internally, not dummy variables.
   * No user baseline selection needed - factors are treated as categorical.
   */
  private async orchestrateTwoWayAnova(tests: string[]): Promise<void> {
    if (!this.hasTwoWayANOVA()) {
      return
    }

    // Reset mapping to avoid stale state across runs
    this.twoWayFactorMapping = null

    // Step 1: DV Selection (numeric-only)
    const hasNumericDV = this.prepareNumericDVContext(
      tests,
      'Two-Way ANOVA requires at least one numeric dependent variable'
    )
    if (!hasNumericDV) {
      return
    }

    const dvResult = await this.promptForDependentVariable()
    if (dvResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    const dvName = dvResult.selectedVariable
    this.reorderColumnsDVFirst(dvName)

    // Step 2: Validate factor count (2 factors exactly)
    const factorColumns = this.getCategoricalFactorsExcludingDV(dvName)

    if (factorColumns.length !== 2) {
      toast.error('Two-Way ANOVA requires exactly 2 categorical factors')
      return
    }

    // Update dialog context so UI shows correct factor names
    const dvColumn = this.selectedColumns[0]

    // CRITICAL: Filter selectedColumns to only DV + categorical factors
    // This prevents extra numeric columns (e.g., ID columns) from being passed to module validation
    this.selectedColumns = dvColumn ? [dvColumn, ...factorColumns] : factorColumns

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // NO FACTOR ENCODING DIALOG FOR ANOVA
    // ANOVA treats factors as pure categorical variables with effect coding
    // No baseline selection needed - Python handles factor encoding internally

    // Step 2.5: Factor Role Mapping Dialog
    // Allows user to explicitly assign Factor A (primary/x-axis) and Factor B (secondary/grouping)
    const factorMapperResult = await this.showTwoWayFactorMapperDialog()

    if (factorMapperResult.cancelled) {
      toast.info('Analysis cancelled')
      this.twoWayFactorMapping = null
      return
    }

    // Store the factor role mapping for use in executeTest
    this.twoWayFactorMapping = factorMapperResult.mapping

    // Step 3: Simple Effects Dialog (optional - user can skip)
    // Allows user to request pairwise comparisons for interaction interpretation
    const simpleEffectsResult = await this.showSimpleEffectsDialog()

    if (simpleEffectsResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    // Store simple effects configuration in context
    this.twoWayAnovaContext.factorAWithinB = simpleEffectsResult.factorAWithinB
    this.twoWayAnovaContext.factorBWithinA = simpleEffectsResult.factorBWithinA
    this.twoWayAnovaContext.adjustmentMethod =
      simpleEffectsResult.adjustmentMethod ?? 'tukey'
    this.twoWayAnovaContext.controlLevels =
      simpleEffectsResult.controlLevels ?? {}
    this.twoWayAnovaContext.posthocQ =
      simpleEffectsResult.posthocQ ?? this.twoWayAnovaContext.posthocQ ?? 0.05

    // Execute tests
    for (const test of tests) {
      await this.executeTest(test)
    }

    // Clear mapping after execution
    this.twoWayFactorMapping = null
  }

  /**
   * Orchestrate One-Way ANOVA
   * Flow: Show column mapper dialog for long format (2 cols) → Execute test with explicit mapping
   */
  private async orchestrateOneWayAnova(tests: string[]): Promise<void> {
    if (!this.hasOneWayANOVA() || tests.length === 0) {
      return
    }

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Show column mapper dialog for One-Way ANOVA
    // Long format: map group/outcome; Wide format: configure post-hoc settings only.
    const testDef = getTestDefinition(tests[0]!)
    const testDisplayName = testDef?.displayName ?? 'One-Way ANOVA'
    const mapperResult = await this.showOneWayAnovaColumnMapperDialogForTest(testDisplayName)

    if (mapperResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    // Store the mapping for use in executeTest
    this.oneWayAnovaMapping = mapperResult.mapping

    for (const test of tests) {
      await this.executeTest(test)
    }

    // Clear the mapping after execution
    this.oneWayAnovaMapping = null
  }

  /**
   * Orchestrate Kruskal-Wallis Test
   * Flow: Show column mapper dialog for long format (2 cols) → Execute test with explicit mapping
   */
  private async orchestrateKruskalWallis(tests: string[]): Promise<void> {
    if (!this.hasKruskalWallis() || tests.length === 0) {
      return
    }

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Show column mapper dialog for Kruskal-Wallis
    // Long format: map group/outcome. Wide format: configure post-hoc settings only.
    const testDef = getTestDefinition(tests[0]!)
    const testDisplayName = testDef?.displayName ?? 'Kruskal-Wallis Test'
    const mapperResult = await this.showKruskalWallisColumnMapperDialogForTest(testDisplayName)

    if (mapperResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    // Store the mapping for use in executeTest
    this.kruskalWallisMapping = mapperResult.mapping

    for (const test of tests) {
      await this.executeTest(test)
    }

    // Clear the mapping after execution
    this.kruskalWallisMapping = null
  }

  /**
   * Orchestrate Independent Samples T-Test
   * Flow: Direct execution (module validates column requirements)
   */
  private async orchestrateIndependentTTest(tests: string[]): Promise<void> {
    if (!this.hasIndependentTTest() || tests.length === 0) {
      return
    }

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Show column mapper dialog for Independent T-Test
    const testDef = getTestDefinition(tests[0]!)
    const testDisplayName = testDef?.displayName ?? 'Independent T-Test'
    const mapperResult = await this.showIndependentTTestColumnMapperDialogForTest(testDisplayName)

    if (mapperResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    // Store the mapping for use in executeTest
    this.independentTTestMapping = mapperResult.mapping

    for (const test of tests) {
      await this.executeTest(test)
    }

    // Clear mapping after execution
    this.independentTTestMapping = null
  }

  /**
   * Orchestrate Paired Samples T-Test
   * Flow: Column mapper dialog → Direct execution (module validates paired columns)
   */
  private async orchestratePairedTTest(tests: string[]): Promise<void> {
    if (!this.hasPairedTTest() || tests.length === 0) {
      return
    }

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Show column mapper dialog for Paired T-Test
    const testDef = getTestDefinition(tests[0]!)
    const testDisplayName = testDef?.displayName ?? 'Paired T-Test'
    const mapperResult = await this.showPairedTTestColumnMapperDialogForTest(testDisplayName)

    if (mapperResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    // Store the mapping for use in executeTest
    this.pairedTTestMapping = mapperResult.mapping

    for (const test of tests) {
      await this.executeTest(test)
    }

    // Clear the mapping after execution
    this.pairedTTestMapping = null
  }

  /**
   * Orchestrate Wilcoxon Signed-Rank Test
   * Flow: Show column mapper dialog → Execute test with explicit mapping
   */
  private async orchestrateWilcoxon(tests: string[]): Promise<void> {
    if (!this.hasWilcoxon() || tests.length === 0) {
      return
    }

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Show column mapper dialog for Wilcoxon Signed-Rank Test
    const testDef = getTestDefinition(tests[0]!)
    const testDisplayName = testDef?.displayName ?? 'Wilcoxon Signed-Rank Test'
    const mapperResult = await this.showWilcoxonColumnMapperDialogForTest(testDisplayName)

    if (mapperResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    // Store the mapping for use in executeTest
    this.wilcoxonMapping = mapperResult.mapping

    for (const test of tests) {
      await this.executeTest(test)
    }

    // Clear the mapping after execution
    this.wilcoxonMapping = null
  }

  /**
   * Orchestrate Mann-Whitney U Test
   * Flow: Direct execution (module validates independent columns in long format)
   */
  private async orchestrateMannWhitney(tests: string[]): Promise<void> {
    if (!this.hasMannWhitney() || tests.length === 0) {
      return
    }

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Show column mapper dialog for Mann-Whitney U Test
    const testDef = getTestDefinition(tests[0]!)
    const testDisplayName = testDef?.displayName ?? 'Mann-Whitney U Test'
    const mapperResult = await this.showMannWhitneyColumnMapperDialogForTest(testDisplayName)

    if (mapperResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    // Store the mapping for use in executeTest
    this.mannWhitneyMapping = mapperResult.mapping

    for (const test of tests) {
      await this.executeTest(test)
    }

    // Clear mapping after execution
    this.mannWhitneyMapping = null
  }

  /**
   * Orchestrate One-Sample T-Test
   * Flow: Direct execution (module validates single column)
   */
  private async orchestrateOneSampleTTest(tests: string[]): Promise<void> {
    if (!this.hasOneSampleTTest() || tests.length === 0) {
      return
    }

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    for (const test of tests) {
      await this.executeTest(test)
    }
  }

  /**
   * Orchestrate Scheirer-Ray-Hare (Nonparametric Multi-Factorial ANOVA)
   * Flow: DV selection → Factor role mapping → Execute
   *
   * Nonparametric ANOVA - uses rank-based analysis.
   * Factor mapping ensures explicit role assignment (like Two-Way/Multifactorial ANOVA).
   * NO simple effects dialog - interpretation is less meaningful for rank-based tests.
   */
  private async orchestrateScheirerRayHare(tests: string[]): Promise<void> {
    if (!this.hasScheirerRayHare()) {
      return
    }

    // Reset mapping to avoid stale state across runs
    this.scheirerRayHareFactorMapping = null

    // Step 1: DV Selection (numeric-only)
    this.scheirerRayHareContext.reset()
    const hasNumericDV = this.prepareNumericDVContext(
      tests,
      'Scheirer-Ray-Hare test requires a numeric dependent variable'
    )
    if (!hasNumericDV) {
      return
    }

    const dvResult = await this.promptForDependentVariable()
    if (dvResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    const dvName = dvResult.selectedVariable
    this.reorderColumnsDVFirst(dvName)

    // Step 2: Validate factor count (2+ factors)
    const factorColumns = this.getCategoricalFactorsExcludingDV(dvName)

    if (factorColumns.length < 2) {
      toast.error('Scheirer-Ray-Hare requires 2+ categorical factors')
      return
    }

    const dvColumn = this.selectedColumns[0]

    // CRITICAL: Filter selectedColumns to only DV + categorical factors
    // This prevents extra numeric columns (e.g., ID columns) from being passed to module validation
    this.selectedColumns = dvColumn ? [dvColumn, ...factorColumns] : factorColumns

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // NO FACTOR ENCODING - Scheirer-Ray-Hare uses rank-based nonparametric analysis
    // Python backend handles all factor processing automatically

    // Step 3: Factor Role Mapping Dialog
    // Allows user to explicitly assign factor roles for plot layout
    if (factorColumns.length === 2) {
      // Two factors: use two-way factor mapper
      const factorMapperResult = await this.showTwoWayFactorMapperDialog()

      if (factorMapperResult.cancelled) {
        toast.info('Analysis cancelled')
        this.scheirerRayHareFactorMapping = null
        return
      }

      // Store the factor role mapping for use in executeTest
      this.scheirerRayHareFactorMapping = factorMapperResult.mapping
    } else {
      // Three or more factors: use multifactorial factor mapper
      const factorMapperResult = await this.showMultifactorialFactorMapperDialog()

      if (factorMapperResult.cancelled) {
        toast.info('Analysis cancelled')
        this.scheirerRayHareFactorMapping = null
        return
      }

      // Store the factor role mapping for use in executeTest
      this.scheirerRayHareFactorMapping = factorMapperResult.mapping
    }

    // Execute tests
    for (const test of tests) {
      await this.executeTest(test)
    }

    // Clear mapping after execution
    this.scheirerRayHareFactorMapping = null
  }

  /**
   * Orchestrate Multi-Factorial ANOVA (3+ factors)
   * Flow: DV selection → Validate factors → Execute (NO encoding, NO config dialog)
   *
   * ANOVA with 3+ factors - examines main effects and interactions.
   * No baseline encoding needed - factors are categorical with effect coding.
   */
  private async orchestrateMultifactorialAnova(tests: string[]): Promise<void> {
    if (!this.hasMultifactorialANOVA()) {
      return
    }

    // Reset mapping to avoid stale state across runs
    this.multifactorialFactorMapping = null

    // Step 1: DV Selection (numeric-only)
    const hasNumericDV = this.prepareNumericDVContext(
      tests,
      'Multi-Factorial ANOVA requires a numeric dependent variable'
    )
    if (!hasNumericDV) {
      return
    }

    const dvResult = await this.promptForDependentVariable()
    if (dvResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    const dvName = dvResult.selectedVariable
    this.reorderColumnsDVFirst(dvName)

    // Step 2: Validate factor count (3+ factors)
    const factorColumns = this.getCategoricalFactorsExcludingDV(dvName)

    if (factorColumns.length < 3) {
      toast.error('Multi-Factorial ANOVA requires 3+ categorical factors')
      return
    }

    const dvColumn = this.selectedColumns[0]

    // CRITICAL: Filter selectedColumns to only DV + categorical factors
    // This prevents extra numeric columns (e.g., ID columns) from being passed to module validation
    this.selectedColumns = dvColumn ? [dvColumn, ...factorColumns] : factorColumns

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // NO FACTOR ENCODING - Multi-factorial ANOVA uses effect coding
    // Python backend handles factor processing and interaction terms automatically

    // Step 2.5: Factor Role Mapping Dialog
    // Allows user to explicitly assign Primary (x-axis), Secondary (series), and Facet factors (panels)
    const factorMapperResult = await this.showMultifactorialFactorMapperDialog()

    if (factorMapperResult.cancelled) {
      toast.info('Analysis cancelled')
      this.multifactorialFactorMapping = null
      return
    }

    // Store the factor role mapping for use in executeTest
    this.multifactorialFactorMapping = factorMapperResult.mapping

    // Step 3: Multi-Factorial Simple Effects Dialog
    // Pass factor names directly to avoid async state timing issues
    const factorNames = factorColumns.map(col => col.columnName)
    const multiFactorialResult = await this.showMultiFactorialSimpleEffectsDialog(factorNames)

    if (multiFactorialResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    // Store simple effects configuration
    this.multiFactorialContext.simpleEffects = multiFactorialResult.simpleEffects
    this.multiFactorialContext.adjustmentMethod =
      multiFactorialResult.adjustmentMethod ?? 'tukey'
    this.multiFactorialContext.controlLevels =
      multiFactorialResult.controlLevels ?? {}
    this.multiFactorialContext.posthocQ =
      multiFactorialResult.posthocQ ?? this.multiFactorialContext.posthocQ ?? 0.05

    // Execute tests
    for (const test of tests) {
      await this.executeTest(test)
    }

    // Clear mapping after execution
    this.multifactorialFactorMapping = null
  }

  /**
   * Orchestrate Linear Mixed Model
   * Flow: dedicated LMM config dialog -> optional simple effects -> execute
   */
  private async orchestrateLmmAnova(tests: string[]): Promise<void> {
    if (!this.hasLmmAnova()) {
      return
    }

    this.lmmAnovaContext.reset()

    const lmmConfigResult = await this.showLmmAnovaConfigDialog()
    if (lmmConfigResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    this.lmmAnovaContext.config = lmmConfigResult.config
    this.lmmAnovaContext.adjustmentMethod = lmmConfigResult.config.adjustmentMethod ?? 'tukey'
    this.lmmAnovaContext.controlLevels = lmmConfigResult.config.controlLevels ?? {}
    this.lmmAnovaContext.posthocQ = lmmConfigResult.config.posthocQ ?? this.lmmAnovaContext.posthocQ ?? 0.05
    this.lmmAnovaContext.simpleEffects = lmmConfigResult.config.simpleEffects ?? []

    for (const test of tests) {
      await this.executeTest(test)
    }

    this.lmmAnovaContext.reset()
  }

  /**
   * Orchestrate Friedman Test (Repeated Measures ANOVA)
   * Avalonia ref: StatisticalAnalysisViewModel.cs lines 1761-1806 (DV selection only)
   * Flow: DV selection → Execute (NO factor encoding)
   */
  private async orchestrateFriedman(tests: string[]): Promise<void> {
    if (!this.hasFriedman()) {
      return
    }

    // Step 1: DV Selection (numeric-only)
    const hasNumericDV = this.prepareNumericDVContext(
      tests,
      'Friedman test requires numeric columns for repeated measures'
    )
    if (!hasNumericDV) {
      return
    }

    const dvResult = await this.promptForDependentVariable()
    if (dvResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    const dvName = dvResult.selectedVariable
    this.reorderColumnsDVFirst(dvName)

    // NO factor encoding - Friedman uses all numeric columns as repeated measures

    // Execute tests
    for (const test of tests) {
      await this.executeTest(test)
    }
  }

  /**
   * Orchestrate Binary Logistic Regression
   * Avalonia ref: StatisticalAnalysisViewModel.cs lines 2015-2090
   * Flow: DV selection → DV encoding → Predictor encoding (NO simple effects) → Execute
   */
  private async orchestrateBinaryLogistic(tests: string[]): Promise<void> {
    if (!this.hasBinaryLogistic()) {
      return
    }

    // Step 1: DV Selection (categorical outcome)
    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests
    })

    const dvResult = await this.promptForDependentVariable()
    if (dvResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    const dvName = dvResult.selectedVariable
    this.binaryLogisticRegressionContext.dependentVariable = dvName
    this.reorderColumnsDVFirst(dvName)

    // Step 2: DV Encoding Dialog (pick baseline for outcome)
    this.dialogService?.updateDialogContext({
      columns: [this.findColumn(dvName)!].filter(Boolean),
      selectedTests: tests  // Pass test context so dialog knows it's binary logistic
    })

    const dvEncoding = await this.showDVEncodingDialog()
    if (dvEncoding.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    this.binaryLogisticRegressionContext.outcomeEncoding = dvEncoding.encodingMapping

    // Step 3: Predictor Encoding (categorical predictors, NO simple effects)
    const predictorColumns = this.getCategoricalFactorsExcludingDV(dvName)

    if (this.hasCategoricalPredictors() && predictorColumns.length > 0) {
      this.dialogService?.updateDialogContext({
        columns: predictorColumns,
        selectedTests: tests  // Used to determine showSimpleEffects=false
      })

      const factorResult = await this.showFactorEncodingDialog()
      if (factorResult.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      this.columnEncodingMappings = factorResult.encodingMappings
    }

    // Execute tests
    for (const test of tests) {
      await this.executeTest(test)
    }
  }

  /**
   * Orchestrate Multinomial Logistic Regression
   * Avalonia ref: StatisticalAnalysisViewModel.cs lines 2061-2120
   * Flow: DV selection → DV encoding (3+ levels) → Predictor encoding (NO simple effects) → Execute
   */
  private async orchestrateMultinomialLogistic(tests: string[]): Promise<void> {
    if (!this.hasMultinomialLogistic()) {
      return
    }

    // Step 1: DV Selection (categorical outcome with 3+ levels)
    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests
    })

    const dvResult = await this.promptForDependentVariable()
    if (dvResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    const dvName = dvResult.selectedVariable
    this.multinomialLogisticRegressionContext.dependentVariable = dvName
    this.reorderColumnsDVFirst(dvName)

    // Step 2: DV Encoding Dialog (pick reference level from 3+ categories)
    this.dialogService?.updateDialogContext({
      columns: [this.findColumn(dvName)!].filter(Boolean),
      selectedTests: tests  // Pass test context so dialog knows it's multinomial logistic
    })

    const dvEncoding = await this.showDVEncodingDialog()
    if (dvEncoding.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    this.multinomialLogisticRegressionContext.outcomeEncoding = dvEncoding.encodingMapping

    // Step 3: Predictor Encoding (categorical predictors, NO simple effects)
    const predictorColumns = this.getCategoricalFactorsExcludingDV(dvName)

    if (this.hasCategoricalPredictors() && predictorColumns.length > 0) {
      this.dialogService?.updateDialogContext({
        columns: predictorColumns,
        selectedTests: tests  // Used to determine showSimpleEffects=false
      })

      const factorResult = await this.showFactorEncodingDialog()
      if (factorResult.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      this.columnEncodingMappings = factorResult.encodingMappings
    }

    // Execute tests
    for (const test of tests) {
      await this.executeTest(test)
    }
  }

  /**
   * Orchestrate Linear Regression
   * Avalonia ref: StatisticalAnalysisViewModel.cs lines 1950-2010
   * Flow: DV selection → Predictor encoding (NO DV encoding, NO simple effects) → Execute
   */
  private async orchestrateLinearRegression(tests: string[]): Promise<void> {
    if (!this.hasLinearRegression()) {
      return
    }

    // Step 1: DV Selection (numeric outcome)
    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests
    })

    const dvResult = await this.promptForDependentVariable()
    if (dvResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    const dvName = dvResult.selectedVariable
    this.linearRegressionContext.dependentVariable = dvName
    this.reorderColumnsDVFirst(dvName)

    // Auto-switch: Detect if "Simple Linear" selected but has multiple predictors
    const predictorCount = this.selectedColumns.length - 1 // -1 for DV
    const isSimpleLinearSelected = tests.some(t => {
      const normalized = this.normalizeTestName(t)
      return normalized === 'simple linear regression' ||
             normalized === 'linear regression' ||
             t === 'linear_regression'
    })

    if (isSimpleLinearSelected && predictorCount > 1) {
      // Show confirmation dialog for auto-switch
      if (!this.dialogService) {
        toast.error('Dialog service not initialized')
        return
      }

      const userConfirmed = await this.dialogService.showConfirmDialog(
        'Auto-Switch Required',
        `You selected "Simple Linear Regression" but have ${predictorCount} predictor variables.\n\nSimple Linear Regression requires exactly 1 predictor.\n\nWould you like to automatically switch to Multiple Linear Regression to analyze all ${predictorCount} predictors?`,
        `Yes, use Multiple Linear Regression`,
        `No, cancel and reselect columns`
      )

      if (!userConfirmed) {
        toast.info('Analysis cancelled. Please select only 2 columns (1 outcome + 1 predictor) for Simple Linear Regression.')
        return
      }

      // User confirmed - Update test names in the array
      tests = tests.map(t => {
        const normalized = this.normalizeTestName(t)
        if (normalized === 'simple linear regression' ||
            normalized === 'linear regression' ||
            t === 'linear_regression') {
          return 'multiple_linear_regression'
        }
        return t
      })

      toast.success('Switched to Multiple Linear Regression')
    }

    const simpleLinearStillSelected = tests.some(t => {
      const normalized = this.normalizeTestName(t)
      return normalized === 'simple linear regression' ||
             normalized === 'linear regression' ||
             t === 'linear_regression'
    })

    if (simpleLinearStillSelected && predictorCount === 1) {
      const singlePredictor = this.selectedColumns[1]
      const isCategoricalPredictor = singlePredictor
        ? singlePredictor.dataType === ColumnDataType.Categorical ||
          singlePredictor.dataType === ColumnDataType.Binary
        : false

      if (singlePredictor && isCategoricalPredictor && singlePredictor.uniqueValueCount > 2) {
        if (!this.dialogService) {
          toast.error('Dialog service not initialized')
          return
        }

        const userConfirmed = await this.dialogService.showConfirmDialog(
          'Auto-Switch Required',
          `You selected "Simple Linear Regression" but the predictor "${singlePredictor.columnName}" has ${singlePredictor.uniqueValueCount} categories.\n\nThis requires multiple dummy variables, so Simple Linear Regression is not valid.\n\nWould you like to automatically switch to Multiple Linear Regression?`,
          `Yes, use Multiple Linear Regression`,
          `No, cancel and reselect columns`
        )

        if (!userConfirmed) {
          toast.info('Analysis cancelled. Please select a numeric predictor or use Multiple Linear Regression.')
          return
        }

        tests = tests.map(t => {
          const normalized = this.normalizeTestName(t)
          if (normalized === 'simple linear regression' ||
              normalized === 'linear regression' ||
              t === 'linear_regression') {
            return 'multiple_linear_regression'
          }
          return t
        })

        toast.success('Switched to Multiple Linear Regression')
      }
    }

    // Step 2: Predictor Encoding (categorical predictors, NO simple effects)
    const categoricalPredictorColumns = this.getCategoricalFactorsExcludingDV(dvName)

    if (this.hasCategoricalPredictors() && categoricalPredictorColumns.length > 0) {
      this.dialogService?.updateDialogContext({
        columns: categoricalPredictorColumns,
        selectedTests: tests  // Used to determine showSimpleEffects=false
      })

      const factorResult = await this.showFactorEncodingDialog()
      if (factorResult.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      this.columnEncodingMappings = factorResult.encodingMappings
    }

    // Execute tests
    for (const test of tests) {
      await this.executeTest(test)
    }
  }

  /**
   * Orchestrate Dose-Response Tests
   * Flow: Column mapper dialog → Execute with mapped columns
   *
   * Dose-response tests require explicit column mapping:
   * - Dose (concentration/amount)
   * - Response (measured effect)
   */
  private async orchestrateDoseResponse(tests: string[]): Promise<void> {
    if (!this.hasDoseResponse() || tests.length === 0) {
      return
    }

    const originalColumns = this.selectedColumns

    // Ensure the dialog always sees the correct column list (don't rely on prior orchestration state).
    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    try {
      // Step 1: Show column mapper dialog for the first test (same mapping used for all dose-response tests)
      const testDef = getTestDefinition(tests[0]!)
      const testDisplayName = testDef?.displayName ?? tests[0]!

      const mapperResult = await this.showDoseResponseColumnMapperDialogForTest(testDisplayName)

      if (mapperResult.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      // Step 2: Reorder columns to match expected order for dose-response modules:
      // [0] = dose, [1] = response
      const { dose, response } = mapperResult.mapping

      const findByIdOrName = (idOrName: string) =>
        originalColumns.find(c => c.columnId === idOrName || c.columnName === idOrName)

      const doseColumn = findByIdOrName(dose)
      const responseColumn = findByIdOrName(response)

      if (!doseColumn || !responseColumn) {
        toast.error('Invalid column mapping')
        return
      }

      // Reorder to [dose, response] for dose-response execution only.
      // Do not permanently mutate selectedColumns, because other test families may run after this.
      this.selectedColumns = [doseColumn, responseColumn]

      // Step 3: Execute all dose-response tests with the same column mapping
      for (const test of tests) {
        await this.executeTest(test)
      }
    } finally {
      this.selectedColumns = originalColumns
    }
  }

  /**
   * Orchestrate Synergy Tests
   * Flow: Column mapper dialog → Execute with mapped columns
   *
   * All synergy tests use explicit column mapping:
   * - Drug A Dose
   * - Drug B Dose
   * - Combined Response
   * - Optional single-agent responses (explicit columns or boundary rows)
   *
   * The dialog ensures clear, explicit column-to-field assignment.
   */
  private async orchestrateSynergy(tests: string[]): Promise<void> {
    if (!this.hasSynergy() || tests.length === 0) {
      return
    }

    // Ensure the dialog always sees the correct column list (don't rely on prior orchestration state).
    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Step 1: Show column mapper dialog for the first test (same mapping used for all synergy tests)
    // Get display name for dialog title
    const testDef = getTestDefinition(tests[0]!)
    const testDisplayName = testDef?.displayName ?? tests[0]!

    const mapperResult = await this.showSynergyColumnMapperDialogForTest(testDisplayName)

    if (mapperResult.cancelled) {
      toast.info('Analysis cancelled')
      return
    }

    const originalColumns = this.selectedColumns

    // Step 2: Reorder columns to match expected order for synergy modules:
    // [0] = doseA, [1] = doseB, [2] = responseCombined, optionally [3] = responseA, [4] = responseB
    const { doseA, doseB, responseA, responseB, responseCombined } = mapperResult.mapping

    const findByIdOrName = (idOrName: string) =>
      originalColumns.find(col => col.columnId === idOrName || col.columnName === idOrName)

    const useExplicitSingleAgents =
      responseA !== SYNERGY_BOUNDARY_ROWS_SENTINEL &&
      responseB !== SYNERGY_BOUNDARY_ROWS_SENTINEL

    if (
      (responseA === SYNERGY_BOUNDARY_ROWS_SENTINEL) !==
      (responseB === SYNERGY_BOUNDARY_ROWS_SENTINEL)
    ) {
      toast.error(
        'Synergy mapping invalid: map both single-agent response columns, or use boundary rows for both.'
      )
      return
    }

    const orderedColumns = [
      findByIdOrName(doseA),
      findByIdOrName(doseB),
      findByIdOrName(responseCombined),
      ...(useExplicitSingleAgents ? [findByIdOrName(responseA), findByIdOrName(responseB)] : []),
    ].filter(Boolean) as typeof this.selectedColumns

    // Validate all columns were found
    if (orderedColumns.length !== (useExplicitSingleAgents ? 5 : 3)) {
      toast.error('Column mapping failed: Some selected columns were not found')
      return
    }

    // Replace selectedColumns with the ordered columns
    this.selectedColumns = orderedColumns

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Step 3: Execute all synergy tests with the mapped columns
    try {
      for (const test of tests) {
        await this.executeTest(test)
      }
    } finally {
      this.selectedColumns = originalColumns
    }
  }

  /**
   * Orchestrate Correlation Tests
   *
   * INDEPENDENT LOGIC - not shared with regression:
   * - No DV selection (correlation is symmetric: X ↔ Y)
   * - No context object (stateless execution)
   * - No encoding dialogs (requires 2 numeric columns)
   *
   * Validation:
   * - Requires 2-20 columns
   * - Module validates column types
   * - Errors shown via toast
   *
   * Data Extraction:
   * - Pairwise complete cases (drop rows where X or Y missing)
   * - Report n_used vs n_total in results
   */
  private async orchestrateCorrelation(tests: string[]): Promise<void> {
    if (!this.hasCorrelation() || tests.length === 0) {
      return
    }

    // Pre-validation: Ensure we have 2-20 columns
    if (this.selectedColumns.length < 2 || this.selectedColumns.length > 20) {
      toast.error('Correlation requires between 2 and 20 columns. Please select numeric columns.')
      return
    }

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Direct execution - no dialogs needed for correlation
    for (const test of tests) {
      await this.executeTest(test)
    }
  }

  /**
   * Orchestrate categorical tests (Chi-Square, Fisher's Exact, McNemar, Chi-Square GOF)
   *
   * No dialogs needed - direct execution with column validation handled by modules.
   */
  private async orchestrateCategorical(tests: string[]): Promise<void> {
    if (tests.length === 0) return

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    const gofTests = tests.filter((test) => {
      const testDef = getTestDefinition(test)
      return testDef?.id === 'chi_square_gof' || test === 'chi_square_gof'
    })

    const chiSquareTests = tests.filter((test) => {
      const testDef = getTestDefinition(test)
      return testDef?.id === 'chi_square' || test === 'chi_square'
    })

    const fisherExactTests = tests.filter((test) => {
      const testDef = getTestDefinition(test)
      return testDef?.id === 'fishers_exact' || test === 'fishers_exact'
    })

    const mcnemarTests = tests.filter((test) => {
      const testDef = getTestDefinition(test)
      return testDef?.id === 'mcnemar' || test === 'mcnemar'
    })

    const remainingTests = tests.filter(
      (test) => !gofTests.includes(test) && !chiSquareTests.includes(test) && !fisherExactTests.includes(test) && !mcnemarTests.includes(test)
    )

    if (chiSquareTests.length > 0) {
      const testDef = getTestDefinition(chiSquareTests[0]!)
      const testDisplayName = testDef?.displayName ?? chiSquareTests[0]!
      const mapperResult = await this.showChiSquareColumnMapperDialogForTest(testDisplayName)

      if (mapperResult.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      this.chiSquareMapping = mapperResult.mapping

      try {
        for (const test of chiSquareTests) {
          await this.executeTest(test)
        }
      } finally {
        this.chiSquareMapping = null
      }
    }

    if (gofTests.length > 0) {
      const testDef = getTestDefinition(gofTests[0]!)
      const testDisplayName = testDef?.displayName ?? gofTests[0]!
      const mapperResult = await this.showChiSquareGofColumnMapperDialogForTest(testDisplayName)

      if (mapperResult.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      this.chiSquareGofMapping = mapperResult.mapping

      try {
        for (const test of gofTests) {
          await this.executeTest(test)
        }
      } finally {
        this.chiSquareGofMapping = null
      }
    }

    if (fisherExactTests.length > 0) {
      const testDef = getTestDefinition(fisherExactTests[0]!)
      const testDisplayName = testDef?.displayName ?? fisherExactTests[0]!
      const mapperResult = await this.showFisherExactColumnMapperDialogForTest(testDisplayName)

      if (mapperResult.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      this.fisherExactMapping = mapperResult.mapping

      try {
        for (const test of fisherExactTests) {
          await this.executeTest(test)
        }
      } finally {
        this.fisherExactMapping = null
      }
    }

    if (mcnemarTests.length > 0) {
      const testDef = getTestDefinition(mcnemarTests[0]!)
      const testDisplayName = testDef?.displayName ?? mcnemarTests[0]!
      const mapperResult = await this.showMcNemarColumnMapperDialogForTest(testDisplayName)

      if (mapperResult.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      this.mcnemarMapping = mapperResult.mapping

      try {
        for (const test of mcnemarTests) {
          await this.executeTest(test)
        }
      } finally {
        this.mcnemarMapping = null
      }
    }

    for (const test of remainingTests) {
      await this.executeTest(test)
    }
  }

  /**
   * Orchestrate descriptive tests (Descriptive Statistics, Outlier Detection)
   *
   * Simple execution pattern - no dialogs needed.
   * Validates single numeric column requirement.
   */
  private async orchestrateDescriptive(tests: string[]): Promise<void> {
    if (tests.length === 0) return

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Direct execution - no user dialogs needed
    for (const test of tests) {
      await this.executeTest(test)
    }
  }

  /**
   * Orchestrate distribution/normality tests (Shapiro-Wilk, K-S, Anderson-Darling, etc.)
   *
   * Simple execution pattern - no dialogs needed.
   * Validates single numeric column requirement.
   */
  private async orchestrateDistribution(tests: string[]): Promise<void> {
    if (tests.length === 0) return

    this.dialogService?.updateDialogContext({
      columns: this.selectedColumns,
      selectedTests: tests,
    })

    // Direct execution - no user dialogs needed
    for (const test of tests) {
      await this.executeTest(test)
    }
  }

  /**
   * Orchestrate Survival Analysis Tests
   * Flow: Detect test type → Show survival dialog → Store context → Reorder columns → Execute
   *
   * Handles all three survival test types:
   * - Kaplan-Meier: time + event + optional group
   * - Cox Regression: time + event + required covariates
   * - Nelson-Aalen: time + event + optional group + optional custom time points
   *
   * Event Encoding:
   * - Auto-detects 0/1, true/false, boolean (no mapping needed)
   * - Shows encoding UI for non-numeric binary labels (e.g., "Alive"/"Dead")
   * - Enforces mapping selection before allowing test execution
   */
  private async orchestrateSurvival(tests: string[]): Promise<void> {
    if (tests.length === 0) return

    // Process each survival test independently (different contexts)
    for (const test of tests) {
      const originalColumns = this.selectedColumns
      const normalized = this.normalizeTestName(test)

      // Determine analysis type
      let analysisType: 'kaplan_meier' | 'cox_regression' | 'nelson_aalen'
      if (normalized.includes('kaplan') || normalized.includes('kaplan-meier')) {
        analysisType = 'kaplan_meier'
      } else if (normalized.includes('cox')) {
        analysisType = 'cox_regression'
      } else if (normalized.includes('nelson') || normalized.includes('nelson-aalen')) {
        analysisType = 'nelson_aalen'
      } else {
        toast.error(`Unknown survival test type: ${test}`)
        continue
      }

      // Update dialog context
      this.dialogService?.updateDialogContext({
        columns: this.selectedColumns,
        selectedTests: [test],
      })

      // Show survival configuration dialog
      if (!this.dialogService) {
        toast.error('Dialog service not initialized')
        return
      }

      const config = await this.dialogService.showSurvivalAnalysisDialog({
        columns: this.selectedColumns,
        analysisType,
      })

      if (config.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      const findColumn = (name: string) =>
        originalColumns.find(col => col.columnName === name || col.columnId === name)

      const timeColumn = findColumn(config.timeVariable)
      const eventColumn = findColumn(config.eventVariable)

      if (!timeColumn || !eventColumn) {
        toast.error('Selected survival columns could not be found in the dataset.')
        return
      }

      try {
        if (analysisType === 'kaplan_meier') {
          this.kaplanMeierContext.timeVariable = config.timeVariable
          this.kaplanMeierContext.eventVariable = config.eventVariable
          this.kaplanMeierContext.groupVariable = config.groupVariable
          this.kaplanMeierContext.eventEncoding = config.eventEncoding

          const ordered = [timeColumn, eventColumn]
          if (config.groupVariable) {
            const groupColumn = findColumn(config.groupVariable)
            if (!groupColumn) {
              toast.error('Selected group column could not be found in the dataset.')
              return
            }
            ordered.push(groupColumn)
          }

          this.selectedColumns = ordered
          await this.executeTest(test)
        } else if (analysisType === 'cox_regression') {
          if (config.covariates.length === 0) {
            toast.error('Cox regression requires at least one covariate.')
            return
          }

          this.coxRegressionContext.timeVariable = config.timeVariable
          this.coxRegressionContext.eventVariable = config.eventVariable
          this.coxRegressionContext.covariates = config.covariates
          this.coxRegressionContext.eventEncoding = config.eventEncoding
          this.coxRegressionContext.covariateEncodings = config.covariateEncodings

          const covariateSet = new Set(config.covariates)
          const covariateColumns = originalColumns.filter(col => covariateSet.has(col.columnName))
          if (covariateColumns.length !== config.covariates.length) {
            toast.error('One or more selected covariates could not be found in the dataset.')
            return
          }

          this.selectedColumns = [timeColumn, eventColumn, ...covariateColumns]
          await this.executeTest(test)
        } else {
          this.nelsonAalenContext.timeVariable = config.timeVariable
          this.nelsonAalenContext.eventVariable = config.eventVariable
          this.nelsonAalenContext.groupVariable = config.groupVariable
          this.nelsonAalenContext.customTimePoints = config.customTimePoints
          this.nelsonAalenContext.eventEncoding = config.eventEncoding

          const ordered = [timeColumn, eventColumn]
          if (config.groupVariable) {
            const groupColumn = findColumn(config.groupVariable)
            if (!groupColumn) {
              toast.error('Selected group column could not be found in the dataset.')
              return
            }
            ordered.push(groupColumn)
          }

          this.selectedColumns = ordered
          await this.executeTest(test)
        }
      } finally {
        this.selectedColumns = originalColumns
        this.kaplanMeierContext.reset()
        this.coxRegressionContext.reset()
        this.nelsonAalenContext.reset()
      }
    }
  }

  /**
   * Orchestrate Mediation Analysis (Model 4)
   * Flow: Show dialog → Store context → Reorder columns → Execute
   */
  private async orchestrateMediation(tests: string[]): Promise<void> {
    if (tests.length === 0) return

    for (const test of tests) {
      const originalColumns = this.selectedColumns

      // Update dialog context
      this.dialogService?.updateDialogContext({
        columns: this.selectedColumns,
        selectedTests: [test],
      })

      // Show mediation configuration dialog
      if (!this.dialogService) {
        toast.error('Dialog service not initialized')
        return
      }

      const config = await this.dialogService.showMediationAnalysisDialog({
        columns: this.selectedColumns,
      })

      if (config.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      const findColumn = (name: string) =>
        originalColumns.find(col => col.columnName === name || col.columnId === name)

      const ivColumn = findColumn(config.independentVariable)
      const mediatorColumn = findColumn(config.mediator)
      const dvColumn = findColumn(config.dependentVariable)

      if (!ivColumn || !mediatorColumn || !dvColumn) {
        toast.error('Selected mediation columns could not be found in the dataset.')
        return
      }

      try {
        // Store configuration in context
        this.mediationContext.independentVariable = config.independentVariable
        this.mediationContext.mediator = config.mediator
        this.mediationContext.dependentVariable = config.dependentVariable
        this.mediationContext.covariates = config.covariates
        this.mediationContext.nBootstrap = config.nBootstrap
        this.mediationContext.confidenceLevel = config.confidenceLevel
        this.mediationContext.seed = config.seed ?? this.mediationContext.seed
        this.mediationContext.ivEncoding = config.ivEncoding
        this.mediationContext.mediatorEncoding = config.mediatorEncoding
        this.mediationContext.dvEncoding = config.dvEncoding
        this.mediationContext.covariateEncodings = config.covariateEncodings

        // Reorder columns: [IV, Mediator, DV, ...covariates]
        const ordered = [ivColumn, mediatorColumn, dvColumn]

        if (config.covariates.length > 0) {
          const covariateColumns = config.covariates
            .map((name) => originalColumns.find((col) => col.columnName === name || col.columnId === name))
            .filter((col): col is ColumnClassification => !!col)
          if (covariateColumns.length !== config.covariates.length) {
            toast.error('One or more selected covariates could not be found in the dataset.')
            return
          }
          ordered.push(...covariateColumns)
        }

        this.selectedColumns = ordered
        await this.executeTest(test)
      } finally {
        this.selectedColumns = originalColumns
        this.mediationContext.reset()
      }
    }
  }

  /**
   * Orchestrate Moderation Analysis (Model 1)
   * Flow: Show dialog → Store context → Reorder columns → Execute
   */
  private async orchestrateModeration(tests: string[]): Promise<void> {
    if (tests.length === 0) return

    for (const test of tests) {
      const originalColumns = this.selectedColumns

      // Update dialog context
      this.dialogService?.updateDialogContext({
        columns: this.selectedColumns,
        selectedTests: [test],
      })

      // Show moderation configuration dialog
      if (!this.dialogService) {
        toast.error('Dialog service not initialized')
        return
      }

      const config = await this.dialogService.showModerationAnalysisDialog({
        columns: this.selectedColumns,
      })

      if (config.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      const findColumn = (name: string) =>
        originalColumns.find(col => col.columnName === name || col.columnId === name)

      const ivColumn = findColumn(config.independentVariable)
      const moderatorColumn = findColumn(config.moderator)
      const dvColumn = findColumn(config.dependentVariable)

      if (!ivColumn || !moderatorColumn || !dvColumn) {
        toast.error('Selected moderation columns could not be found in the dataset.')
        return
      }

      try {
        // Store configuration in context
        this.moderationContext.independentVariable = config.independentVariable
        this.moderationContext.moderator = config.moderator
        this.moderationContext.dependentVariable = config.dependentVariable
        this.moderationContext.covariates = config.covariates
        this.moderationContext.centerPredictor = config.centerPredictor
        this.moderationContext.centerModerator = config.centerModerator
        this.moderationContext.probeValues = config.customProbeValues
        this.moderationContext.confidenceLevel = config.confidenceLevel
        this.moderationContext.seed = config.seed ?? this.moderationContext.seed
        this.moderationContext.ivEncoding = config.ivEncoding
        this.moderationContext.moderatorEncoding = config.moderatorEncoding
        this.moderationContext.dvEncoding = config.dvEncoding
        this.moderationContext.covariateEncodings = config.covariateEncodings

        // Reorder columns: [IV, Moderator, DV, ...covariates]
        const ordered = [ivColumn, moderatorColumn, dvColumn]

        if (config.covariates.length > 0) {
          const covariateColumns = config.covariates
            .map((name) => originalColumns.find((col) => col.columnName === name || col.columnId === name))
            .filter((col): col is ColumnClassification => !!col)
          if (covariateColumns.length !== config.covariates.length) {
            toast.error('One or more selected covariates could not be found in the dataset.')
            return
          }
          ordered.push(...covariateColumns)
        }

        this.selectedColumns = ordered
        await this.executeTest(test)
      } finally {
        this.selectedColumns = originalColumns
        this.moderationContext.reset()
      }
    }
  }

  /**
   * Orchestrate Moderated Mediation Analysis (Model 7)
   * Flow: Show dialog → Store context → Reorder columns → Execute
   */
  private async orchestrateModeratedMediation(tests: string[]): Promise<void> {
    if (tests.length === 0) return

    for (const test of tests) {
      const originalColumns = this.selectedColumns

      // Update dialog context
      this.dialogService?.updateDialogContext({
        columns: this.selectedColumns,
        selectedTests: [test],
      })

      // Show moderated mediation configuration dialog
      if (!this.dialogService) {
        toast.error('Dialog service not initialized')
        return
      }

      const config = await this.dialogService.showModeratedMediationAnalysisDialog({
        columns: this.selectedColumns,
      })

      if (config.cancelled) {
        toast.info('Analysis cancelled')
        return
      }

      const findColumn = (name: string) =>
        originalColumns.find(col => col.columnName === name || col.columnId === name)

      const ivColumn = findColumn(config.independentVariable)
      const mediatorColumn = findColumn(config.mediator)
      const moderatorColumn = findColumn(config.moderator)
      const dvColumn = findColumn(config.dependentVariable)

      if (!ivColumn || !mediatorColumn || !moderatorColumn || !dvColumn) {
        toast.error('Selected moderated mediation columns could not be found in the dataset.')
        return
      }

      try {
        // Store configuration in context
        this.moderatedMediationContext.independentVariable = config.independentVariable
        this.moderatedMediationContext.mediator = config.mediator
        this.moderatedMediationContext.moderator = config.moderator
        this.moderatedMediationContext.dependentVariable = config.dependentVariable
        this.moderatedMediationContext.covariates = config.covariates
        this.moderatedMediationContext.centerPredictor = config.centerPredictor
        this.moderatedMediationContext.centerModerator = config.centerModerator
        this.moderatedMediationContext.probeValues = config.customProbeValues
        this.moderatedMediationContext.nBootstrap = config.nBootstrap
        this.moderatedMediationContext.confidenceLevel = config.confidenceLevel
        this.moderatedMediationContext.seed = config.seed ?? this.moderatedMediationContext.seed
        this.moderatedMediationContext.ivEncoding = config.ivEncoding
        this.moderatedMediationContext.mediatorEncoding = config.mediatorEncoding
        this.moderatedMediationContext.moderatorEncoding = config.moderatorEncoding
        this.moderatedMediationContext.dvEncoding = config.dvEncoding
        this.moderatedMediationContext.covariateEncodings = config.covariateEncodings

        // Reorder columns: [IV, Moderator, Mediator, DV, ...covariates]
        const ordered = [ivColumn, moderatorColumn, mediatorColumn, dvColumn]

        if (config.covariates.length > 0) {
          const covariateColumns = config.covariates
            .map((name) => originalColumns.find((col) => col.columnName === name || col.columnId === name))
            .filter((col): col is ColumnClassification => !!col)
          if (covariateColumns.length !== config.covariates.length) {
            toast.error('One or more selected covariates could not be found in the dataset.')
            return
          }
          ordered.push(...covariateColumns)
        }

        this.selectedColumns = ordered
        await this.executeTest(test)
      } finally {
        this.selectedColumns = originalColumns
        this.moderatedMediationContext.reset()
      }
    }
  }

  private async executeTest(testName: string): Promise<void> {
    const toastId = `test-${testName}-${Date.now()}`
    toast.loading(`Running ${testName}`, { id: toastId })

    try {
      await ensureProjectId()
      // Get module from registry
      const module = await moduleRegistry.getModule(testName)
      if (!module) {
        toast.error(`Module not found for test: ${testName}`, { id: toastId })
        return
      }

      // Build column indices array (local indices 0, 1, 2... for the selected columns)
      const selectedColumnIndices = this.selectedColumns.map((_, idx) => idx)

      // Phase 5: Check if this is a large dataset BEFORE fetching data
      // Large datasets use DuckDB + Python DataProvider, skip frontend data loading
      const selectedColumnIds = this.selectedColumns.map(col => col.columnId || col.columnName)
      const missingIds = this.selectedColumns.filter(col => !(col.columnId || col.columnName))
      const duplicateIds = selectedColumnIds.filter((id, idx) => id && selectedColumnIds.indexOf(id) !== idx)

      if (missingIds.length > 0) {
        const missingNames = missingIds.map((col) => col.columnName).filter(Boolean).join(', ')
        const suffix = missingNames ? ` Missing: ${missingNames}.` : ''
        toast.error(`Analysis failed: one or more selected columns have no identifier.${suffix}`, { id: toastId })
        return
      }
      if (duplicateIds.length > 0) {
        const dupSet = [...new Set(duplicateIds)]
        const dupList = dupSet.join(', ')
        if (this.dialogService) {
          const proceed = await this.dialogService.showConfirmDialog(
            'Duplicate column identifiers detected',
            `Duplicate identifiers: ${dupList}.\n\nContinuing can cause data to bleed between columns. Proceed anyway?`,
            'Continue',
            'Cancel'
          )
          if (!proceed) {
            toast.info('Analysis cancelled', { id: toastId })
            return
          }
        } else {
          toast.error(`Analysis failed: duplicate column identifiers detected (${dupList}).`, { id: toastId })
          return
        }
      }
      let isLargeDataset = false
      let duckdbPath: string | null = null
      let duckdbReady = false
      let duckdbFlushError: string | null = null

      try {
        const storageInfo = await cacheService.getDatasetStorageInfo(this._currentDataset.id)
        if (storageInfo.isLarge && storageInfo.duckdbPath) {
          isLargeDataset = true
          duckdbPath = storageInfo.duckdbPath
          logger.info(`Large dataset detected, will use DataProvider path`, {
            duckdbPath,
            columnIds: selectedColumnIds,
          })
        }
      } catch (storageError) {
        // Non-fatal: fall back to standard path if storage info unavailable
        logger.warn('Could not get dataset storage info, using standard path', {
          error: storageError instanceof Error ? storageError.message : String(storageError),
        })
        if (this._currentDataset?.duckdbPath) {
          isLargeDataset = true
          duckdbPath = this._currentDataset.duckdbPath
        }
      }

      let rowsArray: unknown[][] = []
      let rowCount = 0

      // Phase 2: Execution mode selection for large datasets
      let executionMode: ExecutionMode = 'exact'  // Default for small datasets

      if (isLargeDataset) {
        // Check if this test requires exact mode only (complex iterative algorithms)
        const testDef = getTestDefinition(testName)
        const testFamily = testDef?.family ?? ''
        const requiresExactMode = EXACT_MODE_ONLY_FAMILIES.has(testFamily)

        if (requiresExactMode) {
          // Force exact mode for complex tests (regression, survival, mediation, moderation)
          executionMode = 'exact'
          logger.info(`Test '${testName}' requires exact mode (family: ${testFamily})`, {
            testName,
            family: testFamily,
          })
          toast.info(`Using exact mode for ${testDef?.displayName ?? testName} (full data required)`, {
            duration: 3000,
          })
        } else if (this.dialogService) {
          // Show execution mode dialog for other tests
          const dataRowCount = this._currentDataset.dataRowCount ?? this._currentDataset.rowCount ?? 1000000
          const modeResult = await this.dialogService.showExecutionModeDialog(testName, dataRowCount)

          if (modeResult.mode === null) {
            // User cancelled
            toast.info(`${testName} cancelled`, { id: toastId })
            return
          }

          executionMode = modeResult.mode
          logger.info(`User selected execution mode: ${executionMode}`, { testName, rowCount: dataRowCount })
        }

        // Large dataset path: Flush pending edits to DuckDB before analysis
        if (duckdbPath) {
          try {
            await cacheService.ensureLatestCache(this._currentDataset.id)
            duckdbReady = true
          } catch (flushError) {
            duckdbReady = false
            duckdbFlushError = flushError instanceof Error ? flushError.message : String(flushError)
            logger.warn('Failed to flush overlay before analysis', {
              error: duckdbFlushError,
            })
          }
        }

        logger.info('Skipping frontend data fetch for large dataset')
        rowCount = 0 // Determined by Python from DuckDB
      } else {
        // Small dataset path: Fetch data via cacheService (existing behavior)
        await cacheService.ensureLatestCache(this._currentDataset.id)
        const columnsData = await cacheService.getColumnsData(
          this._currentDataset.id,
          selectedColumnIds
        )

        // Derive row count from first selected column
        const firstColId = selectedColumnIds[0]
        rowCount =
          firstColId && Array.isArray(columnsData[firstColId])
            ? columnsData[firstColId]!.length
            : 0

        if (rowCount === 0) {
          toast.error('No data available for this dataset', { id: toastId })
          return
        }

        // Build rowsArray as row-major matrix [rowIndex][localColumnIndex]
        rowsArray = Array.from({ length: rowCount }, (_row, rowIdx) =>
          selectedColumnIds.map(colId => columnsData[colId]?.[rowIdx])
        )
      }

      // Gather parameters from contexts
      const analysisStore = useAnalysisStore.getState()
      const parameters: Record<string, any> = {
        ...analysisStore.parameters,
      }

      // Add dependent variable if present
      const testLower = testName.toLowerCase()
      const normalizedTestName = testLower.replace(/[_-]+/g, ' ')
      const testDefForParams = getTestDefinition(testName)

      // Group 7: normalize UI parameters to Python expectations (applies to large + small datasets).
      if (
        testDefForParams?.id === 'mediation_model4' ||
        testDefForParams?.id === 'moderation_model1' ||
        testDefForParams?.id === 'moderated_mediation_model7'
      ) {
        if (parameters.n_boot == null && parameters.bootstrap != null) {
          parameters.n_boot = parameters.bootstrap
        }
        if (parameters.confidence == null && typeof parameters.alpha === 'number') {
          parameters.confidence = 1 - parameters.alpha
        }
        if (parameters.seed == null) {
          parameters.seed = 12345
        }
        if (testDefForParams.id === 'mediation_model4') {
          if (parameters.bootstrap_direct_effect == null) {
            parameters.bootstrap_direct_effect = true
          }
          if (parameters.bootstrap_prop_mediated == null) {
            parameters.bootstrap_prop_mediated = true
          }
        }
      }

      const isGofTest =
        testDefForParams?.id === 'chi_square_gof' || normalizedTestName.includes('goodness of fit')

      if (isGofTest && this.chiSquareGofMapping) {
        parameters.gof_mapping = this.chiSquareGofMapping
      }

      const isChiSquareTest =
        testDefForParams?.id === 'chi_square' || normalizedTestName.includes('chi square')

      if (isChiSquareTest && this.chiSquareMapping) {
        parameters.chi_square_mapping = this.chiSquareMapping
      }

      const isFisherExactTest =
        testDefForParams?.id === 'fishers_exact' || normalizedTestName.includes('fisher')

      if (isFisherExactTest && this.fisherExactMapping) {
        parameters.fisher_mapping = this.fisherExactMapping
      }

      const isMcNemarTest =
        testDefForParams?.id === 'mcnemar' || normalizedTestName.includes('mcnemar')

      if (isMcNemarTest && this.mcnemarMapping) {
        parameters.mcnemar_mapping = this.mcnemarMapping
      }

      const isIndependentTTest =
        testDefForParams?.id === 't_test_two_sample' ||
        testDefForParams?.id === 'independent_ttest' ||
        normalizedTestName.includes('independent') ||
        normalizedTestName.includes('two sample')

      if (isIndependentTTest && this.independentTTestMapping) {
        parameters.ttest_mapping = this.independentTTestMapping
      }

      const isPairedTTest =
        testDefForParams?.id === 't_test_paired' ||
        testDefForParams?.id === 'paired_ttest' ||
        normalizedTestName.includes('paired')

      if (isPairedTTest && this.pairedTTestMapping) {
        parameters.paired_ttest_mapping = this.pairedTTestMapping
      }

      const isWilcoxon =
        testDefForParams?.id === 'wilcoxon' ||
        normalizedTestName.includes('wilcoxon')

      if (isWilcoxon && this.wilcoxonMapping) {
        parameters.wilcoxon_mapping = this.wilcoxonMapping
      }

      const isMannWhitney =
        testDefForParams?.id === 'mann_whitney' ||
        (normalizedTestName.includes('mann') && normalizedTestName.includes('whitney'))

      if (isMannWhitney && this.mannWhitneyMapping) {
        parameters.mann_whitney_mapping = this.mannWhitneyMapping
      }

      const isOneWayAnova =
        testDefForParams?.id === 'one_way_anova' ||
        normalizedTestName.includes('one') && normalizedTestName.includes('way') && normalizedTestName.includes('anova')

      if (isOneWayAnova && this.oneWayAnovaMapping) {
        parameters.one_way_anova_mapping = this.oneWayAnovaMapping
      }

      const isKruskalWallis =
        testDefForParams?.id === 'kruskal_wallis' ||
        normalizedTestName.includes('kruskal')

      if (isKruskalWallis && this.kruskalWallisMapping) {
        parameters.kruskal_wallis_mapping = this.kruskalWallisMapping
      }

      const isTwoWayAnova =
        testDefForParams?.id === 'two_way_anova' ||
        (normalizedTestName.includes('two') && normalizedTestName.includes('way') && normalizedTestName.includes('anova'))

      if (isTwoWayAnova && this.twoWayFactorMapping) {
        parameters.factor_role_mapping = this.twoWayFactorMapping
      }

      const isMultifactorialAnova =
        testDefForParams?.id === 'multifactorial_anova' ||
        (normalizedTestName.includes('multifactorial') && normalizedTestName.includes('anova'))

      if (isMultifactorialAnova && this.multifactorialFactorMapping) {
        parameters.factor_role_mapping = this.multifactorialFactorMapping
      }

      const isScheirerRayHare =
        testDefForParams?.id === 'scheirer_ray_hare' ||
        (normalizedTestName.includes('scheirer') && normalizedTestName.includes('ray') && normalizedTestName.includes('hare'))

      if (isScheirerRayHare && this.scheirerRayHareFactorMapping) {
        parameters.factor_role_mapping = this.scheirerRayHareFactorMapping
      }

      if (normalizedTestName.includes('linear regression')) {
        if (this.linearRegressionContext.dependentVariable) {
          parameters.dependentVariable = this.linearRegressionContext.dependentVariable
        }
      } else if (testLower.includes('binary logistic') || (testLower.includes('logistic') && !testLower.includes('multinomial'))) {
        if (this.binaryLogisticRegressionContext.dependentVariable) {
          parameters.dependentVariable = this.binaryLogisticRegressionContext.dependentVariable
        }
        if (this.binaryLogisticRegressionContext.outcomeEncoding) {
          parameters.outcomeEncoding = Object.fromEntries(this.binaryLogisticRegressionContext.outcomeEncoding)
        }
      } else if (testLower.includes('multinomial')) {
        if (this.multinomialLogisticRegressionContext.dependentVariable) {
          parameters.dependentVariable = this.multinomialLogisticRegressionContext.dependentVariable
        }
        if (this.multinomialLogisticRegressionContext.outcomeEncoding) {
          parameters.outcomeEncoding = Object.fromEntries(this.multinomialLogisticRegressionContext.outcomeEncoding)
        }
      }

      if (testLower.includes('kaplan')) {
        if (this.kaplanMeierContext.eventEncoding) {
          parameters.event_encoding = this.kaplanMeierContext.eventEncoding
        }
      } else if (testLower.includes('cox')) {
        if (this.coxRegressionContext.eventEncoding) {
          parameters.event_encoding = this.coxRegressionContext.eventEncoding
        }
        if (this.coxRegressionContext.covariateEncodings) {
          parameters.covariate_encodings = this.coxRegressionContext.covariateEncodings
        }
      } else if (testLower.includes('nelson')) {
        if (this.nelsonAalenContext.eventEncoding) {
          parameters.event_encoding = this.nelsonAalenContext.eventEncoding
        }
        if (this.nelsonAalenContext.customTimePoints.length > 0) {
          parameters.custom_time_points = this.nelsonAalenContext.customTimePoints
        }
      }

      // Mediation & Moderation context parameters
      if (testLower.includes('mediation') && testLower.includes('model4')) {
        // Mediation Analysis (Model 4)
        if (this.mediationContext.nBootstrap) {
          parameters.n_boot = this.mediationContext.nBootstrap
        }
        if (this.mediationContext.confidenceLevel) {
          parameters.confidence = this.mediationContext.confidenceLevel
        }
        if (this.mediationContext.seed !== undefined) {
          parameters.seed = this.mediationContext.seed
        }
        if (parameters.bootstrap_direct_effect == null) {
          parameters.bootstrap_direct_effect = true
        }
        if (parameters.bootstrap_prop_mediated == null) {
          parameters.bootstrap_prop_mediated = true
        }
        if (this.mediationContext.ivEncoding) {
          parameters.iv_encoding = this.mediationContext.ivEncoding
        }
        if (this.mediationContext.mediatorEncoding) {
          parameters.mediator_encoding = this.mediationContext.mediatorEncoding
        }
        if (this.mediationContext.dvEncoding) {
          parameters.dv_encoding = this.mediationContext.dvEncoding
        }
        if (this.mediationContext.covariateEncodings) {
          // Map covariate name -> encoding to covariate_N_encoding by covariate index
          const covariateNames = this.mediationContext.covariates
          for (let i = 0; i < covariateNames.length; i++) {
            const covName = covariateNames[i]
            if (covName && this.mediationContext.covariateEncodings[covName]) {
              parameters[`covariate_${i}_encoding`] = this.mediationContext.covariateEncodings[covName]
            }
          }
        }
      } else if (testLower.includes('moderation') && testLower.includes('model1')) {
        // Moderation Analysis (Model 1)
        if (this.moderationContext.centerPredictor !== undefined) {
          parameters.center_predictor = this.moderationContext.centerPredictor
        }
        if (this.moderationContext.centerModerator !== undefined) {
          parameters.center_moderator = this.moderationContext.centerModerator
        }
        if (this.moderationContext.probeValues) {
          parameters.probe_values = this.moderationContext.probeValues
        } else {
          delete parameters.probe_values
        }
        if (this.moderationContext.confidenceLevel) {
          parameters.confidence = this.moderationContext.confidenceLevel
        }
        if (this.moderationContext.seed !== undefined) {
          parameters.seed = this.moderationContext.seed
        }
        if (this.moderationContext.ivEncoding) {
          parameters.iv_encoding = this.moderationContext.ivEncoding
        }
        if (this.moderationContext.moderatorEncoding) {
          parameters.moderator_encoding = this.moderationContext.moderatorEncoding
        }
        if (this.moderationContext.dvEncoding) {
          parameters.dv_encoding = this.moderationContext.dvEncoding
        }
        if (this.moderationContext.covariateEncodings) {
          // Map covariate name -> encoding to covariate_N_encoding by covariate index
          const covariateNames = this.moderationContext.covariates
          for (let i = 0; i < covariateNames.length; i++) {
            const covName = covariateNames[i]
            if (covName && this.moderationContext.covariateEncodings[covName]) {
              parameters[`covariate_${i}_encoding`] = this.moderationContext.covariateEncodings[covName]
            }
          }
        }
      } else if (testLower.includes('moderated') && testLower.includes('mediation') && testLower.includes('model7')) {
        // Moderated Mediation Analysis (Model 7)
        if (this.moderatedMediationContext.centerPredictor !== undefined) {
          parameters.center_predictor = this.moderatedMediationContext.centerPredictor
        }
        if (this.moderatedMediationContext.centerModerator !== undefined) {
          parameters.center_moderator = this.moderatedMediationContext.centerModerator
        }
        if (this.moderatedMediationContext.probeValues) {
          parameters.probe_values = this.moderatedMediationContext.probeValues
        } else {
          delete parameters.probe_values
        }
        if (this.moderatedMediationContext.nBootstrap) {
          parameters.n_boot = this.moderatedMediationContext.nBootstrap
        }
        if (this.moderatedMediationContext.confidenceLevel) {
          parameters.confidence = this.moderatedMediationContext.confidenceLevel
        }
        if (this.moderatedMediationContext.seed !== undefined) {
          parameters.seed = this.moderatedMediationContext.seed
        }
        if (this.moderatedMediationContext.independentVariable) {
          parameters.predictor_name = this.moderatedMediationContext.independentVariable
        }
        if (this.moderatedMediationContext.mediator) {
          parameters.mediator_name = this.moderatedMediationContext.mediator
        }
        if (this.moderatedMediationContext.moderator) {
          parameters.moderator_name = this.moderatedMediationContext.moderator
        }
        if (this.moderatedMediationContext.dependentVariable) {
          parameters.outcome_name = this.moderatedMediationContext.dependentVariable
        }
        // Binary categorical encodings
        if (this.moderatedMediationContext.ivEncoding) {
          parameters.iv_encoding = this.moderatedMediationContext.ivEncoding
        }
        if (this.moderatedMediationContext.mediatorEncoding) {
          parameters.mediator_encoding = this.moderatedMediationContext.mediatorEncoding
        }
        if (this.moderatedMediationContext.moderatorEncoding) {
          parameters.moderator_encoding = this.moderatedMediationContext.moderatorEncoding
        }
        if (this.moderatedMediationContext.dvEncoding) {
          parameters.dv_encoding = this.moderatedMediationContext.dvEncoding
        }
        if (this.moderatedMediationContext.covariateEncodings) {
          const covariateNames = this.moderatedMediationContext.covariates
          for (let i = 0; i < covariateNames.length; i++) {
            const covName = covariateNames[i]
            if (covName && this.moderatedMediationContext.covariateEncodings[covName]) {
              parameters[`covariate_${i}_encoding`] = this.moderatedMediationContext.covariateEncodings[covName]
            }
          }
        }
      }

      // Add factor encodings ONLY for regression tests (dummy variable creation)
      // ANOVA tests use effect coding and don't need baseline encodings
      const isRegressionTest = testLower.includes('regression')
      if (isRegressionTest && this.columnEncodingMappings.size > 0) {
        const encodingsObj: Record<string, Record<string, number>> = {}
        this.columnEncodingMappings.forEach((encoding, colName) => {
          encodingsObj[colName] = Object.fromEntries(encoding)
        })
        parameters.factorEncodings = encodingsObj
      }

      // Add simple effects configuration for ANOVA tests
      // Two-Way ANOVA: Pass { factor_a_within_factor_b: bool, factor_b_within_factor_a: bool }
      // Multi-Factorial ANOVA: Pass array of { factor, within } objects
      if (normalizedTestName.includes('two way')) {
        // Two-Way ANOVA: use twoWayAnovaContext
        parameters.simple_effects = {
          factor_a_within_factor_b: this.twoWayAnovaContext.factorAWithinB,
          factor_b_within_factor_a: this.twoWayAnovaContext.factorBWithinA,
        }
        parameters.posthoc_adjustment = this.twoWayAnovaContext.adjustmentMethod ?? 'tukey'
        if (this.twoWayAnovaContext.adjustmentMethod === 'fdr_bh' && this.twoWayAnovaContext.posthocQ !== null) {
          parameters.posthoc_q = this.twoWayAnovaContext.posthocQ
        }
        if (Object.keys(this.twoWayAnovaContext.controlLevels).length > 0) {
          parameters.control_levels = this.twoWayAnovaContext.controlLevels
        }
      } else if (testLower.includes('multifactorial') || normalizedTestName.includes('multi factorial')) {
        // Multi-Factorial ANOVA: use multiFactorialContext simple effects if any
        if (this.multiFactorialContext.simpleEffects.length > 0) {
          parameters.simple_effects = this.multiFactorialContext.simpleEffects
        }
        parameters.posthoc_adjustment = this.multiFactorialContext.adjustmentMethod ?? 'tukey'
        if (this.multiFactorialContext.adjustmentMethod === 'fdr_bh' && this.multiFactorialContext.posthocQ !== null) {
          parameters.posthoc_q = this.multiFactorialContext.posthocQ
        }
        if (Object.keys(this.multiFactorialContext.controlLevels).length > 0) {
          parameters.control_levels = this.multiFactorialContext.controlLevels
        }
      } else if (testDefForParams?.id === 'lmm_anova' || normalizedTestName.includes('lmm anova')) {
        if (this.lmmAnovaContext.config) {
          parameters.lmm_config = this.lmmAnovaContext.config
        }
        const lmmSimpleEffects =
          this.lmmAnovaContext.config?.simpleEffects ?? this.lmmAnovaContext.simpleEffects
        if (Array.isArray(lmmSimpleEffects) && lmmSimpleEffects.length > 0) {
          parameters.simple_effects = lmmSimpleEffects
        } else {
          delete parameters.simple_effects
        }
        parameters.posthoc_adjustment = this.lmmAnovaContext.adjustmentMethod ?? 'tukey'
        if (this.lmmAnovaContext.adjustmentMethod === 'fdr_bh' && this.lmmAnovaContext.posthocQ !== null) {
          parameters.posthoc_q = this.lmmAnovaContext.posthocQ
        }
        if (Object.keys(this.lmmAnovaContext.controlLevels).length > 0) {
          parameters.control_levels = this.lmmAnovaContext.controlLevels
        }
      }

      let payloadResult: BuildPayloadResult

      if (isLargeDataset) {
        // Large dataset: validate selection, skip payload data extraction
        const validation = module.validateSelection(this.selectedColumns)
        if (!validation.isValid) {
          for (const error of validation.errors) {
            toast.error(String(error), { id: toastId })
          }
          return
        }

        if (validation.warnings.length > 0) {
          for (const warning of validation.warnings) {
            toast.warning(String(warning))
          }
        }

        if (testLower.includes('logistic')) {
          if (!parameters.dependentVariable) {
            toast.error('Logistic regression requires a dependent variable selection.', { id: toastId })
            return
          }
          if (!parameters.outcomeEncoding) {
            toast.error(
              'Logistic regression requires outcome encoding. Please select a baseline level for the dependent variable.',
              { id: toastId }
            )
            return
          }
        }

        let payloadTestName = testName
        if (testName === 'linear_regression') {
          const predictorColumns = this.selectedColumns.slice(1)
          if (predictorColumns.length === 1) {
            const predictor = predictorColumns[0]
            const isCategoricalPredictor = predictor
              ? predictor.dataType === ColumnDataType.Categorical ||
                predictor.dataType === ColumnDataType.Binary
              : false
            const encodingLevels =
              predictor && parameters.factorEncodings?.[predictor.columnName]
                ? Object.keys(parameters.factorEncodings[predictor.columnName]!).length
                : predictor?.uniqueValueCount
            if (predictor && isCategoricalPredictor && (encodingLevels ?? 0) > 2) {
              payloadTestName = 'multiple_linear_regression'
              toast.warning(
                `Predictor '${predictor.columnName}' has ${(encodingLevels ?? predictor.uniqueValueCount)} categories. Using Multiple Linear Regression.`
              )
            }
          }
        }

        payloadResult = {
          success: true,
          payload: {
            test: payloadTestName,
            data: {},
            parameters,
          },
          encodingMappings:
            this.columnEncodingMappings.size > 0 ? new Map(this.columnEncodingMappings) : undefined,
        }
      } else {
        // Small dataset: build payload from row data
        payloadResult = module.buildPayload(
          this.selectedColumns,
          selectedColumnIndices,
          rowsArray,
          parameters
        )
      }

      if (!payloadResult.success) {
        toast.error(`Payload building failed: ${payloadResult.error}`, { id: toastId })
        return
      }

      // Surface payload-level warnings (e.g., low event counts in logistic regression)
      const payloadWarnings = payloadResult.payload?.metadata?.warnings
      if (Array.isArray(payloadWarnings) && payloadWarnings.length > 0) {
        for (const warning of payloadWarnings) {
          toast.warning(String(warning))
        }
      }

      // Execute test via Tauri invoke
      // Use actual test name from payload (handles auto-switch scenarios like Simple → Multiple Linear)
      const actualTestName = payloadResult.payload!.test
      const fastpathKey = actualTestName.trim().toLowerCase()
      const isAggregateFastpathTest = AGGREGATE_FASTPATH_TESTS.has(fastpathKey)
      logger.info(`Executing ${actualTestName}`, {
        testType: actualTestName,
        columns: this.selectedColumns.length,
        rows: rowsArray.length,
      })

      if (actualTestName.toLowerCase().includes('anova')) {
        const anovaPayloadLog = {
          testType: actualTestName,
          posthoc_adjustment: parameters.posthoc_adjustment,
          simple_effects: parameters.simple_effects,
          control_levels: parameters.control_levels,
        }
        logger.info('ANOVA payload adjustment', anovaPayloadLog)
        console.log('[ANOVA payload adjustment]', anovaPayloadLog)
      }

      // NOTE: Removed verbose paired t-test payload logging (noisy + data exposure).

      // Phase 5: Build invoke payload based on dataset size
      // For large datasets: pass analysisMode='large' + columnIds, let Python use DataProvider
      // For small datasets: pass actual data in payload
      let arrowDataPath: string | null = null
      let analysisDuckdbPath: string | null = duckdbPath
      let aggregateInput: Record<string, unknown> | null = null

      const wantsRustAggregates =
        isLargeDataset &&
        RUST_AGGREGATE_TESTS.has(fastpathKey)

      if (wantsRustAggregates && !duckdbReady) {
        logger.error('Cannot run Rust aggregates: DuckDB overlay flush failed', {
          datasetId: this._currentDataset.id,
          testName: actualTestName,
          duckdbFlushError,
        })
        toast.error('Failed to prepare data for analysis (DuckDB flush failed).', { id: toastId })
        return
      }

      const useRustAggregates = wantsRustAggregates && duckdbReady

      const useDuckdbFastpath =
        isLargeDataset &&
        Boolean(duckdbPath) &&
        duckdbReady &&
        isAggregateFastpathTest &&
        !useRustAggregates

      if (isLargeDataset) {
        const duckdbPathExtension =
          duckdbPath && duckdbPath.includes('.')
            ? duckdbPath.slice(duckdbPath.lastIndexOf('.'))
            : null
        const duckdbPathIsEcpdb =
          typeof duckdbPath === 'string' && duckdbPath.toLowerCase().endsWith('.ecpdb')
        const dataPathDecision = {
          datasetId: this._currentDataset.id,
          testName: actualTestName,
          executionMode,
          isAggregateFastpathTest,
          wantsRustAggregates,
          useRustAggregates,
          duckdbPath,
          duckdbPathExtension,
          duckdbPathIsEcpdb,
          duckdbReady,
          duckdbFlushError,
          selectedColumns: selectedColumnIds.length,
          decision: useRustAggregates
            ? 'rust-aggregate'
            : useDuckdbFastpath
              ? 'duckdb-aggregate'
              : 'arrow-export',
        }
        logger.info('Large dataset analysis path selected', dataPathDecision)
        console.log('[Large dataset path]', dataPathDecision)
      }

      if (useRustAggregates) {
        const numericColumns = this.selectedColumns.filter(
          col => col.dataType === ColumnDataType.Numeric || col.dataType === ColumnDataType.Ordinal
        )
        const categoricalColumns = this.selectedColumns.filter(
          col => col.dataType === ColumnDataType.Categorical || col.dataType === ColumnDataType.Binary
        )
        const columnsById = new Map(this.selectedColumns.map(col => [col.columnId, col]))

        let numericColumnId: string | null = null
        let groupColumnId: string | null = null

        if (fastpathKey === 'descriptive_stats') {
          numericColumnId = numericColumns[0]?.columnId ?? null
        } else if (fastpathKey === 'one_sample_ttest') {
          numericColumnId = numericColumns[0]?.columnId ?? null
        } else if (fastpathKey === 'independent_ttest' || fastpathKey === 't_test_two_sample') {
          const mapping = parameters.ttest_mapping as IndependentTTestColumnMapping | undefined
          const mappedOutcome = mapping?.outcome
          const mappedGroup = mapping?.group
          if (mappedOutcome && mappedGroup && columnsById.has(mappedOutcome) && columnsById.has(mappedGroup)) {
            numericColumnId = mappedOutcome
            groupColumnId = mappedGroup
          } else {
            numericColumnId = numericColumns[0]?.columnId ?? null
            groupColumnId = categoricalColumns[0]?.columnId ?? null
          }
        } else if (fastpathKey === 'paired_ttest' || fastpathKey === 't_test_paired') {
          const mapping = parameters.paired_ttest_mapping as PairedTTestColumnMapping | undefined
          const mappedGroup = mapping?.group
          const mappedOutcome = mapping?.outcome
          if (mappedGroup && mappedOutcome && columnsById.has(mappedGroup) && columnsById.has(mappedOutcome)) {
            numericColumnId = mappedGroup
            groupColumnId = mappedOutcome
          } else {
            numericColumnId = numericColumns[0]?.columnId ?? null
            groupColumnId = numericColumns[1]?.columnId ?? null
          }
        } else if (fastpathKey === 'correlation_pearson' || fastpathKey === 'correlation_spearman') {
          numericColumnId = numericColumns[0]?.columnId ?? null
          groupColumnId = numericColumns[1]?.columnId ?? null
        } else if (fastpathKey === 'one_way_anova') {
          const mapping = parameters.one_way_anova_mapping as OneWayAnovaColumnMapping | undefined
          const mappedOutcome = mapping?.outcome
          const mappedGroup = mapping?.group
          if (mappedOutcome && mappedGroup && columnsById.has(mappedOutcome) && columnsById.has(mappedGroup)) {
            numericColumnId = mappedOutcome
            groupColumnId = mappedGroup
          } else {
            numericColumnId = numericColumns[0]?.columnId ?? null
            groupColumnId = categoricalColumns[0]?.columnId ?? null
          }
        }

        const requiresSecondColumn = !['one_sample_ttest', 'descriptive_stats'].includes(fastpathKey)
        if (!numericColumnId || (requiresSecondColumn && !groupColumnId)) {
          logger.error('Rust aggregate column resolution failed', {
            testName: actualTestName,
            numericColumnId,
            groupColumnId,
          })
          toast.error('Failed to prepare aggregates for analysis (missing column mapping).', { id: toastId })
          return
        }

        try {
          const aggregateResponse = await cacheService.getAggregatesForTest(
            this._currentDataset.id,
            fastpathKey,
            numericColumnId,
            groupColumnId
          )
          aggregateInput = aggregateResponse.aggregates as Record<string, unknown>
          analysisDuckdbPath = null
          logger.info('Prepared Rust aggregates for analysis', {
            datasetId: this._currentDataset.id,
            testName: actualTestName,
            numericColumnId,
            groupColumnId,
          })
          console.log('[Rust aggregates] Prepared', {
            datasetId: this._currentDataset.id,
            testName: actualTestName,
          })
        } catch (aggregateError) {
          logger.error('Failed to compute Rust aggregates for analysis', {
            error: aggregateError instanceof Error ? aggregateError.message : String(aggregateError),
          })
          toast.error('Failed to prepare data for analysis (aggregate compute).', { id: toastId })
          return
        }
      }

      if (isLargeDataset && !useDuckdbFastpath && !useRustAggregates) {
        try {
          arrowDataPath = await cacheService.exportColumnsToArrow(
            this._currentDataset.id,
            selectedColumnIds
          )
          analysisDuckdbPath = null
          logger.info('Prepared Arrow export for analysis', {
            datasetId: this._currentDataset.id,
            columns: selectedColumnIds.length,
            arrowDataPath,
          })
        } catch (arrowError) {
          logger.error('Failed to export columns to Arrow for analysis', {
            error: arrowError instanceof Error ? arrowError.message : String(arrowError),
          })
          toast.error('Failed to prepare data for analysis (Arrow export).', { id: toastId })
          return
        }
      }

      const result = await invoke<Record<string, unknown>>('run_statistical_test', {
        testName: actualTestName,
        // For large datasets, payload.data may be empty - Python will fetch via DataProvider
        data: isLargeDataset ? {} : payloadResult.payload!.data,
        parameters: {
          ...payloadResult.payload!.parameters,
          // Phase 2+5: Large dataset parameters for Python DataProvider
          ...(isLargeDataset
            ? {
                ...(analysisDuckdbPath ? { duckdb_path: analysisDuckdbPath } : {}),
                analysis_mode: 'large',
                execution_mode: executionMode,  // Phase 2: User-selected execution mode
                column_ids: selectedColumnIds,
                column_names: this.selectedColumns.map(col => col.columnName),
                column_types: this.selectedColumns.map(col => col.dataType),
                ...(aggregateInput
                  ? { aggregate_input: aggregateInput, aggregate_source: 'rust_duckdb' }
                  : {}),
              }
            : {}),
        },
        arrowDataPath,
      })

      // Get test definition for parsing using actual test name
      const testDef = getTestDefinition(actualTestName)
      if (!testDef) {
        logger.error(`Test definition not found: ${actualTestName}`)
        toast.error(`Test definition not found: ${actualTestName}`, { id: toastId })
        return
      }

      const resultsDataRaw = (result.results as Record<string, unknown> | undefined) ?? result
      const selectedColumnNames = this.selectedColumns.map((col) => col.columnName)

      if (
        resultsDataRaw &&
        typeof resultsDataRaw === 'object' &&
        'success' in resultsDataRaw &&
        (resultsDataRaw as { success?: boolean }).success === false
      ) {
        const backendErrorPayload = (resultsDataRaw as { error?: unknown }).error
        const structuredBackendError = extractAppError(backendErrorPayload)
        if (structuredBackendError) {
          logger.error(
            `Python backend error [${structuredBackendError.code}]: ${structuredBackendError.message}`,
            structuredBackendError.detail ? new Error(structuredBackendError.detail) : undefined
          )
          showAppErrorToast(structuredBackendError, { id: toastId })
          return
        }
        const errorMessage = extractErrorMessage(
          backendErrorPayload,
          'Python backend returned an error.'
        )
        logger.error('Python backend error', new Error(errorMessage))
        toast.error(`Test execution failed: ${errorMessage}`, { id: toastId })
        return
      }

      // Log result structure for ANOVA debugging
      if (testDef.family === 'parametric' && actualTestName.toLowerCase().includes('anova')) {
        logger.debug('ANOVA result structure', {
          testType: (resultsDataRaw as any).test_type,
          hasMainEffects: 'main_effects' in resultsDataRaw,
          hasFactor1F: 'factor1_f' in resultsDataRaw,
          hasInteraction: 'interaction_f' in resultsDataRaw,
          topLevelKeys: Object.keys(resultsDataRaw).slice(0, 10),
        })

        const anovaResultLog = {
          testType: actualTestName,
          adjustment_method: (resultsDataRaw as any).adjustment_method,
          first_pairwise_method: Array.isArray((resultsDataRaw as any).pairwise_comparisons)
            ? (resultsDataRaw as any).pairwise_comparisons[0]?.method
            : undefined,
        }
        logger.info('ANOVA result adjustment', anovaResultLog)
        console.log('[ANOVA result adjustment]', anovaResultLog)

        // If Python returned an error, log it
        if ((resultsDataRaw as any).error) {
          logger.error('Python returned error', new Error(String((resultsDataRaw as any).error)))
        }
      }

      const payloadData = payloadResult.payload?.data as Record<string, unknown> | undefined
      const payloadMetadata = payloadResult.payload?.metadata as Record<string, unknown> | undefined

      // Augment results with frontend-known context when backend doesn't echo it back.
      // Keeps backend frozen while improving table labels (e.g., dose headers in synergy matrices).
      const resultsData: Record<string, unknown> = { ...(resultsDataRaw as Record<string, unknown>) }

      // Ensure Group 7 seed is surfaced in results when backend omits it.
      if (
        (testDef.id === 'mediation_model4' ||
          testDef.id === 'moderation_model1' ||
          testDef.id === 'moderated_mediation_model7') &&
        resultsData.model_info &&
        typeof resultsData.model_info === 'object'
      ) {
        const modelInfo = resultsData.model_info as Record<string, unknown>
        if (modelInfo.seed === null || modelInfo.seed === undefined) {
          const fallbackSeed =
            (parameters.seed as number | undefined) ??
            (testDef.id === 'mediation_model4'
              ? this.mediationContext.seed
              : testDef.id === 'moderation_model1'
                ? this.moderationContext.seed
                : this.moderatedMediationContext.seed)
          if (fallbackSeed !== undefined && fallbackSeed !== null) {
            resultsData.model_info = { ...modelInfo, seed: fallbackSeed }
          }
        }
      }
      if (testDef.family === 'pharmacology' && testDef.id.startsWith('synergy_') && payloadData) {
        if (resultsData.doses_a === undefined && payloadData.doses_a !== undefined) {
          resultsData.doses_a = payloadData.doses_a
        }
        if (resultsData.doses_b === undefined && payloadData.doses_b !== undefined) {
          resultsData.doses_b = payloadData.doses_b
        }
        // Sparse-mode payloads use dose_a/dose_b (row-wise) instead of doses_a/doses_b.
        if (resultsData.doses_a === undefined && payloadData.dose_a !== undefined) {
          resultsData.doses_a = payloadData.dose_a
        }
        if (resultsData.doses_b === undefined && payloadData.dose_b !== undefined) {
          resultsData.doses_b = payloadData.dose_b
        }

        // Merge frontend warnings from payload metadata into results
        if (payloadMetadata?.warnings && Array.isArray(payloadMetadata.warnings)) {
          const existingWarnings = (resultsData.warnings as string[] | undefined) || []
          resultsData.warnings = [...existingWarnings, ...payloadMetadata.warnings]
        }
      }

      // Preserve dose-response input data for plotting
      if (testDef.family === 'pharmacology' && testDef.id.startsWith('dose_response_') && payloadData) {
        // Preserve original doses from payload
        if (resultsData.input_doses === undefined && payloadData.doses !== undefined) {
          resultsData.input_doses = payloadData.doses
        }
        // Recover observed responses: observed = fitted + residual
        const fittedValues = resultsData.fitted_values as number[] | undefined
        const residuals = resultsData.residuals as number[] | undefined
        if (
          resultsData.input_responses === undefined &&
          fittedValues &&
          residuals &&
          fittedValues.length === residuals.length
        ) {
          resultsData.input_responses = fittedValues.map((f, i) => f + (residuals[i] ?? 0))
        }
      }

      const parsed = parseTestResults(
        resultsData as Record<string, unknown>,
        testDef.family,
        testDef.id
      )

      logger.debug('Parsed results', {
        hasStatistics: !!parsed.statistics,
        hasSummary: !!parsed.summary,
        statisticsKeys: parsed.statistics ? Object.keys(parsed.statistics) : [],
      })

      const primaryColumnName =
        (payloadMetadata?.variable_name as string | undefined) ||
        this.selectedColumns[0]?.columnName ||
        (payloadData?.dependent_name as string | undefined) ||
        (payloadData?.value_column as string | undefined) ||
        'response'

      // DEBUG: Log raw Python results before table building
      if (testDef.id === 'paired_ttest') {
        console.log('=== PAIRED T-TEST RAW RESULTS ===')
        console.log('resultsData keys:', Object.keys(resultsData))
        console.log('resultsData:', resultsData)
        console.log('=================================')
      }

      const tableBuilderResultInput: Record<string, unknown> = {
        ...(resultsData as Record<string, unknown>),
      }
      if (payloadResult.payload?.parameters && tableBuilderResultInput.parameters == null) {
        tableBuilderResultInput.parameters = payloadResult.payload.parameters
      }
      const ecpTableCollection = buildECPTables(
        testDef.id,
        tableBuilderResultInput,
        { variableName: primaryColumnName }
      )

      // Phase 7: Extract sampling metadata from Python results (Tier 3 tests on large datasets)
      const pythonSamplingMeta = (resultsData as Record<string, unknown>)._sampling_metadata as
        | {
            is_sampled?: boolean
            sample_size?: number
            total_rows?: number
            sampling_method?: string
            random_seed?: number
            sample_percentage?: number
            confidence_note?: string
          }
        | undefined

      const plotPayload =
        !isLargeDataset &&
        payloadResult.payload &&
        Object.keys(payloadResult.payload.data ?? {}).length > 0 &&
        GROUP1_PLOT_PAYLOAD_TESTS.has(testDef.id)
          ? payloadResult.payload
          : undefined

      const rawResult = (resultsData ?? {}) as Record<string, unknown>
      const survivalExtras: Record<string, unknown> = {}
      if (Array.isArray(rawResult.adjusted_survival_curves)) {
        survivalExtras.adjustedSurvivalCurves = rawResult.adjusted_survival_curves
      }
      if (typeof rawResult.adjusted_survival_note === 'string') {
        survivalExtras.adjustedSurvivalNote = rawResult.adjusted_survival_note
      }
      if (rawResult.smoothed_hazard && typeof rawResult.smoothed_hazard === 'object') {
        survivalExtras.smoothedHazard = rawResult.smoothed_hazard
      }

      const testResult: any = {
        id: crypto.randomUUID(),
        testId: testDef.id,
        testName: testDef.displayName,
        family: testDef.family,
        statisticsFamilyId: useAppStore.getState().activeFamilyId,
        executedAt: new Date(),
        parameters: {
          ...payloadResult.payload!.parameters,
          columns: selectedColumnNames,
        },
        statistics: parsed.statistics ?? {},
        modelFit: parsed.modelFit,
        coefficients: parsed.coefficients,
        summary: {
          Test: testDef.displayName,
          Columns: selectedColumnNames.join(', '),
          ...(parsed.summary ?? {}),
        },
        ecpTableCollection,
        rawOutput: resultsData,
        plotPayload,
        encodingMappings: payloadResult.encodingMappings,
        dummyVariableInfo: payloadResult.payload?.data?.dummy_variable_info,
        ...survivalExtras,
        // Phase 7: Add sampling metadata if present (Tier 3 tests on large datasets)
        ...(pythonSamplingMeta?.is_sampled && {
          samplingMetadata: {
            isSampled: pythonSamplingMeta.is_sampled,
            sampleSize: pythonSamplingMeta.sample_size ?? 0,
            totalRows: pythonSamplingMeta.total_rows ?? 0,
            samplingMethod: (pythonSamplingMeta.sampling_method as 'random' | 'stratified') ?? 'random',
            randomSeed: pythonSamplingMeta.random_seed ?? 42,
            samplePercentage: pythonSamplingMeta.sample_percentage ?? 0,
            confidenceNote: pythonSamplingMeta.confidence_note ?? '',
          },
        }),
        // Large dataset flag - prevents plot auto-generation (Plotly would freeze on 18M+ rows)
        isLargeDataset,
      }

      const pValue = testResult.statistics.pValue
      if (pValue !== undefined && testResult.summary) {
        testResult.summary['p-value'] = pValue < 0.001 ? '< 0.001' : pValue.toFixed(4)
        testResult.summary['Significant'] = pValue < 0.05 ? 'Yes (alpha = 0.05)' : 'No'
      }

      useResultsStore.getState().addResult(testResult)

      // Phase 2: Auto-generate plots for results (supports multi-plot via recipes)
      // Skip plot generation for large datasets - Plotly would freeze on 18M+ rows
      // Large datasets get statistics only, no visualizations
      if (isLargeDataset) {
        logger.info('[Plot Auto-Gen] Skipping plot generation for large dataset', {
          testId: testResult.testId,
          testName: testResult.testName,
        })
      } else {
        logger.debug('[Plot Auto-Gen] Starting plot generation', {
          testId: testResult.testId,
          testName: testResult.testName,
          hasVisualizations: Boolean(testResult.visualizations),
          hasPlotlyJson: Boolean(testResult.visualizations?.plotlyJson),
          hasCellSummaries: Boolean(testResult.cellSummaries),
        })
      }

      // Primary guard: Skip plot generation entirely for large datasets
      const plotPayloads = isLargeDataset ? [] : buildPlotSpecsFromResult(testResult)

      logger.debug('[Plot Auto-Gen] Plot generation result', {
        testId: testResult.testId,
        plotCount: plotPayloads.length,
        plotTypes: plotPayloads.map(p => p.plot.type),
      })

      if (plotPayloads.length > 0) {
        const plotsStore = usePlotsStore.getState()
        const existing = plotsStore.getPlotsByResult(testResult.id)

        logger.debug('[Plot Auto-Gen] Checking for existing plots', {
          resultId: testResult.id,
          existingCount: existing.length,
        })

        if (existing.length === 0) {
          // Add all plots from recipe/builder
          for (const plotPayload of plotPayloads) {
            plotsStore.addPlot(plotPayload.plot, { preserveActiveUserPlot: true })
            if (Object.keys(plotPayload.stats).length > 0) {
              plotsStore.setPlotStats(plotPayload.plot.id, plotPayload.stats)
            }
            logger.debug('[Plot Auto-Gen] Plot added to gallery', {
              plotId: plotPayload.plot.id,
              plotType: plotPayload.plot.type,
              plotTitle: plotPayload.plot.title,
            })
          }
        } else {
          // Add missing plots and refresh stats for existing ones.
          const existingByKey = new Map(
            existing.map((plot) => [`${plot.type}|${plot.title ?? ''}`, plot])
          )
          let addedCount = 0
          let refreshedCount = 0
          for (const plotPayload of plotPayloads) {
            const key = `${plotPayload.plot.type}|${plotPayload.plot.title ?? ''}`
            const existingPlot = existingByKey.get(key)
            if (existingPlot) {
              if (isPlaceholderPlot(existingPlot)) {
                const { id: _id, sourceType: _sourceType, createdAt: _createdAt, ...updates } =
                  plotPayload.plot
                plotsStore.updatePlot(existingPlot.id, updates)
                if (Object.keys(plotPayload.stats).length > 0) {
                  plotsStore.setPlotStats(existingPlot.id, plotPayload.stats)
                }
                refreshedCount += 1
                continue
              }
              if (Object.keys(plotPayload.stats).length > 0) {
                plotsStore.setPlotStats(existingPlot.id, plotPayload.stats)
                refreshedCount += 1
              }
              continue
            }
            plotsStore.addPlot(plotPayload.plot, { preserveActiveUserPlot: true })
            if (Object.keys(plotPayload.stats).length > 0) {
              plotsStore.setPlotStats(plotPayload.plot.id, plotPayload.stats)
            }
            existingByKey.set(key, plotPayload.plot)
            addedCount += 1
            logger.debug('[Plot Auto-Gen] Plot added to gallery (missing)', {
              plotId: plotPayload.plot.id,
              plotType: plotPayload.plot.type,
              plotTitle: plotPayload.plot.title,
            })
          }
          logger.debug('[Plot Auto-Gen] Existing plots retained', {
            existingCount: existing.length,
            addedCount,
            refreshedCount,
          })
        }
      } else {
        logger.warn('[Plot Auto-Gen] No plots generated', {
          testId: testResult.testId,
          testName: testResult.testName,
        })
      }

      // Phase 2: Display any warnings from Python results (including OOM fallback)
      const pythonWarnings = (resultsData as Record<string, unknown>).warnings
      if (Array.isArray(pythonWarnings) && pythonWarnings.length > 0) {
        for (const warning of pythonWarnings) {
          toast.warning(String(warning))
        }
      }

      // Phase 2: Check for OOM fallback specifically
      if ((resultsData as Record<string, unknown>).oom_fallback) {
        toast.info('Analysis completed with memory-optimized sampling', {
          description: 'Click results for details about the sample used.',
          duration: 5000,
        })
      } else {
        toast.success(`${testDef.displayName} completed`, { id: toastId })
      }

      // Switch to results view
      useAppStore.getState().setWorkspaceViewMode('results')
    } catch (error) {
      console.error('Test execution error:', error)
      const structuredError = extractAppError(error)
      if (structuredError) {
        showAppErrorToast(structuredError, { id: toastId })
        markErrorToastShown(error)
      } else {
        toast.error(`Test failed: ${extractErrorMessage(error, 'Unknown error')}`, { id: toastId })
        markErrorToastShown(error)
      }
      throw error
    }
  }
}

