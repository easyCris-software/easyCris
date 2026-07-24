/**
 * Plots Store - Phase 1 Plots Feature
 *
 * Separate store for the new Plots panel (does NOT modify results-store.ts).
 * Uses discriminated union PlotSpec with all fields required per source type.
 *
 * Key design decisions:
 * - Discriminated union: TestResultPlotSpec | UserDerivedPlotSpec
 * - All fields required (no optional fields, explicit nulls)
 * - ISO 8601 strings for timestamps (not Date objects)
 * - Separate from results-store to avoid breaking existing SavedPlot
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { PlotType, StatisticalFamily, PlotRole, PlotDataType } from '@/config/plotRegistry'
import type { Config } from 'plotly.js'
import type { LmmTraceRoleOverride } from '@/services/plotResult/lmm/resolveTraceRoles'

// =============================================================================
// TYPES - Discriminated Union PlotSpec
// =============================================================================

/**
 * Sampling configuration for sampled plots
 */
export interface SamplingConfig {
  method: 'random' | 'systematic' | 'stratified'
  sampleSize: number
  seed: number | null
}

/**
 * Aggregation configuration for aggregated plots
 */
export interface AggregationConfig {
  groupBy: string[]
  aggregations: {
    column: string
    function: 'mean' | 'median' | 'sum' | 'count' | 'min' | 'max' | 'std' | 'q1' | 'q3'
  }[]
}

/**
 * Column data for user-derived plots
 */
export interface PlotColumn {
  role: PlotRole
  columnId: string
  columnName: string
  values: unknown[]
  inferredType: PlotDataType
}

/**
 * Base fields shared by all PlotSpec types
 */
interface PlotSpecBase {
  id: string
  type: PlotType
  title: string
  /**
   * Statistics "family instance" id (Navigator tab), e.g. "statistics-1".
   * Keeps plots isolated per Statistics tab.
   */
  statisticsFamilyId: string
  plotlyData: unknown[]
  plotlyLayout: unknown
  plotlyConfig: Partial<Config>
  dataPolicy: 'raw' | 'sampled' | 'aggregated'
  samplingConfig: SamplingConfig | null
  aggregationConfig: AggregationConfig | null
  createdAt: string   // ISO 8601
  updatedAt: string   // ISO 8601
}

/**
 * Plot linked to a test result
 */
export interface TestResultPlotSpec extends PlotSpecBase {
  sourceType: 'test_result'
  resultId: string
  testType: string
  testFamily: Exclude<StatisticalFamily, 'user_derived'>
  dataSnapshot: null  // Data lives in the test result
  /**
   * Facet key for LMM per-stratum plots (e.g. "sex=M", "sex=F|treatment=VEH").
   * null for pooled LMM results and all non-LMM plots.
   */
  facetKey: string | null
  /**
   * LMM-specific emitted mode.
   * - trajectory: per-group means over time
   * - contrast: pairwise contrast over time
   * - line_unavailable: axis roles cannot be resolved; placeholder card shown
   * null for non-LMM plots.
   */
  lmmMode: 'trajectory' | 'contrast' | 'line_unavailable' | null
}

/**
 * User-derived plot with embedded data snapshot
 */
export interface UserDerivedPlotSpec extends PlotSpecBase {
  sourceType: 'user_derived'
  resultId: null
  testType: null
  testFamily: 'user_derived'
  dataSnapshot: {
    columns: PlotColumn[]
    metadata: {
      totalRows: number
      sampledRows: number
      snapshotTimestamp: string  // ISO 8601
      datasetId: string
    }
  }
}

/**
 * Discriminated union - all plot specs
 */
export type PlotSpec = TestResultPlotSpec | UserDerivedPlotSpec

/**
 * Type guard for test result plots
 */
export function isTestResultPlot(spec: PlotSpec): spec is TestResultPlotSpec {
  return spec.sourceType === 'test_result'
}

/**
 * Type guard for user-derived plots
 */
export function isUserDerivedPlot(spec: PlotSpec): spec is UserDerivedPlotSpec {
  return spec.sourceType === 'user_derived'
}

function resolveStatisticsFamilyId(plot: PlotSpec): string {
  return (plot as PlotSpec & { statisticsFamilyId?: string }).statisticsFamilyId ?? 'statistics-1'
}

// =============================================================================
// FACTORY FUNCTIONS - Create PlotSpec with required fields
// =============================================================================

/**
 * Create a test result plot spec with all required fields
 */
export function createTestResultPlotSpec(
  params: {
    id: string
    type: PlotType
    title: string
    statisticsFamilyId: string
    resultId: string
    testType: string
    testFamily: Exclude<StatisticalFamily, 'user_derived'>
    plotlyData: unknown[]
    plotlyLayout: unknown
    plotlyConfig?: Partial<Config>
    dataPolicy?: 'raw' | 'sampled' | 'aggregated'
    samplingConfig?: SamplingConfig | null
    aggregationConfig?: AggregationConfig | null
    facetKey?: string | null
    lmmMode?: 'trajectory' | 'contrast' | 'line_unavailable' | null
  }
): TestResultPlotSpec {
  const now = new Date().toISOString()
  return {
    id: params.id,
    type: params.type,
    title: params.title,
    statisticsFamilyId: params.statisticsFamilyId,
    plotlyData: params.plotlyData,
    plotlyLayout: params.plotlyLayout,
    plotlyConfig: params.plotlyConfig ?? {},
    dataPolicy: params.dataPolicy ?? 'raw',
    samplingConfig: params.samplingConfig ?? null,
    aggregationConfig: params.aggregationConfig ?? null,
    createdAt: now,
    updatedAt: now,
    sourceType: 'test_result',
    resultId: params.resultId,
    testType: params.testType,
    testFamily: params.testFamily,
    dataSnapshot: null,
    facetKey: params.facetKey ?? null,
    lmmMode: params.lmmMode ?? null,
  }
}

/**
 * Create a user-derived plot spec with all required fields
 */
export function createUserDerivedPlotSpec(
  params: {
    id: string
    type: PlotType
    title: string
    statisticsFamilyId: string
    datasetId: string
    columns: PlotColumn[]
    totalRows: number
    sampledRows: number
    plotlyData: unknown[]
    plotlyLayout: unknown
    plotlyConfig?: Partial<Config>
    dataPolicy?: 'raw' | 'sampled' | 'aggregated'
    samplingConfig?: SamplingConfig | null
    aggregationConfig?: AggregationConfig | null
  }
): UserDerivedPlotSpec {
  const now = new Date().toISOString()
  return {
    id: params.id,
    type: params.type,
    title: params.title,
    statisticsFamilyId: params.statisticsFamilyId,
    plotlyData: params.plotlyData,
    plotlyLayout: params.plotlyLayout,
    plotlyConfig: params.plotlyConfig ?? {},
    dataPolicy: params.dataPolicy ?? 'raw',
    samplingConfig: params.samplingConfig ?? null,
    aggregationConfig: params.aggregationConfig ?? null,
    createdAt: now,
    updatedAt: now,
    sourceType: 'user_derived',
    resultId: null,
    testType: null,
    testFamily: 'user_derived',
    dataSnapshot: {
      columns: params.columns,
      metadata: {
        totalRows: params.totalRows,
        sampledRows: params.sampledRows,
        snapshotTimestamp: now,
        datasetId: params.datasetId,
      },
    },
  }
}

// =============================================================================
// STORE STATE & ACTIONS
// =============================================================================

type DirtyOptions = {
  suppressDirty?: boolean
}

interface PlotsState {
  // State
  plots: PlotSpec[]
  activePlotId: string | null
  activeFamily: StatisticalFamily | 'all'
  activeStatisticsFamilyId: string | null

  // Computed stats (for E2E hidden DOM node)
  computedStats: Record<string, Record<string, number | string>>  // plotId -> statName -> value

  // Per-plot LMM style overrides
  // Key: "${resultId}|${facetKey ?? 'pooled'}|${lmmMode}"
  lmmStyleOverrides: Record<string, LmmTraceRoleOverride>

  // Actions - Plot management
  addPlot: (
    plot: PlotSpec,
    options?: {
      preserveActiveUserPlot?: boolean
    }
  ) => void
  updatePlot: (plotId: string, updates: Partial<Omit<PlotSpec, 'id' | 'sourceType' | 'createdAt'>>) => void
  removePlot: (plotId: string) => void
  clearPlots: (options?: DirtyOptions) => void
  clearFamilyPlots: (family: StatisticalFamily, options?: DirtyOptions) => void
  clearStatisticsFamilyPlots: (familyId: string, options?: DirtyOptions) => void
  restorePlots: (plots: PlotSpec[]) => void

  // Actions - Active plot
  setActivePlot: (plotId: string | null) => void
  setActiveFamily: (family: StatisticalFamily | 'all') => void
  setActiveStatisticsFamilyId: (familyId: string | null) => void
  migrateLegacyPlots: (familyId: string) => void

  // Actions - Stats (for E2E validation)
  setPlotStats: (plotId: string, stats: Record<string, number | string>) => void
  getPlotStats: (plotId: string) => Record<string, number> | undefined

  // Actions - LMM style overrides
  setLmmStyleOverride: (key: string, override: LmmTraceRoleOverride) => void
  clearLmmStyleOverride: (key: string) => void

  // Selectors
  getPlot: (plotId: string) => PlotSpec | undefined
  getPlotsByFamily: (family: StatisticalFamily | 'all') => PlotSpec[]
  getPlotsByResult: (resultId: string) => PlotSpec[]
  getActivePlot: () => PlotSpec | undefined
  getLmmStyleOverride: (key: string) => LmmTraceRoleOverride | undefined
}

export const usePlotsStore = create<PlotsState>()(
  devtools(
    (set, get) => ({
      // Initial state
      plots: [],
      activePlotId: null,
      activeFamily: 'all',
      activeStatisticsFamilyId: null,
      computedStats: {},
      lmmStyleOverrides: {},

      // Plot management
      addPlot: (plot, options) => {
        set(
          (state) => {
            const plotFamilyId = resolveStatisticsFamilyId(plot)
            const activeStatisticsFamilyId = state.activeStatisticsFamilyId ?? plotFamilyId
            const activePlot = state.activePlotId
              ? state.plots.find((p) => p.id === state.activePlotId)
              : undefined
            const preserveActiveUserPlot =
              options?.preserveActiveUserPlot === true &&
              plot.sourceType === 'test_result' &&
              activePlot?.sourceType === 'user_derived' &&
              resolveStatisticsFamilyId(activePlot) === plotFamilyId
            const shouldActivate =
              plotFamilyId === activeStatisticsFamilyId && !preserveActiveUserPlot
            return {
              plots: [...state.plots, plot],
              activeStatisticsFamilyId,
              activePlotId: shouldActivate ? plot.id : state.activePlotId,
            }
          },
          undefined,
          'plots/addPlot'
        )
        import('./app-store').then(({ useAppStore }) => {
          const appStore = useAppStore.getState()
          appStore.setProjectDirty(true)
          appStore.markPlotSettingsAttention(
            resolveStatisticsFamilyId(plot),
            plot.sourceType
          )
        })
      },

      updatePlot: (plotId, updates) => {
        set(
          (state) => ({
            plots: state.plots.map((p) =>
              p.id === plotId
                ? ({ ...p, ...updates, updatedAt: new Date().toISOString() } as PlotSpec)
                : p
            ),
          }),
          undefined,
          'plots/updatePlot'
        )
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      removePlot: (plotId) => {
        set(
          (state) => {
            const removedPlot = state.plots.find((p) => p.id === plotId)
            const newPlots = state.plots.filter((p) => p.id !== plotId)
            const newStats = { ...state.computedStats }
            delete newStats[plotId]
            let nextActivePlotId = state.activePlotId

            if (state.activePlotId === plotId) {
              const familyId =
                state.activeStatisticsFamilyId ??
                (removedPlot ? resolveStatisticsFamilyId(removedPlot) : 'statistics-1')
              const familyPlots = newPlots.filter(
                (p) => resolveStatisticsFamilyId(p) === familyId
              )
              nextActivePlotId = familyPlots[0]?.id ?? null
            }

            return {
              plots: newPlots,
              computedStats: newStats,
              activePlotId: nextActivePlotId,
            }
          },
          undefined,
          'plots/removePlot'
        )
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      clearPlots: (options) => {
        set(
          { plots: [], activePlotId: null, computedStats: {} },
          undefined,
          'plots/clearPlots'
        )
        if (!options?.suppressDirty) {
          import('./app-store').then(({ useAppStore }) => {
            useAppStore.getState().setProjectDirty(true)
          })
        }
      },

      clearFamilyPlots: (family, options) => {
        set(
          (state) => {
            const newPlots = state.plots.filter((p) => p.testFamily !== family)
            const removedIds = new Set(
              state.plots.filter((p) => p.testFamily === family).map((p) => p.id)
            )
            const newStats = Object.fromEntries(
              Object.entries(state.computedStats).filter(([id]) => !removedIds.has(id))
            )
            const activePlot = state.activePlotId
              ? state.plots.find((p) => p.id === state.activePlotId)
              : undefined
            const activeFamilyId =
              state.activeStatisticsFamilyId ??
              (activePlot ? resolveStatisticsFamilyId(activePlot) : 'statistics-1')
            const activeFamilyPlots = newPlots.filter(
              (p) => resolveStatisticsFamilyId(p) === activeFamilyId
            )
            const nextActivePlotId =
              removedIds.has(state.activePlotId ?? '')
                ? activeFamilyPlots[0]?.id ?? null
                : state.activePlotId

            return {
              plots: newPlots,
              computedStats: newStats,
              activePlotId: nextActivePlotId,
            }
          },
          undefined,
          'plots/clearFamilyPlots'
        )
        if (!options?.suppressDirty) {
          import('./app-store').then(({ useAppStore }) => {
            useAppStore.getState().setProjectDirty(true)
          })
        }
      },

      clearStatisticsFamilyPlots: (familyId, options) => {
        set(
          (state) => {
            const newPlots = state.plots.filter(
              (p) => resolveStatisticsFamilyId(p) !== familyId
            )
            const removedIds = new Set(
              state.plots
                .filter((p) => resolveStatisticsFamilyId(p) === familyId)
                .map((p) => p.id)
            )
            const newStats = Object.fromEntries(
              Object.entries(state.computedStats).filter(([id]) => !removedIds.has(id))
            )
            const activeFamilyId = state.activeStatisticsFamilyId ?? familyId
            const activeFamilyPlots = newPlots.filter(
              (p) => resolveStatisticsFamilyId(p) === activeFamilyId
            )
            const nextActivePlotId =
              removedIds.has(state.activePlotId ?? '')
                ? activeFamilyPlots[0]?.id ?? null
                : state.activePlotId

            return {
              plots: newPlots,
              computedStats: newStats,
              activePlotId: nextActivePlotId,
            }
          },
          undefined,
          'plots/clearStatisticsFamilyPlots'
        )
        if (!options?.suppressDirty) {
          import('./app-store').then(({ useAppStore }) => {
            useAppStore.getState().setProjectDirty(true)
          })
        }
      },

      restorePlots: (plots) =>
        set(
          {
            plots,
            computedStats: {}, // Clear stats when restoring
            activePlotId: null, // Will be set separately by setActivePlot if needed
          },
          undefined,
          'plots/restorePlots'
        ),

      // Active plot
      setActivePlot: (plotId) =>
        set((state) => {
          const activeStatisticsFamilyId = state.activeStatisticsFamilyId
          if (!plotId) {
            return { activePlotId: null }
          }
          const plot = state.plots.find((p) => p.id === plotId)
          if (plot && activeStatisticsFamilyId) {
            const plotFamilyId = resolveStatisticsFamilyId(plot)
            if (plotFamilyId !== activeStatisticsFamilyId) {
              return { activePlotId: state.activePlotId }
            }
          }
          return { activePlotId: plotId }
        }, undefined, 'plots/setActivePlot'),

      setActiveFamily: (family) =>
        set({ activeFamily: family }, undefined, 'plots/setActiveFamily'),

      setActiveStatisticsFamilyId: (familyId) =>
        set(
          (state) => {
            if (!familyId) {
              return { activeStatisticsFamilyId: null, activePlotId: null }
            }
            const currentPlot = state.activePlotId
              ? state.plots.find((p) => p.id === state.activePlotId)
              : undefined
            const currentPlotFamily = currentPlot
              ? resolveStatisticsFamilyId(currentPlot)
              : null
            const keepCurrent = currentPlot && currentPlotFamily === familyId
            const familyPlots = state.plots.filter(
              (p) => resolveStatisticsFamilyId(p) === familyId
            )
            return {
              activeStatisticsFamilyId: familyId,
              activePlotId: keepCurrent ? state.activePlotId : familyPlots[0]?.id ?? null,
            }
          },
          undefined,
          'plots/setActiveStatisticsFamilyId'
        ),

      migrateLegacyPlots: (familyId) =>
        set(
          (state) => {
            let changed = false
            const nextPlots = state.plots.map((plot) => {
              const currentId = (plot as PlotSpec & { statisticsFamilyId?: string })
                .statisticsFamilyId
              if (currentId) return plot
              changed = true
              return { ...plot, statisticsFamilyId: familyId }
            })
            return changed ? { plots: nextPlots } : state
          },
          undefined,
          'plots/migrateLegacyPlots'
        ),

      // Stats for E2E
      setPlotStats: (plotId, stats) =>
        set(
          (state) => ({
            computedStats: {
              ...state.computedStats,
              [plotId]: stats,
            },
          }),
          undefined,
          'plots/setPlotStats'
        ),

      getPlotStats: (plotId) => get().computedStats[plotId],

      // LMM style overrides
      setLmmStyleOverride: (key, override) => {
        // Prune swapStyles when false or undefined — both mean "no swap", absent is canonical
        const pruned: LmmTraceRoleOverride = { ...override }
        if (!pruned.swapStyles) delete pruned.swapStyles

        // If nothing meaningful remains, clear the entry instead of storing a no-op
        const hasContent = Object.values(pruned).some((v) => v !== undefined)
        if (!hasContent) {
          set(
            (state) => {
              const next = { ...state.lmmStyleOverrides }
              delete next[key]
              return { lmmStyleOverrides: next }
            },
            undefined,
            'plots/setLmmStyleOverride'
          )
          return
        }

        set(
          (state) => ({ lmmStyleOverrides: { ...state.lmmStyleOverrides, [key]: pruned } }),
          undefined,
          'plots/setLmmStyleOverride'
        )
      },

      clearLmmStyleOverride: (key) =>
        set(
          (state) => {
            const next = { ...state.lmmStyleOverrides }
            delete next[key]
            return { lmmStyleOverrides: next }
          },
          undefined,
          'plots/clearLmmStyleOverride'
        ),

      // Selectors
      getPlot: (plotId) => get().plots.find((p) => p.id === plotId),

      getPlotsByFamily: (family) => {
        const plots = get().plots
        if (family === 'all') return plots
        return plots.filter((p) => p.testFamily === family)
      },

      getPlotsByResult: (resultId) =>
        get().plots.filter(
          (p) => isTestResultPlot(p) && p.resultId === resultId
        ),

      getActivePlot: () => {
        const { plots, activePlotId, activeStatisticsFamilyId } = get()
        if (!activePlotId) return undefined
        const plot = plots.find((p) => p.id === activePlotId)
        if (!plot) return undefined
        if (
          activeStatisticsFamilyId &&
          resolveStatisticsFamilyId(plot) !== activeStatisticsFamilyId
        ) {
          return undefined
        }
        return plot
      },

      getLmmStyleOverride: (key) => get().lmmStyleOverrides[key],
    }),
    { name: 'PlotsStore' }
  )
)

export default usePlotsStore
