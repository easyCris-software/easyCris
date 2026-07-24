export type FormulaEditMode =
  | 'idle'
  | 'cell_edit'
  | 'cell_range_pick'
  | 'bar_edit'
  | 'bar_range_pick'

export type FormulaEditEvent =
  | { type: 'cell_input'; rangePick: boolean }
  | { type: 'bar_input'; rangePick: boolean }
  | { type: 'migrate_cell_to_bar'; rangePick: boolean }
  | { type: 'end_session' }

export function isRangePickFormulaMode(mode: FormulaEditMode): boolean {
  return mode === 'cell_range_pick' || mode === 'bar_range_pick'
}

function modeForOwner(owner: 'cell' | 'bar', rangePick: boolean): FormulaEditMode {
  if (owner === 'cell') {
    return rangePick ? 'cell_range_pick' : 'cell_edit'
  }
  return rangePick ? 'bar_range_pick' : 'bar_edit'
}

export function transitionFormulaEditMode(
  current: FormulaEditMode,
  event: FormulaEditEvent
): FormulaEditMode | null {
  if (event.type === 'end_session') {
    return 'idle'
  }

  switch (event.type) {
    case 'cell_input':
      if (
        current === 'idle' ||
        current === 'cell_edit' ||
        current === 'cell_range_pick'
      ) {
        return modeForOwner('cell', event.rangePick)
      }
      return null
    case 'bar_input':
      if (
        current === 'idle' ||
        current === 'bar_edit' ||
        current === 'bar_range_pick'
      ) {
        return modeForOwner('bar', event.rangePick)
      }
      return null
    case 'migrate_cell_to_bar':
      if (current === 'cell_edit' || current === 'cell_range_pick') {
        return modeForOwner('bar', event.rangePick)
      }
      return null
    default:
      return null
  }
}
