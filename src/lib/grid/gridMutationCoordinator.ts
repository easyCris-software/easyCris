import type {
  ApplyGridMutationInput,
  CellEdit,
  GridBlockState,
  GridMutationCoordinator,
  GridMutationCoordinatorDeps,
  GridMutationLifecycleStage,
  GridMutationKind,
  GridMutationResult,
  GridTransactionRecord,
} from './types'
import { computeRequiredDataRowsForPaste, planInsertedRowsForPaste } from './pastePreflight'

type GridBlockLoadOutcome = 'loaded' | 'retry' | 'evict'

function isRowWithinSegments(
  row: number,
  segments: Array<{ start: number; count: number }> | undefined
): boolean {
  if (!segments || segments.length === 0) return false
  return segments.some((segment) => row >= segment.start && row < segment.start + segment.count)
}

interface PlanPasteTransactionInput {
  id: string
  datasetId: string
  kind: Extract<GridMutationKind, 'paste' | 'paste-values' | 'paste-transpose'>
  startCol: number
  startViewRow: number
  parsedData: unknown[][]
  availableDataRows: number
  columns: Array<{ id?: string }>
  viewToModel: (viewRow: number) => number
  getOldValue: (modelRow: number, columnId: string) => unknown
  coerceValue?: (value: unknown, columnId: string, row: number) => unknown
  isWritableColumn?: (columnId: string) => boolean
  copyContext?: GridTransactionRecord['clipboardContext']
  mutationRevision?: number
}

interface PlanCutTransactionInput {
  id: string
  datasetId: string
  selectedColumnIds: string[]
  selectedViewRows: number[]
  rowCount: number
  viewToModel: (viewRow: number) => number
  getOldValue: (modelRow: number, columnId: string) => unknown
  mutationRevision?: number
}

interface PreviousMutationTrigger {
  datasetId: string
  kind: GridMutationKind
  triggerAtMs: number
}

interface DedupeGridMutationArgs {
  datasetId: string
  kind: GridMutationKind
  triggerAtMs: number
  previous: PreviousMutationTrigger | null
  dedupeWindowMs?: number
}

interface FinalizeGridMutationArgs {
  transactionDatasetId: string
  activeDatasetId: string | null | undefined
  transactionRevision?: number | null
  currentRevision?: number | null
}

interface ApplyMutationReadbackArgs {
  datasetId: string
  activeDatasetId: string | null | undefined
  startedRevision: number
  currentRevision: number
}

function reverseCellEdits(
  edits: CellEdit[] | undefined,
  options?: { skipRowsWithin?: Array<{ start: number; count: number }> }
): CellEdit[] | undefined {
  if (!edits || edits.length === 0) return undefined
  const reversed = edits
    .filter((edit) => !isRowWithinSegments(edit.row, options?.skipRowsWithin))
    .map((edit) => ({
      ...edit,
      oldValue: edit.newValue,
      newValue: edit.oldValue,
      computedValue: undefined,
    }))
  return reversed.length > 0 ? reversed : undefined
}

function reverseStructuralMutation(
  structural: GridTransactionRecord['structural']
): GridTransactionRecord['structural'] | undefined {
  if (!structural) return undefined
  const removedRows = structural.insertedRows?.map((segment) => ({ ...segment }))
  const insertedRows = structural.removedRows?.map((segment) => ({ ...segment }))
  if ((!removedRows || removedRows.length === 0) && (!insertedRows || insertedRows.length === 0)) {
    return undefined
  }
  return { insertedRows, removedRows }
}

function reverseColumnRenames(
  columnRenames: GridTransactionRecord['columnRenames']
): GridTransactionRecord['columnRenames'] | undefined {
  if (!columnRenames || columnRenames.length === 0) return undefined
  return columnRenames.map((rename) => ({
    columnId: rename.columnId,
    oldName: rename.newName,
    newName: rename.oldName,
  }))
}

function cloneBackendPasteBlock(
  block: GridTransactionRecord['backendPasteBlock']
): GridTransactionRecord['backendPasteBlock'] {
  if (!block) return undefined
  return {
    kind: block.kind,
    rows: [...block.rows],
    columnIds: [...block.columnIds],
    values: block.values.map((rowValues) => [...rowValues]),
    undoValues: block.undoValues?.map((rowValues) => [...rowValues]),
  }
}

function createBackendClearRangeBlock(
  block: GridTransactionRecord['backendPasteBlock']
): GridTransactionRecord['backendPasteBlock'] {
  if (!block) return undefined
  return {
    kind: block.kind,
    rows: [...block.rows],
    columnIds: [...block.columnIds],
    values: block.rows.map(() => block.columnIds.map(() => '')),
  }
}

function createBackendUndoBlock(
  block: GridTransactionRecord['backendPasteBlock']
): GridTransactionRecord['backendPasteBlock'] {
  if (!block) return undefined
  if (!block.undoValues) {
    return createBackendClearRangeBlock(block)
  }
  return {
    kind: block.kind,
    rows: [...block.rows],
    columnIds: [...block.columnIds],
    values: block.undoValues.map((rowValues) => [...rowValues]),
    undoValues: block.undoValues.map((rowValues) => [...rowValues]),
  }
}

export function createUndoGridTransaction(
  transaction: GridTransactionRecord
): GridTransactionRecord {
  const removedRows = transaction.structural?.insertedRows?.map((segment) => ({ ...segment }))
  if (transaction.backendPasteBlock) {
    return {
      ...transaction,
      kind: 'undo',
      edits: undefined,
      largePasteUndoPolicy: transaction.backendPasteBlock.undoValues
        ? undefined
        : transaction.largePasteUndoPolicy,
      backendPasteBlock: createBackendUndoBlock(transaction.backendPasteBlock),
      columnRenames: reverseColumnRenames(transaction.columnRenames),
      structural: reverseStructuralMutation(transaction.structural),
    }
  }
  return {
    ...transaction,
    kind: 'undo',
    edits: reverseCellEdits(transaction.edits, { skipRowsWithin: removedRows }),
    columnRenames: reverseColumnRenames(transaction.columnRenames),
    structural: reverseStructuralMutation(transaction.structural),
  }
}

export function createRedoGridTransaction(
  transaction: GridTransactionRecord
): GridTransactionRecord {
  return {
    ...transaction,
    kind: 'redo',
    edits: transaction.edits?.map((edit) => ({ ...edit, computedValue: undefined })),
    backendPasteBlock: cloneBackendPasteBlock(transaction.backendPasteBlock),
    columnRenames: transaction.columnRenames?.map((rename) => ({ ...rename })),
    structural: transaction.structural
      ? {
          insertedRows: transaction.structural.insertedRows?.map((segment) => ({ ...segment })),
          removedRows: transaction.structural.removedRows?.map((segment) => ({ ...segment })),
        }
      : undefined,
  }
}

export function planPasteTransaction(input: PlanPasteTransactionInput): GridTransactionRecord {
  const requiredDataRows = computeRequiredDataRowsForPaste(
    input.startViewRow,
    input.parsedData.length,
    input.viewToModel
  )
  const structural = {
    insertedRows: planInsertedRowsForPaste(input.availableDataRows, requiredDataRows),
  }

  const edits: CellEdit[] = []
  input.parsedData.forEach((rowValues, rowOffset) => {
    const viewRow = input.startViewRow + rowOffset
    const modelRow = input.viewToModel(viewRow)
    if (!Number.isFinite(modelRow) || modelRow < 0) {
      return
    }

    rowValues.forEach((value, colOffset) => {
      const gridColumn = input.columns[input.startCol + colOffset]
      if (!gridColumn?.id) {
        return
      }
      if (input.isWritableColumn && !input.isWritableColumn(gridColumn.id)) {
        return
      }
      edits.push({
        row: modelRow,
        columnId: gridColumn.id,
        oldValue: input.getOldValue(modelRow, gridColumn.id),
        newValue: input.coerceValue
          ? input.coerceValue(value, gridColumn.id, modelRow)
          : value,
      })
    })
  })

  return {
    id: input.id,
    datasetId: input.datasetId,
    kind: input.kind,
    edits,
    structural: structural.insertedRows ? structural : undefined,
    clipboardContext: input.copyContext,
    mutationRevision: input.mutationRevision,
  }
}

export function planCutTransaction(input: PlanCutTransactionInput): GridTransactionRecord {
  const edits: CellEdit[] = []

  for (const viewRow of input.selectedViewRows) {
    if (viewRow < 0 || viewRow >= input.rowCount) {
      continue
    }
    const modelRow = input.viewToModel(viewRow)
    if (!Number.isFinite(modelRow) || modelRow < 0) {
      continue
    }

    input.selectedColumnIds.forEach((columnId) => {
      edits.push({
        row: modelRow,
        columnId,
        oldValue: input.getOldValue(modelRow, columnId),
        newValue: '',
      })
    })
  }

  return {
    id: input.id,
    datasetId: input.datasetId,
    kind: 'cut',
    edits,
    mutationRevision: input.mutationRevision,
  }
}

export function shouldDedupeGridMutation({
  datasetId,
  kind,
  triggerAtMs,
  previous,
  dedupeWindowMs = 150,
}: DedupeGridMutationArgs): boolean {
  if (!previous) return false
  if (previous.datasetId !== datasetId || previous.kind !== kind) return false
  return triggerAtMs - previous.triggerAtMs <= dedupeWindowMs
}

export function canFinalizeGridMutation({
  transactionDatasetId,
  activeDatasetId,
  transactionRevision,
  currentRevision,
}: FinalizeGridMutationArgs): boolean {
  if (!activeDatasetId || activeDatasetId !== transactionDatasetId) {
    return false
  }
  if (transactionRevision == null || currentRevision == null) {
    return true
  }
  return transactionRevision === currentRevision
}

export function shouldApplyMutationReadback({
  datasetId,
  activeDatasetId,
  startedRevision,
  currentRevision,
}: ApplyMutationReadbackArgs): boolean {
  if (!activeDatasetId || activeDatasetId !== datasetId) {
    return false
  }
  return startedRevision === currentRevision
}

export function shouldQueueGridBlockLoad(state: GridBlockState | undefined): boolean {
  return state === undefined || state === 'dirty'
}

export function resolveGridBlockLoadState(
  currentState: GridBlockState | undefined,
  outcome: GridBlockLoadOutcome
): GridBlockState | undefined {
  if (outcome === 'loaded') {
    if (currentState === 'dirty') {
      return 'dirty'
    }
    return 'loaded'
  }
  if (outcome === 'retry') {
    return currentState === 'loaded' ? 'loaded' : 'dirty'
  }
  return undefined
}

export function createGridMutationCoordinator(
  deps: GridMutationCoordinatorDeps,
  queueStore: Map<string, Promise<void>> = new Map()
): GridMutationCoordinator {
  const datasetQueues = queueStore

  const emit = (stage: GridMutationLifecycleStage, transaction: GridTransactionRecord) => {
    deps.onLifecycle?.({ stage, transaction })
  }

  return {
    async applyGridMutation(input: ApplyGridMutationInput): Promise<GridMutationResult> {
      const queueKey = input.datasetId
      const previous = datasetQueues.get(queueKey)
      const seedTransaction: GridTransactionRecord = {
        id: input.id,
        datasetId: input.datasetId,
        kind: input.kind,
      }

      const run = async (): Promise<GridMutationResult> => {
        emit('start', seedTransaction)
        const transaction = await deps.plan(input)
        emit('plan', transaction)
        await deps.applyLocal(transaction)
        emit('applyLocal', transaction)
        await deps.enqueuePersist(transaction)
        emit('enqueuePersist', transaction)
        await deps.finalizeUI(transaction)
        emit('finalizeUI', transaction)
        emit('persisted', transaction)
        return { transaction }
      }

      const queued = (async () => {
        if (previous) {
          await previous
        }
        return run()
      })()

      const queueTail = queued.then(
        () => undefined,
        () => undefined
      )
      datasetQueues.set(queueKey, queueTail)

      queueTail.finally(() => {
        if (datasetQueues.get(queueKey) === queueTail) {
          datasetQueues.delete(queueKey)
        }
      })

      return queued
    },
  }
}
