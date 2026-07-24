/**
 * useStatisticalAnalysisController Hook
 *
 * Integrates StatisticalAnalysisController with React state management.
 * Provides orchestrated dialog workflow for statistical analysis configuration.
 *
 * Replicates Avalonia's StatisticalAnalysisViewModel.RunAnalysis() pattern
 * with React hooks and dialog state management.
 *
 * Reference: easyCris.Avalonia/ViewModels/StatisticalAnalysisViewModel.cs
 * Lines: 1586-4376 (orchestration logic)
 */

import { useState, useCallback, useRef, useMemo } from 'react'
import type { GridViewScope } from '@/lib/grid/gridViewScope'
import {
  StatisticalAnalysisController,
  type IDialogService,
  type DependentVariableDialogResult,
  type EncodingDialogResult,
  type FactorEncodingDialogResult,
  type SimpleEffectsDialogResult,
  type MultiFactorialSimpleEffectsDialogResult,
  type LmmAnovaConfigDialogResult,
  type TwoWayFactorMapperDialogResult,
  type MultifactorialFactorMapperDialogResult,
  type DoseResponseColumnMapperDialogResult,
  type SynergyColumnMapperDialogResult,
  type ChiSquareGofColumnMapperDialogResult,
  type ChiSquareColumnMapperDialogResult,
  type FisherExactColumnMapperDialogResult,
  type McNemarColumnMapperDialogResult,
  type IndependentTTestColumnMapperDialogResult,
  type MannWhitneyColumnMapperDialogResult,
  type PairedTTestColumnMapperDialogResult,
  type WilcoxonColumnMapperDialogResult,
  type OneWayAnovaColumnMapperDialogResult,
  type KruskalWallisColumnMapperDialogResult,
  type SurvivalAnalysisDialogResult,
  type MediationAnalysisDialogResult,
  type ModerationAnalysisDialogResult,
  type ModeratedMediationAnalysisDialogResult,
  type ExecutionModeDialogResult,
} from '@/lib/analysis/StatisticalAnalysisController'
import type { ColumnClassification } from '@/lib/modules/core/types'

/**
 * Dialog state for orchestration
 */
interface DialogState {
  showDVSelection: boolean
  showDVEncoding: boolean
  showFactorEncoding: boolean // ONLY for regression
  showSimpleEffects: boolean // For 2-factor ANOVA (Two-Way, Scheirer-Ray-Hare)
  showMultiFactorialSimpleEffects: boolean // For 3+ factor ANOVA (Multi-Factorial, Scheirer-Ray-Hare)
  multiFactorialFactorNames: string[] // Factor names for multi-factorial dialog (passed directly to avoid async timing)
  multiFactorialSimpleEffectsTestIdPrefix: string // Prefix for reused simple-effects dialog test ids
  showLmmAnovaConfig: boolean // Dedicated Linear Mixed Model configuration dialog
  showTwoWayFactorMapper: boolean // For Two-Way ANOVA factor role mapping (Factor A vs Factor B)
  showMultifactorialFactorMapper: boolean // For Multifactorial ANOVA factor role mapping (Primary, Secondary, Facets)
  showDoseResponseColumnMapper: boolean // For dose-response tests (3PL, 4PL, 5PL)
  doseResponseMapperTestName: string // Test name to show in dose-response mapper dialog title
  showSynergyColumnMapper: boolean // For synergy tests (Bliss, HSA, Loewe, ZIP, All)
  synergyMapperTestName: string // Test name to show in synergy mapper dialog title
  showChiSquareGofColumnMapper: boolean // For chi-square GOF column mapper
  chiSquareGofMapperTestName: string // Test name to show in GOF mapper dialog title
  showChiSquareColumnMapper: boolean // For chi-square independence column mapper
  chiSquareMapperTestName: string // Test name to show in chi-square mapper dialog title
  showFisherExactColumnMapper: boolean // For Fisher's Exact column mapper
  fisherExactMapperTestName: string // Test name to show in Fisher's Exact mapper dialog title
  showMcNemarColumnMapper: boolean // For McNemar's Test column mapper
  mcnemarMapperTestName: string // Test name to show in McNemar mapper dialog title
  showIndependentTTestColumnMapper: boolean // For Independent T-Test column mapper
  independentTTestMapperTestName: string // Test name to show in T-Test mapper dialog title
  showMannWhitneyColumnMapper: boolean // For Mann-Whitney U column mapper
  mannWhitneyMapperTestName: string // Test name to show in Mann-Whitney mapper dialog title
  showPairedTTestColumnMapper: boolean // For Paired T-Test column mapper
  pairedTTestMapperTestName: string // Test name to show in Paired T-Test mapper dialog title
  showWilcoxonColumnMapper: boolean // For Wilcoxon Signed-Rank Test column mapper
  wilcoxonMapperTestName: string // Test name to show in Wilcoxon mapper dialog title
  showOneWayAnovaColumnMapper: boolean // For One-Way ANOVA column mapper (long format)
  oneWayAnovaMapperTestName: string // Test name to show in One-Way ANOVA mapper dialog title
  oneWayAnovaGroupLevels: string[] // Group levels for Dunnett control selection
  showKruskalWallisColumnMapper: boolean // For Kruskal-Wallis Test column mapper (long format)
  kruskalWallisMapperTestName: string // Test name to show in Kruskal-Wallis mapper dialog title
  showSurvivalAnalysisDialog: boolean // For survival tests (KM, Cox, NA)
  survivalAnalysisType: 'kaplan_meier' | 'cox_regression' | 'nelson_aalen'
  showMediationAnalysisDialog: boolean // Model 4 - Simple mediation
  showModerationAnalysisDialog: boolean // Model 1 - Simple moderation
  showModeratedMediationAnalysisDialog: boolean // Model 7 - Moderated mediation
  showConfirmDialog: boolean // Generic confirmation dialog
  confirmDialogTitle: string // Title for confirm dialog
  confirmDialogMessage: string // Message for confirm dialog
  confirmDialogConfirmLabel: string // Confirm button label
  confirmDialogCancelLabel: string // Cancel button label
  // Phase 2: Execution mode dialog for large datasets
  showExecutionModeDialog: boolean
  executionModeTestName: string
  executionModeRowCount: number
}

/**
 * Dialog data context passed to dialogs
 */
export interface DialogContext {
  columns: ColumnClassification[]
  selectedTests: string[]
}

/**
 * Hook result
 */
interface UseStatisticalAnalysisControllerResult {
  // Controller instance
  controller: StatisticalAnalysisController

  // Dialog state
  dialogState: DialogState
  dialogContext: DialogContext

  // Orchestration method
  runAnalysisWithTests: (
    testNames: string[],
    columns: ColumnClassification[],
    dataset: any,
    familyId?: string | null,
    viewScope?: GridViewScope | null
  ) => Promise<void>

  // Update dialog context (for dynamic context updates between steps)
  updateDialogContext: (updates: Partial<DialogContext>) => void

  // Cancel orchestration
  cancelOrchestration: () => void

  // Dialog callbacks (to be called from dialog components)
  handleDVSelectionConfirm: (result: DependentVariableDialogResult) => void
  handleDVSelectionCancel: () => void
  handleDVEncodingConfirm: (result: EncodingDialogResult) => void
  handleDVEncodingCancel: () => void
  handleFactorEncodingConfirm: (result: FactorEncodingDialogResult) => void
  handleFactorEncodingCancel: () => void
  handleSimpleEffectsConfirm: (result: SimpleEffectsDialogResult) => void
  handleSimpleEffectsCancel: () => void
  handleMultiFactorialSimpleEffectsConfirm: (result: MultiFactorialSimpleEffectsDialogResult) => void
  handleMultiFactorialSimpleEffectsCancel: () => void
  handleLmmAnovaConfigConfirm: (result: LmmAnovaConfigDialogResult) => void
  handleLmmAnovaConfigCancel: () => void
  handleTwoWayFactorMapperConfirm: (result: TwoWayFactorMapperDialogResult) => void
  handleTwoWayFactorMapperCancel: () => void
  handleMultifactorialFactorMapperConfirm: (result: MultifactorialFactorMapperDialogResult) => void
  handleMultifactorialFactorMapperCancel: () => void
  handleDoseResponseColumnMapperConfirm: (result: DoseResponseColumnMapperDialogResult) => void
  handleDoseResponseColumnMapperCancel: () => void
  handleSynergyColumnMapperConfirm: (result: SynergyColumnMapperDialogResult) => void
  handleSynergyColumnMapperCancel: () => void
  handleChiSquareGofColumnMapperConfirm: (result: ChiSquareGofColumnMapperDialogResult) => void
  handleChiSquareGofColumnMapperCancel: () => void
  handleChiSquareColumnMapperConfirm: (result: ChiSquareColumnMapperDialogResult) => void
  handleChiSquareColumnMapperCancel: () => void
  handleFisherExactColumnMapperConfirm: (result: FisherExactColumnMapperDialogResult) => void
  handleFisherExactColumnMapperCancel: () => void
  handleMcNemarColumnMapperConfirm: (result: McNemarColumnMapperDialogResult) => void
  handleMcNemarColumnMapperCancel: () => void
  handleIndependentTTestColumnMapperConfirm: (result: IndependentTTestColumnMapperDialogResult) => void
  handleIndependentTTestColumnMapperCancel: () => void
  handleMannWhitneyColumnMapperConfirm: (result: MannWhitneyColumnMapperDialogResult) => void
  handleMannWhitneyColumnMapperCancel: () => void
  handlePairedTTestColumnMapperConfirm: (result: PairedTTestColumnMapperDialogResult) => void
  handlePairedTTestColumnMapperCancel: () => void
  handleWilcoxonColumnMapperConfirm: (result: WilcoxonColumnMapperDialogResult) => void
  handleWilcoxonColumnMapperCancel: () => void
  handleOneWayAnovaColumnMapperConfirm: (result: OneWayAnovaColumnMapperDialogResult) => void
  handleOneWayAnovaColumnMapperCancel: () => void
  handleKruskalWallisColumnMapperConfirm: (result: KruskalWallisColumnMapperDialogResult) => void
  handleKruskalWallisColumnMapperCancel: () => void
  handleSurvivalAnalysisConfirm: (result: SurvivalAnalysisDialogResult) => void
  handleSurvivalAnalysisCancel: () => void
  handleMediationAnalysisConfirm: (result: MediationAnalysisDialogResult) => void
  handleMediationAnalysisCancel: () => void
  handleModerationAnalysisConfirm: (result: ModerationAnalysisDialogResult) => void
  handleModerationAnalysisCancel: () => void
  handleModeratedMediationAnalysisConfirm: (result: ModeratedMediationAnalysisDialogResult) => void
  handleModeratedMediationAnalysisCancel: () => void
  handleConfirmDialogConfirm: () => void
  handleConfirmDialogCancel: () => void
  // Phase 2: Execution mode dialog handlers
  handleExecutionModeSelect: (result: ExecutionModeDialogResult) => void
}

/**
 * Hook for integrating StatisticalAnalysisController with React
 *
 * @returns Controller instance, dialog state, and orchestration methods
 *
 * @example
 * const { controller, dialogState, runAnalysisWithTests } = useStatisticalAnalysisController()
 *
 * // Start orchestrated analysis
 * await runAnalysisWithTests(['linear_regression'], classifications, dataset)
 */
export function useStatisticalAnalysisController(): UseStatisticalAnalysisControllerResult {
  // Create controller instance (persists across renders)
  const controllerRef = useRef<StatisticalAnalysisController>(
    new StatisticalAnalysisController()
  )

  // Dialog visibility state
  const [dialogState, setDialogState] = useState<DialogState>({
    showDVSelection: false,
    showDVEncoding: false,
    showFactorEncoding: false, // ONLY for regression
    showSimpleEffects: false, // For 2-factor ANOVA
    showMultiFactorialSimpleEffects: false, // For 3+ factor ANOVA
    multiFactorialFactorNames: [], // Factor names for multi-factorial dialog
    multiFactorialSimpleEffectsTestIdPrefix: 'multi',
    showLmmAnovaConfig: false, // For Linear Mixed Model
    showTwoWayFactorMapper: false, // For Two-Way ANOVA factor role mapping
    showMultifactorialFactorMapper: false, // For Multifactorial ANOVA factor role mapping
    showDoseResponseColumnMapper: false, // For dose-response tests
    doseResponseMapperTestName: '', // Test name for dose-response mapper dialog
    showSynergyColumnMapper: false, // For synergy tests
    synergyMapperTestName: '', // Test name for synergy mapper dialog
    showChiSquareGofColumnMapper: false, // For chi-square GOF tests
    chiSquareGofMapperTestName: '', // Test name for GOF mapper dialog
    showChiSquareColumnMapper: false, // For chi-square independence tests
    chiSquareMapperTestName: '', // Test name for chi-square mapper dialog
    showFisherExactColumnMapper: false, // For Fisher's Exact tests
    fisherExactMapperTestName: '', // Test name for Fisher's Exact mapper dialog
    showMcNemarColumnMapper: false, // For McNemar's Test
    mcnemarMapperTestName: '', // Test name for McNemar mapper dialog
    showIndependentTTestColumnMapper: false, // For Independent T-Test
    independentTTestMapperTestName: '', // Test name for T-Test mapper dialog
    showMannWhitneyColumnMapper: false, // For Mann-Whitney U
    mannWhitneyMapperTestName: '', // Test name for Mann-Whitney mapper dialog
    showPairedTTestColumnMapper: false, // For Paired T-Test
    pairedTTestMapperTestName: '', // Test name for Paired T-Test mapper dialog
    showWilcoxonColumnMapper: false, // For Wilcoxon Signed-Rank Test
    wilcoxonMapperTestName: '', // Test name for Wilcoxon mapper dialog
    showOneWayAnovaColumnMapper: false, // For One-Way ANOVA (long format)
    oneWayAnovaMapperTestName: '', // Test name for One-Way ANOVA mapper dialog
    oneWayAnovaGroupLevels: [], // Group levels for Dunnett control selection
    showKruskalWallisColumnMapper: false, // For Kruskal-Wallis Test (long format)
    kruskalWallisMapperTestName: '', // Test name for Kruskal-Wallis mapper dialog
    showSurvivalAnalysisDialog: false, // For survival tests
    survivalAnalysisType: 'kaplan_meier',
    showMediationAnalysisDialog: false,
    showModerationAnalysisDialog: false,
    showModeratedMediationAnalysisDialog: false,
    showConfirmDialog: false, // Generic confirmation dialog
    confirmDialogTitle: '', // Title for confirm dialog
    confirmDialogMessage: '', // Message for confirm dialog
    confirmDialogConfirmLabel: 'Confirm', // Confirm button label
    confirmDialogCancelLabel: 'Cancel', // Cancel button label
    // Phase 2: Execution mode dialog
    showExecutionModeDialog: false,
    executionModeTestName: '',
    executionModeRowCount: 0,
  })

  // Dialog context (data passed to dialogs)
  const [dialogContext, setDialogContext] = useState<DialogContext>({
    columns: [],
    selectedTests: [],
  })

  // Promise resolve/reject refs for each dialog
  const dvSelectionResolveRef = useRef<((result: DependentVariableDialogResult) => void) | null>(
    null
  )
  const dvEncodingResolveRef = useRef<((result: EncodingDialogResult) => void) | null>(null)
  const factorEncodingResolveRef = useRef<((result: FactorEncodingDialogResult) => void) | null>(
    null
  )
  const simpleEffectsResolveRef = useRef<((result: SimpleEffectsDialogResult) => void) | null>(
    null
  )
  const multiFactorialSimpleEffectsResolveRef = useRef<((result: MultiFactorialSimpleEffectsDialogResult) => void) | null>(
    null
  )
  const lmmAnovaConfigResolveRef = useRef<((result: LmmAnovaConfigDialogResult) => void) | null>(
    null
  )
  const twoWayFactorMapperResolveRef = useRef<((result: TwoWayFactorMapperDialogResult) => void) | null>(
    null
  )
  const multifactorialFactorMapperResolveRef = useRef<((result: MultifactorialFactorMapperDialogResult) => void) | null>(
    null
  )
  const synergyColumnMapperResolveRef = useRef<((result: SynergyColumnMapperDialogResult) => void) | null>(
    null
  )
  const doseResponseColumnMapperResolveRef = useRef<((result: DoseResponseColumnMapperDialogResult) => void) | null>(
    null
  )
  const chiSquareGofColumnMapperResolveRef = useRef<((result: ChiSquareGofColumnMapperDialogResult) => void) | null>(
    null
  )
  const chiSquareColumnMapperResolveRef = useRef<((result: ChiSquareColumnMapperDialogResult) => void) | null>(
    null
  )
  const fisherExactColumnMapperResolveRef = useRef<((result: FisherExactColumnMapperDialogResult) => void) | null>(
    null
  )
  const mcnemarColumnMapperResolveRef = useRef<((result: McNemarColumnMapperDialogResult) => void) | null>(
    null
  )
  const independentTTestColumnMapperResolveRef = useRef<((result: IndependentTTestColumnMapperDialogResult) => void) | null>(
    null
  )
  const mannWhitneyColumnMapperResolveRef = useRef<((result: MannWhitneyColumnMapperDialogResult) => void) | null>(
    null
  )
  const pairedTTestColumnMapperResolveRef = useRef<((result: PairedTTestColumnMapperDialogResult) => void) | null>(
    null
  )
  const wilcoxonColumnMapperResolveRef = useRef<((result: WilcoxonColumnMapperDialogResult) => void) | null>(
    null
  )
  const oneWayAnovaColumnMapperResolveRef = useRef<((result: OneWayAnovaColumnMapperDialogResult) => void) | null>(
    null
  )
  const kruskalWallisColumnMapperResolveRef = useRef<((result: KruskalWallisColumnMapperDialogResult) => void) | null>(
    null
  )
  const confirmDialogResolveRef = useRef<((result: boolean) => void) | null>(null)
  const survivalAnalysisResolveRef = useRef<((result: SurvivalAnalysisDialogResult) => void) | null>(
    null
  )
  const mediationAnalysisResolveRef = useRef<((result: MediationAnalysisDialogResult) => void) | null>(
    null
  )
  const moderationAnalysisResolveRef = useRef<((result: ModerationAnalysisDialogResult) => void) | null>(
    null
  )
  const moderatedMediationResolveRef = useRef<((result: ModeratedMediationAnalysisDialogResult) => void) | null>(
    null
  )
  const executionModeResolveRef = useRef<((result: ExecutionModeDialogResult) => void) | null>(null)

  // Dialog service implementation
  const dialogService = useMemo<IDialogService>(
    () => ({
      showDVSelectionDialog: () =>
        new Promise<DependentVariableDialogResult>((resolve) => {
          dvSelectionResolveRef.current = resolve
          setDialogState((prev) => ({ ...prev, showDVSelection: true }))
        }),

      showDVEncodingDialog: () =>
        new Promise<EncodingDialogResult>((resolve) => {
          dvEncodingResolveRef.current = resolve
          setDialogState((prev) => ({ ...prev, showDVEncoding: true }))
        }),

      showFactorEncodingDialog: () =>
        new Promise<FactorEncodingDialogResult>((resolve) => {
          factorEncodingResolveRef.current = resolve
          setDialogState((prev) => ({ ...prev, showFactorEncoding: true }))
        }),

      showSimpleEffectsDialog: () =>
        new Promise<SimpleEffectsDialogResult>((resolve) => {
          simpleEffectsResolveRef.current = resolve
          setDialogState((prev) => ({ ...prev, showSimpleEffects: true }))
        }),

      showMultiFactorialSimpleEffectsDialog: (factorNames: string[], testIdPrefix = 'multi') =>
        new Promise<MultiFactorialSimpleEffectsDialogResult>((resolve) => {
          multiFactorialSimpleEffectsResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showMultiFactorialSimpleEffects: true,
            multiFactorialFactorNames: factorNames,
            multiFactorialSimpleEffectsTestIdPrefix: testIdPrefix,
          }))
        }),

      showLmmAnovaConfigDialog: () =>
        new Promise<LmmAnovaConfigDialogResult>((resolve) => {
          lmmAnovaConfigResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showLmmAnovaConfig: true,
          }))
        }),

      showTwoWayFactorMapperDialog: () =>
        new Promise<TwoWayFactorMapperDialogResult>((resolve) => {
          twoWayFactorMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showTwoWayFactorMapper: true,
          }))
        }),

      showMultifactorialFactorMapperDialog: () =>
        new Promise<MultifactorialFactorMapperDialogResult>((resolve) => {
          multifactorialFactorMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showMultifactorialFactorMapper: true,
          }))
        }),

      showSynergyColumnMapperDialog: (testName: string) =>
        new Promise<SynergyColumnMapperDialogResult>((resolve) => {
          synergyColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showSynergyColumnMapper: true,
            synergyMapperTestName: testName
          }))
        }),

      showDoseResponseColumnMapperDialog: (testName: string) =>
        new Promise<DoseResponseColumnMapperDialogResult>((resolve) => {
          doseResponseColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showDoseResponseColumnMapper: true,
            doseResponseMapperTestName: testName
          }))
        }),

      showChiSquareGofColumnMapperDialog: (testName: string) =>
        new Promise<ChiSquareGofColumnMapperDialogResult>((resolve) => {
          chiSquareGofColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showChiSquareGofColumnMapper: true,
            chiSquareGofMapperTestName: testName
          }))
        }),

      showChiSquareColumnMapperDialog: (testName: string) =>
        new Promise<ChiSquareColumnMapperDialogResult>((resolve) => {
          chiSquareColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showChiSquareColumnMapper: true,
            chiSquareMapperTestName: testName
          }))
        }),

      showFisherExactColumnMapperDialog: (testName: string) =>
        new Promise<FisherExactColumnMapperDialogResult>((resolve) => {
          fisherExactColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showFisherExactColumnMapper: true,
            fisherExactMapperTestName: testName
          }))
        }),

      showMcNemarColumnMapperDialog: (testName: string) =>
        new Promise<McNemarColumnMapperDialogResult>((resolve) => {
          mcnemarColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showMcNemarColumnMapper: true,
            mcnemarMapperTestName: testName
          }))
        }),

      showIndependentTTestColumnMapperDialog: (testName: string) =>
        new Promise<IndependentTTestColumnMapperDialogResult>((resolve) => {
          independentTTestColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showIndependentTTestColumnMapper: true,
            independentTTestMapperTestName: testName
          }))
        }),

      showMannWhitneyColumnMapperDialog: (testName: string) =>
        new Promise<MannWhitneyColumnMapperDialogResult>((resolve) => {
          mannWhitneyColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showMannWhitneyColumnMapper: true,
            mannWhitneyMapperTestName: testName
          }))
        }),

      showPairedTTestColumnMapperDialog: (testName: string) =>
        new Promise<PairedTTestColumnMapperDialogResult>((resolve) => {
          pairedTTestColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showPairedTTestColumnMapper: true,
            pairedTTestMapperTestName: testName
          }))
        }),

      showWilcoxonColumnMapperDialog: (testName: string) =>
        new Promise<WilcoxonColumnMapperDialogResult>((resolve) => {
          wilcoxonColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showWilcoxonColumnMapper: true,
            wilcoxonMapperTestName: testName
          }))
        }),

      showOneWayAnovaColumnMapperDialog: (testName: string, groupLevels?: string[]) =>
        new Promise<OneWayAnovaColumnMapperDialogResult>((resolve) => {
          oneWayAnovaColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showOneWayAnovaColumnMapper: true,
            oneWayAnovaMapperTestName: testName,
            oneWayAnovaGroupLevels: groupLevels || []
          }))
        }),

      showKruskalWallisColumnMapperDialog: (testName: string) =>
        new Promise<KruskalWallisColumnMapperDialogResult>((resolve) => {
          kruskalWallisColumnMapperResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showKruskalWallisColumnMapper: true,
            kruskalWallisMapperTestName: testName
          }))
        }),

      showSurvivalAnalysisDialog: (options) =>
        new Promise<SurvivalAnalysisDialogResult>((resolve) => {
          survivalAnalysisResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showSurvivalAnalysisDialog: true,
            survivalAnalysisType: options.analysisType,
          }))
        }),

      showMediationAnalysisDialog: () =>
        new Promise<MediationAnalysisDialogResult>((resolve) => {
          mediationAnalysisResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showMediationAnalysisDialog: true,
          }))
        }),

      showModerationAnalysisDialog: () =>
        new Promise<ModerationAnalysisDialogResult>((resolve) => {
          moderationAnalysisResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showModerationAnalysisDialog: true,
          }))
        }),

      showModeratedMediationAnalysisDialog: () =>
        new Promise<ModeratedMediationAnalysisDialogResult>((resolve) => {
          moderatedMediationResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showModeratedMediationAnalysisDialog: true,
          }))
        }),

      updateDialogContext: (updates) => {
        setDialogContext((prev) => ({ ...prev, ...updates }))
      },

      showConfirmDialog: (title: string, message: string, confirmLabel: string, cancelLabel: string) =>
        new Promise<boolean>((resolve) => {
          confirmDialogResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showConfirmDialog: true,
            confirmDialogTitle: title,
            confirmDialogMessage: message,
            confirmDialogConfirmLabel: confirmLabel,
            confirmDialogCancelLabel: cancelLabel,
          }))
        }),

      showExecutionModeDialog: (testName: string, rowCount: number) =>
        new Promise<ExecutionModeDialogResult>((resolve) => {
          executionModeResolveRef.current = resolve
          setDialogState((prev) => ({
            ...prev,
            showExecutionModeDialog: true,
            executionModeTestName: testName,
            executionModeRowCount: rowCount,
          }))
        }),
    }),
    []
  )

  // Inject dialog service into controller
  useMemo(() => {
    controllerRef.current.setDialogService(dialogService)
  }, [dialogService])

  /**
   * Dialog callbacks - called from dialog components
   */
  const handleDVSelectionConfirm = useCallback((result: DependentVariableDialogResult) => {
    dvSelectionResolveRef.current?.(result)
    dvSelectionResolveRef.current = null
    setDialogState((prev) => ({ ...prev, showDVSelection: false }))
  }, [])

  const handleDVSelectionCancel = useCallback(() => {
    dvSelectionResolveRef.current?.({ selectedVariable: '', cancelled: true })
    dvSelectionResolveRef.current = null
    setDialogState((prev) => ({ ...prev, showDVSelection: false }))
  }, [])

  const handleDVEncodingConfirm = useCallback((result: EncodingDialogResult) => {
    dvEncodingResolveRef.current?.(result)
    dvEncodingResolveRef.current = null
    setDialogState((prev) => ({ ...prev, showDVEncoding: false }))
  }, [])

  const handleDVEncodingCancel = useCallback(() => {
    dvEncodingResolveRef.current?.({ encodingMapping: new Map(), cancelled: true })
    dvEncodingResolveRef.current = null
    setDialogState((prev) => ({ ...prev, showDVEncoding: false }))
  }, [])

  const handleFactorEncodingConfirm = useCallback((result: FactorEncodingDialogResult) => {
    factorEncodingResolveRef.current?.(result)
    factorEncodingResolveRef.current = null
    setDialogState((prev) => ({ ...prev, showFactorEncoding: false }))
  }, [])

  const handleFactorEncodingCancel = useCallback(() => {
    factorEncodingResolveRef.current?.({
      encodingMappings: new Map(),
      // REMOVED: simpleEffects - Not needed for regression
      cancelled: true,
    })
    factorEncodingResolveRef.current = null
    setDialogState((prev) => ({ ...prev, showFactorEncoding: false }))
  }, [])

  const handleSimpleEffectsConfirm = useCallback((result: SimpleEffectsDialogResult) => {
    simpleEffectsResolveRef.current?.(result)
    simpleEffectsResolveRef.current = null
    setDialogState((prev) => ({ ...prev, showSimpleEffects: false }))
  }, [])

  const handleSimpleEffectsCancel = useCallback(() => {
    simpleEffectsResolveRef.current?.({
      factorAWithinB: false,
      factorBWithinA: false,
      adjustmentMethod: 'tukey',
      controlLevels: {},
      posthocQ: 0.05,
      cancelled: true,
    })
    simpleEffectsResolveRef.current = null
    setDialogState((prev) => ({ ...prev, showSimpleEffects: false }))
  }, [])

  const handleMultiFactorialSimpleEffectsConfirm = useCallback(
    (result: MultiFactorialSimpleEffectsDialogResult) => {
      multiFactorialSimpleEffectsResolveRef.current?.(result)
      multiFactorialSimpleEffectsResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showMultiFactorialSimpleEffects: false,
        multiFactorialFactorNames: [],
        multiFactorialSimpleEffectsTestIdPrefix: 'multi',
      }))
    },
    []
  )

  const handleMultiFactorialSimpleEffectsCancel = useCallback(() => {
    multiFactorialSimpleEffectsResolveRef.current?.({
      simpleEffects: [],
      adjustmentMethod: 'tukey',
      controlLevels: {},
      posthocQ: 0.05,
      cancelled: true,
    })
    multiFactorialSimpleEffectsResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showMultiFactorialSimpleEffects: false,
      multiFactorialFactorNames: [],
      multiFactorialSimpleEffectsTestIdPrefix: 'multi',
    }))
  }, [])

  const handleLmmAnovaConfigConfirm = useCallback((result: LmmAnovaConfigDialogResult) => {
    lmmAnovaConfigResolveRef.current?.(result)
    lmmAnovaConfigResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showLmmAnovaConfig: false,
    }))
  }, [])

  const handleLmmAnovaConfigCancel = useCallback(() => {
    lmmAnovaConfigResolveRef.current?.({
      cancelled: true,
      config: {
        dependentColumnId: '',
        subjectColumnId: '',
        predictorColumnIds: [],
        predictorTypes: {},
        reml: false,
        interactionDepth: 2,
        dfMethod: 'satterthwaite',
        randomEffectsMode: 'random_intercept',
        stratified: false,
        stratifyBy: [],
        adjustmentMethod: 'tukey',
        controlLevels: {},
        posthocQ: 0.05,
      },
    })
    lmmAnovaConfigResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showLmmAnovaConfig: false,
    }))
  }, [])

  const handleSynergyColumnMapperConfirm = useCallback(
    (result: SynergyColumnMapperDialogResult) => {
      synergyColumnMapperResolveRef.current?.(result)
      synergyColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showSynergyColumnMapper: false,
        synergyMapperTestName: ''
      }))
    },
    []
  )

  const handleSynergyColumnMapperCancel = useCallback(() => {
    synergyColumnMapperResolveRef.current?.({
      mapping: {
        doseA: '',
        doseB: '',
        responseA: '',
        responseB: '',
        responseCombined: '',
      },
      cancelled: true,
    })
    synergyColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showSynergyColumnMapper: false,
      synergyMapperTestName: ''
    }))
  }, [])

  const handleChiSquareGofColumnMapperConfirm = useCallback(
    (result: ChiSquareGofColumnMapperDialogResult) => {
      chiSquareGofColumnMapperResolveRef.current?.(result)
      chiSquareGofColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showChiSquareGofColumnMapper: false,
        chiSquareGofMapperTestName: ''
      }))
    },
    []
  )

  const handleChiSquareGofColumnMapperCancel = useCallback(() => {
    chiSquareGofColumnMapperResolveRef.current?.({
      mapping: {
        category: null,
        observed: '',
        expected: null,
      },
      cancelled: true,
    })
    chiSquareGofColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showChiSquareGofColumnMapper: false,
      chiSquareGofMapperTestName: ''
    }))
  }, [])

  const handleChiSquareColumnMapperConfirm = useCallback(
    (result: ChiSquareColumnMapperDialogResult) => {
      chiSquareColumnMapperResolveRef.current?.(result)
      chiSquareColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showChiSquareColumnMapper: false,
        chiSquareMapperTestName: ''
      }))
    },
    []
  )

  const handleChiSquareColumnMapperCancel = useCallback(() => {
    chiSquareColumnMapperResolveRef.current?.({
      mapping: {
        group: '',
        outcome: '',
      },
      cancelled: true,
    })
    chiSquareColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showChiSquareColumnMapper: false,
      chiSquareMapperTestName: ''
    }))
  }, [])

  const handleFisherExactColumnMapperConfirm = useCallback(
    (result: FisherExactColumnMapperDialogResult) => {
      fisherExactColumnMapperResolveRef.current?.(result)
      fisherExactColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showFisherExactColumnMapper: false,
        fisherExactMapperTestName: ''
      }))
    },
    []
  )

  const handleFisherExactColumnMapperCancel = useCallback(() => {
    fisherExactColumnMapperResolveRef.current?.({
      mapping: {
        group: '',
        outcome: '',
      },
      cancelled: true,
    })
    fisherExactColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showFisherExactColumnMapper: false,
      fisherExactMapperTestName: ''
    }))
  }, [])

  const handleMcNemarColumnMapperConfirm = useCallback(
    (result: McNemarColumnMapperDialogResult) => {
      mcnemarColumnMapperResolveRef.current?.(result)
      mcnemarColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showMcNemarColumnMapper: false,
        mcnemarMapperTestName: ''
      }))
    },
    []
  )

  const handleMcNemarColumnMapperCancel = useCallback(() => {
    mcnemarColumnMapperResolveRef.current?.({
      mapping: {
        before: '',
        after: '',
      },
      cancelled: true,
    })
    mcnemarColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showMcNemarColumnMapper: false,
      mcnemarMapperTestName: ''
    }))
  }, [])

  const handleIndependentTTestColumnMapperConfirm = useCallback(
    (result: IndependentTTestColumnMapperDialogResult) => {
      independentTTestColumnMapperResolveRef.current?.(result)
      independentTTestColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showIndependentTTestColumnMapper: false,
        independentTTestMapperTestName: ''
      }))
    },
    []
  )

  const handleIndependentTTestColumnMapperCancel = useCallback(() => {
    independentTTestColumnMapperResolveRef.current?.({
      mapping: {
        group: '',
        outcome: '',
      },
      cancelled: true,
    })
    independentTTestColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showIndependentTTestColumnMapper: false,
      independentTTestMapperTestName: ''
      }))
    }, [])

  const handleMannWhitneyColumnMapperConfirm = useCallback(
    (result: MannWhitneyColumnMapperDialogResult) => {
      mannWhitneyColumnMapperResolveRef.current?.(result)
      mannWhitneyColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showMannWhitneyColumnMapper: false,
        mannWhitneyMapperTestName: ''
      }))
    },
    []
  )

  const handleMannWhitneyColumnMapperCancel = useCallback(() => {
    mannWhitneyColumnMapperResolveRef.current?.({
      mapping: {
        group: '',
        outcome: '',
      },
      cancelled: true,
    })
    mannWhitneyColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showMannWhitneyColumnMapper: false,
      mannWhitneyMapperTestName: ''
    }))
  }, [])

  const handlePairedTTestColumnMapperConfirm = useCallback(
    (result: PairedTTestColumnMapperDialogResult) => {
      pairedTTestColumnMapperResolveRef.current?.(result)
      pairedTTestColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showPairedTTestColumnMapper: false,
        pairedTTestMapperTestName: ''
      }))
    },
    []
  )

  const handlePairedTTestColumnMapperCancel = useCallback(() => {
    pairedTTestColumnMapperResolveRef.current?.({
      mapping: {
        group: '',
        outcome: '',
        pair_id: '',
      },
      cancelled: true,
    })
    pairedTTestColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showPairedTTestColumnMapper: false,
      pairedTTestMapperTestName: ''
    }))
  }, [])

  const handleWilcoxonColumnMapperConfirm = useCallback(
    (result: WilcoxonColumnMapperDialogResult) => {
      wilcoxonColumnMapperResolveRef.current?.(result)
      wilcoxonColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showWilcoxonColumnMapper: false,
        wilcoxonMapperTestName: ''
      }))
    },
    []
  )

  const handleWilcoxonColumnMapperCancel = useCallback(() => {
    wilcoxonColumnMapperResolveRef.current?.({
      mapping: {
        group: '',
        outcome: '',
        pair_id: '',
      },
      cancelled: true,
    })
    wilcoxonColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showWilcoxonColumnMapper: false,
      wilcoxonMapperTestName: ''
    }))
  }, [])

  const handleOneWayAnovaColumnMapperConfirm = useCallback(
    (result: OneWayAnovaColumnMapperDialogResult) => {
      oneWayAnovaColumnMapperResolveRef.current?.(result)
      oneWayAnovaColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showOneWayAnovaColumnMapper: false,
        oneWayAnovaMapperTestName: '',
        oneWayAnovaGroupLevels: []
      }))
    },
    []
  )

  const handleOneWayAnovaColumnMapperCancel = useCallback(() => {
    oneWayAnovaColumnMapperResolveRef.current?.({
      mapping: {
        group: '',
        outcome: '',
      },
      cancelled: true,
    })
    oneWayAnovaColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showOneWayAnovaColumnMapper: false,
      oneWayAnovaMapperTestName: '',
      oneWayAnovaGroupLevels: []
    }))
  }, [])

  const handleKruskalWallisColumnMapperConfirm = useCallback(
    (result: KruskalWallisColumnMapperDialogResult) => {
      kruskalWallisColumnMapperResolveRef.current?.(result)
      kruskalWallisColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showKruskalWallisColumnMapper: false,
        kruskalWallisMapperTestName: ''
      }))
    },
    []
  )

  const handleKruskalWallisColumnMapperCancel = useCallback(() => {
    kruskalWallisColumnMapperResolveRef.current?.({
      mapping: {
        group: '',
        outcome: '',
      },
      cancelled: true,
    })
    kruskalWallisColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showKruskalWallisColumnMapper: false,
      kruskalWallisMapperTestName: ''
    }))
  }, [])

  const handleSurvivalAnalysisConfirm = useCallback((result: SurvivalAnalysisDialogResult) => {
    survivalAnalysisResolveRef.current?.(result)
    survivalAnalysisResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showSurvivalAnalysisDialog: false,
      survivalAnalysisType: 'kaplan_meier',
    }))
  }, [])

  const handleSurvivalAnalysisCancel = useCallback(() => {
    survivalAnalysisResolveRef.current?.({
      timeVariable: '',
      eventVariable: '',
      groupVariable: null,
      covariates: [],
      customTimePoints: [],
      eventEncoding: undefined,
      cancelled: true,
    })
    survivalAnalysisResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showSurvivalAnalysisDialog: false,
      survivalAnalysisType: 'kaplan_meier',
    }))
  }, [])

  const handleMediationAnalysisConfirm = useCallback((result: MediationAnalysisDialogResult) => {
    mediationAnalysisResolveRef.current?.(result)
    mediationAnalysisResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showMediationAnalysisDialog: false,
    }))
  }, [])

  const handleMediationAnalysisCancel = useCallback(() => {
    mediationAnalysisResolveRef.current?.({
      independentVariable: '',
      mediator: '',
      dependentVariable: '',
      covariates: [],
      nBootstrap: 5000,
      confidenceLevel: 0.95,
      seed: 12345,
      cancelled: true,
    })
    mediationAnalysisResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showMediationAnalysisDialog: false,
    }))
  }, [])

  const handleModerationAnalysisConfirm = useCallback((result: ModerationAnalysisDialogResult) => {
    moderationAnalysisResolveRef.current?.(result)
    moderationAnalysisResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showModerationAnalysisDialog: false,
    }))
  }, [])

  const handleModerationAnalysisCancel = useCallback(() => {
    moderationAnalysisResolveRef.current?.({
      independentVariable: '',
      moderator: '',
      dependentVariable: '',
      covariates: [],
      centerPredictor: true,
      centerModerator: true,
      probeMode: 'default',
      customProbeValues: null,
      confidenceLevel: 0.95,
      seed: 12345,
      cancelled: true,
    })
    moderationAnalysisResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showModerationAnalysisDialog: false,
    }))
  }, [])

  const handleModeratedMediationAnalysisConfirm = useCallback(
    (result: ModeratedMediationAnalysisDialogResult) => {
      moderatedMediationResolveRef.current?.(result)
      moderatedMediationResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showModeratedMediationAnalysisDialog: false,
      }))
    },
    []
  )

  const handleModeratedMediationAnalysisCancel = useCallback(() => {
    moderatedMediationResolveRef.current?.({
      independentVariable: '',
      mediator: '',
      moderator: '',
      dependentVariable: '',
      covariates: [],
      centerPredictor: true,
      centerModerator: true,
      probeMode: 'default',
      customProbeValues: null,
      nBootstrap: 5000,
      confidenceLevel: 0.95,
      seed: 12345,
      cancelled: true,
    })
    moderatedMediationResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showModeratedMediationAnalysisDialog: false,
    }))
  }, [])

  const handleTwoWayFactorMapperConfirm = useCallback(
    (result: TwoWayFactorMapperDialogResult) => {
      twoWayFactorMapperResolveRef.current?.(result)
      twoWayFactorMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showTwoWayFactorMapper: false,
      }))
    },
    []
  )

  const handleTwoWayFactorMapperCancel = useCallback(() => {
    twoWayFactorMapperResolveRef.current?.({
      mapping: {
        factorA: '',
        factorB: '',
      },
      cancelled: true,
    })
    twoWayFactorMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showTwoWayFactorMapper: false,
    }))
  }, [])

  const handleMultifactorialFactorMapperConfirm = useCallback(
    (result: MultifactorialFactorMapperDialogResult) => {
      multifactorialFactorMapperResolveRef.current?.(result)
      multifactorialFactorMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showMultifactorialFactorMapper: false,
      }))
    },
    []
  )

  const handleMultifactorialFactorMapperCancel = useCallback(() => {
    multifactorialFactorMapperResolveRef.current?.({
      mapping: {
        primary: '',
        secondary: '',
        facets: [],
      },
      cancelled: true,
    })
    multifactorialFactorMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showMultifactorialFactorMapper: false,
    }))
  }, [])

  const handleDoseResponseColumnMapperConfirm = useCallback(
    (result: DoseResponseColumnMapperDialogResult) => {
      doseResponseColumnMapperResolveRef.current?.(result)
      doseResponseColumnMapperResolveRef.current = null
      setDialogState((prev) => ({
        ...prev,
        showDoseResponseColumnMapper: false,
        doseResponseMapperTestName: ''
      }))
    },
    []
  )

  const handleDoseResponseColumnMapperCancel = useCallback(() => {
    doseResponseColumnMapperResolveRef.current?.({
      mapping: {
        dose: '',
        response: '',
      },
      cancelled: true,
    })
    doseResponseColumnMapperResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showDoseResponseColumnMapper: false,
      doseResponseMapperTestName: ''
    }))
  }, [])

  const handleConfirmDialogConfirm = useCallback(() => {
    confirmDialogResolveRef.current?.(true)
    confirmDialogResolveRef.current = null
    setDialogState((prev) => ({ ...prev, showConfirmDialog: false }))
  }, [])

  const handleConfirmDialogCancel = useCallback(() => {
    confirmDialogResolveRef.current?.(false)
    confirmDialogResolveRef.current = null
    setDialogState((prev) => ({ ...prev, showConfirmDialog: false }))
  }, [])

  // Phase 2: Execution mode dialog handler
  const handleExecutionModeSelect = useCallback((result: ExecutionModeDialogResult) => {
    executionModeResolveRef.current?.(result)
    executionModeResolveRef.current = null
    setDialogState((prev) => ({
      ...prev,
      showExecutionModeDialog: false,
      executionModeTestName: '',
      executionModeRowCount: 0,
    }))
  }, [])

  /**
   * Cancel ongoing orchestration
   * Closes all dialogs and rejects all pending promises
   */
  const cancelOrchestration = useCallback(() => {
    // Reject all pending promises
    handleDVSelectionCancel()
    handleDVEncodingCancel()
    handleFactorEncodingCancel()
    handleSimpleEffectsCancel()
    handleMultiFactorialSimpleEffectsCancel()
    handleLmmAnovaConfigCancel()
    handleDoseResponseColumnMapperCancel()
    handleSynergyColumnMapperCancel()
    handleChiSquareGofColumnMapperCancel()
    handleChiSquareColumnMapperCancel()
    handleFisherExactColumnMapperCancel()
    handleMcNemarColumnMapperCancel()
    handleIndependentTTestColumnMapperCancel()
    handleMannWhitneyColumnMapperCancel()
    handlePairedTTestColumnMapperCancel()
    handleWilcoxonColumnMapperCancel()
    handleOneWayAnovaColumnMapperCancel()
    handleKruskalWallisColumnMapperCancel()
    handleSurvivalAnalysisCancel()
    handleMediationAnalysisCancel()
    handleModerationAnalysisCancel()
    handleModeratedMediationAnalysisCancel()
    handleConfirmDialogCancel()
    handleExecutionModeSelect({ mode: null })

    // Close all dialogs
    setDialogState({
      showDVSelection: false,
      showDVEncoding: false,
      showFactorEncoding: false,
      showSimpleEffects: false,
      showMultiFactorialSimpleEffects: false,
      multiFactorialFactorNames: [],
      multiFactorialSimpleEffectsTestIdPrefix: 'multi',
      showLmmAnovaConfig: false,
      showTwoWayFactorMapper: false,
      showMultifactorialFactorMapper: false,
      showDoseResponseColumnMapper: false,
      doseResponseMapperTestName: '',
      showSynergyColumnMapper: false,
      synergyMapperTestName: '',
      showChiSquareGofColumnMapper: false,
      chiSquareGofMapperTestName: '',
      showChiSquareColumnMapper: false,
      chiSquareMapperTestName: '',
      showFisherExactColumnMapper: false,
      fisherExactMapperTestName: '',
      showMcNemarColumnMapper: false,
      mcnemarMapperTestName: '',
      showIndependentTTestColumnMapper: false,
      independentTTestMapperTestName: '',
      showMannWhitneyColumnMapper: false,
      mannWhitneyMapperTestName: '',
      showPairedTTestColumnMapper: false,
      pairedTTestMapperTestName: '',
      showWilcoxonColumnMapper: false,
      wilcoxonMapperTestName: '',
      showOneWayAnovaColumnMapper: false,
      oneWayAnovaMapperTestName: '',
      oneWayAnovaGroupLevels: [],
      showKruskalWallisColumnMapper: false,
      kruskalWallisMapperTestName: '',
      showSurvivalAnalysisDialog: false,
      survivalAnalysisType: 'kaplan_meier',
      showMediationAnalysisDialog: false,
      showModerationAnalysisDialog: false,
      showModeratedMediationAnalysisDialog: false,
      showConfirmDialog: false,
      confirmDialogTitle: '',
      confirmDialogMessage: '',
      confirmDialogConfirmLabel: 'Confirm',
      confirmDialogCancelLabel: 'Cancel',
      showExecutionModeDialog: false,
      executionModeTestName: '',
      executionModeRowCount: 0,
    })
  }, [
    handleDVSelectionCancel,
    handleDVEncodingCancel,
    handleFactorEncodingCancel,
    handleSimpleEffectsCancel,
    handleMultiFactorialSimpleEffectsCancel,
    handleLmmAnovaConfigCancel,
    handleTwoWayFactorMapperCancel,
    handleMultifactorialFactorMapperCancel,
    handleDoseResponseColumnMapperCancel,
    handleSynergyColumnMapperCancel,
    handleChiSquareGofColumnMapperCancel,
    handleChiSquareColumnMapperCancel,
    handleFisherExactColumnMapperCancel,
    handleMcNemarColumnMapperCancel,
    handleIndependentTTestColumnMapperCancel,
    handleMannWhitneyColumnMapperCancel,
    handlePairedTTestColumnMapperCancel,
    handleWilcoxonColumnMapperCancel,
    handleOneWayAnovaColumnMapperCancel,
    handleKruskalWallisColumnMapperCancel,
    handleSurvivalAnalysisCancel,
    handleMediationAnalysisCancel,
    handleModerationAnalysisCancel,
    handleModeratedMediationAnalysisCancel,
    handleConfirmDialogCancel,
    handleExecutionModeSelect,
  ])

  /**
   * Update dialog context dynamically
   * Used to update context between dialog steps
   */
  const updateDialogContext = useCallback((updates: Partial<DialogContext>) => {
    setDialogContext((prev) => ({ ...prev, ...updates }))
  }, [])

  /**
   * Run orchestrated analysis
   * Delegates to controller which manages conditional dialog flow
   */
  const runAnalysisWithTests = useCallback(
    async (
      testNames: string[],
      columns: ColumnClassification[],
      dataset: any,
      familyId?: string | null,
      viewScope?: GridViewScope | null
    ) => {
      try {
        // Store context for dialogs
        setDialogContext({ columns, selectedTests: testNames })

        // Controller's runAnalysisWithTests() will orchestrate dialog flow
        await controllerRef.current.runAnalysisWithTests(testNames, columns, dataset, familyId, viewScope)
      } catch (error) {
        console.error('Analysis orchestration error:', error)
        cancelOrchestration()
        throw error
      }
    },
    [cancelOrchestration]
  )

  return {
    controller: controllerRef.current,
    dialogState,
    dialogContext,
    runAnalysisWithTests,
    updateDialogContext,
    cancelOrchestration,
    handleDVSelectionConfirm,
    handleDVSelectionCancel,
    handleDVEncodingConfirm,
    handleDVEncodingCancel,
    handleFactorEncodingConfirm,
    handleFactorEncodingCancel,
    handleSimpleEffectsConfirm,
    handleSimpleEffectsCancel,
    handleMultiFactorialSimpleEffectsConfirm,
    handleMultiFactorialSimpleEffectsCancel,
    handleLmmAnovaConfigConfirm,
    handleLmmAnovaConfigCancel,
    handleTwoWayFactorMapperConfirm,
    handleTwoWayFactorMapperCancel,
    handleMultifactorialFactorMapperConfirm,
    handleMultifactorialFactorMapperCancel,
    handleDoseResponseColumnMapperConfirm,
    handleDoseResponseColumnMapperCancel,
    handleSynergyColumnMapperConfirm,
    handleSynergyColumnMapperCancel,
    handleChiSquareGofColumnMapperConfirm,
    handleChiSquareGofColumnMapperCancel,
    handleChiSquareColumnMapperConfirm,
    handleChiSquareColumnMapperCancel,
    handleFisherExactColumnMapperConfirm,
    handleFisherExactColumnMapperCancel,
    handleMcNemarColumnMapperConfirm,
    handleMcNemarColumnMapperCancel,
    handleIndependentTTestColumnMapperConfirm,
    handleIndependentTTestColumnMapperCancel,
    handleMannWhitneyColumnMapperConfirm,
    handleMannWhitneyColumnMapperCancel,
    handlePairedTTestColumnMapperConfirm,
    handlePairedTTestColumnMapperCancel,
    handleWilcoxonColumnMapperConfirm,
    handleWilcoxonColumnMapperCancel,
    handleOneWayAnovaColumnMapperConfirm,
    handleOneWayAnovaColumnMapperCancel,
    handleKruskalWallisColumnMapperConfirm,
    handleKruskalWallisColumnMapperCancel,
    handleSurvivalAnalysisConfirm,
    handleSurvivalAnalysisCancel,
    handleMediationAnalysisConfirm,
    handleMediationAnalysisCancel,
    handleModerationAnalysisConfirm,
    handleModerationAnalysisCancel,
    handleModeratedMediationAnalysisConfirm,
    handleModeratedMediationAnalysisCancel,
    handleConfirmDialogConfirm,
    handleConfirmDialogCancel,
    handleExecutionModeSelect,
  }
}
