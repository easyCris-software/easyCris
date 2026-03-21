import { describe, expect, it } from 'vitest'
import {
  isRangePickFormulaMode,
  transitionFormulaEditMode,
  type FormulaEditMode,
} from '../formulaEditStateMachine'

describe('formulaEditStateMachine', () => {
  it('transitions idle -> cell edit/range states explicitly', () => {
    expect(transitionFormulaEditMode('idle', { type: 'cell_input', rangePick: false })).toBe('cell_edit')
    expect(transitionFormulaEditMode('idle', { type: 'cell_input', rangePick: true })).toBe('cell_range_pick')
  })

  it('transitions idle -> bar edit/range states explicitly', () => {
    expect(transitionFormulaEditMode('idle', { type: 'bar_input', rangePick: false })).toBe('bar_edit')
    expect(transitionFormulaEditMode('idle', { type: 'bar_input', rangePick: true })).toBe('bar_range_pick')
  })

  it('supports explicit cell->bar migration only from cell-owned states', () => {
    expect(transitionFormulaEditMode('cell_edit', { type: 'migrate_cell_to_bar', rangePick: false })).toBe('bar_edit')
    expect(transitionFormulaEditMode('cell_range_pick', { type: 'migrate_cell_to_bar', rangePick: true })).toBe('bar_range_pick')
    expect(transitionFormulaEditMode('bar_edit', { type: 'migrate_cell_to_bar', rangePick: false })).toBeNull()
  })

  it('rejects implicit cross-owner takeover via late callbacks', () => {
    expect(transitionFormulaEditMode('bar_edit', { type: 'cell_input', rangePick: false })).toBeNull()
    expect(transitionFormulaEditMode('bar_range_pick', { type: 'cell_input', rangePick: true })).toBeNull()
    expect(transitionFormulaEditMode('cell_edit', { type: 'bar_input', rangePick: false })).toBeNull()
    expect(transitionFormulaEditMode('cell_range_pick', { type: 'bar_input', rangePick: true })).toBeNull()
  })

  it('ends session deterministically to idle from any mode', () => {
    const modes: FormulaEditMode[] = ['idle', 'cell_edit', 'cell_range_pick', 'bar_edit', 'bar_range_pick']
    for (const mode of modes) {
      expect(transitionFormulaEditMode(mode, { type: 'end_session' })).toBe('idle')
    }
  })

  it('flags range-pick modes only', () => {
    expect(isRangePickFormulaMode('cell_range_pick')).toBe(true)
    expect(isRangePickFormulaMode('bar_range_pick')).toBe(true)
    expect(isRangePickFormulaMode('cell_edit')).toBe(false)
  })
})
