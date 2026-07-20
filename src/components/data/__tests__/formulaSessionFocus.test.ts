import { describe, expect, it } from 'vitest'
import { getFormulaBarFocusAction } from '../formulaSessionFocus'

describe('getFormulaBarFocusAction', () => {
  it('restores existing bar session first', () => {
    expect(getFormulaBarFocusAction({ active: true, source: 'bar' }, 'focus_bar')).toBe('restore_bar_session')
  })

  it('migrates active cell session on formula-bar focus to preserve draft', () => {
    expect(getFormulaBarFocusAction({ active: true, source: 'cell' }, 'focus_bar')).toBe('migrate_cell_session')
  })

  it('loads from active cell when no active session exists', () => {
    expect(getFormulaBarFocusAction(null, 'focus_bar')).toBe('load_from_active_cell')
  })

  it('keeps passive flows out of cell-session migration', () => {
    expect(getFormulaBarFocusAction({ active: true, source: 'cell' }, 'passive')).toBe('load_from_active_cell')
  })
})
