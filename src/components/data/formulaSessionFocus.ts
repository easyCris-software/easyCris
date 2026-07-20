export type FormulaSessionFocusSource = 'bar' | 'cell'

export type FormulaSessionFocusState = {
  active: boolean
  source: FormulaSessionFocusSource
} | null

export type FormulaBarFocusAction =
  | 'restore_bar_session'
  | 'migrate_cell_session'
  | 'load_from_active_cell'

export type FormulaBarFocusIntent = 'focus_bar' | 'passive'

export function getFormulaBarFocusAction(
  session: FormulaSessionFocusState,
  intent: FormulaBarFocusIntent
): FormulaBarFocusAction {
  if (!session?.active) {
    return 'load_from_active_cell'
  }
  if (session.source === 'bar') {
    return 'restore_bar_session'
  }
  if (intent === 'passive') {
    return 'load_from_active_cell'
  }
  return 'migrate_cell_session'
}
