/**
 * useClipboard Hook - Clipboard operations for spreadsheet data
 *
 * Features:
 * - Copy selected cells to clipboard (TSV format for Excel compatibility)
 * - Paste from clipboard with validation
 * - Cut operation (copy + delete)
 * - Transpose paste (rows ↔ columns)
 * - Undo tracking via CellChange records
 *
 * Based on Avalonia's ClipboardManager (easyCris.Avalonia/Services/)
 */

import { useCallback } from 'react'
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager'
import type { Dataset } from '@/store/data-store'

/**
 * Cell change record for undo tracking
 */
export interface CellChange {
  row: number
  col: number
  columnId: string
  oldValue: unknown
  newValue: unknown
}

/**
 * useClipboard Hook
 */
export function useClipboard() {
  /**
   * Copy selected cells to clipboard (TSV format)
   * Excel-compatible tab-separated values
   */
  const copyToClipboard = useCallback(
    async (
      selectedRows: number[],
      selectedColumns: string[],
      dataset: Dataset,
      rowData: Map<number, Record<string, unknown>>
    ): Promise<void> => {
      if (selectedRows.length === 0 || selectedColumns.length === 0) {
        console.warn('No cells selected for copy')
        return
      }

      // Build TSV grid
      const lines: string[] = []

      // Sort rows and columns for consistent output
      const sortedRows = [...selectedRows].sort((a, b) => a - b)
      const sortedColumns = selectedColumns
        .map(colId => dataset.columns.find(c => c.id === colId))
        .filter(Boolean)
        .sort((a, b) => {
          const aIdx = dataset.columns.indexOf(a!)
          const bIdx = dataset.columns.indexOf(b!)
          return aIdx - bIdx
        })

      for (const rowIdx of sortedRows) {
        const row = rowData.get(rowIdx)
        if (!row) continue

        const cells: string[] = []
        for (const col of sortedColumns) {
          const value = row[col!.id]
          // Convert to string, handle null/undefined
          cells.push(value === null || value === undefined ? '' : String(value))
        }

        lines.push(cells.join('\t'))
      }

      const tsvText = lines.join('\n')

      try {
        await writeText(tsvText)
        console.log(`Copied ${sortedRows.length}×${sortedColumns.length} cells to clipboard`)
      } catch (error) {
        console.error('Failed to write to clipboard:', error)
      }
    },
    []
  )

  /**
   * Paste from clipboard into selected cells
   * Returns CellChange[] for undo tracking
   */
  const pasteFromClipboard = useCallback(
    async (
      startRow: number,
      startColumn: string,
      dataset: Dataset,
      rowData: Map<number, Record<string, unknown>>
    ): Promise<CellChange[]> => {
      try {
        const tsvText = await readText()
        if (!tsvText) {
          console.warn('Clipboard is empty')
          return []
        }

        // Parse TSV
        const lines = tsvText.split(/\r?\n/)
        const changes: CellChange[] = []

        // Find start column index
        const startColIndex = dataset.columns.findIndex(c => c.id === startColumn)
        if (startColIndex === -1) {
          console.error('Start column not found')
          return []
        }

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx] ?? ''
          const cells = line.split('\t')
          const targetRowIdx = startRow + lineIdx

          // Stop if we exceed dataset row count
          if (targetRowIdx >= dataset.rowCount) break

          for (let cellIdx = 0; cellIdx < cells.length; cellIdx++) {
            const targetColIdx = startColIndex + cellIdx

            // Stop if we exceed dataset column count
            if (targetColIdx >= dataset.columns.length) break

            const column = dataset.columns[targetColIdx]
            if (!column) continue
            const row = rowData.get(targetRowIdx)
            if (!row) continue

            // CRITICAL: Use ?? instead of || to preserve zeros
            const oldValue = row[column.id] ?? ''
            const newValue = cells[cellIdx]

            // Only track if value actually changed
            if (oldValue !== newValue) {
              changes.push({
                row: targetRowIdx,
                col: targetColIdx,
                columnId: column.id,
                oldValue,
                newValue,
              })
            }
          }
        }

        console.log(`Pasted ${changes.length} cells from clipboard`)
        return changes
      } catch (error) {
        console.error('Failed to read from clipboard:', error)
        return []
      }
    },
    []
  )

  /**
   * Cut operation: copy + delete cells
   * Returns CellChange[] for undo tracking (delete operations)
   */
  const cutToClipboard = useCallback(
    async (
      selectedRows: number[],
      selectedColumns: string[],
      dataset: Dataset,
      rowData: Map<number, Record<string, unknown>>
    ): Promise<CellChange[]> => {
      // First, copy to clipboard
      await copyToClipboard(selectedRows, selectedColumns, dataset, rowData)

      // Then, track delete operations for undo
      const changes: CellChange[] = []
      for (const rowIdx of selectedRows) {
        const row = rowData.get(rowIdx)
        if (!row) continue

        for (const columnId of selectedColumns) {
          // CRITICAL: Use ?? instead of || to preserve zeros
          const oldValue = row[columnId] ?? ''
          changes.push({
            row: rowIdx,
            col: dataset.columns.findIndex(c => c.id === columnId),
            columnId,
            oldValue,
            newValue: '',
          })
        }
      }

      console.log(`Cut ${changes.length} cells to clipboard`)
      return changes
    },
    [copyToClipboard]
  )

  /**
   * Transpose paste: rows ↔ columns
   * Reads clipboard TSV, transposes grid, then pastes
   */
  const transposeFromClipboard = useCallback(
    async (
      startRow: number,
      startColumn: string,
      dataset: Dataset,
      rowData: Map<number, Record<string, unknown>>
    ): Promise<CellChange[]> => {
      try {
        const tsvText = await readText()
        if (!tsvText) {
          console.warn('Clipboard is empty')
          return []
        }

        // Parse TSV
        const lines = tsvText.split(/\r?\n/)
        const grid: string[][] = lines.map(line => line.split('\t'))

        // Transpose: rows become columns, columns become rows
        const transposed: string[][] = []
        const maxCols = Math.max(...grid.map(row => row.length))

        for (let colIdx = 0; colIdx < maxCols; colIdx++) {
          const newRow: string[] = []
          for (let rowIdx = 0; rowIdx < grid.length; rowIdx++) {
            newRow.push(grid[rowIdx]?.[colIdx] ?? '')
          }
          transposed.push(newRow)
        }

        // Build transposed TSV
        const transposedTsv = transposed.map(row => row.join('\t')).join('\n')

        // Temporarily write transposed data to clipboard
        await writeText(transposedTsv)

        // Now paste normally
        const changes = await pasteFromClipboard(startRow, startColumn, dataset, rowData)

        console.log(`Transposed and pasted ${changes.length} cells`)
        return changes
      } catch (error) {
        console.error('Failed to transpose from clipboard:', error)
        return []
      }
    },
    [pasteFromClipboard]
  )

  return {
    copyToClipboard,
    pasteFromClipboard,
    cutToClipboard,
    transposeFromClipboard,
  }
}

export default useClipboard
