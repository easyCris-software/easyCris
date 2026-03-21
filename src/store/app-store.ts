/**
 * Application Store - Zustand store for global app state
 *
 * Manages:
 * - Navigator families tree (Statistics, Statistics #2, etc.)
 * - Workspace view mode (DataGrid, Results, Plots)
 * - Active family and dataset binding
 * - Application-level status (Python health, messages)
 * - UI state (command palette, preferences)
 *
 * This is the PRIMARY store for Phase 3B Navigator implementation.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
// Fix #2: Static imports for synchronous cleanup (no circular dependency)
import { useDataStore } from '@/store/data-store'
import { useResultsStore } from '@/store/results-store'
import { usePlotsStore } from '@/store/plots-store'
import cacheService from '@/services/cacheService'

const INVALID_PROJECT_ID_CHARS = /[<>:"/\\|?*\u0000-\u001F]/

export function isValidProjectIdForCache(projectId: string | null | undefined): boolean {
  const trimmed = (projectId ?? '').trim()
  if (!trimmed) return false
  if (trimmed.length > 128) return false
  if (trimmed.includes('..')) return false
  if (INVALID_PROJECT_ID_CHARS.test(trimmed)) return false
  return true
}

/**
 * Statistics family (top-level Navigator node)
 * Mirrors Avalonia's tabbed family structure
 */
export interface StatisticsFamily {
  id: string
  name: string // "Statistics", "Statistics #2", etc.
  datasetId?: string // Reference to loaded dataset (ties to data-store)
  hasData: boolean // True when dataset imported
  hasResults: boolean // True when analysis completes
  createdAt: Date
}

/**
 * Recent projects entry (Navigator tree)
 */
export interface RecentProject {
  id: string
  name: string
  path: string
  lastOpened: Date
}

/**
 * Navigator tree node types
 */
export type NavigatorNodeType =
  | 'family' // Statistics family (top-level)
  | 'data' // Data view within family
  | 'plots' // Plots view within family
  | 'recent' // Recent projects

/**
 * Workspace view mode (right panel content)
 * Phase 4 Fix: Added 'results' for test output display
 */
export type WorkspaceViewMode = 'data' | 'results' | 'plots'

/**
 * Python backend health status
 */
export interface PythonStatus {
  available: boolean
  version: string
  lastChecked: Date
  error?: string
}

export interface AppOperationLock {
  active: boolean
  token: string | null
  owner: string | null
  operation: string | null
  progress: number
  stage: string
  startedAt: string | null
}

export interface PlotSettingsAttention {
  unseenAutoPlot: boolean
  unseenUserPlot: boolean
}

const createEmptyPlotSettingsAttention = (): PlotSettingsAttention => ({
  unseenAutoPlot: false,
  unseenUserPlot: false,
})

const clearPlotSettingsAttentionForFamily = (
  source: Record<string, PlotSettingsAttention>,
  familyId: string
) => {
  const current = source[familyId]
  if (!current || (!current.unseenAutoPlot && !current.unseenUserPlot)) {
    return source
  }
  return {
    ...source,
    [familyId]: createEmptyPlotSettingsAttention(),
  }
}

/**
 * Application Store State
 */
interface AppState {
  // Navigator state
  families: StatisticsFamily[]
  activeFamilyId: string | null
  recentProjects: RecentProject[]
  recentProjectsLoading: boolean // Fix #5: Loading state for recent projects
  maxRecentProjects: number

  // Workspace state
  workspaceViewMode: WorkspaceViewMode
  showNavigator: boolean
  navigatorWidth: number // in pixels
  showConsole: boolean
  showPlotSidebar: boolean
  plotSidebarTab: 'colors' | 'axes' | 'data' | 'brackets' | 'shapes'
  plotSettingsAttentionByFamily: Record<string, PlotSettingsAttention>

  // Application status
  statusMessage: string
  pythonStatus: PythonStatus | null
  appOperationLock: AppOperationLock

  // UI state
  commandPaletteOpen: boolean
  preferencesOpen: boolean

  // Project state (Smart Save)
  projectFilePath: string | null // Path where project was last saved
  projectId: string | null // Stable UUID for cache namespacing (Phase 1)
  projectDirty: boolean // True if there are unsaved changes
  openProjectHandler: (() => Promise<void>) | undefined // Handler registered by AppShell
  saveProjectHandler: (() => Promise<void>) | undefined // Handler registered by AppShell
  saveProjectAsHandler: (() => Promise<void>) | undefined // Handler registered by AppShell

  // Actions - Families
  createFamily: (name?: string) => Promise<StatisticsFamily>
  removeFamily: (familyId: string) => void
  setActiveFamily: (familyId: string) => Promise<void>
  setActiveFamilyDataset: (familyId: string, datasetId: string, hasData?: boolean) => void
  setFamilyResults: (familyId: string, hasResults: boolean) => void
  updateFamilyDataFlag: (familyId: string, hasData: boolean) => void
  updateActiveFamilyData: (datasetId: string) => void
  updateActiveFamilyResults: (hasResults: boolean) => void
  restoreFamilies: (families: StatisticsFamily[], activeFamilyId?: string | null) => void
  getActiveFamily: () => StatisticsFamily | null

  // Actions - Recent Projects
  // Note: Backend is source of truth. Use tauriApi to persist changes.
  setRecentProjects: (projects: RecentProject[]) => void
  setRecentProjectsLoading: (loading: boolean) => void // Fix #5: Loading state
  removeRecentProject: (filePath: string) => void // Updates local state only

  // Actions - Workspace
  setWorkspaceViewMode: (mode: WorkspaceViewMode) => void
  toggleNavigator: () => void
  setShowNavigator: (show: boolean) => void
  setNavigatorWidth: (width: number) => void
  toggleConsole: () => void
  togglePlotSidebar: () => void
  setShowPlotSidebar: (show: boolean) => void
  setPlotSidebarTab: (tab: 'colors' | 'axes' | 'data' | 'brackets' | 'shapes') => void
  markPlotSettingsAttention: (
    familyId: string,
    sourceType: 'test_result' | 'user_derived'
  ) => void
  clearPlotSettingsAttention: (familyId: string) => void

  // Actions - Status
  setStatusMessage: (message: string) => void
  setPythonStatus: (status: PythonStatus) => void
  clearStatusMessage: () => void
  acquireAppOperationLock: (params: {
    owner: string
    operation: string
    stage?: string
    progress?: number
  }) => string | null
  updateAppOperationLock: (
    token: string,
    updates: {
      stage?: string
      progress?: number
      operation?: string
    }
  ) => void
  releaseAppOperationLock: (token: string) => boolean
  clearAppOperationLock: () => void

  // Actions - UI
  toggleCommandPalette: () => void
  setCommandPaletteOpen: (open: boolean) => void
  togglePreferences: () => void
  setPreferencesOpen: (open: boolean) => void

  // Actions - Project (Smart Save)
  setProjectFilePath: (path: string | null) => void
  setProjectId: (id: string | null) => void
  setProjectDirty: (dirty: boolean) => void
  setOpenProjectHandler: (handler: (() => Promise<void>) | undefined) => void
  setSaveProjectHandler: (handler: (() => Promise<void>) | undefined) => void
  setSaveProjectAsHandler: (handler: (() => Promise<void>) | undefined) => void
  openProject: () => Promise<void>
  saveProject: () => Promise<void>
  saveProjectAs: () => Promise<void>

  // Actions - Utilities
  reset: () => void
}

/**
 * Initial state factory
 */
const createInitialState = () => ({
  // Navigator state
  families: [
    {
      id: 'statistics-1',
      name: 'Statistics',
      hasData: false,
      hasResults: false,
      createdAt: new Date(),
    },
  ] as StatisticsFamily[],
  activeFamilyId: 'statistics-1',
  recentProjects: [] as RecentProject[],
  recentProjectsLoading: true, // Fix #5: Start as loading to prevent flash
  maxRecentProjects: 5, // Matches backend MAX_RECENT_PROJECTS

  // Workspace state
  workspaceViewMode: 'data' as WorkspaceViewMode,
  showNavigator: true,
  navigatorWidth: 240, // Default 240px like Avalonia
  showConsole: false,
  showPlotSidebar:
    typeof window !== 'undefined'
      ? !(window.innerWidth < 1280 || window.innerHeight < 800)
      : true,
  plotSidebarTab: 'colors' as const,
  plotSettingsAttentionByFamily: {},

  // Application status
  statusMessage: 'Ready',
  pythonStatus: null,
  appOperationLock: {
    active: false,
    token: null,
    owner: null,
    operation: null,
    progress: 0,
    stage: '',
    startedAt: null,
  } as AppOperationLock,

  // UI state
  commandPaletteOpen: false,
  preferencesOpen: false,

  // Project state (Smart Save)
  projectFilePath: null,
  projectId: null,
  projectDirty: false,
  openProjectHandler: undefined,
  saveProjectHandler: undefined,
  saveProjectAsHandler: undefined,
})

export const useAppStore = create<AppState>()(
  devtools(
    (set, get) => ({
      ...createInitialState(),

      // Families actions
      createFamily: async (name?: string) => {
        const state = get()
        const familyNumber =
          Math.max(
            0,
            ...state.families
              .map(f => {
                const m = /^statistics-(\d+)$/.exec(f.id)
                return m ? Number(m[1]) : 0
              })
              .filter(n => Number.isFinite(n))
          ) + 1
        const newFamily: StatisticsFamily = {
          id: `statistics-${familyNumber}`,
          name: name || (familyNumber === 1 ? 'Statistics' : `Statistics #${familyNumber}`),
          hasData: false,
          hasResults: false,
          createdAt: new Date(),
        }

        set(
          {
            families: [...state.families, newFamily],
            activeFamilyId: newFamily.id, // Auto-activate new family
          },
          undefined,
          'createFamily'
        )

        // CRITICAL: Create a blank dataset for this new family to prevent inheriting old data
        try {
          const dataset = await useDataStore
            .getState()
            .initializeBlankDataset(`${newFamily.name} Data`)
          get().setActiveFamilyDataset(newFamily.id, dataset.id, false)
        } catch (error) {
          console.error('Failed to initialize blank dataset for new family:', error)
        }

        // Mark project dirty after creating family
        get().setProjectDirty(true)

        return newFamily
      },

      removeFamily: (familyId: string) => {
        set(
          state => {
            const removedFamily = state.families.find(f => f.id === familyId)

            // Filter out the removed family
            let newFamilies = state.families.filter(f => f.id !== familyId)

            // Keep family IDs stable (do NOT renumber IDs), but keep display names tidy.
            // First family is "Statistics", rest are "Statistics #N"
            newFamilies = newFamilies.map((family, index) => ({
              ...family,
              name: index === 0 ? 'Statistics' : `Statistics #${index + 1}`,
            }))

            // Fix #2: Synchronous cleanup - update dataset names to match new family names
            const dataStore = useDataStore.getState()
            newFamilies.forEach(family => {
              if (family.datasetId) {
                const dataset = dataStore.datasets.find(d => d.id === family.datasetId)
                if (dataset) {
                  // Update dataset name to match new family name
                  const newDatasetName = `${family.name} Data`
                  dataStore.updateDataset(family.datasetId, { name: newDatasetName })
                }
              }
            })

            // Phase C: Clear all data owned by the removed family
            if (removedFamily) {
              // Clear datasets with this familyId (includes the direct datasetId reference)
              dataStore.clearDatasetsByFamily(removedFamily.id)
              // Also remove the direct dataset reference if it exists and wasn't caught by familyId
              if (removedFamily.datasetId) {
                const stillExists = dataStore.datasets.find(d => d.id === removedFamily.datasetId)
                if (stillExists && (!stillExists.familyId || stillExists.familyId === removedFamily.id)) {
                  dataStore.removeDataset(removedFamily.datasetId)
                }
              }
              // Clear results for the removed family (per-family isolation)
              useResultsStore.getState().clearFamilyResults(removedFamily.id)
              // Clear plots for the removed family
              usePlotsStore.getState().clearStatisticsFamilyPlots(removedFamily.id)
            }

            // Update active family ID (keep stable IDs)
            const removedIndex = state.families.findIndex(f => f.id === familyId)
            let newActiveFamilyId = state.activeFamilyId

            if (state.activeFamilyId === familyId) {
              // If we removed the active family, activate the one at the same position
              // or the last one if we removed the last family
              const newActiveIndex = Math.min(removedIndex, newFamilies.length - 1)
              newActiveFamilyId = newFamilies[newActiveIndex]?.id ?? null
            }

            return {
              families: newFamilies,
              activeFamilyId: newActiveFamilyId,
              plotSettingsAttentionByFamily: removedFamily
                ? Object.fromEntries(
                    Object.entries(state.plotSettingsAttentionByFamily).filter(
                      ([id]) => id !== removedFamily.id
                    )
                  )
                : state.plotSettingsAttentionByFamily,
            }
          },
          undefined,
          'removeFamily'
        )
        // Mark project dirty after removing family
        get().setProjectDirty(true)
      },

      setActiveFamily: async (familyId: string) => {
        set({ activeFamilyId: familyId }, undefined, 'setActiveFamily')
        if (get().workspaceViewMode === 'plots' && get().showPlotSidebar) {
          get().clearPlotSettingsAttention(familyId)
        }

        // Switch to this family's dataset when activating the family
        // Fix #2: Synchronous - use static import (no circular dependency)
        const family = get().families.find(f => f.id === familyId)
        if (!family) {
          return
        }
        if (!family.datasetId) {
          try {
            const dataset = await useDataStore
              .getState()
              .initializeBlankDataset(`${family.name} Data`)
            get().setActiveFamilyDataset(family.id, dataset.id, false)
          } catch (error) {
            console.error('Failed to initialize blank dataset for family:', error)
          }
          return
        }
        const dataset = useDataStore.getState().datasets.find(d => d.id === family.datasetId)
        if (!dataset) {
          useDataStore.getState().setCurrentDataset(null)
          return
        }
        if (dataset.familyId && dataset.familyId !== familyId) {
          console.warn(
            `Family '${familyId}' references dataset '${dataset.id}' owned by '${dataset.familyId}'.`
          )
          useDataStore.getState().setCurrentDataset(null)
          return
        }
        useDataStore.getState().setCurrentDataset(dataset)
      },

      setActiveFamilyDataset: (familyId: string, datasetId: string, hasData: boolean = true) => {
        const dataStore = useDataStore.getState()
        const dataset = dataStore.datasets.find(d => d.id === datasetId)
        if (dataset?.familyId && dataset.familyId !== familyId) {
          console.warn(
            `Refusing to assign dataset '${datasetId}' from family '${dataset.familyId}' to '${familyId}'.`
          )
          return
        }
        set(
          state => ({
            families: state.families.map(f =>
              f.id === familyId ? { ...f, datasetId, hasData } : f
            ),
          }),
          undefined,
          'setActiveFamilyDataset'
        )
        // Phase C: Set familyId on the dataset for ownership tracking
        dataStore.setDatasetFamily(datasetId, familyId)
      },

      setFamilyResults: (familyId: string, hasResults: boolean) =>
        set(
          state => ({
            families: state.families.map(f =>
              f.id === familyId ? { ...f, hasResults } : f
            ),
          }),
          undefined,
          'setFamilyResults'
        ),

      updateFamilyDataFlag: (familyId: string, hasData: boolean) =>
        set(
          state => ({
            families: state.families.map(f =>
              f.id === familyId
                ? {
                    ...f,
                    hasData,
                    datasetId: hasData ? f.datasetId : undefined,
                  }
                : f
            ),
          }),
          undefined,
          'updateFamilyDataFlag'
        ),

      updateActiveFamilyData: (datasetId: string) => {
        const state = get()
        if (state.activeFamilyId) {
          const dataStore = useDataStore.getState()
          const dataset = dataStore.datasets.find(d => d.id === datasetId)
          if (dataset?.familyId && dataset.familyId !== state.activeFamilyId) {
            console.warn(
              `Refusing to assign dataset '${datasetId}' from family '${dataset.familyId}' to '${state.activeFamilyId}'.`
            )
            return
          }
          set(
            {
              families: state.families.map(f =>
                f.id === state.activeFamilyId
                  ? { ...f, datasetId, hasData: true }
                  : f
              ),
            },
            undefined,
            'updateActiveFamilyData'
          )
          // Phase C: Set familyId on the dataset for ownership tracking
          dataStore.setDatasetFamily(datasetId, state.activeFamilyId)
        }
      },

      updateActiveFamilyResults: (hasResults: boolean) => {
        const state = get()
        if (state.activeFamilyId) {
          set(
            {
              families: state.families.map(f =>
                f.id === state.activeFamilyId ? { ...f, hasResults } : f
              ),
            },
            undefined,
            'updateActiveFamilyResults'
          )
        }
      },

      restoreFamilies: (families: StatisticsFamily[], activeFamilyId?: string | null) => {
        const nextFamilies = families.length > 0 ? families : createInitialState().families
        const desiredActive =
          (activeFamilyId && nextFamilies.some(f => f.id === activeFamilyId)
            ? activeFamilyId
            : nextFamilies[0]?.id) ?? null

        set(
          {
            families: nextFamilies,
            activeFamilyId: desiredActive,
            plotSettingsAttentionByFamily: {},
          },
          undefined,
          'restoreFamilies'
        )

        // Phase C Migration: Populate familyId on datasets from family->datasetId mapping
        // This handles projects saved before Phase C that don't have familyId on datasets
        const dataStore = useDataStore.getState()
        nextFamilies.forEach(family => {
          if (family.datasetId) {
            const dataset = dataStore.datasets.find(d => d.id === family.datasetId)
            if (dataset && !dataset.familyId) {
              dataStore.setDatasetFamily(family.datasetId, family.id)
            }
          }
        })
      },

      getActiveFamily: () => {
        const state = get()
        return (
          state.families.find(f => f.id === state.activeFamilyId) || null
        )
      },

      // Recent Projects actions
      // Note: Backend is source of truth. These actions update local state only.
      // Use tauriApi.addRecentProject/removeRecentProject to persist changes.
      setRecentProjects: projects =>
        set(
          {
            recentProjects: projects.slice(0, get().maxRecentProjects),
            recentProjectsLoading: false, // Fix #5: Clear loading when data arrives
          },
          undefined,
          'setRecentProjects'
        ),

      setRecentProjectsLoading: (loading: boolean) =>
        set({ recentProjectsLoading: loading }, undefined, 'setRecentProjectsLoading'),

      removeRecentProject: (filePath: string) =>
        set(
          state => ({
            // Filter by path (id === path in our mapping from backend)
            recentProjects: state.recentProjects.filter(p => p.path !== filePath),
          }),
          undefined,
          'removeRecentProject'
        ),

      // Workspace actions
      setWorkspaceViewMode: (mode: WorkspaceViewMode) =>
        set({ workspaceViewMode: mode }, undefined, 'setWorkspaceViewMode'),

      toggleNavigator: () =>
        set(
          state => ({ showNavigator: !state.showNavigator }),
          undefined,
          'toggleNavigator'
        ),

      setShowNavigator: (show: boolean) =>
        set({ showNavigator: show }, undefined, 'setShowNavigator'),

      setNavigatorWidth: (width: number) =>
        set({ navigatorWidth: width }, undefined, 'setNavigatorWidth'),

      toggleConsole: () =>
        set(
          state => ({ showConsole: !state.showConsole }),
          undefined,
          'toggleConsole'
        ),

      togglePlotSidebar: () =>
        set(
          state => {
            const nextShowPlotSidebar = !state.showPlotSidebar
            if (!nextShowPlotSidebar || !state.activeFamilyId) {
              return { showPlotSidebar: nextShowPlotSidebar }
            }
            return {
              showPlotSidebar: true,
              plotSettingsAttentionByFamily: clearPlotSettingsAttentionForFamily(
                state.plotSettingsAttentionByFamily,
                state.activeFamilyId
              ),
            }
          },
          undefined,
          'togglePlotSidebar'
        ),

      setShowPlotSidebar: (show: boolean) =>
        set(
          state => {
            if (!show || !state.activeFamilyId) {
              return { showPlotSidebar: show }
            }
            return {
              showPlotSidebar: true,
              plotSettingsAttentionByFamily: clearPlotSettingsAttentionForFamily(
                state.plotSettingsAttentionByFamily,
                state.activeFamilyId
              ),
            }
          },
          undefined,
          'setShowPlotSidebar'
        ),

      setPlotSidebarTab: (tab: 'colors' | 'axes' | 'data' | 'brackets' | 'shapes') =>
        set({ plotSidebarTab: tab }, undefined, 'setPlotSidebarTab'),

      markPlotSettingsAttention: (familyId, sourceType) =>
        set(
          state => {
            const familyExists = state.families.some((family) => family.id === familyId)
            if (!familyExists) {
              return state
            }
            if (state.showPlotSidebar && state.activeFamilyId === familyId) {
              return state
            }
            const existing =
              state.plotSettingsAttentionByFamily[familyId] ??
              createEmptyPlotSettingsAttention()
            const nextAttention: PlotSettingsAttention = {
              unseenAutoPlot:
                sourceType === 'test_result' ? true : existing.unseenAutoPlot,
              unseenUserPlot:
                sourceType === 'user_derived' ? true : existing.unseenUserPlot,
            }
            if (
              nextAttention.unseenAutoPlot === existing.unseenAutoPlot &&
              nextAttention.unseenUserPlot === existing.unseenUserPlot
            ) {
              return state
            }
            return {
              plotSettingsAttentionByFamily: {
                ...state.plotSettingsAttentionByFamily,
                [familyId]: nextAttention,
              },
            }
          },
          undefined,
          'markPlotSettingsAttention'
        ),

      clearPlotSettingsAttention: (familyId) =>
        set(
          state => ({
            plotSettingsAttentionByFamily: clearPlotSettingsAttentionForFamily(
              state.plotSettingsAttentionByFamily,
              familyId
            ),
          }),
          undefined,
          'clearPlotSettingsAttention'
        ),

      // Status actions
      setStatusMessage: (message: string) =>
        set({ statusMessage: message }, undefined, 'setStatusMessage'),

      setPythonStatus: (status: PythonStatus) =>
        set({ pythonStatus: status }, undefined, 'setPythonStatus'),

      clearStatusMessage: () =>
        set({ statusMessage: 'Ready' }, undefined, 'clearStatusMessage'),

      acquireAppOperationLock: ({ owner, operation, stage, progress }) => {
        const state = get()
        if (state.appOperationLock.active) {
          return null
        }

        const token = crypto.randomUUID()
        set(
          {
            appOperationLock: {
              active: true,
              token,
              owner,
              operation,
              progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress ?? 0)) : 0,
              stage: stage ?? '',
              startedAt: new Date().toISOString(),
            },
          },
          undefined,
          'acquireAppOperationLock'
        )
        return token
      },

      updateAppOperationLock: (token: string, updates) => {
        set(
          (state) => {
            if (!state.appOperationLock.active || state.appOperationLock.token !== token) {
              return state
            }

            const nextProgress =
              updates.progress === undefined
                ? state.appOperationLock.progress
                : Math.max(0, Math.min(100, updates.progress))

            return {
              appOperationLock: {
                ...state.appOperationLock,
                progress: nextProgress,
                stage: updates.stage ?? state.appOperationLock.stage,
                operation: updates.operation ?? state.appOperationLock.operation,
              },
            }
          },
          undefined,
          'updateAppOperationLock'
        )
      },

      releaseAppOperationLock: (token: string) => {
        const state = get()
        if (!state.appOperationLock.active || state.appOperationLock.token !== token) {
          return false
        }
        set(
          {
            appOperationLock: {
              active: false,
              token: null,
              owner: null,
              operation: null,
              progress: 0,
              stage: '',
              startedAt: null,
            },
          },
          undefined,
          'releaseAppOperationLock'
        )
        return true
      },

      clearAppOperationLock: () =>
        set(
          {
            appOperationLock: {
              active: false,
              token: null,
              owner: null,
              operation: null,
              progress: 0,
              stage: '',
              startedAt: null,
            },
          },
          undefined,
          'clearAppOperationLock'
        ),

      // UI actions
      toggleCommandPalette: () =>
        set(
          state => ({ commandPaletteOpen: !state.commandPaletteOpen }),
          undefined,
          'toggleCommandPalette'
        ),

      setCommandPaletteOpen: (open: boolean) =>
        set({ commandPaletteOpen: open }, undefined, 'setCommandPaletteOpen'),

      togglePreferences: () =>
        set(
          state => ({ preferencesOpen: !state.preferencesOpen }),
          undefined,
          'togglePreferences'
        ),

      setPreferencesOpen: (open: boolean) =>
        set({ preferencesOpen: open }, undefined, 'setPreferencesOpen'),

      // Project actions (Smart Save)
      setProjectFilePath: (path: string | null) =>
        set({ projectFilePath: path }, undefined, 'setProjectFilePath'),

      setProjectId: (id: string | null) =>
        set({ projectId: id }, undefined, 'setProjectId'),

      setProjectDirty: (dirty: boolean) =>
        set({ projectDirty: dirty }, undefined, 'setProjectDirty'),

      setOpenProjectHandler: (handler: (() => Promise<void>) | undefined) =>
        set({ openProjectHandler: handler }, undefined, 'setOpenProjectHandler'),

      setSaveProjectHandler: (handler: (() => Promise<void>) | undefined) =>
        set({ saveProjectHandler: handler }, undefined, 'setSaveProjectHandler'),

      setSaveProjectAsHandler: (handler: (() => Promise<void>) | undefined) =>
        set({ saveProjectAsHandler: handler }, undefined, 'setSaveProjectAsHandler'),

      openProject: async () => {
        const handler = get().openProjectHandler
        if (handler) {
          await handler()
        }
      },

      saveProject: async () => {
        const handler = get().saveProjectHandler
        if (handler) {
          await handler()
        }
      },

      saveProjectAs: async () => {
        const handler = get().saveProjectAsHandler
        if (handler) {
          await handler()
        }
      },

      // Utilities
      reset: () => set(createInitialState(), undefined, 'reset'),
    }),
    {
      name: 'app-store',
    }
  )
)

export default useAppStore

let projectIdInitPromise: Promise<string> | null = null
let lastActiveProjectId: string | null = null

export async function ensureProjectId(): Promise<string> {
  if (projectIdInitPromise) {
    return projectIdInitPromise
  }

  const state = useAppStore.getState()
  if (state.projectId && state.projectId === lastActiveProjectId && isValidProjectIdForCache(state.projectId)) {
    return state.projectId
  }

  projectIdInitPromise = (async () => {
    const currentState = useAppStore.getState()
    let projectId: string | null = currentState.projectId
    if (!isValidProjectIdForCache(projectId)) {
      projectId = crypto.randomUUID()
      currentState.setProjectId(projectId)
    }
    if (!projectId) {
      projectId = crypto.randomUUID()
      currentState.setProjectId(projectId)
    }
    await cacheService.setActiveProjectId(projectId)
    lastActiveProjectId = projectId
    return projectId
  })()

  try {
    return await projectIdInitPromise
  } finally {
    projectIdInitPromise = null
  }
}
