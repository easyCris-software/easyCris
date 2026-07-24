/**
 * StatisticalAnalysisController Integration Tests
 *
 * Validates the orchestration flow against Avalonia's RunAnalysis() logic without
 * driving the UI. Dialog interactions are mocked via IDialogService and state is
 * provided through the existing Zustand stores.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toast } from 'sonner'
import type {
  IDialogService,
  FactorEncodingDialogResult,
  EncodingDialogResult,
  DependentVariableDialogResult,
  SimpleEffectsDialogResult,
  MultiFactorialSimpleEffectsDialogResult,
  LmmAnovaConfigDialogResult,
} from '../StatisticalAnalysisController'
import type { ColumnClassification } from '@/lib/modules/core/types'
import { ColumnDataType } from '@/lib/modules/core/types'
import type { ITestModule } from '@/lib/modules/core/types'
import { makeColumnClassification } from '@/test-utils/factories'

// =============================================================================
// Hoisted Mocks (must be defined before imports)
// =============================================================================

const hoisted = vi.hoisted(() => {
  const analysisState = {
    parameters: {} as Record<string, unknown>,
    execution: { status: 'idle' as 'idle' | 'running' | 'validating' },
    startExecution: vi.fn(() => {
      analysisState.execution.status = 'running'
    }),
    completeExecution: vi.fn(() => {
      analysisState.execution.status = 'idle'
    }),
  }
  const dataCache = new Map<string, unknown[]>()
  const dataStoreState = {
    dataCache,
    currentDataset: null as { id: string } | null,
  }
  const appStoreState = {
    appOperationLock: { active: false },
    acquireAppOperationLock: vi.fn(() => 'lock-1'),
    releaseAppOperationLock: vi.fn(),
    activeFamilyId: 'statistics-1',
    markPlotSettingsAttention: vi.fn(),
    setWorkspaceViewMode: vi.fn(),
    setProjectDirty: vi.fn(),
  }
  const mockEnsureProjectId = vi.fn(async () => 'project-1')

  const defaultInvoke = async (_command: string, args: any) => {
    if (_command === 'get_columns_data') {
      // Return column data from the seeded dataCache
      const datasetId = args.datasetId as string
      const columnIds = args.columnIds as string[]
      const cachedRows = dataCache.get(`dataset:${datasetId}`) as Record<string, unknown>[] | undefined

      // Convert row-oriented data to column-oriented data
      const result: Record<string, unknown[]> = {}
      for (const colId of columnIds) {
        result[colId] = cachedRows?.map(row => row[colId]) ?? []
      }
      return result
    }
    if (_command === 'get_dataset_storage_info') {
      return { isLarge: false }
    }
    if (_command === 'export_columns_to_arrow_hybrid') {
      return 'C:/tmp/test.arrow'
    }
    if (_command !== 'run_statistical_test') {
      throw new Error(`Unexpected command: ${_command}`)
    }
    return {
      results: {
        statistic: 12.5,
        p_value: 0.001,
        ...args.data,
      },
    }
  }

  const mockInvoke = vi.fn(defaultInvoke)

  const mockResultsStore = {
    addResult: vi.fn(),
  }

  const mockAnalysisStore = {
    getState: vi.fn(() => analysisState),
  }

  const mockDataStore = {
    getState: vi.fn(() => dataStoreState),
  }

  const mockAppStore = {
    getState: vi.fn(() => appStoreState),
  }

  const validateSelectionMock = vi.fn(
    () => ({
      isValid: true,
      errors: [],
      warnings: [],
      suggestions: [],
    })
  )

  const buildPayloadMock = vi.fn(
    (
      columns: ColumnClassification[],
      _indices: number[],
      _rows: unknown[][],
      parameters: Record<string, unknown>
    ) => ({
      success: true,
      payload: {
        test: 'two_way_anova',
        data: { columns: columns.map(c => c.columnName) },
        parameters,
      },
      encodingMappings: new Map(),
    })
  )

  const defaultParametersMock = vi.fn(() => ({}))

  const mockModule: ITestModule = {
    moduleId: 'two_way_anova',
    validateSelection: validateSelectionMock,
    buildPayload: buildPayloadMock,
    defaultParameters: defaultParametersMock,
  }

  const mockModuleRegistry = {
    getModule: vi.fn(async () => mockModule),
  }

  return {
    mockInvoke,
    mockResultsStore,
    mockAnalysisStore,
    mockDataStore,
    dataStoreState,
    analysisState,
    mockAppStore,
    appStoreState,
    mockModuleRegistry,
    mockModule,
    validateSelectionMock,
    buildPayloadMock,
    defaultParametersMock,
    mockEnsureProjectId,
    defaultInvoke,
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: hoisted.mockInvoke,
}))

vi.mock('@/store/results-store', () => ({
  useResultsStore: {
    getState: () => hoisted.mockResultsStore,
  },
}))

vi.mock('@/store/analysis-store', () => ({
  useAnalysisStore: hoisted.mockAnalysisStore,
}))

vi.mock('@/store/data-store', () => ({
  useDataStore: hoisted.mockDataStore,
}))

vi.mock('@/store/app-store', () => ({
  useAppStore: hoisted.mockAppStore,
  ensureProjectId: hoisted.mockEnsureProjectId,
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
  },
}))

vi.mock('@/lib/modules/core/ModuleRegistry', () => ({
  moduleRegistry: hoisted.mockModuleRegistry,
}))

vi.mock('@/config/testRegistry', () => ({
  getTestDefinition: (id: string) => ({
    id,
    displayName: id.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
    family: 'ANOVA',
    pythonTestName: id,
  }),
}))

const {
  mockInvoke,
  mockResultsStore,
  dataStoreState,
  analysisState,
  appStoreState,
  mockModuleRegistry,
  mockModule,
  validateSelectionMock,
  buildPayloadMock,
  defaultParametersMock,
  mockEnsureProjectId,
  defaultInvoke,
} = hoisted

import { StatisticalAnalysisController } from '../StatisticalAnalysisController'

// =============================================================================
// Helper Utilities
// =============================================================================

function makeColumn(name: string, type: ColumnDataType, uniqueValueCount = 3, index = 0) {
  const uniqueValues =
    type === ColumnDataType.Numeric ? [] : Array.from({ length: uniqueValueCount }, (_, i) => `L${i}`)
  const isBinary = type === ColumnDataType.Binary

  return makeColumnClassification({
    columnIndex: index,
    columnName: name,
    columnId: name.toLowerCase(),
    dataType: type,
    uniqueValueCount: type === ColumnDataType.Numeric ? 100 : uniqueValueCount,
    numericValues: type === ColumnDataType.Numeric ? 100 : 0,
    categoricalValues: type === ColumnDataType.Numeric ? 0 : 100,
    isBinary,
    uniqueValues,
  })
}

function createFakeRows(columns: ColumnClassification[], rowCount = 10) {
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < rowCount; i++) {
    const row: Record<string, unknown> = {}
    columns.forEach(col => {
      if (!col.columnId) return
      if (col.dataType === ColumnDataType.Numeric) {
        row[col.columnId] = i + 0.5
      } else {
        const levels = col.uniqueValues.length ? col.uniqueValues : ['A', 'B']
        row[col.columnId] = levels[i % levels.length]
      }
    })
    rows.push(row)
  }
  return rows
}

function seedDataStore(dataset: { id: string }, rows: Record<string, unknown>[]) {
  dataStoreState.dataCache.clear()
  dataStoreState.dataCache.set(`dataset:${dataset.id}`, rows)
  dataStoreState.currentDataset = dataset
}

type DialogContextShape = {
  columns: ColumnClassification[]
  selectedTests: string[]
}

function createMockDialogService() {
  let context: DialogContextShape = { columns: [], selectedTests: [] }
  let dvSelectionResolver: ((result: DependentVariableDialogResult) => void) | null = null
  let dvEncodingResolver: ((result: EncodingDialogResult) => void) | null = null
  let factorEncodingResolver: ((result: FactorEncodingDialogResult) => void) | null = null
  let simpleEffectsResolver: ((result: SimpleEffectsDialogResult) => void) | null = null
  let multiFactorialSimpleEffectsResolver: ((result: MultiFactorialSimpleEffectsDialogResult) => void) | null = null
  let lmmConfigResolver: ((result: LmmAnovaConfigDialogResult) => void) | null = null

  const showDVSelectionDialog = vi.fn(
    () =>
      new Promise(resolve => {
        dvSelectionResolver = resolve
      })
  ) as unknown as IDialogService['showDVSelectionDialog']

  const showDVEncodingDialog = vi.fn(
    () =>
      new Promise(resolve => {
        dvEncodingResolver = resolve
      })
  ) as unknown as IDialogService['showDVEncodingDialog']

  const showFactorEncodingDialog = vi.fn(
    () =>
      new Promise(resolve => {
        factorEncodingResolver = resolve
      })
  ) as unknown as IDialogService['showFactorEncodingDialog']

  const showSimpleEffectsDialog = vi.fn(
    () =>
      new Promise(resolve => {
        simpleEffectsResolver = resolve
      })
  ) as unknown as IDialogService['showSimpleEffectsDialog']

  const showMultiFactorialSimpleEffectsDialog = vi.fn(
    (_factorNames: string[], _testIdPrefix?: string) =>
      new Promise(resolve => {
        multiFactorialSimpleEffectsResolver = resolve
      })
  ) as unknown as IDialogService['showMultiFactorialSimpleEffectsDialog']

  const showLmmAnovaConfigDialog = vi.fn(
    () =>
      new Promise(resolve => {
        lmmConfigResolver = resolve
      })
  ) as unknown as IDialogService['showLmmAnovaConfigDialog']

  const showTwoWayFactorMapperDialog = vi.fn(
    () =>
      Promise.resolve({
        mapping: { factorA: 'col1', factorB: 'col2' },
        cancelled: false,
      })
  ) as unknown as IDialogService['showTwoWayFactorMapperDialog']

  const showMultifactorialFactorMapperDialog = vi.fn(
    () =>
      Promise.resolve({
        mapping: { primary: 'col1', secondary: 'col2', facets: ['col3'] },
        cancelled: false,
      })
  ) as unknown as IDialogService['showMultifactorialFactorMapperDialog']

  const updateDialogContext = vi.fn((updates: Partial<DialogContextShape>) => {
    context = { ...context, ...updates }
  })

  // Dose-response column mapper dialog - returns cancelled by default in tests
  const showDoseResponseColumnMapperDialog = vi.fn(
    () =>
      Promise.resolve({
        mapping: {
          dose: '',
          response: '',
        },
        cancelled: true,
      })
  ) as unknown as IDialogService['showDoseResponseColumnMapperDialog']

  // Synergy column mapper dialog - returns cancelled by default in tests
  const showSynergyColumnMapperDialog = vi.fn(
    () =>
      Promise.resolve({
        mapping: {
          doseA: '',
          doseB: '',
          responseA: '',
          responseB: '',
          responseCombined: '',
        },
        cancelled: true,
      })
  ) as unknown as IDialogService['showSynergyColumnMapperDialog']

  const showChiSquareGofColumnMapperDialog = vi.fn(
    () =>
      Promise.resolve({
        mapping: {
          category: null,
          observed: '',
          expected: null,
        },
        cancelled: true,
      })
  ) as unknown as IDialogService['showChiSquareGofColumnMapperDialog']

  const showChiSquareColumnMapperDialog = vi.fn(
    () =>
      Promise.resolve({
        mapping: {
          group: '',
          outcome: '',
        },
        cancelled: true,
      })
  ) as unknown as IDialogService['showChiSquareColumnMapperDialog']

  const showSurvivalAnalysisDialog = vi.fn(
    () =>
      Promise.resolve({
        timeVariable: '',
        eventVariable: '',
        groupVariable: null,
        covariates: [],
        customTimePoints: [],
        eventEncoding: undefined,
        cancelled: true,
      })
  ) as unknown as IDialogService['showSurvivalAnalysisDialog']

  const showMediationAnalysisDialog = vi.fn(
    () =>
      Promise.resolve({
        independentVariable: '',
        mediator: '',
        dependentVariable: '',
        covariates: [],
        nBootstrap: 5000,
        confidenceLevel: 0.95,
        seed: 12345,
        cancelled: true,
      })
  ) as unknown as IDialogService['showMediationAnalysisDialog']

  const showModerationAnalysisDialog = vi.fn(
    () =>
      Promise.resolve({
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
  ) as unknown as IDialogService['showModerationAnalysisDialog']

  const showModeratedMediationAnalysisDialog = vi.fn(
    () =>
      Promise.resolve({
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
  ) as unknown as IDialogService['showModeratedMediationAnalysisDialog']

  const service: IDialogService = {
    showDVSelectionDialog,
    showDVEncodingDialog,
    showFactorEncodingDialog,
    showSimpleEffectsDialog,
    showMultiFactorialSimpleEffectsDialog,
    showLmmAnovaConfigDialog,
    showTwoWayFactorMapperDialog,
    showMultifactorialFactorMapperDialog,
    showDoseResponseColumnMapperDialog,
    showSynergyColumnMapperDialog,
    showChiSquareGofColumnMapperDialog,
    showChiSquareColumnMapperDialog,
    showFisherExactColumnMapperDialog: vi.fn().mockResolvedValue({
      mapping: { group: 'col1', outcome: 'col2' },
      cancelled: false,
    }),
    showMcNemarColumnMapperDialog: vi.fn().mockResolvedValue({
      mapping: { before: 'col1', after: 'col2' },
      cancelled: false,
    }),
    showIndependentTTestColumnMapperDialog: vi.fn().mockResolvedValue({
      mapping: { group: 'col1', outcome: 'col2' },
      cancelled: false,
    }),
    showMannWhitneyColumnMapperDialog: vi.fn().mockResolvedValue({
      mapping: { group: 'col1', outcome: 'col2' },
      cancelled: false,
    }),
    showPairedTTestColumnMapperDialog: vi.fn().mockResolvedValue({
      mapping: { group: 'col1', outcome: 'col2' },
      cancelled: false,
    }),
    showWilcoxonColumnMapperDialog: vi.fn().mockResolvedValue({
      mapping: { group: 'col1', outcome: 'col2' },
      cancelled: false,
    }),
    showOneWayAnovaColumnMapperDialog: vi.fn().mockResolvedValue({
      mapping: { group: 'col1', outcome: 'col2' },
      cancelled: false,
    }),
    showKruskalWallisColumnMapperDialog: vi.fn().mockResolvedValue({
      mapping: { group: 'col1', outcome: 'col2' },
      cancelled: false,
    }),
    showSurvivalAnalysisDialog,
    showMediationAnalysisDialog,
    showModerationAnalysisDialog,
    showModeratedMediationAnalysisDialog,
    showConfirmDialog: vi.fn().mockResolvedValue(true),
    showExecutionModeDialog: vi.fn().mockResolvedValue({ mode: 'exact' }),
    updateDialogContext,
  }

  return {
    service,
    getContext: () => context,
    resolveDVSelection: (result: DependentVariableDialogResult) => dvSelectionResolver?.(result),
    resolveDVEncoding: (result: EncodingDialogResult) => dvEncodingResolver?.(result),
    resolveFactorEncoding: (result: FactorEncodingDialogResult) => factorEncodingResolver?.(result),
    resolveSimpleEffects: (result: SimpleEffectsDialogResult) => simpleEffectsResolver?.(result),
    resolveMultiFactorialSimpleEffects: (result: MultiFactorialSimpleEffectsDialogResult) =>
      multiFactorialSimpleEffectsResolver?.(result),
    resolveLmmConfig: (result: LmmAnovaConfigDialogResult) => lmmConfigResolver?.(result),
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('StatisticalAnalysisController - Orchestration', () => {
  let dialogServiceMock: ReturnType<typeof createMockDialogService>

  beforeEach(() => {
    dialogServiceMock = createMockDialogService()

    analysisState.parameters = {}
    analysisState.execution.status = 'idle'
    analysisState.startExecution.mockClear()
    analysisState.completeExecution.mockClear()
    dataStoreState.dataCache.clear()
    dataStoreState.currentDataset = null
    appStoreState.appOperationLock.active = false
    appStoreState.acquireAppOperationLock.mockClear()
    appStoreState.releaseAppOperationLock.mockClear()
    appStoreState.markPlotSettingsAttention.mockClear()
    appStoreState.setWorkspaceViewMode.mockClear()
    appStoreState.setProjectDirty.mockClear()
    mockEnsureProjectId.mockClear()

    mockInvoke.mockClear()
    mockInvoke.mockImplementation(defaultInvoke)
    mockResultsStore.addResult.mockClear()
    validateSelectionMock.mockClear()
    buildPayloadMock.mockClear()
    defaultParametersMock.mockClear()

    mockModule.moduleId = 'two_way_anova'
    buildPayloadMock.mockImplementation((columns, _indices, _rows, parameters) => ({
      success: true,
      payload: {
        test: mockModule.moduleId,
        data: { columns: columns.map(c => c.columnName) },
        parameters,
      },
      encodingMappings: new Map(),
    }))

    mockModuleRegistry.getModule.mockResolvedValue(mockModule)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('Two-Way ANOVA Flow', () => {
    it('runs DV selection → simple effects → execute', async () => {
      const columns: ColumnClassification[] = [
        makeColumn('Concentration', ColumnDataType.Numeric, 100, 0),
        makeColumn('Treatment', ColumnDataType.Categorical, 3, 1),
        makeColumn('Batch', ColumnDataType.Categorical, 2, 2),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-1' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['two_way_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveDVSelection({
        cancelled: false,
        selectedVariable: 'Concentration',
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showSimpleEffectsDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveSimpleEffects({
        cancelled: false,
        factorAWithinB: true,
        factorBWithinA: false,
      })

      await orchestration

      expect(buildPayloadMock).toHaveBeenCalledTimes(1)
      const buildPayloadCall = buildPayloadMock.mock.calls[0]!
      const payloadColumns = buildPayloadCall[0] as ColumnClassification[]
      expect(payloadColumns.length).toBeGreaterThan(0)
      expect(payloadColumns[0]!.columnName).toBe('Concentration')
      const payloadParams = buildPayloadCall[3] as Record<string, unknown>
      expect(payloadParams.simple_effects).toEqual({
        factor_a_within_factor_b: true,
        factor_b_within_factor_a: false,
      })

      expect(mockInvoke).toHaveBeenCalledWith(
        'run_statistical_test',
        expect.objectContaining({ testName: 'two_way_anova' })
      )
      expect(mockResultsStore.addResult).toHaveBeenCalledTimes(1)
      expect(appStoreState.setWorkspaceViewMode).toHaveBeenCalledWith('results')
    })

    it('stops when user cancels DV dialog', async () => {
      const columns: ColumnClassification[] = [
        makeColumn('Concentration', ColumnDataType.Numeric, 100, 0),
        makeColumn('Treatment', ColumnDataType.Categorical, 3, 1),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-2' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['two_way_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveDVSelection({ cancelled: true, selectedVariable: '' })

      await expect(orchestration).resolves.toBeUndefined()
      expect(mockInvoke).not.toHaveBeenCalled()
      expect(mockResultsStore.addResult).not.toHaveBeenCalled()
    })

    it('only exposes numeric columns for DV selection', async () => {
      const columns: ColumnClassification[] = [
        makeColumn('Concentration', ColumnDataType.Numeric, 100, 0),
        makeColumn('Treatment', ColumnDataType.Categorical, 3, 1),
        makeColumn('Batch', ColumnDataType.Categorical, 2, 2),
      ]
      const dataset = { id: 'ds-anova-numeric-filter' }
      seedDataStore(dataset, createFakeRows(columns))

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      controller.runAnalysisWithTests(['two_way_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )

      const context = dialogServiceMock.getContext()
      expect(context.columns.map(col => col.columnName)).toEqual(['Concentration'])
    })

    it('fails early when no numeric columns exist', async () => {
      const columns: ColumnClassification[] = [
        makeColumn('Treatment', ColumnDataType.Categorical, 3, 0),
        makeColumn('Batch', ColumnDataType.Categorical, 2, 1),
      ]
      const dataset = { id: 'ds-anova-no-numeric' }
      seedDataStore(dataset, createFakeRows(columns))

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      await controller.runAnalysisWithTests(['two_way_anova'], columns, dataset)

      expect(dialogServiceMock.service.showDVSelectionDialog).not.toHaveBeenCalled()
      expect(mockInvoke).not.toHaveBeenCalled()
    })
  })

  describe('Binary Logistic Regression Flow', () => {
    it('runs DV selection → DV encoding → execute', async () => {
      mockModule.moduleId = 'logistic_regression'

      const columns: ColumnClassification[] = [
        makeColumn('Outcome', ColumnDataType.Binary, 2, 0),
        makeColumn('Age', ColumnDataType.Numeric, 100, 1),
        makeColumn('Group', ColumnDataType.Categorical, 3, 2),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-logistic' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(
        ['binary_logistic_regression'],
        columns,
        dataset
      )

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveDVSelection({
        cancelled: false,
        selectedVariable: 'Outcome',
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVEncodingDialog).toHaveBeenCalledTimes(1)
      )

      const context = dialogServiceMock.getContext()
      expect(context.columns[0]?.columnName).toBe('Outcome')

      dialogServiceMock.resolveDVEncoding({
        cancelled: false,
        encodingMapping: new Map([
          ['L0', 0],
          ['L1', 1],
        ]),
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showFactorEncodingDialog).toHaveBeenCalledTimes(1)
      )

      const factorContext = dialogServiceMock.getContext()
      expect(factorContext.columns.map((col: ColumnClassification) => col.columnName)).toEqual([
        'Group',
      ])

      dialogServiceMock.resolveFactorEncoding({
        cancelled: false,
        encodingMappings: new Map([
          ['Group', new Map([['L0', 0], ['L1', 1], ['L2', 2]])],
        ]),
      })

      await orchestration

      const buildPayloadCall = buildPayloadMock.mock.calls[0]!
      const payloadParams = buildPayloadCall[3] as Record<string, unknown>
      expect(payloadParams.dependentVariable).toBe('Outcome')
      expect(payloadParams.outcomeEncoding).toEqual({
        L0: 0,
        L1: 1,
      })
      expect(payloadParams.factorEncodings).toEqual({
        Group: { L0: 0, L1: 1, L2: 2 },
      })
      expect(mockInvoke).toHaveBeenCalled()
      expect(mockResultsStore.addResult).toHaveBeenCalled()
    })
  })

  describe('Multi-Factorial ANOVA Flow', () => {
    it('runs DV selection → multi-factor config → execute', async () => {
      mockModule.moduleId = 'multi_factorial_anova'

      const columns: ColumnClassification[] = [
        makeColumn('Response', ColumnDataType.Numeric, 100, 0),
        makeColumn('FactorA', ColumnDataType.Categorical, 2, 1),
        makeColumn('FactorB', ColumnDataType.Categorical, 3, 2),
        makeColumn('FactorC', ColumnDataType.Categorical, 2, 3),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-multi' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(
        ['multi_factorial_anova'],
        columns,
        dataset
      )

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveDVSelection({
        cancelled: false,
        selectedVariable: 'Response',
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showMultifactorialFactorMapperDialog).toHaveBeenCalledTimes(1)
      )
      expect(dialogServiceMock.service.showFactorEncodingDialog).not.toHaveBeenCalled()

      const multiContext = dialogServiceMock.getContext()
      expect(multiContext.columns.map(c => c.columnName)).toEqual([
        'Response',
        'FactorA',
        'FactorB',
        'FactorC',
      ])

      dialogServiceMock.resolveMultiFactorialSimpleEffects({
        cancelled: false,
        simpleEffects: [
          { factor: 'FactorA', within: 'FactorB' },
          { factor: 'FactorC', within: 'FactorA' },
        ],
      })

      await orchestration

      const buildPayloadCall = buildPayloadMock.mock.calls[0]!
      const payloadParams = buildPayloadCall[3] as Record<string, unknown>
      expect(payloadParams.simple_effects).toEqual([
        { factor: 'FactorA', within: 'FactorB' },
        { factor: 'FactorC', within: 'FactorA' },
      ])
    })
  })

  describe('Scheirer-Ray-Hare Flow (Nonparametric Multi-Factorial)', () => {
    it('runs DV selection → multi-factor config → execute', async () => {
      mockModule.moduleId = 'scheirer_ray_hare'

      const columns: ColumnClassification[] = [
        makeColumn('Response', ColumnDataType.Numeric, 100, 0),
        makeColumn('FactorA', ColumnDataType.Categorical, 2, 1),
        makeColumn('FactorB', ColumnDataType.Categorical, 3, 2),
        makeColumn('FactorC', ColumnDataType.Categorical, 2, 3),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-scheirer' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(
        ['scheirer_ray_hare'],
        columns,
        dataset
      )

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveDVSelection({
        cancelled: false,
        selectedVariable: 'Response',
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showMultifactorialFactorMapperDialog).toHaveBeenCalledTimes(1)
      )

      const multiContext = dialogServiceMock.getContext()
      expect(multiContext.columns.map(c => c.columnName)).toEqual([
        'Response',
        'FactorA',
        'FactorB',
        'FactorC',
      ])

      await orchestration

      const buildPayloadCall = buildPayloadMock.mock.calls[0]!
      const payloadParams = buildPayloadCall[3] as Record<string, unknown>
      expect(payloadParams.simple_effects).toBeUndefined()
      expect(mockInvoke).toHaveBeenCalled()
      expect(mockResultsStore.addResult).toHaveBeenCalled()
    })
  })

  describe('Multinomial Logistic Regression Flow', () => {
    it('runs DV selection → DV encoding (3+ levels) → execute', async () => {
      mockModule.moduleId = 'multinomial_logistic_regression'

      const columns: ColumnClassification[] = [
        makeColumn('Outcome', ColumnDataType.Categorical, 4, 0),
        makeColumn('Age', ColumnDataType.Numeric, 100, 1),
        makeColumn('Group', ColumnDataType.Categorical, 2, 2),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-multinomial' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(
        ['multinomial_logistic_regression'],
        columns,
        dataset
      )

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveDVSelection({
        cancelled: false,
        selectedVariable: 'Outcome',
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVEncodingDialog).toHaveBeenCalledTimes(1)
      )

      const context = dialogServiceMock.getContext()
      expect(context.columns[0]?.columnName).toBe('Outcome')

      dialogServiceMock.resolveDVEncoding({
        cancelled: false,
        encodingMapping: new Map([
          ['L0', 0],
          ['L1', 1],
          ['L2', 2],
          ['L3', 3],
        ]),
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showFactorEncodingDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveFactorEncoding({
        cancelled: false,
        encodingMappings: new Map([
          ['Group', new Map([['L0', 0], ['L1', 1]])],
        ]),
      })

      await orchestration

      const buildPayloadCall = buildPayloadMock.mock.calls[0]!
      const payloadParams = buildPayloadCall[3] as Record<string, unknown>
      expect(payloadParams.dependentVariable).toBe('Outcome')
      expect(payloadParams.outcomeEncoding).toEqual({
        L0: 0,
        L1: 1,
        L2: 2,
        L3: 3,
      })
      expect(mockInvoke).toHaveBeenCalled()
      expect(mockResultsStore.addResult).toHaveBeenCalled()
    })
  })

  describe('Friedman Test Flow (Repeated Measures ANOVA)', () => {
    it('runs DV selection → execute (no factor encoding)', async () => {
      mockModule.moduleId = 'friedman_test'

      const columns: ColumnClassification[] = [
        makeColumn('Baseline', ColumnDataType.Numeric, 100, 0),
        makeColumn('Week1', ColumnDataType.Numeric, 100, 1),
        makeColumn('Week2', ColumnDataType.Numeric, 100, 2),
        makeColumn('Week3', ColumnDataType.Numeric, 100, 3),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-friedman' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(
        ['friedman_test'],
        columns,
        dataset
      )

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveDVSelection({
        cancelled: false,
        selectedVariable: 'Baseline',
      })

      await orchestration

      expect(dialogServiceMock.service.showFactorEncodingDialog).not.toHaveBeenCalled()
      expect(dialogServiceMock.service.showDVEncodingDialog).not.toHaveBeenCalled()
      expect(dialogServiceMock.service.showMultiFactorialSimpleEffectsDialog).not.toHaveBeenCalled()

      expect(mockInvoke).toHaveBeenCalled()
      expect(mockResultsStore.addResult).toHaveBeenCalled()
    })
  })

  describe('Edge cases', () => {
    it('uses view-filter data model rows when building small-dataset payloads', async () => {
      const columns: ColumnClassification[] = [
        makeColumn('Concentration', ColumnDataType.Numeric, 100, 0),
        makeColumn('Treatment', ColumnDataType.Categorical, 2, 1),
        makeColumn('Batch', ColumnDataType.Categorical, 2, 2),
      ]
      const dataset = {
        id: 'ds-view-filter-scope',
        rowCount: 4,
        dataRowCount: 4,
      }
      seedDataStore(dataset, [
        { concentration: 10, treatment: 'A', batch: 'X' },
        { concentration: 20, treatment: 'B', batch: 'Y' },
        { concentration: 30, treatment: 'A', batch: 'X' },
        { concentration: 40, treatment: 'B', batch: 'Y' },
      ])

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(
        ['two_way_anova'],
        columns,
        dataset,
        'statistics-1',
        {
          datasetId: dataset.id,
          source: 'view-filter',
          viewFilterConfig: { groups: [], groupOperator: 'AND' },
          displayRowOrder: [0, 2, 4],
          dataModelRows: [0, 2],
          displayRowCount: 3,
          dataRowCount: 2,
          totalDataRowCount: 4,
        }
      )

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveDVSelection({
        cancelled: false,
        selectedVariable: 'Concentration',
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showSimpleEffectsDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveSimpleEffects({
        cancelled: false,
        factorAWithinB: false,
        factorBWithinA: false,
      })

      await orchestration

      expect(buildPayloadMock).toHaveBeenCalledTimes(1)
      const buildPayloadCall = buildPayloadMock.mock.calls[0]!
      expect(buildPayloadCall[2]).toEqual([
        [10, 'A', 'X'],
        [30, 'A', 'X'],
      ])
      const payloadParams = buildPayloadCall[3] as Record<string, unknown>
      expect(payloadParams.analysis_scope).toBe('view-filter')
      expect(payloadParams.analysis_scope_row_count).toBe(2)
      expect(payloadParams.analysis_scope_total_rows).toBe(4)
    })

    it('blocks filtered large-dataset analysis instead of running the full dataset', async () => {
      const columns: ColumnClassification[] = [
        makeColumn('Concentration', ColumnDataType.Numeric, 100, 0),
        makeColumn('Treatment', ColumnDataType.Categorical, 2, 1),
        makeColumn('Batch', ColumnDataType.Categorical, 2, 2),
      ]
      const dataset = {
        id: 'ds-large-view-filter-scope',
        rowCount: 1_500_000,
        dataRowCount: 1_500_000,
      }
      seedDataStore(dataset, createFakeRows(columns))

      mockInvoke.mockImplementation(async (command: string, args: any) => {
        if (command === 'get_dataset_storage_info') {
          return { isLarge: true, duckdbPath: 'C:/tmp/test.ecpdb' }
        }
        return defaultInvoke(command, args)
      })

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(
        ['two_way_anova'],
        columns,
        dataset,
        'statistics-1',
        {
          datasetId: dataset.id,
          source: 'view-filter',
          viewFilterConfig: { groups: [], groupOperator: 'AND' },
          displayRowOrder: [0, 2],
          dataModelRows: [0, 2],
          displayRowCount: 2,
          dataRowCount: 2,
          totalDataRowCount: 1_500_000,
        }
      )

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveDVSelection({
        cancelled: false,
        selectedVariable: 'Concentration',
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showSimpleEffectsDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveSimpleEffects({
        cancelled: false,
        factorAWithinB: false,
        factorBWithinA: false,
      })

      await orchestration

      expect(mockInvoke).not.toHaveBeenCalledWith(
        'run_statistical_test',
        expect.anything()
      )
      expect(buildPayloadMock).not.toHaveBeenCalled()
      expect(dialogServiceMock.service.showExecutionModeDialog).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Use the Advanced Filter dropdown option under Data'),
        expect.objectContaining({ id: expect.any(String) })
      )
    })

    it('falls back to duckdbPath when storage lookup fails (large dataset path)', async () => {
      const columns: ColumnClassification[] = [
        makeColumn('Concentration', ColumnDataType.Numeric, 100, 0),
        makeColumn('Treatment', ColumnDataType.Categorical, 3, 1),
        makeColumn('Batch', ColumnDataType.Categorical, 2, 2),
      ]
      const rows = createFakeRows(columns)
      const dataset = {
        id: 'ds-large-fallback',
        duckdbPath: 'C:/tmp/test.ecpdb',
        rowCount: 1_500_000,
        dataRowCount: 1_500_000,
      }
      seedDataStore(dataset, rows)

      mockInvoke.mockImplementation(async (command: string, args: any) => {
        if (command === 'get_dataset_storage_info') {
          throw new Error('storage lookup failed')
        }
        if (command === 'export_columns_to_arrow_hybrid') {
          return 'C:/tmp/test.arrow'
        }
        if (command === 'get_columns_data') {
          const columnIds = args.columnIds as string[]
          return Object.fromEntries(columnIds.map(colId => [colId, []]))
        }
        if (command === 'run_statistical_test') {
          return { results: { statistic: 12.5, p_value: 0.001 } }
        }
        throw new Error(`Unexpected command: ${command}`)
      })

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['two_way_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveDVSelection({
        cancelled: false,
        selectedVariable: 'Concentration',
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showSimpleEffectsDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveSimpleEffects({
        cancelled: false,
        factorAWithinB: false,
        factorBWithinA: false,
      })

      await orchestration

      expect(mockEnsureProjectId).toHaveBeenCalled()
      const runCall = mockInvoke.mock.calls.find(([cmd]) => cmd === 'run_statistical_test')
      expect(runCall).toBeDefined()
      const [, args] = runCall as [string, any]
      expect(args.parameters?.analysis_mode).toBe('large')
      expect(args.parameters?.duckdb_path).toBeUndefined()
      expect(args.arrowDataPath).toBe('C:/tmp/test.arrow')
    })

    it('cancels when factor encoding cancelled', async () => {
      const columns: ColumnClassification[] = [
        makeColumn('Concentration', ColumnDataType.Numeric, 100, 0),
        makeColumn('Treatment', ColumnDataType.Categorical, 3, 1),
        makeColumn('Batch', ColumnDataType.Categorical, 2, 2),
      ]
      const dataset = { id: 'ds-edge' }
      seedDataStore(dataset, createFakeRows(columns))

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['two_way_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveDVSelection({
        cancelled: false,
        selectedVariable: 'Concentration',
      })

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showSimpleEffectsDialog).toHaveBeenCalledTimes(1)
      )
      dialogServiceMock.resolveSimpleEffects({
        cancelled: true,
        factorAWithinB: false,
        factorBWithinA: false,
      })

      await expect(orchestration).resolves.toBeUndefined()
      expect(mockInvoke).not.toHaveBeenCalled()
    })

    it('stops when user cancels DV selection without selecting a variable', async () => {
      const columns: ColumnClassification[] = [
        makeColumn('Concentration', ColumnDataType.Numeric, 100, 0),
        makeColumn('Treatment', ColumnDataType.Categorical, 3, 1),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-empty-dv' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['two_way_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showDVSelectionDialog).toHaveBeenCalledTimes(1)
      )

      // User cancels or doesn't select anything
      dialogServiceMock.resolveDVSelection({ cancelled: true, selectedVariable: '' })

      await expect(orchestration).resolves.toBeUndefined()

      // No further dialogs should appear
      expect(dialogServiceMock.service.showFactorEncodingDialog).not.toHaveBeenCalled()
      expect(dialogServiceMock.service.showDVEncodingDialog).not.toHaveBeenCalled()
      expect(dialogServiceMock.service.showMultiFactorialSimpleEffectsDialog).not.toHaveBeenCalled()

      // Test should not execute
      expect(mockInvoke).not.toHaveBeenCalled()
      expect(mockResultsStore.addResult).not.toHaveBeenCalled()
    })

  })

  describe('Linear Mixed Model flow', () => {
    it('runs the dedicated LMM config dialog, uses inline simple effects, then executes with structured parameters', async () => {
      mockModule.moduleId = 'lmm_anova'

      const columns: ColumnClassification[] = [
        makeColumn('Value', ColumnDataType.Numeric, 100, 0),
        makeColumn('Sample ID', ColumnDataType.Categorical, 4, 1),
        makeColumn('Treatment', ColumnDataType.Categorical, 2, 2),
        makeColumn('Sex', ColumnDataType.Binary, 2, 3),
        makeColumn('Day', ColumnDataType.Numeric, 3, 4),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-lmm-1' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['lmm_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showLmmAnovaConfigDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveLmmConfig({
        cancelled: false,
        config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample id',
          predictorColumnIds: ['treatment', 'sex', 'strain', 'day'],
          predictorTypes: {
            treatment: 'categorical',
            sex: 'categorical',
            strain: 'categorical',
            day: 'categorical',
          },
          stratified: true,
          stratifyBy: ['sex', 'strain'],
          reml: true,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          randomSlopeTarget: '',
          adjustmentMethod: 'tukey',
          controlLevels: {},
          posthocQ: 0.05,
          simpleEffects: [{ factor: 'Treatment', within: 'Day' }],
        } as any,
      })

      await orchestration

      expect(dialogServiceMock.service.showMultiFactorialSimpleEffectsDialog).not.toHaveBeenCalled()
      expect(buildPayloadMock).toHaveBeenCalledTimes(1)
      const payloadParams = buildPayloadMock.mock.calls[0]![3] as Record<string, unknown>
      expect(payloadParams.lmm_config).toEqual(
        expect.objectContaining({
          dependentColumnId: 'value',
          subjectColumnId: 'sample id',
          stratified: true,
          stratifyBy: ['sex', 'strain'],
          reml: true,
          randomEffectsMode: 'random_intercept',
          randomSlopeTarget: '',
        })
      )
      expect(payloadParams.simple_effects).toEqual([{ factor: 'Treatment', within: 'Day' }])
      expect(payloadParams.posthoc_adjustment).toBe('tukey')
      expect(payloadParams.control_levels).toBeUndefined()
      expect(payloadParams.posthoc_q).toBeUndefined()
      expect(mockResultsStore.addResult).toHaveBeenCalledTimes(1)
      expect(mockResultsStore.addResult.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          testId: 'lmm_anova',
          plotPayload: expect.objectContaining({
            test: 'lmm_anova',
          }),
        })
      )
    })

    it('propagates continuous-effects config from LMM dialog state into module parameters', async () => {
      mockModule.moduleId = 'lmm_anova'

      const columns: ColumnClassification[] = [
        makeColumn('Value', ColumnDataType.Numeric, 100, 0),
        makeColumn('Sample ID', ColumnDataType.Categorical, 4, 1),
        makeColumn('Treatment', ColumnDataType.Categorical, 2, 2),
        makeColumn('Sex', ColumnDataType.Binary, 2, 3),
        makeColumn('Day', ColumnDataType.Numeric, 5, 4),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-lmm-continuous-1' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['lmm_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showLmmAnovaConfigDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveLmmConfig({
        cancelled: false,
        config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample id',
          predictorColumnIds: ['treatment', 'sex', 'day'],
          predictorTypes: {
            treatment: 'categorical',
            sex: 'categorical',
            day: 'continuous',
          },
          stratified: false,
          stratifyBy: [],
          reml: false,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_slope',
          randomSlopeTarget: 'day',
          adjustmentMethod: 'holm',
          controlLevels: {},
          posthocQ: 0.05,
          simpleEffects: [],
          continuousEffectsConfig: {
            mode: 'at_values',
            groupFactorId: 'treatment',
            timeFactorId: 'day',
            timeValues: [0, 2, 4],
          },
        } as any,
      })

      await orchestration

      expect(buildPayloadMock).toHaveBeenCalledTimes(1)
      const payloadParams = buildPayloadMock.mock.calls[0]![3] as Record<string, unknown>
      expect(payloadParams.lmm_config).toEqual(
        expect.objectContaining({
          randomEffectsMode: 'random_slope',
          randomSlopeTarget: 'day',
          continuousEffectsConfig: {
            mode: 'at_values',
            groupFactorId: 'treatment',
            timeFactorId: 'day',
            timeValues: [0, 2, 4],
          },
        })
      )
    })

    it('does not leak stale simple_effects from previous analysis-store state when LMM config selects none', async () => {
      mockModule.moduleId = 'lmm_anova'
      analysisState.parameters = {
        simple_effects: [{ factor: 'StaleFactor', within: 'StaleWithin' }],
      }

      const columns: ColumnClassification[] = [
        makeColumn('Value', ColumnDataType.Numeric, 100, 0),
        makeColumn('Sample ID', ColumnDataType.Categorical, 4, 1),
        makeColumn('Treatment', ColumnDataType.Categorical, 2, 2),
        makeColumn('Sex', ColumnDataType.Binary, 2, 3),
        makeColumn('Day', ColumnDataType.Numeric, 5, 4),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-lmm-stale-simple-effects' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['lmm_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showLmmAnovaConfigDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveLmmConfig({
        cancelled: false,
        config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample id',
          predictorColumnIds: ['treatment', 'sex', 'day'],
          predictorTypes: {
            treatment: 'categorical',
            sex: 'categorical',
            day: 'continuous',
          },
          stratified: false,
          stratifyBy: [],
          reml: false,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          randomSlopeTarget: '',
          adjustmentMethod: 'holm',
          controlLevels: {},
          posthocQ: 0.05,
          simpleEffects: [],
        } as any,
      })

      await orchestration

      expect(buildPayloadMock).toHaveBeenCalledTimes(1)
      const payloadParams = buildPayloadMock.mock.calls[0]![3] as Record<string, unknown>
      expect(payloadParams.simple_effects).toBeUndefined()
    })

    it('surfaces top-level LMM warnings through the generic Python warning toast path', async () => {
      mockModule.moduleId = 'lmm_anova'
      mockInvoke.mockImplementation(async (command: string, args: any) => {
        if (command !== 'run_statistical_test') {
          return defaultInvoke(command, args)
        }
        return {
          results: {
            success: true,
            test_type: 'lmm_anova',
            fixed_effects: [],
            fit_metrics: { converged: true },
            diagnostics: {
              converged: true,
              singular_fit: true,
              near_zero_random_variance: false,
              rows_dropped: 0,
              warnings: ['Random-effects covariance appears singular.'],
            },
            warnings: ['Random-effects covariance appears singular.'],
          },
        }
      })

      const columns: ColumnClassification[] = [
        makeColumn('Value', ColumnDataType.Numeric, 100, 0),
        makeColumn('Sample ID', ColumnDataType.Categorical, 4, 1),
        makeColumn('Treatment', ColumnDataType.Categorical, 2, 2),
        makeColumn('Sex', ColumnDataType.Binary, 2, 3),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-lmm-warn-1' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['lmm_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showLmmAnovaConfigDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveLmmConfig({
        cancelled: false,
        config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample id',
          predictorColumnIds: ['treatment', 'sex'],
          predictorTypes: {
            treatment: 'categorical',
            sex: 'categorical',
          },
          reml: true,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          randomSlopeTarget: '',
          stratified: false,
          stratifyBy: [],
          adjustmentMethod: 'holm',
          controlLevels: {},
          posthocQ: 0.05,
        },
      })

      await orchestration

      expect(toast.warning).toHaveBeenCalledWith('Random-effects covariance appears singular.')
    })

    it('uses adjustment settings from the LMM config dialog when the simple-effects dialog is skipped', async () => {
      mockModule.moduleId = 'lmm_anova'

      const columns: ColumnClassification[] = [
        makeColumn('Value', ColumnDataType.Numeric, 100, 0),
        makeColumn('Sample ID', ColumnDataType.Categorical, 4, 1),
        makeColumn('Treatment', ColumnDataType.Categorical, 2, 2),
        makeColumn('Sex', ColumnDataType.Binary, 2, 3),
        makeColumn('Day', ColumnDataType.Numeric, 3, 4),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-lmm-2' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['lmm_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showLmmAnovaConfigDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveLmmConfig({
        cancelled: false,
        config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample id',
          predictorColumnIds: ['treatment', 'sex', 'day'],
          predictorTypes: {
            treatment: 'categorical',
            sex: 'categorical',
            day: 'continuous',
          },
          stratified: true,
          stratifyBy: ['sex'],
          reml: false,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          randomSlopeTarget: '',
          adjustmentMethod: 'fdr_bh',
          controlLevels: {},
          posthocQ: 0.1,
        },
      })

      await orchestration

      expect(dialogServiceMock.service.showMultiFactorialSimpleEffectsDialog).not.toHaveBeenCalled()

      const payloadParams = buildPayloadMock.mock.calls[0]![3] as Record<string, unknown>
      expect(payloadParams.posthoc_adjustment).toBe('fdr_bh')
      expect(payloadParams.posthoc_q).toBe(0.1)
    })

    it('preserves main-dialog adjustment settings when inline LMM simple effects are selected', async () => {
      mockModule.moduleId = 'lmm_anova'

      const columns: ColumnClassification[] = [
        makeColumn('Value', ColumnDataType.Numeric, 100, 0),
        makeColumn('Sample ID', ColumnDataType.Categorical, 4, 1),
        makeColumn('Treatment', ColumnDataType.Categorical, 2, 2),
        makeColumn('Sex', ColumnDataType.Binary, 2, 3),
        makeColumn('Day', ColumnDataType.Categorical, 3, 4),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-lmm-adjustment-preserve' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['lmm_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showLmmAnovaConfigDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveLmmConfig({
        cancelled: false,
        config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample id',
          predictorColumnIds: ['treatment', 'sex', 'day'],
          predictorTypes: {
            treatment: 'categorical',
            sex: 'categorical',
            day: 'categorical',
          },
          stratified: false,
          stratifyBy: [],
          reml: false,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          randomSlopeTarget: '',
          adjustmentMethod: 'dunnett',
          controlLevels: {
            treatment: 'Control',
            sex: 'F',
          },
          posthocQ: 0.2,
          simpleEffects: [{ factor: 'Treatment', within: 'Day' }],
        } as any,
      })

      await orchestration

      expect(dialogServiceMock.service.showMultiFactorialSimpleEffectsDialog).not.toHaveBeenCalled()
      expect(buildPayloadMock).toHaveBeenCalledTimes(1)
      const payloadParams = buildPayloadMock.mock.calls[0]![3] as Record<string, unknown>
      expect(payloadParams.simple_effects).toEqual([{ factor: 'Treatment', within: 'Day' }])
      expect(payloadParams.posthoc_adjustment).toBe('dunnett')
      expect(payloadParams.control_levels).toEqual({
        treatment: 'Control',
        sex: 'F',
      })
      expect(payloadParams.posthoc_q).toBeUndefined()
    })

    it('keeps the stratified simple-effects empty-note visible when simple effects were requested', async () => {
      mockModule.moduleId = 'lmm_anova'
      mockInvoke.mockImplementation(async (command: string, args: any) => {
        if (command !== 'run_statistical_test') {
          return defaultInvoke(command, args)
        }
        return {
          results: {
            success: true,
            test_type: 'lmm_anova_stratified',
            stratified: true,
            stratify_by: ['Sex'],
            strata_results: [
              {
                success: true,
                stratum: { Sex: 'F' },
                fixed_effects: [
                  {
                    source: 'Treatment',
                    f_value: 3.4,
                    num_df: 1,
                    den_df: 12,
                    p_value: 0.08,
                  },
                ],
                pairwise_comparisons: [],
                diagnostics: {
                  converged: true,
                  singular_fit: false,
                },
              },
            ],
          },
        }
      })

      const columns: ColumnClassification[] = [
        makeColumn('Value', ColumnDataType.Numeric, 100, 0),
        makeColumn('Sample ID', ColumnDataType.Categorical, 4, 1),
        makeColumn('Treatment', ColumnDataType.Categorical, 2, 2),
        makeColumn('Sex', ColumnDataType.Binary, 2, 3),
        makeColumn('Day', ColumnDataType.Categorical, 3, 4),
      ]
      const rows = createFakeRows(columns)
      const dataset = { id: 'ds-lmm-stratified-empty-simple-note' }
      seedDataStore(dataset, rows)

      const controller = new StatisticalAnalysisController(dialogServiceMock.service)
      const orchestration = controller.runAnalysisWithTests(['lmm_anova'], columns, dataset)

      await vi.waitFor(() =>
        expect(dialogServiceMock.service.showLmmAnovaConfigDialog).toHaveBeenCalledTimes(1)
      )

      dialogServiceMock.resolveLmmConfig({
        cancelled: false,
        config: {
          dependentColumnId: 'value',
          subjectColumnId: 'sample id',
          predictorColumnIds: ['treatment', 'day'],
          predictorTypes: {
            treatment: 'categorical',
            day: 'categorical',
            sex: 'categorical',
          },
          stratified: true,
          stratifyBy: ['sex'],
          reml: false,
          interactionDepth: 2,
          dfMethod: 'satterthwaite',
          randomEffectsMode: 'random_intercept',
          randomSlopeTarget: '',
          adjustmentMethod: 'holm',
          controlLevels: {},
          posthocQ: 0.05,
          simpleEffects: [{ factor: 'Treatment', within: 'Day' }],
        } as any,
      })

      await orchestration

      const addedResult = mockResultsStore.addResult.mock.calls[0]?.[0] as
        | { ecpTableCollection?: { tables?: Array<{ testName?: string; rows?: Array<{ cells: Array<{ value: unknown }> }> }> } }
        | undefined
      const simpleTable = addedResult?.ecpTableCollection?.tables?.find(
        table => table.testName === 'lmm_simple_effects_report'
      )
      const hasUnavailableNote = Boolean(
        simpleTable?.rows?.some(row =>
          row.cells.some(cell =>
            typeof cell.value === 'string' &&
            cell.value.includes('No categorical simple effects were available inside the subgroup fits')
          )
        )
      )
      expect(hasUnavailableNote).toBe(true)
    })
  })
})
