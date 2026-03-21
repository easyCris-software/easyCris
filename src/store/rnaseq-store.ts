/**
 * RNA-seq Store - Zustand store for RNA-seq module state
 *
 * Manages:
 * - RNA-seq projects (Navigator tree items)
 * - PyDESeq2 model configurations
 * - Analysis results (DEG tables, PCA data)
 * - UI state (active project, tab, plot type)
 * - Project persistence (serialize/restore)
 *
 * This store is ISOLATED from the Statistics module to prevent
 * cross-contamination of state.
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type {
  RNAseqProject,
  RNAseqTab,
  DESeqModel,
  DESeqResult,
  DESeqResultRun,
  RNAseqPlotType,
  SerializedRNAseqState,
  SerializedRNAseqProject,
  ResultReference,
} from '@/types/rnaseq'

/**
 * RNA-seq Store State
 */
type DirtyOptions = {
  suppressDirty?: boolean
}

interface RNAseqState {
  // Projects
  projects: RNAseqProject[]
  activeProjectId: string | null

  // UI state
  isAnalysisRunning: boolean
  analysisProgress: number
  analysisStage: string

  // Actions - Projects
  createProject: (name: string) => RNAseqProject
  deleteProject: (projectId: string) => void
  renameProject: (projectId: string, newName: string) => void
  setActiveProject: (projectId: string | null) => void
  getActiveProject: () => RNAseqProject | null
  getProject: (projectId: string) => RNAseqProject | undefined

  // Actions - Dataset Linking
  setCountsDataset: (projectId: string, datasetId: string | null) => void
  setMetadataDataset: (projectId: string, datasetId: string | null) => void

  // Actions - Model Management
  addModel: (projectId: string, model: DESeqModel) => void
  updateModel: (projectId: string, modelId: string, updates: Partial<DESeqModel>) => void
  deleteModel: (projectId: string, modelId: string) => void
  getModel: (projectId: string, modelId: string) => DESeqModel | undefined

  // Actions - Results
  setResult: (projectId: string, modelId: string, result: DESeqResult) => void
  addResultRun: (
    projectId: string,
    result: DESeqResultRun,
    options?: DirtyOptions
  ) => void
  getResult: (projectId: string, resultId: string) => DESeqResultRun | undefined
  getResultsForModel: (projectId: string, modelId: string) => DESeqResultRun[]
  getResultsForProject: (projectId: string) => DESeqResultRun[]
  clearResult: (projectId: string, resultId: string) => void
  updateResult: (projectId: string, resultId: string, updates: Partial<DESeqResultRun>) => void

  // Actions - View State
  setActiveTab: (projectId: string, tab: RNAseqTab) => void
  setActiveModel: (projectId: string, modelId: string | null) => void
  setActiveResult: (projectId: string, resultId: string | null) => void
  setActivePlot: (projectId: string, plotType: RNAseqPlotType | null) => void

  // Actions - Analysis State
  setAnalysisRunning: (running: boolean) => void
  setAnalysisProgress: (progress: number, stage?: string) => void

  // Actions - Persistence
  serializeForProject: () => SerializedRNAseqState
  restoreFromProject: (state: SerializedRNAseqState) => void
  clearAllProjects: (options?: DirtyOptions) => void

  // Actions - Utilities
  reset: () => void
}

/**
 * Generate unique ID for projects and models
 */
const generateId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
const NORMALIZED_COUNTS_MAX_CELLS = 2_000_000

const getNormalizedCountsCellCount = (counts?: number[][]): number => {
  if (!counts || counts.length === 0) return 0
  const cols = counts[0]?.length ?? 0
  return counts.length * cols
}

const maybeTrimNormalizedCounts = <T extends { normalizedCounts?: number[][]; warnings?: string[] }>(result: T): T => {
  const cellCount = getNormalizedCountsCellCount(result.normalizedCounts)
  if (cellCount <= NORMALIZED_COUNTS_MAX_CELLS || cellCount === 0) return result

  const warning = `Normalized counts matrix (${cellCount.toLocaleString()} cells) is too large to store; heatmap disabled for this run.`
  const warnings = result.warnings ? [...result.warnings] : []
  if (!warnings.includes(warning)) {
    warnings.push(warning)
  }

  return {
    ...result,
    normalizedCounts: undefined,
    warnings,
  }
}

/**
 * Initial state factory
 */
const createInitialState = () => ({
  projects: [] as RNAseqProject[],
  activeProjectId: null as string | null,
  isAnalysisRunning: false,
  analysisProgress: 0,
  analysisStage: '',
})

export const useRNAseqStore = create<RNAseqState>()(
  devtools(
    (set, get) => ({
      ...createInitialState(),

      // =================================================================
      // Project Actions
      // =================================================================

      createProject: (name: string) => {
        const newProject: RNAseqProject = {
          id: generateId('rnaseq'),
          name,
          createdAt: new Date(),
          modifiedAt: new Date(),
          countsDatasetId: null,
          metadataDatasetId: null,
          models: [],
          results: [],
          activeTab: 'counts',
          activeModelId: null,
          activeResultId: null,
          activePlotType: null,
        }

        set((state) => ({
          projects: [...state.projects, newProject],
          activeProjectId: newProject.id,
        }))

        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })

        return newProject
      },

      deleteProject: (projectId: string) => {
        set((state) => {
          const projects = state.projects.filter((p) => p.id !== projectId)
          let activeProjectId: string | null = state.activeProjectId

          if (state.activeProjectId === projectId) {
            const firstProject = projects[0]
            activeProjectId = firstProject ? firstProject.id : null
          }

          return { projects, activeProjectId }
        })
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      renameProject: (projectId: string, newName: string) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, name: newName, modifiedAt: new Date() } : p
          ),
        }))
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      setActiveProject: (projectId: string | null) => {
        set({ activeProjectId: projectId })
      },

      getActiveProject: () => {
        const state = get()
        return state.projects.find((p) => p.id === state.activeProjectId) ?? null
      },

      getProject: (projectId: string) => {
        return get().projects.find((p) => p.id === projectId)
      },

      // =================================================================
      // Dataset Linking Actions
      // =================================================================

      setCountsDataset: (projectId: string, datasetId: string | null) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, countsDatasetId: datasetId, modifiedAt: new Date() } : p
          ),
        }))
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      setMetadataDataset: (projectId: string, datasetId: string | null) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, metadataDatasetId: datasetId, modifiedAt: new Date() } : p
          ),
        }))
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      // =================================================================
      // Model Management Actions
      // =================================================================

      addModel: (projectId: string, model: DESeqModel) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  models: [...p.models, model],
                  activeModelId: model.id,
                  modifiedAt: new Date(),
                }
              : p
          ),
        }))
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      updateModel: (projectId: string, modelId: string, updates: Partial<DESeqModel>) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  models: p.models.map((m) => (m.id === modelId ? { ...m, ...updates } : m)),
                  modifiedAt: new Date(),
                }
              : p
          ),
        }))
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      deleteModel: (projectId: string, modelId: string) => {
        set((state) => ({
          projects: state.projects.map((p) => {
            if (p.id !== projectId) return p
            const newResults = p.results.filter((result) => result.modelId !== modelId)

            return {
              ...p,
              models: p.models.filter((m) => m.id !== modelId),
              results: newResults,
              activeModelId: p.activeModelId === modelId ? null : p.activeModelId,
              activeResultId:
                p.activeResultId && newResults.some((r) => r.id === p.activeResultId)
                  ? p.activeResultId
                  : newResults[0]?.id ?? null,
              modifiedAt: new Date(),
            }
          }),
        }))
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      getModel: (projectId: string, modelId: string) => {
        const project = get().projects.find((p) => p.id === projectId)
        return project?.models.find((m) => m.id === modelId)
      },

      // =================================================================
      // Results Actions
      // =================================================================

      setResult: (projectId: string, modelId: string, result: DESeqResult) => {
        const sanitizedResult = maybeTrimNormalizedCounts(result)
        set((state) => ({
          projects: state.projects.map((p) => {
            if (p.id !== projectId) return p

            // Soft limit: warn if too many runs accumulate (performance/file size concern)
            const MAX_RUNS_WARNING = 50
            if (p.results.length >= MAX_RUNS_WARNING) {
              console.warn(
                `[RNAseq] Project "${p.name}" has ${p.results.length} result runs. ` +
                `Consider clearing old runs to improve performance and reduce project file size.`
              )
            }

            const modelName =
              p.models.find((m) => m.id === modelId)?.name ?? 'RNA-seq Model'
            const executedAt = sanitizedResult.executedAt ?? new Date()
            const label = `${modelName} - ${executedAt.toLocaleString()}`
            const run: DESeqResultRun = {
              ...sanitizedResult,
              id: generateId('rnaseq_result'),
              label,
              modelId,
              executedAt,
            }

            // Results are stored newest-first (prepend), so UI tabs show recent runs first
            // This ordering matches user expectations (most recent work is most relevant)
            return {
              ...p,
              results: [run, ...p.results],
              activeResultId: run.id,
              modifiedAt: new Date(),
            }
          }),
        }))
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      addResultRun: (projectId: string, result: DESeqResultRun, options) => {
        const sanitizedResult = maybeTrimNormalizedCounts(result)
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  results: [sanitizedResult, ...p.results],
                  activeResultId: p.activeResultId ?? sanitizedResult.id,
                  modifiedAt: new Date(),
                }
              : p
          ),
        }))
        if (!options?.suppressDirty) {
          import('./app-store').then(({ useAppStore }) => {
            useAppStore.getState().setProjectDirty(true)
          })
        }
      },

      getResult: (projectId: string, resultId: string) => {
        const project = get().projects.find((p) => p.id === projectId)
        return project?.results.find((result) => result.id === resultId)
      },

      getResultsForModel: (projectId: string, modelId: string) => {
        const project = get().projects.find((p) => p.id === projectId)
        if (!project) return []
        return project.results.filter((result) => result.modelId === modelId)
      },

      getResultsForProject: (projectId: string) => {
        const project = get().projects.find((p) => p.id === projectId)
        return project?.results ?? []
      },

      clearResult: (projectId: string, resultId: string) => {
        set((state) => ({
          projects: state.projects.map((p) => {
            if (p.id !== projectId) return p
            const newResults = p.results.filter((result) => result.id !== resultId)
            const nextActiveResultId =
              p.activeResultId === resultId ? newResults[0]?.id ?? null : p.activeResultId
            const nextActiveModelId =
              p.activeResultId === resultId
                ? newResults.find((result) => result.id === nextActiveResultId)?.modelId ?? null
                : p.activeModelId

            return {
              ...p,
              results: newResults,
              activeResultId: nextActiveResultId,
              activeModelId: nextActiveModelId,
              modifiedAt: new Date(),
            }
          }),
        }))
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      updateResult: (projectId: string, resultId: string, updates: Partial<DESeqResultRun>) => {
        set((state) => ({
          projects: state.projects.map((p) => {
            if (p.id !== projectId) return p
            let updated = false
            const results = p.results.map((result) => {
              if (result.id !== resultId) return result
              updated = true
              return { ...result, ...updates }
            })
            return updated ? { ...p, results, modifiedAt: new Date() } : p
          }),
        }))
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      // =================================================================
      // View State Actions
      // =================================================================

      setActiveTab: (projectId: string, tab: RNAseqTab) => {
        set((state) => ({
          projects: state.projects.map((p) => (p.id === projectId ? { ...p, activeTab: tab } : p)),
        }))
      },

      setActiveModel: (projectId: string, modelId: string | null) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, activeModelId: modelId } : p
          ),
        }))
      },

      setActiveResult: (projectId: string, resultId: string | null) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, activeResultId: resultId } : p
          ),
        }))
      },

      setActivePlot: (projectId: string, plotType: RNAseqPlotType | null) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, activePlotType: plotType } : p
          ),
        }))
      },

      // =================================================================
      // Analysis State Actions
      // =================================================================

      setAnalysisRunning: (running: boolean) => {
        set({
          isAnalysisRunning: running,
          analysisProgress: running ? 0 : get().analysisProgress,
          analysisStage: running ? 'Starting...' : '',
        })
      },

      setAnalysisProgress: (progress: number, stage?: string) => {
        set((state) => ({
          analysisProgress: progress,
          analysisStage: stage ?? state.analysisStage,
        }))
      },

      // =================================================================
      // Persistence Actions
      // =================================================================

      serializeForProject: () => {
        const state = get()

        const serializedProjects: SerializedRNAseqProject[] = state.projects.map((p) => {
          // Build results references (actual results stored separately)
          const resultsRef: ResultReference[] = p.results.map((result) => ({
            resultId: result.id,
            modelId: result.modelId,
            label: result.label,
            executedAt: result.executedAt.toISOString(),
            storageKey: `result_${result.id}.json.gz`,
            summary: result.summary,
          }))

          return {
            id: p.id,
            name: p.name,
            createdAt: p.createdAt.toISOString(),
            modifiedAt: p.modifiedAt.toISOString(),
            countsDatasetId: p.countsDatasetId,
            metadataDatasetId: p.metadataDatasetId,
            models: p.models,
            resultsRef,
            activeTab: p.activeTab,
            activeModelId: p.activeModelId,
            activeResultId: p.activeResultId,
            activePlotType: p.activePlotType,
          }
        })

        return {
          schemaVersion: 'rnaseq_v1',
          exportedAt: new Date().toISOString(),
          projects: serializedProjects,
          activeProjectId: state.activeProjectId,
        }
      },

      restoreFromProject: (serializedState: SerializedRNAseqState) => {
        // Validate schema version
        if (serializedState.schemaVersion !== 'rnaseq_v1') {
          console.warn(
            `Unknown RNA-seq schema: ${serializedState.schemaVersion}, attempting restore anyway`
          )
        }

        const projects: RNAseqProject[] = serializedState.projects.map((sp) => ({
          id: sp.id,
          name: sp.name,
          createdAt: new Date(sp.createdAt),
          modifiedAt: new Date(sp.modifiedAt),
          countsDatasetId: sp.countsDatasetId,
          metadataDatasetId: sp.metadataDatasetId,
          models: sp.models,
          results: [], // Results restored separately via setResult/addResultRun
          activeTab: sp.activeTab,
          activeModelId: sp.activeModelId,
          activeResultId: sp.activeResultId ?? null,
          activePlotType: sp.activePlotType,
        }))

        set({
          projects,
          activeProjectId: serializedState.activeProjectId,
          isAnalysisRunning: false,
          analysisProgress: 0,
          analysisStage: '',
        })
      },

      clearAllProjects: (options) => {
        set({
          projects: [],
          activeProjectId: null,
        })
        if (!options?.suppressDirty) {
          import('./app-store').then(({ useAppStore }) => {
            useAppStore.getState().setProjectDirty(true)
          })
        }
      },

      // =================================================================
      // Utility Actions
      // =================================================================

      reset: () => {
        set(createInitialState())
      },
    }),
    {
      name: 'rnaseq-store',
      enabled: process.env.NODE_ENV === 'development',
    }
  )
)

// =============================================================================
// Selector Hooks
// =============================================================================

/**
 * Get the active RNA-seq project
 */
export const useActiveRNAseqProject = () => {
  return useRNAseqStore((state) => {
    if (!state.activeProjectId) return null
    return state.projects.find((p) => p.id === state.activeProjectId) ?? null
  })
}

/**
 * Get all RNA-seq projects for Navigator
 */
export const useRNAseqProjects = () => {
  return useRNAseqStore((state) => state.projects)
}

/**
 * Check if any RNA-seq analysis is running
 */
export const useRNAseqAnalysisStatus = () => {
  const isRunning = useRNAseqStore((state) => state.isAnalysisRunning)
  const progress = useRNAseqStore((state) => state.analysisProgress)
  const stage = useRNAseqStore((state) => state.analysisStage)

  return { isRunning, progress, stage }
}

/**
 * Get results for a specific model
 */
export const useRNAseqResult = (projectId: string | null, resultId: string | null) => {
  return useRNAseqStore((state) => {
    if (!projectId || !resultId) return null
    const project = state.projects.find((p) => p.id === projectId)
    return project?.results.find((result) => result.id === resultId) ?? null
  })
}
