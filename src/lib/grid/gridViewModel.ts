export type RowId = string

export type OverlayCellStatus = 'pending' | 'persisted' | 'confirmed'

export type OverlayCell = {
  value: unknown
  mutationId: string
  revision: number
  status: OverlayCellStatus
}

type RowIdentity = {
  projectId: string | null
  familyId: string | null
  datasetId: string
  modelRow: number
}

type RowRecord = Record<string, unknown>
type OverlayRow = Record<string, OverlayCell>

export type OverlayAcknowledgement = {
  columnId: string
  mutationId: string
  revision: number
  status: OverlayCellStatus
  value: unknown
}

function normalizeComparableCellValue(value: unknown) {
  return value === undefined || value === null || value === '' ? null : value
}

export function buildRowId(input: RowIdentity): RowId {
  return JSON.stringify([input.projectId, input.familyId, input.datasetId, input.modelRow])
}

export function parseRowId(rowId: RowId): RowIdentity {
  const parsed = JSON.parse(rowId) as [string | null, string | null, string, number]
  return {
    projectId: parsed[0],
    familyId: parsed[1],
    datasetId: parsed[2],
    modelRow: parsed[3],
  }
}

export interface GridViewModel {
  writeBaseRow(rowId: RowId, row: RowRecord): void
  deleteBaseRow(rowId: RowId): void
  writeOverlayPatch(rowId: RowId, patch: OverlayRow): void
  /** @internal Task 3 migration bridge for legacy staged row patches; remove after SpreadsheetView writes structured overlay patches directly. */
  ingestLegacyRowPatch(
    rowId: RowId,
    input: { patch: RowRecord; mutationId: string; revision: number; status: OverlayCellStatus }
  ): void
  acknowledgeOverlay(rowId: RowId, input: OverlayAcknowledgement): void
  clearConfirmedOverlay(rowId: RowId): void
  removeOverlayColumns(rowId: RowId, columnIds: string[]): void
  deleteOverlayRow(rowId: RowId): void
  readCell(rowId: RowId, columnId: string): unknown
  readMergedRow(rowId: RowId): RowRecord | null
  getOverlayRow(rowId: RowId): OverlayRow | null
  readOverlayValues(rowId: RowId): RowRecord | null
  listOverlayRows(): Map<RowId, OverlayRow>
  hasOverlayRows(): boolean
}

// Task 3 acknowledgement wiring is intentionally limited to paste-family mutations:
// - paste / paste-values / paste-transpose: existing paste flush completion and activation readback
// Later tasks must extend runtime acknowledgement for type/fill/cut/delete/undo/redo before broadening this contract.
export function createGridViewModel(): GridViewModel {
  const baseRows = new Map<RowId, RowRecord>()
  const overlayRows = new Map<RowId, OverlayRow>()

  const cloneOverlayRow = (row: OverlayRow): OverlayRow => {
    const next: OverlayRow = {}
    for (const [columnId, cell] of Object.entries(row)) {
      next[columnId] = { ...cell }
    }
    return next
  }

  return {
    writeBaseRow(rowId, row) {
      baseRows.set(rowId, { ...row })
    },
    deleteBaseRow(rowId) {
      baseRows.delete(rowId)
    },
    writeOverlayPatch(rowId, patch) {
      const current = overlayRows.get(rowId)
      const next = current ? cloneOverlayRow(current) : {}
      for (const [columnId, cell] of Object.entries(patch)) {
        next[columnId] = { ...cell }
      }
      overlayRows.set(rowId, next)
    },
    ingestLegacyRowPatch(rowId, input) {
      const patch: OverlayRow = {}
      for (const [columnId, value] of Object.entries(input.patch)) {
        patch[columnId] = {
          value,
          mutationId: input.mutationId,
          revision: input.revision,
          status: input.status,
        }
      }
      this.writeOverlayPatch(rowId, patch)
    },
    acknowledgeOverlay(rowId, input) {
      const current = overlayRows.get(rowId)
      const currentCell = current?.[input.columnId]
      if (!current || !currentCell) return
      if (currentCell.mutationId !== input.mutationId) return
      if (currentCell.revision !== input.revision) return
      if (
        !Object.is(
          normalizeComparableCellValue(currentCell.value),
          normalizeComparableCellValue(input.value)
        )
      ) {
        return
      }

      overlayRows.set(rowId, {
        ...cloneOverlayRow(current),
        [input.columnId]: {
          ...currentCell,
          status: input.status,
        },
      })
    },
    clearConfirmedOverlay(rowId) {
      const current = overlayRows.get(rowId)
      if (!current) return
      const next: OverlayRow = {}
      const baseRow = baseRows.get(rowId) ?? null
      for (const [columnId, cell] of Object.entries(current)) {
        const baseValue = baseRow?.[columnId]
        if (
          cell.status !== 'confirmed' ||
          !Object.is(
            normalizeComparableCellValue(baseValue),
            normalizeComparableCellValue(cell.value)
          )
        ) {
          next[columnId] = cell
        }
      }
      if (Object.keys(next).length === 0) {
        overlayRows.delete(rowId)
      } else {
        overlayRows.set(rowId, next)
      }
    },
    removeOverlayColumns(rowId, columnIds) {
      const current = overlayRows.get(rowId)
      if (!current) return
      const next = cloneOverlayRow(current)
      for (const columnId of columnIds) {
        delete next[columnId]
      }
      if (Object.keys(next).length === 0) {
        overlayRows.delete(rowId)
      } else {
        overlayRows.set(rowId, next)
      }
    },
    deleteOverlayRow(rowId) {
      overlayRows.delete(rowId)
    },
    readCell(rowId, columnId) {
      const overlayCell = overlayRows.get(rowId)?.[columnId]
      if (overlayCell) return overlayCell.value
      return baseRows.get(rowId)?.[columnId] ?? null
    },
    readMergedRow(rowId) {
      const baseRow = baseRows.get(rowId) ?? null
      const overlayRow = overlayRows.get(rowId) ?? null
      if (!baseRow && !overlayRow) return null
      const merged: RowRecord = { ...(baseRow ?? {}) }
      if (overlayRow) {
        for (const [columnId, cell] of Object.entries(overlayRow)) {
          merged[columnId] = cell.value
        }
      }
      return merged
    },
    getOverlayRow(rowId) {
      const row = overlayRows.get(rowId)
      return row ? cloneOverlayRow(row) : null
    },
    readOverlayValues(rowId) {
      const row = overlayRows.get(rowId)
      if (!row) return null
      const values: RowRecord = {}
      for (const [columnId, cell] of Object.entries(row)) {
        values[columnId] = cell.value
      }
      return values
    },
    listOverlayRows() {
      return new Map(
        Array.from(overlayRows.entries(), ([rowId, row]) => [rowId, cloneOverlayRow(row)] as const)
      )
    },
    hasOverlayRows() {
      return overlayRows.size > 0
    },
  }
}
