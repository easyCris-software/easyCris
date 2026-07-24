import { isPendingCalculation } from '@/utils/formulaSentinel'

export interface BackendPasteBlockPayload {
  rows: number[]
  columnIds: string[]
  values: unknown[][]
}

export interface BuildBackendPasteBlockInput {
  values: unknown[][]
  startViewRow: number
  columnIds: string[]
  largePasteThreshold: number
  maxBackendPasteCells?: number
  viewRowToModelRow: (viewRow: number) => number | undefined
}

export type BuildBackendPasteBlockResult =
  | {
      usesBackendPaste: true
      payload: BackendPasteBlockPayload
    }
  | {
      usesBackendPaste: false
      payload?: undefined
    }

function isFormulaValue(value: unknown): boolean {
  return isPendingCalculation(value) || (typeof value === 'string' && value.trimStart().startsWith('='))
}

export function buildBackendPasteBlock({
  values,
  startViewRow,
  columnIds,
  largePasteThreshold,
  maxBackendPasteCells = 500_000,
  viewRowToModelRow,
}: BuildBackendPasteBlockInput): BuildBackendPasteBlockResult {
  if (values.length === 0 || columnIds.length === 0) {
    return { usesBackendPaste: false }
  }

  const cellCount = values.length * columnIds.length
  if (cellCount < largePasteThreshold || cellCount > maxBackendPasteCells) {
    return { usesBackendPaste: false }
  }

  const rows: number[] = []
  for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
    const rowValues = values[rowOffset]
    if (!rowValues || rowValues.length !== columnIds.length) {
      return { usesBackendPaste: false }
    }
    if (rowValues.some(isFormulaValue)) {
      return { usesBackendPaste: false }
    }

    const modelRow = viewRowToModelRow(startViewRow + rowOffset)
    if (!Number.isFinite(modelRow) || modelRow === undefined || modelRow < 0) {
      return { usesBackendPaste: false }
    }
    rows.push(modelRow)
  }

  return {
    usesBackendPaste: true,
    payload: {
      rows,
      columnIds: [...columnIds],
      values: values.map((row) => [...row]),
    },
  }
}
