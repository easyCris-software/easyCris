/**
 * Analysis Store - Zustand store for statistical test management
 *
 * Manages:
 * - Selected statistical test and parameters
 * - Test validation state (5-layer validation system)
 * - Execution progress and status
 * - Analysis history
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

/**
 * Statistical test parameter definition
 */
export interface TestParameter {
  name: string
  type: 'numeric' | 'categorical' | 'boolean' | 'column' | 'columns'
  value: unknown
  required: boolean
  defaultValue?: unknown
  min?: number
  max?: number
  options?: string[] // For categorical parameters
  description?: string
}

/**
 * Validation result from the 5-layer validation system
 */
export interface ValidationResult {
  isValid: boolean
  layer:
    | 'structural'
    | 'type'
    | 'range'
    | 'statistical'
    | 'test-specific'
    | null
  errors: string[]
  warnings: string[]
  timestamp: Date
}

/**
 * Statistical test definition
 */
export interface StatisticalTest {
  id: string
  family:
    | 'parametric'
    | 'nonparametric'
    | 'anova'
    | 'posthoc'
    | 'regression'
    | 'correlation'
    | 'contingency'
    | 'survival'
    | 'pharmacology'
    | 'descriptive'
    | 'mediation'
    | 'moderation'
    | 'enrichment'
    | 'power'
  name: string
  description: string
  parameters: TestParameter[]
  requiredColumns: number
  requiredColumnTypes?: ('numeric' | 'categorical')[]
}

/**
 * Analysis execution status
 */
export interface AnalysisExecution {
  status: 'idle' | 'validating' | 'running' | 'completed' | 'failed'
  progress: number // 0-100
  startedAt?: Date
  completedAt?: Date
  duration?: number // milliseconds
  error?: string
}

/**
 * Analysis history entry
 */
export interface AnalysisHistoryEntry {
  id: string
  testId: string
  testName: string
  parameters: Record<string, unknown>
  executedAt: Date
  duration: number
  success: boolean
  resultId?: string // Reference to results store
}

/**
 * Analysis Store State
 */
type DirtyOptions = {
  suppressDirty?: boolean
}

interface AnalysisState {
  // Selected test
  selectedTest: StatisticalTest | null
  selectedTestId: string | null

  // Test parameters
  parameters: Record<string, unknown> // Key: parameter name, Value: parameter value

  // Validation state
  validation: ValidationResult | null
  isValidating: boolean

  // Execution state
  execution: AnalysisExecution

  // History
  history: AnalysisHistoryEntry[]
  maxHistorySize: number

  // Actions - Test selection
  selectTest: (test: StatisticalTest) => void
  clearTest: () => void

  // Actions - Parameter management
  setParameter: (name: string, value: unknown) => void
  setParameters: (parameters: Record<string, unknown>) => void
  resetParameters: () => void
  getParameter: (name: string) => unknown

  // Actions - Validation
  setValidation: (validation: ValidationResult) => void
  clearValidation: () => void
  setValidating: (validating: boolean) => void

  // Actions - Execution
  setExecutionStatus: (
    status: AnalysisExecution['status'],
    error?: string
  ) => void
  setExecutionProgress: (progress: number) => void
  startExecution: () => void
  completeExecution: (success: boolean, resultId?: string) => void
  resetExecution: () => void

  // Actions - History
  addHistoryEntry: (entry: Omit<AnalysisHistoryEntry, 'id'>) => void
  clearHistory: (options?: DirtyOptions) => void
  getHistoryEntry: (id: string) => AnalysisHistoryEntry | undefined
}

export const useAnalysisStore = create<AnalysisState>()(
  devtools(
    (set, get) => ({
      // Initial state
      selectedTest: null,
      selectedTestId: null,
      parameters: {},
      validation: null,
      isValidating: false,
      execution: {
        status: 'idle',
        progress: 0,
      },
      history: [],
      maxHistorySize: 50,

      // Test selection actions
      selectTest: test => {
        // Populate parameters with default values from test definition
        const defaultParameters: Record<string, unknown> = {}
        for (const param of test.parameters) {
          if (param.defaultValue !== undefined) {
            defaultParameters[param.name] = param.defaultValue
          }
        }

        return set(
          {
            selectedTest: test,
            selectedTestId: test.id,
            parameters: defaultParameters, // Initialize with defaults
            validation: null,
            execution: { status: 'idle', progress: 0 },
          },
          undefined,
          'selectTest'
        )
      },

      clearTest: () =>
        set(
          {
            selectedTest: null,
            selectedTestId: null,
            parameters: {},
            validation: null,
            execution: { status: 'idle', progress: 0 },
          },
          undefined,
          'clearTest'
        ),

      // Parameter management actions
      setParameter: (name, value) =>
        set(
          state => ({
            parameters: { ...state.parameters, [name]: value },
          }),
          undefined,
          'setParameter'
        ),

      setParameters: parameters =>
        set({ parameters }, undefined, 'setParameters'),

      resetParameters: () => set({ parameters: {} }, undefined, 'resetParameters'),

      getParameter: name => get().parameters[name],

      // Validation actions
      setValidation: validation =>
        set({ validation }, undefined, 'setValidation'),

      clearValidation: () => set({ validation: null }, undefined, 'clearValidation'),

      setValidating: validating =>
        set({ isValidating: validating }, undefined, 'setValidating'),

      // Execution actions
      setExecutionStatus: (status, error) =>
        set(
          state => ({
            execution: { ...state.execution, status, error },
          }),
          undefined,
          'setExecutionStatus'
        ),

      setExecutionProgress: progress =>
        set(
          state => ({
            execution: { ...state.execution, progress },
          }),
          undefined,
          'setExecutionProgress'
        ),

      startExecution: () =>
        set(
          {
            execution: {
              status: 'running',
              progress: 0,
              startedAt: new Date(),
            },
          },
          undefined,
          'startExecution'
        ),

      completeExecution: (success, resultId) =>
        set(
          state => {
            const now = new Date()
            const duration = state.execution.startedAt
              ? now.getTime() - state.execution.startedAt.getTime()
              : 0

            // Add to history
            if (state.selectedTest) {
              const historyEntry: AnalysisHistoryEntry = {
                // Temporary ID - consider UUID library if deep-linking to history entries
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                testId: state.selectedTest.id,
                testName: state.selectedTest.name,
                parameters: { ...state.parameters },
                executedAt: now,
                duration,
                success,
                resultId,
              }

              const newHistory = [
                historyEntry,
                ...state.history.slice(0, state.maxHistorySize - 1),
              ]

              return {
                execution: {
                  status: success ? 'completed' : 'failed',
                  progress: 100,
                  startedAt: state.execution.startedAt,
                  completedAt: now,
                  duration,
                },
                history: newHistory,
              }
            }

            return {
              execution: {
                status: success ? 'completed' : 'failed',
                progress: 100,
                startedAt: state.execution.startedAt,
                completedAt: now,
                duration,
              },
            }
          },
          undefined,
          'completeExecution'
        ),

      resetExecution: () =>
        set(
          {
            execution: { status: 'idle', progress: 0 },
          },
          undefined,
          'resetExecution'
        ),

      // History actions
      addHistoryEntry: entry => {
        set(
          state => ({
            history: [
              {
                ...entry,
                // Temporary ID - consider UUID library if deep-linking to history entries
                id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              },
              ...state.history.slice(0, state.maxHistorySize - 1),
            ],
          }),
          undefined,
          'addHistoryEntry'
        )
        import('./app-store').then(({ useAppStore }) => {
          useAppStore.getState().setProjectDirty(true)
        })
      },

      clearHistory: (options) => {
        set({ history: [] }, undefined, 'clearHistory')
        if (!options?.suppressDirty) {
          import('./app-store').then(({ useAppStore }) => {
            useAppStore.getState().setProjectDirty(true)
          })
        }
      },

      getHistoryEntry: id => get().history.find(entry => entry.id === id),
    }),
    {
      name: 'analysis-store',
    }
  )
)
