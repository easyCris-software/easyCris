import type { GridTransactionRecord } from './types'

export const LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD = 10_000

function isPasteTransactionKind(kind: GridTransactionRecord['kind']): boolean {
  return kind === 'paste' || kind === 'paste-values' || kind === 'paste-transpose'
}

export function applyLargePasteUndoPolicy(
  transaction: GridTransactionRecord
): GridTransactionRecord {
  const edits = transaction.edits ?? []
  if (!isPasteTransactionKind(transaction.kind) || edits.length <= LARGE_PASTE_UNDO_CLEAR_RANGE_THRESHOLD) {
    return transaction
  }

  return {
    ...transaction,
    largePasteUndoPolicy: {
      kind: 'clear-range',
      editCount: edits.length,
    },
    edits: edits.map((edit) => ({
      ...edit,
      oldValue: '',
      computedValue: undefined,
    })),
  }
}
