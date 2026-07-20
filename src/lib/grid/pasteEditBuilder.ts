import type { CellEdit } from './types'

export interface PasteEditBuildColumn {
  id?: string
}

export interface BuildPasteEditsInChunksInput {
  startCol: number
  startViewRow: number
  parsedData: unknown[][]
  columns: PasteEditBuildColumn[]
  viewToModel: (viewRow: number) => number
  getOldValue: (modelRow: number, columnId: string) => unknown
  coerceValue?: (value: unknown, columnId: string, row: number) => unknown
  isWritableColumn?: (columnId: string) => boolean
  effectiveRowCap?: number
  chunkRows?: number
  shouldContinue?: () => boolean
  yieldToMain?: () => Promise<void> | void
  onChunkProgress?: (chunkIndex: number, totalChunks: number) => void
}

export interface BuildPasteEditsInChunksResult {
  edits: CellEdit[]
  aborted: boolean
}

const defaultYieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export async function buildPasteEditsInChunks({
  startCol,
  startViewRow,
  parsedData,
  columns,
  viewToModel,
  getOldValue,
  coerceValue,
  isWritableColumn,
  effectiveRowCap = Number.POSITIVE_INFINITY,
  chunkRows = 5_000,
  shouldContinue = () => true,
  yieldToMain = defaultYieldToMain,
  onChunkProgress,
}: BuildPasteEditsInChunksInput): Promise<BuildPasteEditsInChunksResult> {
  const edits: CellEdit[] = []
  const safeChunkRows = Math.max(1, Math.floor(chunkRows))
  const totalChunks = Math.max(1, Math.ceil(parsedData.length / safeChunkRows))

  for (let chunkStart = 0, chunkIndex = 0; chunkStart < parsedData.length; chunkStart += safeChunkRows, chunkIndex += 1) {
    if (!shouldContinue()) {
      return { edits, aborted: true }
    }
    onChunkProgress?.(chunkIndex, totalChunks)

    const chunkEnd = Math.min(parsedData.length, chunkStart + safeChunkRows)
    for (let rowOffset = chunkStart; rowOffset < chunkEnd; rowOffset += 1) {
      const rowValues = parsedData[rowOffset]
      if (!rowValues) continue

      const viewRow = startViewRow + rowOffset
      if (viewRow >= effectiveRowCap) {
        continue
      }

      const modelRow = viewToModel(viewRow)
      if (!Number.isFinite(modelRow) || modelRow < 0) {
        continue
      }

      for (let colOffset = 0; colOffset < rowValues.length; colOffset += 1) {
        const gridColumn = columns[startCol + colOffset]
        if (!gridColumn?.id) {
          continue
        }
        if (isWritableColumn && !isWritableColumn(gridColumn.id)) {
          continue
        }

        edits.push({
          row: modelRow,
          columnId: gridColumn.id,
          oldValue: getOldValue(modelRow, gridColumn.id),
          newValue: coerceValue
            ? coerceValue(rowValues[colOffset], gridColumn.id, modelRow)
            : rowValues[colOffset],
        })
      }
    }

    if (chunkEnd < parsedData.length) {
      await yieldToMain()
    }
  }

  return { edits, aborted: false }
}
