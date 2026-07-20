/**
 * Tauri API Service
 *
 * Centralized service for all Tauri backend command invocations.
 * Provides type-safe wrappers around Tauri commands with error handling.
 *
 * Commands organized by domain:
 * - Data Import: CSV, TSV, Excel
 * - Statistical Tests: Parametric, Nonparametric, ANOVA, etc.
 * - Python Backend: Execute Python scripts, validate data
 * - File System: Project save/load, export results
 */

import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { ColumnMetadata } from '@/store/data-store'
import type { PlotSpec } from '@/store/plots-store'
import type { SerializedRNAseqState, SerializedRNAseqResults } from '@/types/rnaseq'

/**
 * Structured error from Tauri backend
 */
export interface TauriError {
  message: string
  code?: string
  details?: unknown
}

/**
 * Helper to create structured error from backend error
 */
function createTauriError(error: unknown, context: string): TauriError {
  const stringifyUnknown = (value: unknown): string => {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.message
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  const extractMessage = (value: unknown): string | undefined => {
    if (typeof value === 'string') return value
    if (value instanceof Error) return value.message
    if (typeof value !== 'object' || value === null) return undefined

    const err = value as Record<string, unknown>
    if (typeof err.message === 'string') return err.message

    for (const key of ['error', 'details', 'cause', 'data']) {
      const nested = err[key]
      if (typeof nested === 'string') return nested
      if (nested instanceof Error) return nested.message
      if (typeof nested === 'object' && nested !== null) {
        const nestedMessage = (nested as Record<string, unknown>).message
        if (typeof nestedMessage === 'string') return nestedMessage
      }
    }

    return undefined
  }

  const errorMsg = extractMessage(error) ?? stringifyUnknown(error)
  const finalMessage = errorMsg.includes('Failed to') ? errorMsg : `${context}: ${errorMsg}`

  if (typeof error === 'object' && error !== null) {
    const err = error as { code?: string }
    return {
      message: finalMessage,
      code: err.code,
      details: error,
    }
  }

  return { message: finalMessage }
}

/**
 * Dataset as received from Tauri backend (wire format)
 * Dates are RFC3339 strings and need conversion to Date objects
 */
export interface TauriDataset {
  id: string
  name: string
  rowCount: number
  columnCount: number
  columns: ColumnMetadata[]
  source?: string // Extra field from Rust backend
  filePath?: string
  importedAt: string // RFC3339 string from Rust
  modifiedAt: string // RFC3339 string from Rust
}

/**
 * Data import result from Tauri backend
 */
export interface DataImportResult {
  dataset: TauriDataset // FIX: Use wire format type (strings, not Dates)
  rows: Record<string, unknown>[]  // FIX: Row data from backend (Phase 3C)
  arrowData?: Uint8Array // Apache Arrow serialized data for large datasets (Phase 4)
  isLargeDataset?: boolean
  sourcePath?: string
}

/**
 * Project column metadata structure for .ecp serialization
 * Mirrors `ProjectColumnMeta` in `src-tauri/src/modules/commands/project_commands.rs`.
 */
export interface ProjectColumnMeta {
  id: string
  name: string
  type: string
  width?: number
}

/**
 * Project dataset structure for .ecp serialization
 * Mirrors `ProjectDataset` in `src-tauri/src/modules/commands/project_commands.rs`.
 */
export interface ProjectDataset {
  id: string
  name: string
  rowCount: number
  dataRowCount?: number // Actual data rows (excludes buffer rows)
  columnCount: number
  columns: ProjectColumnMeta[]
  filePath?: string
  duckdbPath?: string // DuckDB file path (for large datasets >= 1M rows)
  /** Owning family ID (Phase C - family isolation) */
  familyId?: string
  /** Cell highlights keyed by "row:columnId" */
  highlights?: Record<string, string>
  importedAt: string
  modifiedAt: string
}

/**
 * Project test result structure for .ecp serialization
 * Mirrors `TestResult` in `src-tauri/src/modules/commands/project_commands.rs`.
 */
export interface ProjectTestResult {
  id: string
  testId: string
  testName: string
  family: string
  /** Statistics family ID for per-family result isolation */
  statisticsFamilyId?: string
  executedAt: string
  parameters: unknown
  statistics: unknown
  assumptions?: unknown
  tables?: unknown[]
  summary?: unknown
  rawResult?: unknown
}

export interface ProjectFamily {
  id: string
  name: string
  datasetId?: string
  hasData: boolean
  hasResults: boolean
  createdAt: string
}

/**
 * Project file structure (.ecp format)
 */
export interface ProjectFile {
  version: string
  name: string
  projectId: string // Stable project identifier (UUID) for cache namespacing
  /** True when projectId was missing in file and generated during load */
  projectIdGenerated?: boolean
  datasets: ProjectDataset[]
  analysisHistory: unknown[]
  savedResults: ProjectTestResult[]
  families?: ProjectFamily[]
  activeFamilyId?: string
  metadata: {
    createdAt: string
    modifiedAt: string
    author?: string
  }
  // All-DuckDB: dataCache removed - all datasets stored in .ecpdb files
  /** Formula persistence (Phase 7 - Formula Engine) */
  formulas?: Record<string, Record<string, string>> // datasetId -> cellKey -> formula string
  /** Plot persistence (OLE Copy/Paste - Phase 1) */
  plots?: PlotSpec[]
  activePlotId?: string | null
  activeStatisticsFamilyId?: string | null
  rnaseqState?: SerializedRNAseqState
  rnaseqResults?: SerializedRNAseqResults
}

export interface SampleDataset {
  id: string
  name: string
  description: string
  file: string
  group: string
  path: string
  rows?: number
  columns?: number
}

/**
 * Tauri API Service
 */
export const tauriApi = {
  // ==================== DATA IMPORT ====================

  /**
   * Import CSV file
   */
  async importCsv(filePath: string): Promise<DataImportResult> {
    try {
      return await invoke<DataImportResult>('import_csv', { filePath })
    } catch (error) {
      throw createTauriError(error, 'Failed to import CSV')
    }
  },

  /**
   * List bundled sample datasets.
   */
  async getSampleDatasets(): Promise<SampleDataset[]> {
    try {
      return await invoke<SampleDataset[]>('get_sample_datasets')
    } catch (error) {
      throw createTauriError(error, 'Failed to load sample datasets')
    }
  },

  /**
   * Read a preview of a bundled dataset (first N lines).
   */
  async readSampleDatasetPreview(file: string, maxLines = 6): Promise<string> {
    try {
      return await invoke<string>('read_sample_dataset_preview', {
        file,
        maxLines,
      })
    } catch (error) {
      throw createTauriError(error, 'Failed to load dataset preview')
    }
  },

  /**
   * Resolve bundled sample dataset file to an absolute path.
   */
  async resolveSampleDatasetPath(file: string): Promise<string> {
    try {
      return await invoke<string>('resolve_sample_dataset_path', { file })
    } catch (error) {
      throw createTauriError(error, 'Failed to resolve sample dataset path')
    }
  },

  /**
   * Import TSV file
   */
  async importTsv(filePath: string): Promise<DataImportResult> {
    try {
      return await invoke<DataImportResult>('import_tsv', { filePath })
    } catch (error) {
      throw createTauriError(error, 'Failed to import TSV')
    }
  },

  /**
   * Import Excel file (.xlsx, .xls)
   */
  async importExcel(
    filePath: string,
    sheetName?: string
  ): Promise<DataImportResult> {
    try {
      console.log('[tauriApi] Importing Excel file:', filePath, 'sheet:', sheetName)
      const result = await invoke<DataImportResult>('import_excel', {
        filePath,
        sheetName,
      })
      console.log('[tauriApi] Excel import successful:', result.dataset.name)
      return result
    } catch (error) {
      console.error('[tauriApi] Excel import error:', error)
      throw createTauriError(error, 'Failed to import Excel')
    }
  },

  /**
   * Import Parquet file
   *
   * Parquet is optimal for large datasets (50M+ rows):
   * - Columnar format (DuckDB reads with near-zero overhead)
   * - Compressed (10-50x smaller than CSV)
   * - Schema embedded (no type inference needed)
   */
  async importParquet(filePath: string): Promise<DataImportResult> {
    try {
      console.log('[tauriApi] Importing Parquet file:', filePath)
      const result = await invoke<DataImportResult>('import_parquet', { filePath })
      console.log('[tauriApi] Parquet import successful:', result.dataset.name, 'rows:', result.dataset.rowCount)
      return result
    } catch (error) {
      console.error('[tauriApi] Parquet import error:', error)
      throw createTauriError(error, 'Failed to import Parquet')
    }
  },

  /**
   * Update dataset metadata (column names, types, etc.)
   * Called when user renames columns in the grid
   */
  async updateDatasetMetadata(
    datasetId: string,
    columns: ColumnMetadata[]
  ): Promise<void> {
    try {
      await invoke('update_dataset_metadata', {
        datasetId,
        columns
      })
    } catch (error) {
      throw createTauriError(error, 'Failed to update dataset metadata')
    }
  },

  // ==================== STREAMING ROW PROVIDER ====================

  /**
   * Fetch row range from backend cache (streaming row provider)
   * Returns rows [startRow, endRow) - end is exclusive
   *
   * @param datasetId - Dataset identifier
   * @param startRow - Start row index (inclusive, 0-based)
   * @param endRow - End row index (exclusive)
   * @returns Array of row objects for the requested range
   */
  async getRows(
    datasetId: string,
    startRow: number,
    endRow: number
  ): Promise<Record<string, unknown>[]> {
    try {
      return await invoke<Record<string, unknown>[]>('get_rows', {
        datasetId,
        startRow,
        endRow,
      })
    } catch (error) {
      throw createTauriError(error, 'Failed to fetch rows')
    }
  },

  /**
   * Get available tests for a specific family
   */
  async getAvailableTests(
    family: string
  ): Promise<
    Array<{ id: string; name: string; description: string; family: string }>
  > {
    try {
      return await invoke('get_available_tests', { family })
    } catch (error) {
      throw createTauriError(error, 'Failed to get available tests')
    }
  },

  // ==================== PROJECT MANAGEMENT ====================

  /**
   * Save project to .ecp file
   */
  async saveProject(
    filePath: string,
    project: ProjectFile
  ): Promise<void> {
    try {
      await invoke('save_project', { filePath, project })
    } catch (error) {
      throw createTauriError(error, 'Failed to save project')
    }
  },

  /**
   * Load project from .ecp file
   */
  async loadProject(filePath: string): Promise<ProjectFile> {
    try {
      return await invoke<ProjectFile>('load_project', { filePath })
    } catch (error) {
      throw createTauriError(error, 'Failed to load project')
    }
  },

  /**
   * Get recent projects list
   */
  async getRecentProjects(): Promise<
    Array<{ path: string; name: string; modifiedAt: string }>
  > {
    try {
      return await invoke('get_recent_projects')
    } catch (error) {
      throw createTauriError(error, 'Failed to get recent projects')
    }
  },

  /**
   * Add a project to recent projects list (called after successful load)
   */
  async addRecentProject(filePath: string, name: string): Promise<void> {
    try {
      await invoke('add_recent_project', { filePath, name })
    } catch (error) {
      throw createTauriError(error, 'Failed to add recent project')
    }
  },

  /**
   * Remove a project from recent projects list
   */
  async removeRecentProject(filePath: string): Promise<void> {
    try {
      await invoke('remove_recent_project', { filePath })
    } catch (error) {
      throw createTauriError(error, 'Failed to remove recent project')
    }
  },

  /**
   * Check if a project file exists (for pre-click validation)
   */
  async checkProjectFileExists(filePath: string): Promise<boolean> {
    try {
      return await invoke('check_project_file_exists', { filePath })
    } catch (error) {
      throw createTauriError(error, 'Failed to check project file')
    }
  },
  /**
   * Export results table to CSV
   */
  async exportResultsCsv(
    resultId: string,
    filePath: string
  ): Promise<void> {
    try {
      await invoke('export_results_csv', { resultId, filePath })
    } catch (error) {
      throw createTauriError(error, 'Failed to export results CSV')
    }
  },

  /**
   * Export results to HTML report
   */
  async exportResultsHtml(
    resultId: string,
    filePath: string,
    includePlots: boolean
  ): Promise<void> {
    try {
      await invoke('export_results_html', {
        resultId,
        filePath,
        includePlots,
      })
    } catch (error) {
      throw createTauriError(error, 'Failed to export HTML report')
    }
  },

  // ==================== PYTHON BACKEND ====================

  /**
   * Prewarm statistics backend to reduce first-run latency.
   * Best-effort operation; caller should handle failures silently.
   */
  async prewarmStatisticsBackend(families?: string[]): Promise<{
    success: boolean
    results?: Record<string, unknown>
  }> {
    try {
      return await invoke('prewarm_statistics_backend', { families: families ?? [] })
    } catch (error) {
      throw createTauriError(error, 'Statistics backend prewarm failed')
    }
  },

  /**
   * Execute custom Python script
   * @param script - Python code to execute
   * @param context - Variables to inject into Python scope
   */
  async executePythonScript(
    script: string,
    context?: Record<string, unknown>
  ): Promise<{ output: string; error?: string }> {
    if (!import.meta.env.DEV) {
      throw new Error('Custom Python script execution is only available in development builds')
    }

    try {
      return await invoke('execute_python_script', { script, context })
    } catch (error) {
      throw createTauriError(error, 'Python script execution failed')
    }
  },

  // ==================== FILE DIALOGS ====================

  /**
   * Open file dialog for data import
   */
  async openFileDialog(
    filters?: Array<{ name: string; extensions: string[] }>
  ): Promise<string | null> {
    try {
      const result = await open({ multiple: false, filters })
      if (Array.isArray(result)) {
        return result[0] ?? null
      }
      return result ?? null
    } catch (error) {
      throw createTauriError(error, 'File dialog failed')
    }
  },

  /**
   * Save file dialog
   */
  async saveFileDialog(
    defaultPath?: string,
    filters?: Array<{ name: string; extensions: string[] }>
  ): Promise<string | null> {
    try {
      const result = await save({
        defaultPath,
        filters,
      })
      return result ?? null
    } catch (error) {
      throw createTauriError(error, 'Save dialog failed')
    }
  },
}

export default tauriApi

