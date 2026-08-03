import React, { useRef } from 'react'
import { act, render, screen, waitFor } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'

const datasetA = {
  id: 'dataset-a',
  name: 'Dataset A',
  rowCount: 10,
  dataRowCount: 10,
  columns: [{ id: 'col-1', name: 'Column 1', type: 'text', width: 88 }],
} as any

const blankDataset = {
  id: 'blank-dataset-b',
  name: 'Spreadsheet',
  rowCount: 100,
  dataRowCount: 0,
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
  setProjectId: ReturnType<typeof vi.fn>
  setProjectFilePath: ReturnType<typeof vi.fn>
  setProjectDirty: ReturnType<typeof vi.fn>
  setActiveFamilyDataset: (familyId: string, datasetId: string, hasData?: boolean) => void
  createFamily: ReturnType<typeof vi.fn>
  restoreFamilies: (families: Array<{ id: string; name: string; datasetId?: string }>, activeFamilyId?: string | null) => void
  setRecentProjects: ReturnType<typeof vi.fn>
  setOpenProjectHandler: ReturnType<typeof vi.fn>
  setSaveProjectHandler: ReturnType<typeof vi.fn>
  setSaveProjectAsHandler: ReturnType<typeof vi.fn>
  appOperationLock: { active: boolean; owner: string | null }
  pasteInFlight: boolean
  setActiveFamily: (familyId: string) => Promise<void>
  getActiveFamily: () => { id: string; name: string; datasetId?: string } | null
  updateFamilyDataFlag: ReturnType<typeof vi.fn>
  updateActiveFamilyResults: ReturnType<typeof vi.fn>
}

type DataState = {
  currentDataset: typeof datasetA | typeof blankDataset | null
  setCurrentDataset: (dataset: typeof datasetA | typeof blankDataset | null) => void
  addDataset: ReturnType<typeof vi.fn>
  removeDataset: (datasetId: string) => void
  initializeBlankDataset: ReturnType<typeof vi.fn>
  replaceAllDatasetsWith: (dataset: typeof datasetA | typeof blankDataset) => void
  datasets: Array<typeof datasetA | typeof blankDataset>
  clearAllDatasets: () => void
  setLoadingOperation: ReturnType<typeof vi.fn>
  saveTransformSnapshot: ReturnType<typeof vi.fn>
  getTransformSnapshot: ReturnType<typeof vi.fn>
  clearTransformSnapshot: ReturnType<typeof vi.fn>
  transformSnapshots: Map<string, unknown>
  getColumnTypeOverride: ReturnType<typeof vi.fn>
  getDatasetFormulas: ReturnType<typeof vi.fn>
  setDatasetFormulas: ReturnType<typeof vi.fn>
}

let resolveBlankDataset!: (value: typeof blankDataset) => void

const appStoreApi = create<AppState>((set, get) => ({
  showNavigator: true,
  setShowNavigator: (value) => set({ showNavigator: value }),
  workspaceViewMode: 'data',
  updateActiveFamilyData: vi.fn(),
  activeFamilyId: 'statistics-1',
  families: [{ id: 'statistics-1', name: 'Statistics', datasetId: datasetA.id }],
  projectId: 'project-1',
  setProjectId: vi.fn((projectId: string | null) => set({ projectId })),
  setProjectFilePath: vi.fn(),
  setProjectDirty: vi.fn(),
  setActiveFamilyDataset: (familyId: string, datasetId: string) => {
    set(state => ({
      families: state.families.map(family =>
        family.id === familyId ? { ...family, datasetId } : family
      ),
    }))
  },
  createFamily: vi.fn(),
  restoreFamilies: (families, activeFamilyId = null) => set({ families, activeFamilyId }),
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
  replaceAllDatasetsWith: (dataset) =>
    set({
      datasets: [dataset],
      currentDataset: dataset,
      transformSnapshots: new Map(),
    }),
  initializeBlankDataset: vi.fn(() =>
    new Promise<typeof blankDataset>((resolve) => {
      resolveBlankDataset = (dataset) => {
        set(state => ({
          datasets: [...state.datasets, dataset],
        }))
        resolve(dataset)
      }
    })
  ),
  datasets: [datasetA],
  clearAllDatasets: () => set({ currentDataset: null, datasets: [] }),
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
    loading: vi.fn(),
  },
}))

vi.mock('react-resizable-panels', () => ({
  PanelGroup: passthrough,
  Panel: passthrough,
  PanelResizeHandle: () => <div />,
}))

vi.mock('@/components/layout/Toolbar', () => ({
  Toolbar: ({ onNewProject }: { onNewProject?: () => Promise<void> | void }) => (
    <button data-testid="toolbar-new-project" onClick={() => void onNewProject?.()}>
      New Project
    </button>
  ),
}))
vi.mock('@/components/layout/ActionToolbar', () => ({ ActionToolbar: Null }))
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
vi.mock('@/components/dialogs/TestSelectionDialog', () => ({ TestSelectionDialog: Null }))
vi.mock('@/components/dialogs/ColumnSelectionDialog', () => ({ ColumnSelectionDialog: Null }))
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
    runAnalysisWithTests: vi.fn(),
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
vi.mock('@/hooks/useCachedDatasetsHealth', () => ({ useCachedDatasetsHealth: () => [] }))
vi.mock('@/hooks/useEulaAcceptance', () => ({
  LEGAL_POLICY_VERSION: '1',
  useEulaAcceptance: () => ({
    accepted: true,
    loading: false,
    showDialog: false,
    accept: vi.fn(),
    decline: vi.fn(),
    documents: null,
    policyVersion: '1',
    acceptedAt: null,
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
  }),
}))
vi.mock('@/hooks/useDeviceAuthWatcher', () => ({ useDeviceAuthWatcher: vi.fn() }))
vi.mock('@/store/app-store', async () => {
  const actual = await vi.importActual<typeof import('@/store/app-store')>('@/store/app-store')
  return { ...actual, useAppStore }
})
vi.mock('@/store/data-store', async () => {
  const actual = await vi.importActual<typeof import('@/store/data-store')>('@/store/data-store')
  return { ...actual, useDataStore }
})
vi.mock('@/services/cacheService', () => ({
  default: {
    clearAll: vi.fn().mockResolvedValue(undefined),
    setActiveProjectId: vi.fn().mockResolvedValue(undefined),
    getGridMutationQueueState: vi.fn(() => ({ blocked: false })),
    ensureLatestCache: vi.fn().mockResolvedValue(undefined),
    getAllColumnStats: vi.fn().mockResolvedValue([]),
    getPersistedColumnIds: vi.fn().mockResolvedValue(['col-1']),
    clearCurrentProjectCache: vi.fn(),
    clearUnsavedAppCache: vi.fn(),
    clearAllAppCache: vi.fn(),
    removeDataset: vi.fn(),
    createEmptyDuckDB: vi.fn().mockResolvedValue(undefined),
  },
}))
vi.mock('@/services/tauriApi', () => ({ default: { getRecentProjects: vi.fn().mockResolvedValue([]) }, __esModule: true }))
vi.mock('@/services/projectService', () => ({ setProjectLoader: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn().mockResolvedValue(true),
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
}))
vi.mock('@tauri-apps/api/path', () => ({ dirname: vi.fn(), join: vi.fn(), isAbsolute: vi.fn(), basename: vi.fn(), resolveResource: vi.fn() }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn(() => ({ onCloseRequested: vi.fn() })) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('@tauri-apps/plugin-fs', () => ({ BaseDirectory: {}, mkdir: vi.fn(), readTextFile: vi.fn(), writeTextFile: vi.fn(), exists: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(false) }))

let pendingSurfaceReady:
  | ((args: { datasetId: string; token: number }) => void)
  | null = null

vi.mock('@/components/data/SpreadsheetView', () => ({
  SpreadsheetView: (props: any) => {
    const instanceId = useRef(`grid-${Math.random().toString(36).slice(2)}`)
    pendingSurfaceReady =
      props.onPendingSurfaceReady && props.pendingDatasetId
        ? () =>
            props.onPendingSurfaceReady({
              datasetId: props.pendingDatasetId,
              token: props.pendingDatasetToken,
            })
        : null

    return (
      <div data-testid="grid-container" data-instance-id={instanceId.current}>
        <div data-testid="view-state-probe">
          {JSON.stringify({
            datasetId: props.datasetId ?? null,
            pendingDatasetId: props.pendingDatasetId ?? null,
            pendingDatasetToken: props.pendingDatasetToken ?? null,
          })}
        </div>
      </div>
    )
  },
}))

let AppShell: typeof import('../AppShell').AppShell

const APP_SHELL_SETUP_TIMEOUT_MS = 30_000

describe('AppShell clear replacement contract', () => {
  beforeEach(async () => {
    vi.resetModules()
    appStoreApi.setState({
      activeFamilyId: 'statistics-1',
      families: [{ id: 'statistics-1', name: 'Statistics', datasetId: datasetA.id }],
      projectId: 'project-1',
      workspaceViewMode: 'data',
      showNavigator: true,
    })
    dataStoreApi.setState({
      currentDataset: datasetA,
      datasets: [datasetA],
    } as any)
    pendingSurfaceReady = null
    AppShell = (await import('../AppShell')).AppShell
  }, APP_SHELL_SETUP_TIMEOUT_MS)

  it('replaces the active dataset transactionally during clear without a no-grid gap', async () => {
    render(<AppShell />)

    expect(screen.getByTestId('view-state-probe').textContent).toContain('"datasetId":"dataset-a"')

    await act(async () => {
      screen.getByTestId('toolbar-new-project').click()
    })

    await waitFor(() => {
      expect(screen.getByTestId('view-state-probe').textContent).toContain('"datasetId":"dataset-a"')
      expect(useDataStore.getState().currentDataset?.id).toBe('dataset-a')
      expect(screen.getByTestId('view-state-probe').textContent).toContain('"pendingDatasetId":null')
      expect(pendingSurfaceReady).toBeNull()
    })

    await act(async () => {
      resolveBlankDataset(blankDataset)
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByTestId('view-state-probe').textContent).toContain('"datasetId":"dataset-a"')
      expect(screen.getByTestId('view-state-probe').textContent).toContain('"pendingDatasetId":"blank-dataset-b"')
      expect(useDataStore.getState().currentDataset?.id).toBe('dataset-a')
      expect(pendingSurfaceReady).not.toBeNull()
    })

    await act(async () => {
      pendingSurfaceReady?.({ datasetId: 'blank-dataset-b', token: 1 })
    })

    await waitFor(() => {
      expect(screen.getByTestId('view-state-probe').textContent).toContain('"datasetId":"blank-dataset-b"')
      expect(screen.getByTestId('view-state-probe').textContent).toContain('"pendingDatasetId":null')
      expect(useDataStore.getState().currentDataset?.id).toBe('blank-dataset-b')
    })
  })
})
