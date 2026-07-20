export function computeAffectedBlockKeys(
  datasetId: string,
  minModelRow: number,
  maxModelRow: number,
  blockSize: number
): string[] {
  if (!Number.isFinite(minModelRow) || !Number.isFinite(maxModelRow) || blockSize <= 0) {
    return []
  }
  if (maxModelRow < minModelRow) {
    return []
  }

  const safeMinModelRow = Math.max(0, minModelRow)
  const safeMaxModelRow = Math.max(0, maxModelRow)
  if (safeMaxModelRow < safeMinModelRow) {
    return []
  }

  const firstBlock = Math.floor(safeMinModelRow / blockSize)
  const lastBlock = Math.floor(safeMaxModelRow / blockSize)
  const keys: string[] = []

  for (let block = firstBlock; block <= lastBlock; block += 1) {
    keys.push(`${datasetId}:block:${block}`)
  }

  return keys
}

export function computeRequiredDataRowsForPaste(
  startViewRow: number,
  pastedRowCount: number,
  viewToModel: (viewRow: number) => number
): number {
  if (pastedRowCount <= 0) {
    return 0
  }

  const conservativeRequiredRows = Math.max(0, startViewRow + pastedRowCount)
  let maxModelRow = -1
  let unresolved = false

  for (let rowOffset = 0; rowOffset < pastedRowCount; rowOffset += 1) {
    const viewRow = startViewRow + rowOffset
    const modelRow = viewToModel(viewRow)
    if (!Number.isFinite(modelRow) || modelRow < 0) {
      unresolved = true
      continue
    }
    if (modelRow > maxModelRow) {
      maxModelRow = modelRow
    }
  }

  const mappedRequiredRows = maxModelRow + 1
  if (unresolved) {
    return Math.max(conservativeRequiredRows, mappedRequiredRows)
  }
  return mappedRequiredRows
}

export function planInsertedRowsForPaste(
  currentDataRows: number,
  requiredDataRows: number
): Array<{ start: number; count: number }> | undefined {
  const safeCurrentRows = Math.max(0, currentDataRows)
  const safeRequiredRows = Math.max(0, requiredDataRows)
  if (safeRequiredRows <= safeCurrentRows) {
    return undefined
  }

  return [
    {
      start: safeCurrentRows,
      count: safeRequiredRows - safeCurrentRows,
    },
  ]
}

interface SyncBlockSetsForRangeArgs {
  datasetId: string
  minModelRow: number
  maxModelRow: number
  blockSize: number
  loaded: Set<string>
  pending: Set<string>
  wanted: Set<string>
}

export function syncBlockSetsForRange({
  datasetId,
  minModelRow,
  maxModelRow,
  blockSize,
  loaded,
  pending,
  wanted,
}: SyncBlockSetsForRangeArgs): string[] {
  const keys = computeAffectedBlockKeys(datasetId, minModelRow, maxModelRow, blockSize)

  for (const key of keys) {
    loaded.delete(key)
    pending.delete(key)
    wanted.add(key)
  }

  return keys
}

interface SyncBlockSetsForActiveDatasetArgs extends SyncBlockSetsForRangeArgs {
  activeDatasetId: string | null | undefined
}

export function syncBlockSetsForActiveDataset({
  activeDatasetId,
  ...args
}: SyncBlockSetsForActiveDatasetArgs): string[] {
  if (!activeDatasetId || activeDatasetId !== args.datasetId) {
    return []
  }
  return syncBlockSetsForRange(args)
}

/**
 * Paste Preflight
 *
 * Pure computation: given a clipboard matrix and current grid bounds,
 * returns overflow counts and required capacity before any edits are built.
 *
 * SpreadsheetView paste handlers call this after parsing clipboard text
 * and before the forEach edit loop, so they can expand capacity (or offer
 * a user choice) rather than silently clipping rows and columns.
 */

export interface PastePreflightParams {
  /** View-row index of the top-left paste anchor */
  startViewRow: number
  /** Column index of the top-left paste anchor */
  startCol: number
  /** Parsed clipboard data (2D array, rows × cols) */
  parsedData: string[][]
  /** Current grid row capacity (dataRowCount + ROW_BUFFER) */
  currentRowCount: number
  /** Current number of columns in the grid */
  currentColCount: number
}

export interface PastePreflightResult {
  /** Total rows required: startViewRow + pastedRows */
  requiredRowCount: number
  /** Total cols required: startCol + pastedCols */
  requiredColCount: number
  /** Rows that would be clipped under current capacity (0 = none) */
  rowOverflow: number
  /** Columns that would be clipped under current capacity (0 = none) */
  colOverflow: number
  /** True only when both rowOverflow and colOverflow are 0 */
  fitsInBounds: boolean
}

export type PasteDecision = 'expand' | 'within-bounds' | 'cancel'

export interface PasteLoopBounds {
  /** Row index (exclusive) the paste loop should treat as the cap */
  effectiveRowCap: number
  /** Column count the paste loop should treat as the cap */
  effectiveColCap: number
}

/**
 * Converts a preflight result + user decision into effective loop caps.
 *
 * Returns null when the decision is 'cancel' — the caller must not build
 * any edits and must return immediately (no partial writes).
 *
 * - 'expand':       use requiredRowCount / requiredColCount (all pasted rows/cols)
 * - 'within-bounds': use currentRowCount / currentColCount (intentional clip)
 * - 'cancel':       null (abort)
 */
export function resolvePasteLoopBounds(
  preflight: PastePreflightResult,
  decision: PasteDecision,
  current: { currentRowCount: number; currentColCount: number }
): PasteLoopBounds | null {
  if (decision === 'cancel') return null

  if (decision === 'expand') {
    return {
      effectiveRowCap: preflight.requiredRowCount,
      effectiveColCap: preflight.requiredColCount,
    }
  }

  // within-bounds: intentional clip to current capacity
  return {
    effectiveRowCap: current.currentRowCount,
    effectiveColCap: current.currentColCount,
  }
}

/**
 * Returns true when a sort, filter, or group transform is active.
 *
 * Used by paste handlers to block row-overflow expansion when viewToModel
 * is non-identity — new rows appended beyond the view would map to wrong
 * model indices under an active sort/filter/group.
 */
export function isViewTransformActive(params: {
  sortModelLength: number
  enableExcelViewFilter: boolean
  hasViewFilterConfig: boolean
  groupByColumnId: string | null
}): boolean {
  return (
    params.sortModelLength > 0 ||
    (params.enableExcelViewFilter && params.hasViewFilterConfig) ||
    params.groupByColumnId !== null
  )
}

/**
 * No-dialog overflow policy:
 * - fits in bounds -> within-bounds
 * - any row overflow -> expand
 * - any column overflow -> expand
 */
export async function decidePasteOverflow(preflight: PastePreflightResult): Promise<PasteDecision> {
  if (preflight.fitsInBounds) {
    return 'within-bounds'
  }
  return 'expand'
}

/**
 * A single column to be created before the paste loop runs.
 * SpreadsheetView uses these to call insertColumnAtDataset + cacheService.addColumn
 * before building edits, so overflow columns exist in the store and DuckDB.
 */
export interface NewColumnDraft {
  id: string
  name: string
  type: 'text'
}

/**
 * Callbacks injected into applyColumnExpansion so the function stays pure
 * (no direct store or cacheService imports) and fully testable.
 */
export interface ColumnExpansionCallbacks {
  /** Persist the column to the DuckDB backend (async, may throw). */
  addToBackend: (draftId: string) => Promise<unknown>
  /** Insert column metadata into the store (sync). */
  addToStore: (insertIndex: number, draft: NewColumnDraft) => void
  /** Remove a previously added backend column (best-effort rollback). */
  rollbackBackend: (draftId: string) => Promise<unknown>
  /** Remove a previously inserted store column (best-effort rollback). */
  rollbackStore: (insertIndex: number) => void
  /** Release a previously allocated column name. */
  rollbackName: (name: string) => void
  /**
   * Optional abort gate — called before each backend call and immediately
   * after each backend call (before the paired store insert). Return true
   * to abort: already-committed ops are rolled back and { ok: false } is
   * returned. Use this to detect dataset switches mid-loop without relying
   * on the caller's post-await guard (which fires only after the whole loop
   * completes).
   */
  shouldAbort?: () => boolean
}

export type ColumnExpansionResult = { ok: true } | { ok: false }

/**
 * Applies N column additions (backend + store) in order, with a full
 * rollback journal on any failure.
 *
 * Rollback order on failure (strict reverse-commit, backend-first for durability):
 *   1. Backend adds    — reversed (newest-to-oldest committed)
 *   2. Store inserts   — reversed (newest-to-oldest committed)
 *   3. Name allocations — reversed (all drafts, newest-to-oldest)
 *
 * Backend rollback runs first so that if it fails, the store column metadata still
 * exists and both layers agree — the mismatch is visible rather than silent.
 * This satisfies rollbackAutoColumnNameAllocation's "most-recent-first" contract.
 *
 * Rollback callbacks are best-effort: a rollback failure is logged but does
 * not prevent subsequent rollbacks.
 *
 * If cb.shouldAbort is provided it is checked:
 *   (a) before each addToBackend call
 *   (b) after each addToBackend resolves and before the paired addToStore
 * On abort the journal is rolled back exactly as on thrown errors.
 */
export async function applyColumnExpansion(
  drafts: NewColumnDraft[],
  insertBase: number,
  cb: ColumnExpansionCallbacks,
): Promise<ColumnExpansionResult> {
  const backendCommitted: number[] = [] // draft indices whose backend add succeeded
  const storeCommitted: number[] = []   // draft indices whose store add succeeded

  // Shared rollback: backend-first (durability), then store, then names.
  // Extracted so both the catch path and the shouldAbort path use identical logic.
  async function rollback(): Promise<void> {
    for (let j = backendCommitted.length - 1; j >= 0; j--) {
      try { await cb.rollbackBackend(drafts[backendCommitted[j]!]!.id) } catch { /* best-effort */ }
    }
    for (let j = storeCommitted.length - 1; j >= 0; j--) {
      try { cb.rollbackStore(insertBase + storeCommitted[j]!) } catch { /* best-effort */ }
    }
    for (let j = drafts.length - 1; j >= 0; j--) {
      try { cb.rollbackName(drafts[j]!.name) } catch { /* best-effort */ }
    }
  }

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i]!

    // Gate (a): before backend call — catches switches that occurred after the
    // previous iteration's store commit (or before the very first iteration).
    if (cb.shouldAbort?.()) {
      await rollback()
      return { ok: false }
    }

    try {
      await cb.addToBackend(draft.id)
      backendCommitted.push(i)

      // Gate (b): after backend resolves, before store insert — catches switches
      // that occurred DURING the addToBackend await (the tightest race window).
      if (cb.shouldAbort?.()) {
        await rollback()
        return { ok: false }
      }

      cb.addToStore(insertBase + i, draft)
      storeCommitted.push(i)
    } catch {
      await rollback()
      return { ok: false }
    }
  }
  return { ok: true }
}

/**
 * Allocates N new column drafts for column overflow expansion.
 *
 * Calls allocateName once per overflow column (in order) and generateId once
 * per draft to produce a stable list of { id, name, type } objects.
 *
 * Returns null if any allocation fails — caller must not insert partial columns
 * and should rollback already-allocated names via rollbackAutoColumnNameAllocation.
 */
export function buildNewColumnDrafts(
  colOverflow: number,
  allocateName: () => string | null,
  generateId: () => string,
  rollbackName?: (name: string) => void,
): NewColumnDraft[] | null {
  if (colOverflow === 0) return []

  const drafts: NewColumnDraft[] = []
  for (let i = 0; i < colOverflow; i++) {
    const name = allocateName()
    if (name === null) {
      // Rollback previously allocated names newest-first to match
      // rollbackAutoColumnNameAllocation's expected ordering contract.
      if (rollbackName) {
        for (let j = drafts.length - 1; j >= 0; j--) {
          rollbackName(drafts[j]!.name)
        }
      }
      return null
    }
    drafts.push({ id: generateId(), name, type: 'text' })
  }
  return drafts
}

/**
 * Clamps the paste loop's effectiveRowCap to rowOrderLength when a view
 * transform (sort, filter, or group) is active.
 *
 * Problem: viewToModel uses `rowOrder[viewRow] ?? viewRow` as its fallback.
 * When transform is active, rowOrder only covers visible rows. Any viewRow
 * ≥ rowOrder.length falls through to the identity fallback (viewRow === modelRow),
 * which is wrong — those indices may not correspond to valid model rows in the
 * current filtered/sorted view.
 *
 * Fix: cap the paste loop at rowOrderLength so we never attempt to map a
 * viewRow that has no entry in rowOrder. Non-expanding pastes already clip to
 * currentRowCount; this additionally clips to the visible-row count.
 */
export function resolveTransformAwareRowCap(
  effectiveRowCap: number,
  rowOrderLength: number,
  isTransformActive: boolean,
): number {
  if (!isTransformActive) return effectiveRowCap
  return Math.min(effectiveRowCap, rowOrderLength)
}

/**
 * Pure computation for the "bump data row count" policy after paste.
 *
 * Returns the new dataRowCount to persist if promotion is needed (i.e. the
 * pasted row is at or beyond the current dataRowCount boundary), or null if
 * the edited row is already within data rows and no update is required.
 *
 * Callers pass capturedDatasetId + this result to updateDataset directly so
 * the write targets the original dataset even when the active dataset has
 * changed (stale-dataset safety on async paste handlers).
 */
export function computeDataRowCountPromotion(
  maxEditedRowIndex: number,
  currentDataRowCount: number,
): number | null {
  if (maxEditedRowIndex >= currentDataRowCount) {
    return maxEditedRowIndex + 1
  }
  return null
}

export function computePastePreflight(params: PastePreflightParams): PastePreflightResult {
  const { startViewRow, startCol, parsedData, currentRowCount, currentColCount } = params

  const pastedRows = parsedData.length
  let pastedCols = 0
  for (const row of parsedData) {
    if (row.length > pastedCols) {
      pastedCols = row.length
    }
  }

  const requiredRowCount = startViewRow + pastedRows
  const requiredColCount = startCol + pastedCols

  const rowOverflow = Math.max(0, requiredRowCount - currentRowCount)
  const colOverflow = Math.max(0, requiredColCount - currentColCount)

  return {
    requiredRowCount,
    requiredColCount,
    rowOverflow,
    colOverflow,
    fitsInBounds: rowOverflow === 0 && colOverflow === 0,
  }
}
