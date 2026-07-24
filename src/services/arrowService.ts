/**
 * Apache Arrow Service
 *
 * Handles efficient data transfer between Rust backend and TypeScript frontend
 * using Apache Arrow columnar format. Optimized for large datasets (>100K rows).
 *
 * Features:
 * - Deserialize Arrow IPC (Interprocess Communication) format from Rust
 * - Convert Arrow Table to JavaScript arrays for Glide Data Grid
 * - Batch processing for large datasets
 * - Type inference and metadata extraction
 *
 * NOTE: This service assumes Arrow data comes from Rust as Uint8Array (IPC format).
 * Apache Arrow library (apache-arrow) is installed and integrated.
 */

import { invoke } from '@tauri-apps/api/core'
import type { ColumnMetadata } from '@/store/data-store'

/**
 * Cache for Apache Arrow module (avoid repeated dynamic imports)
 */
let arrowModule: typeof import('apache-arrow') | null = null

/**
 * Result from Arrow write operation (from Rust backend)
 */
export interface ArrowWriteResult {
  path: string
  rowCount: number
  columnCount: number
}

/**
 * Arrow column data structure
 */
export interface ArrowColumn {
  name: string
  type: 'numeric' | 'categorical' | 'text' | 'datetime'
  data: unknown[]
  nullCount: number
}

/**
 * Arrow table metadata
 */
export interface ArrowTableMetadata {
  numRows: number
  numColumns: number
  columns: ColumnMetadata[]
  memorySize: number // Bytes
}

/**
 * Batch configuration for processing large datasets
 */
export interface BatchConfig {
  batchSize: number // Rows per batch
  maxBatchesInMemory: number // Cache limit
}

/**
 * Apache Arrow Service
 *
 * Provides Apache Arrow integration for efficient columnar data transfer.
 * The apache-arrow library is installed and fully integrated.
 */
export const arrowService = {
  /**
   * Deserialize Arrow IPC data from Rust backend
   *
   * @param arrowData - Uint8Array in Apache Arrow IPC format
   * @returns Column data and metadata
   */
  async deserializeArrowData(arrowData: Uint8Array): Promise<{
    columns: ArrowColumn[]
    metadata: ArrowTableMetadata
  }> {
    try {
      // Import apache-arrow (cached after first import)
      if (!arrowModule) {
        arrowModule = await import('apache-arrow')
      }
      const table = arrowModule.tableFromIPC(arrowData)

      const columns: ArrowColumn[] = []

      for (let i = 0; i < table.numCols; i++) {
        const field = table.schema.fields[i]
        const vector = table.getChildAt(i)

        if (!field || !vector) continue

        columns.push({
          name: field.name,
          type: this.inferTypeFromArrowType(field.type.toString()),
          data: vector.toArray(),
          nullCount: vector.nullCount,
        })
      }

      const metadata: ArrowTableMetadata = {
        numRows: table.numRows,
        numColumns: table.numCols,
        columns: columns.map(col => ({
          id: col.name,
          name: col.name,
          type: col.type,
        })),
        memorySize: arrowData.byteLength,
      }

      return { columns, metadata }
    } catch (error) {
      throw new Error(`Arrow deserialization failed: ${error}`)
    }
  },

  /**
   * Convert Arrow data to row-major format for Glide Data Grid
   *
   * @param columns - Arrow column data
   * @param startRow - Start index (for pagination)
   * @param endRow - End index (for pagination)
   * @returns Array of row objects
   */
  convertToRowFormat(
    columns: ArrowColumn[],
    startRow = 0,
    endRow?: number
  ): Record<string, unknown>[] {
    if (columns.length === 0) return []

    const numRows = columns[0]?.data.length ?? 0
    const actualEndRow = endRow ?? numRows
    const rows: Record<string, unknown>[] = []

    for (let i = startRow; i < Math.min(actualEndRow, numRows); i++) {
      const row: Record<string, unknown> = {}
      for (const column of columns) {
        row[column.name] = column.data[i]
      }
      rows.push(row)
    }

    return rows
  },

  /**
   * Extract column for specific range (for virtualization)
   *
   * @param column - Arrow column
   * @param startRow - Start index
   * @param endRow - End index
   * @returns Sliced column data
   */
  getColumnSlice(
    column: ArrowColumn,
    startRow: number,
    endRow: number
  ): unknown[] {
    return column.data.slice(startRow, endRow)
  },

  /**
   * Batch process large Arrow table
   *
   * @param arrowData - Arrow IPC data
   * @param config - Batch configuration
   * @param onBatch - Callback for each batch
   */
  async processBatches(
    arrowData: Uint8Array,
    config: BatchConfig,
    onBatch: (batch: {
      rows: Record<string, unknown>[]
      batchIndex: number
      totalBatches: number
    }) => Promise<void>
  ): Promise<void> {
    const { columns, metadata } = await this.deserializeArrowData(arrowData)
    const totalBatches = Math.ceil(metadata.numRows / config.batchSize)

    for (let i = 0; i < totalBatches; i++) {
      const startRow = i * config.batchSize
      const endRow = Math.min((i + 1) * config.batchSize, metadata.numRows)

      const rows = this.convertToRowFormat(columns, startRow, endRow)

      await onBatch({
        rows,
        batchIndex: i,
        totalBatches,
      })
    }
  },

  /**
   * Infer TypeScript type from Arrow type
   * Helper for type conversion
   */
  inferTypeFromArrowType(arrowType: string): ColumnMetadata['type'] {
    // Arrow type mappings
    const typeMap: Record<string, ColumnMetadata['type']> = {
      'int8': 'numeric',
      'int16': 'numeric',
      'int32': 'numeric',
      'int64': 'numeric',
      'uint8': 'numeric',
      'uint16': 'numeric',
      'uint32': 'numeric',
      'uint64': 'numeric',
      'float': 'numeric',
      'double': 'numeric',
      'decimal': 'numeric',
      'utf8': 'text',
      'string': 'text',
      'date': 'datetime',
      'timestamp': 'datetime',
      'time': 'datetime',
      'bool': 'categorical',
      'dictionary': 'categorical',
    }

    const lowerType = arrowType.toLowerCase()
    return typeMap[lowerType] || 'text'
  },

  /**
   * Calculate statistics from Arrow column
   *
   * @param column - Arrow column
   * @returns Column statistics
   */
  calculateColumnStatistics(column: ArrowColumn): {
    min?: number
    max?: number
    mean?: number
    median?: number
    stdDev?: number
    missing: number
    unique: number
  } {
    const nonNullData = column.data.filter(v => v !== null && v !== undefined)
    const missing = column.data.length - nonNullData.length
    const unique = new Set(nonNullData).size

    // Numeric statistics only for numeric columns
    if (column.type === 'numeric') {
      const numericData = nonNullData.filter(
        v => typeof v === 'number'
      ) as number[]

      if (numericData.length === 0) {
        return { missing, unique }
      }

      const sorted = [...numericData].sort((a, b) => a - b)
      const min = sorted[0] ?? 0
      const max = sorted[sorted.length - 1] ?? 0
      const sum = numericData.reduce((acc, val) => acc + val, 0)
      const mean = sum / numericData.length

      // Median
      const mid = Math.floor(sorted.length / 2)
      const median =
        sorted.length % 2 === 0
          ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
          : sorted[mid] ?? 0

      // Standard deviation
      const variance =
        numericData.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) /
        numericData.length
      const stdDev = Math.sqrt(variance)

      return { min, max, mean, median, stdDev, missing, unique }
    }

    return { missing, unique }
  },

  /**
   * Create cache key for Arrow data batch
   */
  createCacheKey(datasetId: string, startRow: number, endRow: number): string {
    return `arrow:${datasetId}:${startRow}-${endRow}`
  },

  /**
   * Check if Arrow library is available
   */
  async isArrowAvailable(): Promise<boolean> {
    try {
      if (!arrowModule) {
        arrowModule = await import('apache-arrow')
      }
      return true
    } catch {
      return false
    }
  },

  // ==================== Tauri Backend Integration ====================

  /**
   * Write dataset to Arrow IPC file via Rust backend
   *
   * @param datasetId - Unique identifier for the dataset
   * @param columns - Column names
   * @param rows - Row data as nested arrays of optional numbers
   * @returns Arrow file path and metadata
   */
  async writeToFile(
    datasetId: string,
    columns: string[],
    rows: (number | null)[][]
  ): Promise<ArrowWriteResult> {
    const result = await invoke<{
      path: string
      row_count: number
      column_count: number
    }>('write_arrow_dataset', {
      datasetId,
      columns,
      rows,
    })

    return {
      path: result.path,
      rowCount: result.row_count,
      columnCount: result.column_count,
    }
  },

  /**
   * Read Arrow IPC file from Rust backend
   *
   * @param arrowPath - Path to the Arrow IPC file
   * @returns Raw bytes of the Arrow file
   */
  async readFromFile(arrowPath: string): Promise<Uint8Array> {
    const bytes = await invoke<number[]>('read_arrow_file', { arrowPath })
    return new Uint8Array(bytes)
  },

  /**
   * Delete temporary Arrow file
   *
   * @param datasetId - Dataset ID used when writing the file
   */
  async deleteFile(datasetId: string): Promise<void> {
    await invoke('delete_arrow_file', { datasetId })
  },

  /**
   * Get Arrow file metadata from Rust backend
   *
   * @param arrowPath - Path to the Arrow IPC file
   * @returns Column names and row count
   */
  async getFileMetadata(arrowPath: string): Promise<{
    columns: string[]
    rowCount: number
  }> {
    const [columns, rowCount] = await invoke<[string[], number]>('get_arrow_metadata', {
      arrowPath,
    })
    return { columns, rowCount }
  },

  /**
   * Convert row-major data from spreadsheet to Arrow-compatible format
   *
   * @param rows - Row-major data from cache
   * @param columnIds - Column IDs to extract
   * @returns Array of rows with numeric values (null for non-numeric)
   */
  prepareNumericData(
    rows: Record<string, unknown>[],
    columnIds: string[]
  ): (number | null)[][] {
    return rows.map(row => {
      return columnIds.map(colId => {
        const val = row[colId]
        if (val === null || val === undefined || val === '') return null
        const num = typeof val === 'number' ? val : parseFloat(String(val))
        return isNaN(num) ? null : num
      })
    })
  },
}

export default arrowService
