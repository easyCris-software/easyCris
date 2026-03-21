/**
 * Results Store - Zustand store for statistical test results
 *
 * Manages:
 * - Test results (statistics, p-values, coefficients)
 * - Plots and visualizations (Plotly.js JSON specs)
 * - Result tables and formatted output
 * - Export functionality (PNG, SVG, PDF, CSV, HTML)
 *
 * IMPORTANT - Navigator State Synchronization:
 * When results are added via addResult(), you should also update
 * the app-store to enable the Results/Plots navigator nodes:
 *
 * @example
 * ```typescript
 * // After adding result to store
 * useResultsStore.getState().addResult(result)
 *
 * // Enable Results/Plots in Navigator
 * useAppStore.getState().updateActiveFamilyResults(true)
 * ```
 *
 * This ensures the Navigator tree reflects actual data state.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { ECPTableCollection } from '@/types/ecpStyleTables'

/**
 * Parameter value type - narrowed from unknown for type-safe JSX rendering
 * Phase 4 Fix: Resolves TS2322 "Type 'unknown' is not assignable to type 'ReactNode'"
 */
export type ParameterValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ParameterValue[]

/**
 * Statistical test result data structure
 * Mirrors the JSON format returned by Python statistics modules
 */
export interface TestResult {
  id: string
  testId: string
  testName: string
  family: string
  /**
   * Statistics "family instance" id (Navigator tab), e.g. "statistics-1".
   * Prevents results from one tab appearing in another.
   */
  statisticsFamilyId?: string
  executedAt: Date
  parameters?: Record<string, ParameterValue>

  // Test statistics - Phase 4 Fix: removed index signature to avoid unknown propagation
  statistics: {
    statistic?: number
    pValue?: number
    degreesOfFreedom?: number
    effectSize?: number
    confidenceInterval?: [number, number]
    rSquared?: number
    fValue?: number
    tValue?: number
    chi2?: number
    correlation?: number
  }

  // Assumptions tests (e.g., normality, homogeneity of variance)
  assumptions?: {
    name: string
    statistic: number
    pValue: number
    passed: boolean
    message: string
  }[]

  // Post-hoc results (for ANOVA, etc.)
  postHoc?: {
    comparison: string
    statistic: number
    pValue: number
    pValueAdjusted?: number
    significant: boolean
  }[]

  // Regression/correlation coefficients
  coefficients?: {
    name: string
    estimate: number
    stdError: number
    tStatistic?: number
    pValue: number
    confidenceInterval?: [number, number]
  }[]

  // Model fit statistics (for regression, dose-response)
  modelFit?: {
    r2?: number
    adjustedR2?: number
    rmse?: number
    aic?: number
    bic?: number
    logLikelihood?: number
    [key: string]: unknown
  }

  // Survival analysis specific
  survivalCurves?: {
    group: string
    time: number[]
    survival: number[]
    nRisk: number[]
    nEvents: number[]
    confidenceLower?: number[]
    confidenceUpper?: number[]
  }[]

  // Cox adjusted survival curves (optional)
  adjustedSurvivalCurves?: {
    label: string
    time: number[]
    survival: number[]
    covariates?: Record<string, number | string>
  }[]
  adjustedSurvivalNote?: string

  // Nelson-Aalen smoothed hazard (optional)
  smoothedHazard?: {
    bandwidth: number
    time: number[]
    hazard: number[]
    ciLower?: number[]
    ciUpper?: number[]
  }

  // Visualization metadata (Plotly JSON payloads, etc.)
  visualizations?: {
    plotlyJson?: unknown
    [key: string]: unknown
  }

  // Summary key/value pairs for quick display
  summary?: Record<string, string | number>

  // Detailed tables embedded in result payload
  tables?: Array<{
    title?: string
    headers?: string[]
    data: Array<Array<string | number>>
  }>

  // ECP-Style formatted tables (new Phase 4 table system)
  ecpTableCollection?: ECPTableCollection

  // Raw Python output (for debugging)
  rawOutput?: unknown

  // Payload used to build plots for small datasets (auto-plot support)
  plotPayload?: {
    test: string
    data: Record<string, unknown>
    parameters?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }

  // Phase 7: Sampling metadata for Tier 3 tests on large datasets
  // When present, indicates results are based on a sample, not the full dataset
  samplingMetadata?: {
    isSampled: boolean
    sampleSize: number
    totalRows: number
    samplingMethod: 'random' | 'stratified'
    randomSeed: number
    samplePercentage: number
    confidenceNote: string
  }

  // Categorical encoding metadata (Phase 4)
  // Allows ECP table builders to decode dummy variables back to categorical levels
  encodingMappings?: Map<string, Map<string, number>> // variable → level → code
  dummyVariableInfo?: Record<string, {
    baselineLevel: string
    dummyLevels: string[]
  }>

  // Large dataset flag - prevents plot auto-generation for large datasets
  // When true, only statistics are computed (no raw data plots)
  isLargeDataset?: boolean
}

/**
 * Plot specification (Plotly.js format)
 */
export interface PlotSpec {
  id: string
  resultId: string
  type: 'scatter' | 'bar' | 'box' | 'histogram' | 'heatmap' | 'survival' | 'doseresponse' | 'qq' | 'residual'
  title: string
  plotlyData: unknown[] // Plotly.js data array
  plotlyLayout: unknown // Plotly.js layout object
  plotlyConfig?: unknown // Plotly.js config object
  createdAt: Date
}

/**
 * Result table for displaying formatted output
 */
export interface ResultTable {
  id: string
  resultId: string
  title: string
  headers: string[]
  rows: (string | number)[][]
  footer?: string
  createdAt: Date
}

/**
 * Export format options
 */
export type ExportFormat = 'png' | 'svg' | 'pdf' | 'html' | 'csv' | 'json'

type DirtyOptions = {
  suppressDirty?: boolean
}

/**
 * Results Store State
 */
interface ResultsState {
  // Active Statistics family (Navigator tab)
  activeStatisticsFamilyId: string | null

  // Per-family result storage (source of truth)
  resultsByFamily: Record<string, TestResult[]>
  currentResultIdByFamily: Record<string, string | null>

  // Results
  currentResult: TestResult | null
  results: TestResult[]
  maxResultsCount: number

  // Plots
  currentPlots: PlotSpec[]
  savedPlots: PlotSpec[]

  // Tables
  currentTables: ResultTable[]

  // Export state
  isExporting: boolean
  exportProgress: number
  exportError: string | null

  // Actions - Results management
  setActiveStatisticsFamilyId: (familyId: string | null) => void
  setCurrentResult: (result: TestResult | null) => void
  addResult: (result: TestResult, options?: DirtyOptions) => void
  removeResult: (resultId: string) => void
  clearFamilyResults: (familyId: string, options?: DirtyOptions) => void
  getFamilyResultCount: (familyId: string) => number
  clearResults: (options?: DirtyOptions) => void
  clearAllResults: (options?: DirtyOptions) => void
  getResult: (resultId: string) => TestResult | undefined
  getAllResults: () => TestResult[]

  // Actions - Plots management
  addPlot: (plot: PlotSpec) => void
  removePlot: (plotId: string) => void
  clearPlots: () => void
  savePlot: (plotId: string) => void
  unsavePlot: (plotId: string) => void

  // Actions - Tables management
  addTable: (table: ResultTable) => void
  removeTable: (tableId: string) => void
  clearTables: () => void

  // Actions - Export
  setExporting: (exporting: boolean) => void
  setExportProgress: (progress: number) => void
  setExportError: (error: string | null) => void
}

export const useResultsStore = create<ResultsState>()(
  devtools(
    (set, get) => ({
      // Initial state
      activeStatisticsFamilyId: null,
      resultsByFamily: {},
      currentResultIdByFamily: {},
      currentResult: null,
      results: [],
      maxResultsCount: 100,
      currentPlots: [],
      savedPlots: [],
      currentTables: [],
      isExporting: false,
      exportProgress: 0,
      exportError: null,

      // Results management actions
      setActiveStatisticsFamilyId: familyId => {
        set(
          state => {
            const nextFamilyId = familyId
            const familyResults = nextFamilyId ? state.resultsByFamily[nextFamilyId] ?? [] : []
            const currentId = nextFamilyId ? state.currentResultIdByFamily[nextFamilyId] : null
            const current =
              currentId ? familyResults.find(r => r.id === currentId) ?? null : null

            return {
              activeStatisticsFamilyId: nextFamilyId,
              results: familyResults,
              currentResult: current,
            }
          },
          undefined,
          'setActiveStatisticsFamilyId'
        )
      },

      setCurrentResult: result =>
        set(
          state => {
            const familyId = state.activeStatisticsFamilyId
            if (!familyId) {
              return { currentResult: result }
            }

            return {
              currentResult: result,
              currentResultIdByFamily: {
                ...state.currentResultIdByFamily,
                [familyId]: result?.id ?? null,
              },
            }
          },
          undefined,
          'setCurrentResult'
        ),

      addResult: (result, options) => {
        set(
          state => ({
            resultsByFamily: (() => {
              const familyId =
                result.statisticsFamilyId ?? state.activeStatisticsFamilyId ?? 'statistics-1'
              const existing = state.resultsByFamily[familyId] ?? []
              const next = [result, ...existing].slice(0, state.maxResultsCount)
              return { ...state.resultsByFamily, [familyId]: next }
            })(),
            currentResultIdByFamily: (() => {
              const familyId =
                result.statisticsFamilyId ?? state.activeStatisticsFamilyId ?? 'statistics-1'
              return { ...state.currentResultIdByFamily, [familyId]: result.id }
            })(),
            ...(state.activeStatisticsFamilyId &&
            (result.statisticsFamilyId ?? state.activeStatisticsFamilyId ?? 'statistics-1') ===
              state.activeStatisticsFamilyId
              ? {
                  results: [
                    result,
                    ...state.results.slice(0, state.maxResultsCount - 1),
                  ],
                  currentResult: result,
                }
              : {}),
          }),
          undefined,
          'addResult'
        )

        // Sync Navigator state so green dot appears on the correct Statistics family
        const familyId = result.statisticsFamilyId ?? get().activeStatisticsFamilyId
        if (familyId) {
          import('./app-store').then(({ useAppStore }) => {
            useAppStore.getState().setFamilyResults(familyId, true)
            if (!options?.suppressDirty) {
              useAppStore.getState().setProjectDirty(true)
            }
          })
        } else {
          // Mark dirty even without familyId
          if (!options?.suppressDirty) {
            import('./app-store').then(({ useAppStore }) => {
              useAppStore.getState().setProjectDirty(true)
            })
          }
        }
      },

      removeResult: resultId => {
        set(
          state => {
            const nextResultsByFamily: Record<string, TestResult[]> = {}
            const nextCurrentByFamily: Record<string, string | null> = {
              ...state.currentResultIdByFamily,
            }

            for (const [familyId, familyResults] of Object.entries(state.resultsByFamily)) {
              const filtered = familyResults.filter(r => r.id !== resultId)
              if (filtered.length !== familyResults.length) {
                if (nextCurrentByFamily[familyId] === resultId) {
                  nextCurrentByFamily[familyId] = filtered[0]?.id ?? null
                }
              }
              nextResultsByFamily[familyId] = filtered
            }

            const activeFamilyId = state.activeStatisticsFamilyId
            const activeResults = activeFamilyId ? nextResultsByFamily[activeFamilyId] ?? [] : []
            const activeCurrentId = activeFamilyId ? nextCurrentByFamily[activeFamilyId] : null
            const activeCurrent = activeCurrentId
              ? activeResults.find(r => r.id === activeCurrentId) ?? null
              : null

            return {
              resultsByFamily: nextResultsByFamily,
              currentResultIdByFamily: nextCurrentByFamily,
              results: activeResults,
              currentResult: activeCurrent,
              currentPlots: state.currentPlots.filter(p => p.resultId !== resultId),
              currentTables: state.currentTables.filter(t => t.resultId !== resultId),
            }
          },
          undefined,
          'removeResult'
        )

        const state = get()
        const familyId = state.activeStatisticsFamilyId
        if (familyId) {
          const remaining = state.resultsByFamily[familyId]?.length ?? 0
          if (remaining === 0) {
            import('./app-store').then(({ useAppStore }) => {
              useAppStore.getState().setFamilyResults(familyId, false)
            })
          }
        }
        // Mark project dirty after removing result
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      clearFamilyResults: (familyId: string, options) => {
        set(
          state => {
            const nextResultsByFamily = { ...state.resultsByFamily }
            const nextCurrentByFamily = { ...state.currentResultIdByFamily }
            delete nextResultsByFamily[familyId]
            delete nextCurrentByFamily[familyId]

            const activeFamilyId = state.activeStatisticsFamilyId
            const activeResults = activeFamilyId ? nextResultsByFamily[activeFamilyId] ?? [] : []
            const activeCurrentId = activeFamilyId ? nextCurrentByFamily[activeFamilyId] : null
            const activeCurrent = activeCurrentId
              ? activeResults.find(r => r.id === activeCurrentId) ?? null
              : null

            return {
              resultsByFamily: nextResultsByFamily,
              currentResultIdByFamily: nextCurrentByFamily,
              results: activeResults,
              currentResult: activeCurrent,
            }
          },
          undefined,
          'clearFamilyResults'
        )

        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setFamilyResults(familyId, false)
          if (!options?.suppressDirty) {
            useAppStore.getState().setProjectDirty(true)
          }
        })
      },

      getFamilyResultCount: (familyId: string) => {
        const list = get().resultsByFamily[familyId]
        return list ? list.length : 0
      },

      clearResults: (options) => {
        const familyId = get().activeStatisticsFamilyId
        if (!familyId) {
          set(
            {
              results: [],
              currentResult: null,
              currentPlots: [],
              currentTables: [],
            },
            undefined,
            'clearResults'
          )
          if (!options?.suppressDirty) {
            import('./app-store').then(({ useAppStore }) => {
              useAppStore.getState().setProjectDirty(true)
            })
          }
          return
        }

        set(
          state => ({
            resultsByFamily: { ...state.resultsByFamily, [familyId]: [] },
            currentResultIdByFamily: { ...state.currentResultIdByFamily, [familyId]: null },
            results: [],
            currentResult: null,
            currentPlots: [],
            currentTables: [],
          }),
          undefined,
          'clearResults'
        )

        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setFamilyResults(familyId, false)
          if (!options?.suppressDirty) {
            useAppStore.getState().setProjectDirty(true)
          }
        })
      },

      clearAllResults: (options) => {
        set(
          {
            resultsByFamily: {},
            currentResultIdByFamily: {},
            results: [],
            currentResult: null,
            currentPlots: [],
            currentTables: [],
          },
          undefined,
          'clearAllResults'
        )

        import('./app-store').then(({ useAppStore }) => {
          const families = useAppStore.getState().families
          for (const f of families) {
            useAppStore.getState().setFamilyResults(f.id, false)
          }
          if (!options?.suppressDirty) {
            useAppStore.getState().setProjectDirty(true)
          }
        })
      },

      getResult: resultId => {
        const { resultsByFamily } = get()
        for (const results of Object.values(resultsByFamily)) {
          const found = results.find(r => r.id === resultId)
          if (found) return found
        }
        return undefined
      },

      getAllResults: () =>
        Object.values(get().resultsByFamily).flat(),

      // Plots management actions
      addPlot: plot =>
        set(
          state => ({
            currentPlots: [...state.currentPlots, plot],
          }),
          undefined,
          'addPlot'
        ),

      removePlot: plotId =>
        set(
          state => ({
            currentPlots: state.currentPlots.filter(p => p.id !== plotId),
            savedPlots: state.savedPlots.filter(p => p.id !== plotId),
          }),
          undefined,
          'removePlot'
        ),

      clearPlots: () =>
        set({ currentPlots: [], savedPlots: [] }, undefined, 'clearPlots'),

      savePlot: plotId =>
        set(
          state => {
            const plot = state.currentPlots.find(p => p.id === plotId)
            if (plot && !state.savedPlots.find(p => p.id === plotId)) {
              return {
                savedPlots: [...state.savedPlots, plot],
              }
            }
            return state
          },
          undefined,
          'savePlot'
        ),

      unsavePlot: plotId =>
        set(
          state => ({
            savedPlots: state.savedPlots.filter(p => p.id !== plotId),
          }),
          undefined,
          'unsavePlot'
        ),

      // Tables management actions
      addTable: table =>
        set(
          state => ({
            currentTables: [...state.currentTables, table],
          }),
          undefined,
          'addTable'
        ),

      removeTable: tableId =>
        set(
          state => ({
            currentTables: state.currentTables.filter(t => t.id !== tableId),
          }),
          undefined,
          'removeTable'
        ),

      clearTables: () => set({ currentTables: [] }, undefined, 'clearTables'),

      // Export actions
      setExporting: exporting =>
        set({ isExporting: exporting }, undefined, 'setExporting'),

      setExportProgress: progress =>
        set({ exportProgress: progress }, undefined, 'setExportProgress'),

      setExportError: error =>
        set({ exportError: error }, undefined, 'setExportError'),
    }),
    {
      name: 'results-store',
    }
  )
)

