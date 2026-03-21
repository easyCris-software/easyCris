import {
  transitionFormulaEditMode,
  type FormulaEditMode,
} from './formulaEditStateMachine'

export type FormulaOwner = 'cell' | 'bar'

export type FormulaOwnerSession = {
  active: boolean
  mode: FormulaEditMode
  source: FormulaOwner
  version: number
  editorSessionId: number | null
}

export type ResolveFormulaOwnerUpdateArgs = {
  previous: FormulaOwnerSession | null
  source: FormulaOwner
  rangePick: boolean
  editorSessionId: number | null
  latestCellEditorSessionId: number | null
}

export type ResolveFormulaOwnerUpdateResult =
  | {
      accepted: false
      reason: 'stale_cell_callback' | 'stale_cross_owner_callback'
      latestCellEditorSessionId: number | null
    }
  | {
      accepted: true
      mode: FormulaEditMode
      source: FormulaOwner
      version: number
      editorSessionId: number | null
      recovered: boolean
      latestCellEditorSessionId: number | null
    }

function modeForOwner(source: FormulaOwner, rangePick: boolean): FormulaEditMode {
  if (source === 'cell') {
    return rangePick ? 'cell_range_pick' : 'cell_edit'
  }
  return rangePick ? 'bar_range_pick' : 'bar_edit'
}

export function bumpFormulaOwnerVersion(session: FormulaOwnerSession): number {
  return session.version + 1
}

export function resolveFormulaOwnerUpdate(
  args: ResolveFormulaOwnerUpdateArgs
): ResolveFormulaOwnerUpdateResult {
  const { previous, source, rangePick, editorSessionId, latestCellEditorSessionId } = args
  const hasCellEditorSessionId = typeof editorSessionId === 'number'

  if (
    source === 'cell' &&
    hasCellEditorSessionId &&
    latestCellEditorSessionId !== null &&
    editorSessionId < latestCellEditorSessionId
  ) {
    return {
      accepted: false,
      reason: 'stale_cell_callback',
      latestCellEditorSessionId,
    }
  }

  const previousMode: FormulaEditMode = previous?.mode ?? 'idle'
  let nextMode = transitionFormulaEditMode(
    previousMode,
    source === 'cell'
      ? { type: 'cell_input', rangePick }
      : { type: 'bar_input', rangePick }
  )
  let recovered = false

  if (!nextMode || nextMode === 'idle') {
    recovered = true
    if (previous?.active && previous.source === source) {
      nextMode = modeForOwner(source, rangePick)
    } else if (previous?.active && previous.source === 'cell' && source === 'bar') {
      nextMode =
        transitionFormulaEditMode(previous.mode, {
          type: 'migrate_cell_to_bar',
          rangePick,
        }) ?? modeForOwner('bar', rangePick)
    } else if (previous?.active && previous.source === 'bar' && source === 'cell') {
      if (hasCellEditorSessionId || latestCellEditorSessionId === null) {
        // Legitimate handoff from bar -> newly focused inline editor.
        // Accept callback when it carries a session id, or when there is
        // no previously seen cell session id to compare against yet.
        nextMode = modeForOwner('cell', rangePick)
      } else {
        return {
          accepted: false,
          reason: 'stale_cross_owner_callback',
          latestCellEditorSessionId,
        }
      }
    } else {
      nextMode = modeForOwner(source, rangePick)
    }
  }

  const nextSource: FormulaOwner = nextMode.startsWith('bar') ? 'bar' : 'cell'
  const nextEditorSessionId =
    nextSource === 'cell' ? editorSessionId ?? previous?.editorSessionId ?? null : null
  const nextVersion = (previous?.version ?? 0) + 1

  const nextLatestCellEditorSessionId =
    nextSource === 'cell' && typeof nextEditorSessionId === 'number'
      ? Math.max(latestCellEditorSessionId ?? nextEditorSessionId, nextEditorSessionId)
      : latestCellEditorSessionId

  return {
    accepted: true,
    mode: nextMode,
    source: nextSource,
    version: nextVersion,
    editorSessionId: nextEditorSessionId,
    recovered,
    latestCellEditorSessionId: nextLatestCellEditorSessionId,
  }
}
