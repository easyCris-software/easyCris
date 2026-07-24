/**
 * Export Service - Phase 4 Milestone 6
 *
 * Frontend service for exporting results and data to various formats.
 * Integrates with Rust backend export commands.
 */

import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'

/**
 * Result structure for export (matches Rust TestResultExport)
 */
export interface ExportableResult {
  id: string
  testName: string
  family: string
  statistics?: {
    statistic?: number
    pValue?: number
    degreesOfFreedom?: number
    effectSize?: number
  }
  summary?: Record<string, unknown>
  executedAt: string
}

export interface ExportSheet {
  name: string
  columns: string[]
  rows: Record<string, unknown>[]
}

/**
 * Export payload wrapper
 */
interface ExportPayload {
  results: ExportableResult[]
}

/**
 * Export file format options
 */
export type ExportFormat = 'excel' | 'csv' | 'html' | 'json'

/**
 * Export service for statistical results and data
 */
export const exportService = {
  /**
   * Export results to Excel (.xlsx)
   */
  async exportToExcel(results: ExportableResult[], filePath?: string): Promise<string> {
    const path = filePath ?? await promptForSavePath('xlsx', 'Excel Files')
    if (!path) throw new Error('Export cancelled')

    const payload: ExportPayload = { results }
    await invoke('export_results_excel', {
      results: JSON.stringify(payload),
      filePath: path,
    })

    return path
  },

  /**
   * Export results to CSV (.csv)
   */
  async exportToCsv(results: ExportableResult[], filePath?: string): Promise<string> {
    const path = filePath ?? await promptForSavePath('csv', 'CSV Files')
    if (!path) throw new Error('Export cancelled')

    const payload: ExportPayload = { results }
    await invoke('export_results_csv', {
      results: JSON.stringify(payload),
      filePath: path,
    })

    return path
  },

  /**
   * Export results to HTML (.html)
   */
  async exportToHtml(results: ExportableResult[], filePath?: string): Promise<string> {
    const path = filePath ?? await promptForSavePath('html', 'HTML Files')
    if (!path) throw new Error('Export cancelled')

    const payload: ExportPayload = { results }
    await invoke('export_results_html', {
      results: JSON.stringify(payload),
      filePath: path,
    })

    return path
  },

  /**
   * Export results to JSON (.json)
   */
  async exportToJson(results: ExportableResult[], filePath?: string): Promise<string> {
    const path = filePath ?? await promptForSavePath('json', 'JSON Files')
    if (!path) throw new Error('Export cancelled')

    const payload: ExportPayload = { results }
    await invoke('export_results_json', {
      results: JSON.stringify(payload),
      filePath: path,
    })

    return path
  },

  /**
   * Export dataset data to CSV
   */
  async exportDataToCsv(
    data: Record<string, unknown>[],
    columns: string[],
    filePath?: string
  ): Promise<string> {
    const path = filePath ?? await promptForSavePath('csv', 'CSV Files')
    if (!path) throw new Error('Export cancelled')

    await invoke('export_data_csv', {
      data: JSON.stringify(data),
      columns,
      filePath: path,
    })

    return path
  },

  /**
   * Export dataset data to Excel
   */
  async exportDataToExcel(
    data: Record<string, unknown>[],
    columns: string[],
    filePath?: string,
    sheetName?: string
  ): Promise<string> {
    const path = filePath ?? await promptForSavePath('xlsx', 'Excel Files')
    if (!path) throw new Error('Export cancelled')

    await invoke('export_data_excel', {
      data: JSON.stringify(data),
      columns,
      filePath: path,
      sheetName,
    })

    return path
  },

  /**
   * Export multiple datasets to Excel (one sheet per dataset)
   */
  async exportDataToExcelMulti(
    sheets: ExportSheet[],
    filePath?: string
  ): Promise<string> {
    const path = filePath ?? await promptForSavePath('xlsx', 'Excel Files')
    if (!path) throw new Error('Export cancelled')

    await invoke('export_data_excel_multi', {
      sheets: JSON.stringify({ sheets }),
      filePath: path,
    })

    return path
  },

  /**
   * Export results to specified format
   */
  async exportResults(
    results: ExportableResult[],
    format: ExportFormat,
    filePath?: string
  ): Promise<string> {
    switch (format) {
      case 'excel':
        return this.exportToExcel(results, filePath)
      case 'csv':
        return this.exportToCsv(results, filePath)
      case 'html':
        return this.exportToHtml(results, filePath)
      case 'json':
        return this.exportToJson(results, filePath)
      default:
        throw new Error(`Unsupported export format: ${format}`)
    }
  },
}

/**
 * Prompt user for save file path
 */
async function promptForSavePath(
  extension: string,
  description: string
): Promise<string | null> {
  const result = await save({
    filters: [
      {
        name: description,
        extensions: [extension],
      },
    ],
    defaultPath: `results.${extension}`,
  })

  return result
}

export default exportService
