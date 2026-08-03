import React, { useRef } from 'react'
import { act, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { getViewStateCache, setViewStateCache } from '@/lib/grid/viewStateCache'

const appShellHarness = vi.hoisted(() => ({
  runAnalysisWithTests: vi.fn(),
  latestSpreadsheetProps: null as any,
}))

const datasetA = {
  id: 'dataset-a',
  name: 'Dataset A',
  rowCount: 10,
  dataRowCount: 10,
  columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
} as any

const datasetB = {
  id: 'dataset-b',
  name: 'Dataset B',
  rowCount: 10,
  dataRowCount: 10,
  columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
} as any

type AppState = {
  showNavigator: boolean
  setShowNavigator: (value: boolean) => void
  workspaceViewMode: 'data' | 'results' | 'plots'
  updateActiveFamilyData: ReturnType<typeof vi.fn>
  activeFamilyId: string | null
  families: Array<{ id: string; name: string; datasetId?: string }>
  projectId: string | null
  setActiveFamilyDataset: ReturnType<typeof vi.fn>
  createFamily: ReturnType<typeof vi.fn>
  restoreFamilies: ReturnType<typeof vi.fn>
  setRecentProjects: ReturnType<typeof vi.fn>
  setOpenProjectHandler: ReturnType<typeof vi.fn>
  setSaveProjectHandler: ReturnType<typeof vi.fn>
  setSaveProjectAsHandler: ReturnType<typeof vi.fn>
  appOperationLock: { active: boolean; owner: string | null }
  pasteInFlight: boolean
  setActiveFamily: (familyId: string) => Promise<void>
  setProjectDirty: ReturnType<typeof vi.fn>
  getActiveFamily: () => { id: string; name: string; datasetId?: string } | null
  updateFamilyDataFlag: ReturnType<typeof vi.fn>
  updateActiveFamilyResults: ReturnType<typeof vi.fn>
}

type DataState = {
  currentDataset: typeof datasetA | typeof datasetB | null
  setCurrentDataset: (dataset: typeof datasetA | typeof datasetB | null) => void
  addDataset: ReturnType<typeof vi.fn>
  removeDataset: ReturnType<typeof vi.fn>
  initializeBlankDataset: ReturnType<typeof vi.fn>
  datasets: Array<typeof datasetA | typeof datasetB>
  clearAllDatasets: ReturnType<typeof vi.fn>
  setLoadingOperation: ReturnType<typeof vi.fn>
  saveTransformSnapshot: ReturnType<typeof vi.fn>
  getTransformSnapshot: ReturnType<typeof vi.fn>
  clearTransformSnapshot: ReturnType<typeof vi.fn>
  transformSnapshots: Map<string, unknown>
  getColumnTypeOverride: ReturnType<typeof vi.fn>
  getDatasetFormulas: ReturnType<typeof vi.fn>
  setDatasetFormulas: ReturnType<typeof vi.fn>
}

const appStoreApi = create<AppState>((set, get) => ({
  showNavigator: true,
  setShowNavigator: (value) => set({ showNavigator: value }),
  workspaceViewMode: 'data',
  updateActiveFamilyData: vi.fn(),
  activeFamilyId: 'statistics-1',
  families: [
    { id: 'statistics-1', name: 'Statistics 1', datasetId: datasetA.id },
    { id: 'statistics-2', name: 'Statistics 2', datasetId: datasetB.id },
  ],
  projectId: 'project-1',
  setActiveFamilyDataset: vi.fn(),
  createFamily: vi.fn(),
  restoreFamilies: vi.fn(),
  setRecentProjects: vi.fn(),
  setOpenProjectHandler: vi.fn(),
  setSaveProjectHandler: vi.fn(),
  setSaveProjectAsHandler: vi.fn(),
  appOperationLock: { active: false, owner: null },
  pasteInFlight: false,
  setActiveFamily: async (familyId: string) => {
    set({ activeFamilyId: familyId })
    const family = get().families.find((entry) => entry.id === familyId)
    const dataset = dataStoreApi.getState().datasets.find((entry) => entry.id === family?.datasetId) ?? null
    dataStoreApi.getState().setCurrentDataset(dataset)
  },
  setProjectDirty: vi.fn(),
  getActiveFamily: () => {
    const familyId = get().activeFamilyId
    return familyId ? get().families.find((family) => family.id === familyId) ?? null : null
  },
  updateFamilyDataFlag: vi.fn(),
  updateActiveFamilyResults: vi.fn(),
}))

const dataStoreApi = create<DataState>((set) => ({
  currentDataset: datasetA,
  setCurrentDataset: (dataset) => set({ currentDataset: dataset }),
  addDataset: vi.fn(),
  removeDataset: vi.fn(),
  initializeBlankDataset: vi.fn(),
  datasets: [datasetA, datasetB],
  clearAllDatasets: vi.fn(),
  setLoadingOperation: vi.fn(),
  saveTransformSnapshot: vi.fn(),
  getTransformSnapshot: vi.fn(),
  clearTransformSnapshot: vi.fn(),
  transformSnapshots: new Map(),
  getColumnTypeOverride: vi.fn(),
  getDatasetFormulas: vi.fn(() => new Map()),
  setDatasetFormulas: vi.fn(),
}))

const useAppStore = appStoreApi as any
const useDataStore = dataStoreApi as any

const Null = () => null
const passthrough = React.forwardRef<any, { children?: React.ReactNode }>(function Passthrough(
  { children },
  _ref
) {
  return <>{children}</>
})

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

vi.mock('react-resizable-panels', () => ({
  PanelGroup: passthrough,
  Panel: passthrough,
  PanelResizeHandle: () => <div />,
}))

vi.mock('@/components/layout/Toolbar', () => ({ Toolbar: Null }))
vi.mock('@/components/layout/ActionToolbar', () => ({
  ActionToolbar: ({ onPerformTest }: any) => (
    <button type="button" data-testid="perform-test" onClick={onPerformTest}>
      Perform Test
    </button>
  ),
}))
vi.mock('@/components/layout/NavigatorPanel', () => ({ NavigatorPanel: Null }))
vi.mock('@/components/layout/StatusBar', () => ({ StatusBar: Null }))
vi.mock('@/components/layout/AppBusyOverlay', () => ({ AppBusyOverlay: Null }))
vi.mock('@/components/results/ResultsPanel', () => ({ ResultsPanel: Null }))
vi.mock('@/components/plots', () => ({ PlotsPanel: Null }))
vi.mock('@/components/command-palette/CommandPalette', () => ({ CommandPalette: Null }))
vi.mock('@/components/ui/sonner', () => ({ Toaster: Null }))
vi.mock('@/components/onboarding/WelcomeScreen', () => ({ WelcomeScreen: Null }))
vi.mock('@/components/dialogs/DeviceLinkDialog', () => ({ DeviceLinkDialog: Null }))
vi.mock('@/components/preferences/PreferencesDialog', () => ({ PreferencesDialog: Null }))
vi.mock('@/components/dialogs/TestSelectionDialog', () => ({
  TestSelectionDialog: ({ open, onConfirm }: any) =>
    open ? (
      <button type="button" data-testid="confirm-test-selection" onClick={onConfirm}>
        Confirm Test
      </button>
    ) : null,
}))
vi.mock('@/components/dialogs/ColumnSelectionDialog', () => ({
  ColumnSelectionDialog: ({ isOpen, onSelect }: any) =>
    isOpen ? (
      <button
        type="button"
        data-testid="confirm-column-selection"
        onClick={() =>
          onSelect([
            { id: 'col-1', name: 'Column 1', overrideType: 'numeric' },
          ])
        }
      >
        Confirm Columns
      </button>
    ) : null,
}))
vi.mock('@/components/dialogs/PivotWiderDialog', () => ({ PivotWiderDialog: Null }))
vi.mock('@/components/dialogs/PivotLongerDialog', () => ({ PivotLongerDialog: Null }))
vi.mock('@/components/dialogs/GroupAggregateDialog', () => ({ GroupAggregateDialog: Null }))
vi.mock('@/components/dialogs/AdvancedFilterDialog', () => ({ AdvancedFilterDialog: Null }))
vi.mock('@/components/data/FilterColumnPickerPopover', () => ({ FilterColumnPickerPopover: Null }))
vi.mock('@/components/dialogs/TransformWarningDialog', () => ({ TransformWarningDialog: Null }))
vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: passthrough,
  AlertDialogContent: passthrough,
  AlertDialogHeader: passthrough,
  AlertDialogTitle: passthrough,
  AlertDialogDescription: passthrough,
  AlertDialogFooter: passthrough,
  AlertDialogCancel: passthrough,
  AlertDialogAction: passthrough,
}))
vi.mock('@/components/ui/button', () => ({
  Button: React.forwardRef<HTMLButtonElement, any>(function MockButton({ children, ...props }, ref) {
    return (
      <button ref={ref} {...props}>
        {children}
      </button>
    )
  }),
}))
vi.mock('@/components/dialogs/ValidationErrorDialog', () => ({ ValidationErrorDialog: Null }))
vi.mock('@/components/dialogs/ConfirmDialog', () => ({ ConfirmDialog: Null }))
vi.mock('@/components/dialogs/DependentVariableDialog', () => ({
  DependentVariableDialog: Null,
  DependentVariableDialogMode: {
    AnovaOrFriedman: 'anova',
    RegressionNumericOutcome: 'linear',
    RegressionCategoricalOutcome: 'logistic',
    RegressionMixedOutcome: 'mixed',
  },
}))
vi.mock('@/components/dialogs/DependentVariableEncodingDialog', () => ({ DependentVariableEncodingDialog: Null }))
vi.mock('@/components/dialogs/FactorEncodingDialog', () => ({ FactorEncodingDialog: Null }))
vi.mock('@/components/dialogs/SimpleEffectsDialog', () => ({ SimpleEffectsDialog: Null }))
vi.mock('@/components/dialogs/MultiFactorialSimpleEffectsDialog', () => ({ MultiFactorialSimpleEffectsDialog: Null }))
vi.mock('@/components/dialogs/LmmSimpleEffectsDialog', () => ({ LmmSimpleEffectsDialog: Null }))
vi.mock('@/components/dialogs/LmmAnovaConfigDialog', () => ({ LmmAnovaConfigDialog: Null }))
vi.mock('@/components/dialogs/TwoWayFactorMappingDialog', () => ({ TwoWayFactorMappingDialog: Null }))
vi.mock('@/components/dialogs/MultifactorialFactorMappingDialog', () => ({ MultifactorialFactorMappingDialog: Null }))
vi.mock('@/components/dialogs/DoseResponseColumnMapperDialog', () => ({ DoseResponseColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/SynergyColumnMapperDialog', () => ({ SynergyColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/ChiSquareGofColumnMapperDialog', () => ({ ChiSquareGofColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/ChiSquareColumnMapperDialog', () => ({ ChiSquareColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/FisherExactColumnMapperDialog', () => ({ FisherExactColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/McNemarColumnMapperDialog', () => ({ McNemarColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/IndependentTTestColumnMapperDialog', () => ({ IndependentTTestColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/MannWhitneyColumnMapperDialog', () => ({ MannWhitneyColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/PairedTTestColumnMapperDialog', () => ({ PairedTTestColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/WilcoxonColumnMapperDialog', () => ({ WilcoxonColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/OneWayAnovaColumnMapperDialog', () => ({ OneWayAnovaColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/KruskalWallisColumnMapperDialog', () => ({ KruskalWallisColumnMapperDialog: Null }))
vi.mock('@/components/dialogs/SurvivalAnalysisDialog', () => ({ SurvivalAnalysisDialog: Null }))
vi.mock('@/components/dialogs/MediationAnalysisDialog', () => ({ MediationAnalysisDialog: Null }))
vi.mock('@/components/dialogs/ModerationAnalysisDialog', () => ({ ModerationAnalysisDialog: Null }))
vi.mock('@/components/dialogs/ModeratedMediationDialog', () => ({ ModeratedMediationDialog: Null }))
vi.mock('@/components/dialogs/RelinkSourceDialog', () => ({ RelinkSourceDialog: Null }))
vi.mock('@/components/dialogs/ImportProgressDialog', () => ({ ImportProgressDialog: Null }))
vi.mock('@/components/dialogs/ExecutionModeDialog', () => ({ ExecutionModeDialog: Null }))
vi.mock('@/components/dialogs/SampleDatasetsDialog', () => ({ SampleDatasetsDialog: Null }))
vi.mock('@/components/cheatsheet/StatisticalTestsGuideDialog', () => ({ StatisticalTestsGuideDialog: Null }))
vi.mock('@/components/cheatsheet/DataCleaningGuideDialog', () => ({ DataCleaningGuideDialog: Null }))
vi.mock('@/components/cheatsheet/BulkRNAseqGuideDialog', () => ({ BulkRNAseqGuideDialog: Null }))
vi.mock('@/components/onboarding/BottomLeftTip', () => ({ BottomLeftTip: Null }))
vi.mock('@/components/rnaseq', () => ({
  RNAseqWorkspace: Null,
  RNAseqNavigatorSection: Null,
}))

vi.mock('@/hooks/useMainWindowEventListeners', () => ({ useMainWindowEventListeners: vi.fn() }))
vi.mock('@/hooks/useFirstLaunch', () => ({
  useFirstLaunch: () => ({
    isFirstLaunch: false,
    isLoading: false,
    markWelcomeSeen: vi.fn(),
  }),
}))
vi.mock('@/hooks/useStatisticalAnalysisController', () => ({
  useStatisticalAnalysisController: () => ({
    dialogState: {
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
      confirmDialogConfirmLabel: '',
      confirmDialogCancelLabel: '',
      showExecutionModeDialog: false,
      executionModeTestName: '',
      executionModeRowCount: 0,
    },
    dialogContext: { columns: [], selectedTests: [] },
    runAnalysisWithTests: appShellHarness.runAnalysisWithTests,
    handleDVSelectionConfirm: vi.fn(),
    handleDVSelectionCancel: vi.fn(),
    handleDVEncodingConfirm: vi.fn(),
    handleDVEncodingCancel: vi.fn(),
    handleFactorEncodingConfirm: vi.fn(),
    handleFactorEncodingCancel: vi.fn(),
    handleSimpleEffectsConfirm: vi.fn(),
    handleSimpleEffectsCancel: vi.fn(),
    handleMultiFactorialSimpleEffectsConfirm: vi.fn(),
    handleMultiFactorialSimpleEffectsCancel: vi.fn(),
    handleLmmAnovaConfigConfirm: vi.fn(),
    handleLmmAnovaConfigCancel: vi.fn(),
    handleTwoWayFactorMapperConfirm: vi.fn(),
    handleTwoWayFactorMapperCancel: vi.fn(),
    handleMultifactorialFactorMapperConfirm: vi.fn(),
    handleMultifactorialFactorMapperCancel: vi.fn(),
    handleDoseResponseColumnMapperConfirm: vi.fn(),
    handleDoseResponseColumnMapperCancel: vi.fn(),
    handleSynergyColumnMapperConfirm: vi.fn(),
    handleSynergyColumnMapperCancel: vi.fn(),
    handleChiSquareGofColumnMapperConfirm: vi.fn(),
    handleChiSquareGofColumnMapperCancel: vi.fn(),
    handleChiSquareColumnMapperConfirm: vi.fn(),
    handleChiSquareColumnMapperCancel: vi.fn(),
    handleFisherExactColumnMapperConfirm: vi.fn(),
    handleFisherExactColumnMapperCancel: vi.fn(),
    handleMcNemarColumnMapperConfirm: vi.fn(),
    handleMcNemarColumnMapperCancel: vi.fn(),
    handleIndependentTTestColumnMapperConfirm: vi.fn(),
    handleIndependentTTestColumnMapperCancel: vi.fn(),
    handleMannWhitneyColumnMapperConfirm: vi.fn(),
    handleMannWhitneyColumnMapperCancel: vi.fn(),
    handlePairedTTestColumnMapperConfirm: vi.fn(),
    handlePairedTTestColumnMapperCancel: vi.fn(),
    handleWilcoxonColumnMapperConfirm: vi.fn(),
    handleWilcoxonColumnMapperCancel: vi.fn(),
    handleOneWayAnovaColumnMapperConfirm: vi.fn(),
    handleOneWayAnovaColumnMapperCancel: vi.fn(),
    handleKruskalWallisColumnMapperConfirm: vi.fn(),
    handleKruskalWallisColumnMapperCancel: vi.fn(),
    handleSurvivalAnalysisConfirm: vi.fn(),
    handleSurvivalAnalysisCancel: vi.fn(),
    handleMediationAnalysisConfirm: vi.fn(),
    handleMediationAnalysisCancel: vi.fn(),
    handleModerationAnalysisConfirm: vi.fn(),
    handleModerationAnalysisCancel: vi.fn(),
    handleModeratedMediationAnalysisConfirm: vi.fn(),
    handleModeratedMediationAnalysisCancel: vi.fn(),
    handleConfirmDialogConfirm: vi.fn(),
    handleConfirmDialogCancel: vi.fn(),
    handleExecutionModeSelect: vi.fn(),
  }),
}))

vi.mock('@/components/layout/firstLaunchDeviceLinking', () => ({
  shouldAutoCompleteFirstLaunchAfterLink: () => false,
  shouldShowWelcomeScreen: () => false,
}))

vi.mock('@/store/app-store', () => ({
  useAppStore,
  ensureProjectId: vi.fn().mockResolvedValue('project-1'),
  isValidProjectIdForCache: vi.fn(() => true),
}))
vi.mock('@/store/data-store', () => ({ useDataStore }))
vi.mock('@/store/analysis-store', () => ({
  useAnalysisStore: Object.assign(
    (selector?: any) => {
      const state = {
        execution: { status: 'idle' },
        history: [],
        maxHistorySize: 50,
        clearHistory: vi.fn(),
        setExecutionProgress: vi.fn(),
        selectedTest: { id: 'descriptive_stats', name: 'Descriptive Statistics' },
        selectTest: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    { getState: () => ({ execution: { status: 'idle' }, history: [], maxHistorySize: 50, clearHistory: vi.fn(), setExecutionProgress: vi.fn(), selectedTest: { id: 'descriptive_stats', name: 'Descriptive Statistics' }, selectTest: vi.fn() }) }
  ),
}))
vi.mock('@/store/results-store', () => ({
  useResultsStore: Object.assign(
    (selector?: any) => {
      const state = {
        results: [],
        getFamilyResultCount: vi.fn(() => 0),
        clearFamilyResults: vi.fn(),
        clearResults: vi.fn(),
        clearAllResults: vi.fn(),
        addResult: vi.fn(),
        getAllResults: vi.fn(() => []),
        setActiveStatisticsFamilyId: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    { getState: () => ({ results: [], getFamilyResultCount: vi.fn(() => 0), clearFamilyResults: vi.fn(), clearResults: vi.fn(), clearAllResults: vi.fn(), addResult: vi.fn(), getAllResults: vi.fn(() => []), setActiveStatisticsFamilyId: vi.fn() }) }
  ),
}))
vi.mock('@/store/plots-store', () => ({
  usePlotsStore: Object.assign(
    (selector?: any) => {
      const state = {
        plots: [],
        activePlotId: null,
        activeStatisticsFamilyId: 'statistics-1',
        clearStatisticsFamilyPlots: vi.fn(),
        clearPlots: vi.fn(),
        migrateLegacyPlots: vi.fn(),
        setActiveStatisticsFamilyId: vi.fn(),
        restorePlots: vi.fn(),
        setActivePlot: vi.fn(),
      }
      return selector ? selector(state) : state
    },
    { getState: () => ({ plots: [], activePlotId: null, activeStatisticsFamilyId: 'statistics-1', clearStatisticsFamilyPlots: vi.fn(), clearPlots: vi.fn(), migrateLegacyPlots: vi.fn(), setActiveStatisticsFamilyId: vi.fn(), restorePlots: vi.fn(), setActivePlot: vi.fn() }) }
  ),
}))
vi.mock('@/store/deviceAuthStore', () => ({
  useDeviceAuthStore: (selector?: any) => {
    const state = {
      mode: 'idle',
      linkDialogOpen: false,
      setLinkDialogOpen: vi.fn(),
    }
    return selector ? selector(state) : state
  },
}))
vi.mock('@/store/rnaseq-store', () => ({
  useActiveRNAseqProject: () => null,
  useRNAseqStore: Object.assign(
    (selector?: any) => {
      const state = {
        projects: [],
        clearAllProjects: vi.fn(),
        restoreFromProject: vi.fn(),
        reconcileRestoredDatasets: vi.fn(),
        createProjectWithBootstrap: vi.fn(),
        serializeForProject: vi.fn(() => ({ projects: [] })),
      }
      return selector ? selector(state) : state
    },
    { getState: () => ({ projects: [], clearAllProjects: vi.fn(), restoreFromProject: vi.fn(), reconcileRestoredDatasets: vi.fn(), createProjectWithBootstrap: vi.fn(), serializeForProject: vi.fn(() => ({ projects: [] })) }) }
  ),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: { theme: 'light' } }),
  useSavePreferences: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/services/cacheService', () => ({
  default: {
    getGridMutationQueueState: vi.fn(() => ({ blocked: false })),
    getDatasetStorageInfo: vi.fn().mockResolvedValue({ isLarge: false }),
    ensureLatestCache: vi.fn().mockResolvedValue(undefined),
    getColumnsData: vi.fn().mockResolvedValue({ 'col-1': [1, 2, 3] }),
    getAllColumnStats: vi.fn().mockResolvedValue([]),
    getPersistedColumnIds: vi.fn().mockResolvedValue(['col-1']),
    clearCurrentProjectCache: vi.fn(),
    clearUnsavedAppCache: vi.fn(),
    clearAllAppCache: vi.fn(),
    removeDataset: vi.fn(),
    createEmptyDuckDB: vi.fn().mockResolvedValue(undefined),
  },
}))
vi.mock('@/services/tauriApi', () => ({
  default: {
    getRecentProjects: vi.fn().mockResolvedValue([]),
  },
  __esModule: true,
}))
vi.mock('@/services/projectService', () => ({ setProjectLoader: vi.fn() }))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn().mockResolvedValue(false),
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}))
vi.mock('@tauri-apps/api/path', () => ({
  dirname: vi.fn(),
  join: vi.fn(),
  isAbsolute: vi.fn(),
  basename: vi.fn(),
  resolveResource: vi.fn(),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({ onCloseRequested: vi.fn() })),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: {},
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  exists: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(false),
}))

const buildMockViewStateCacheKey = (projectId: string, familyId: string, datasetId: string, columns: Array<{ id: string }>) =>
  `project:${projectId}:statistics:${familyId}::${datasetId}::schema:${columns.map((column) => column.id).join('|')}`

vi.mock('@/components/data/SpreadsheetView', () => ({
  SpreadsheetView: (props: any) => {
    appShellHarness.latestSpreadsheetProps = props
    const instanceId = useRef(`grid-${Math.random().toString(36).slice(2)}`)
    const appState = useAppStore.getState()
    const dataState = useDataStore.getState()
    const dataset = dataState.currentDataset
    const cacheKey = dataset
      ? buildMockViewStateCacheKey(appState.projectId ?? 'project-unknown', appState.activeFamilyId ?? 'statistics-1', dataset.id, dataset.columns)
      : null
    const cached = cacheKey ? (getViewStateCache<any>(cacheKey) ?? {}) : {}

    return (
      <div data-testid="grid-container" data-instance-id={instanceId.current}>
        <div data-testid="view-state-probe">
          {JSON.stringify({
            datasetId: dataset?.id ?? null,
            sort: cached.sort ?? null,
            selection: cached.selection ?? null,
            scroll: cached.scroll ?? null,
          })}
        </div>
      </div>
    )
  },
}))

let AppShell: typeof import('../AppShell').AppShell

const APP_SHELL_SETUP_TIMEOUT_MS = 30_000

describe('AppShell statistics grid stability contract', () => {
  beforeEach(async () => {
    vi.resetModules()
    appStoreApi.setState({
      activeFamilyId: 'statistics-1',
      families: [
        { id: 'statistics-1', name: 'Statistics 1', datasetId: datasetA.id },
        { id: 'statistics-2', name: 'Statistics 2', datasetId: datasetB.id },
      ],
      projectId: 'project-1',
      workspaceViewMode: 'data',
      showNavigator: true,
    })
    dataStoreApi.setState({
      currentDataset: datasetA,
      datasets: [datasetA, datasetB],
    } as any)

    setViewStateCache(
      buildMockViewStateCacheKey('project-1', 'statistics-1', datasetA.id, datasetA.columns),
      { sort: 'A-sort', selection: 'A-selection', scroll: 'A-scroll' }
    )
    setViewStateCache(
      buildMockViewStateCacheKey('project-1', 'statistics-2', datasetB.id, datasetB.columns),
      { sort: 'B-sort', selection: 'B-selection', scroll: 'B-scroll' }
    )

    AppShell = (await import('../AppShell')).AppShell
  }, APP_SHELL_SETUP_TIMEOUT_MS)

  it('keeps SpreadsheetView mounted and restores family-scoped cached state across statistics family switches', async () => {
    render(<AppShell />)

    const before = screen.getByTestId('grid-container')
    expect(screen.getByTestId('view-state-probe').textContent).toContain('"sort":"A-sort"')

    await act(async () => {
      await useAppStore.getState().setActiveFamily('statistics-2')
    })

    expect(screen.getByTestId('grid-container')).toBe(before)
    expect(screen.getByTestId('view-state-probe').textContent).toContain('"sort":"B-sort"')
    expect(screen.getByTestId('view-state-probe').textContent).toContain('"datasetId":"dataset-b"')

    await act(async () => {
      await useAppStore.getState().setActiveFamily('statistics-1')
    })

    await waitFor(() => {
      expect(screen.getByTestId('grid-container')).toBe(before)
      expect(screen.getByTestId('view-state-probe').textContent).toContain('"sort":"A-sort"')
      expect(screen.getByTestId('view-state-probe').textContent).toContain('"selection":"A-selection"')
      expect(screen.getByTestId('view-state-probe').textContent).toContain('"scroll":"A-scroll"')
      expect(screen.getByTestId('view-state-probe').textContent).toContain('"datasetId":"dataset-a"')
    })
  })

  it('passes the active grid view scope into analysis runs', async () => {
    render(<AppShell />)

    await waitFor(() => {
      expect(appShellHarness.latestSpreadsheetProps?.onViewScopeChange).toEqual(expect.any(Function))
    })

    const scope = {
      datasetId: datasetA.id,
      source: 'view-filter',
      viewFilterConfig: { groups: [], groupOperator: 'AND' },
      displayRowOrder: [0, 2],
      dataModelRows: [0, 2],
      displayRowCount: 2,
      dataRowCount: 2,
      totalDataRowCount: 10,
    }

    await act(async () => {
      appShellHarness.latestSpreadsheetProps.onViewScopeChange(scope)
    })

    await act(async () => {
      screen.getByTestId('perform-test').click()
    })
    await act(async () => {
      screen.getByTestId('confirm-test-selection').click()
    })
    await act(async () => {
      screen.getByTestId('confirm-column-selection').click()
    })

    await waitFor(() => {
      expect(appShellHarness.runAnalysisWithTests).toHaveBeenCalledWith(
        ['descriptive_stats'],
        expect.any(Array),
        expect.objectContaining({ id: datasetA.id }),
        'statistics-1',
        scope
      )
    })
  })
})
