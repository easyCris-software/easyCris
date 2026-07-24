import { describe, expect, it } from 'vitest'
import {
  deriveInteractionModeFromSession,
  resolveModeAfterFill,
  shouldBlockFillPattern,
  shouldDeferFormulaSelectionApply,
  shouldEnableFillHandle,
  shouldProcessFormulaSelection,
  type GridInteractionMode,
} from '../formulaInteractionArbitration'

describe('formulaInteractionArbitration', () => {
  it('derives formula range-pick mode from active range-pick session', () => {
    const mode = deriveInteractionModeFromSession(
      { active: true, isRangePickMode: true },
      'normal'
    )
    expect(mode).toBe('formula_range_pick')
  })

  it('keeps fill_drag mode stable while drag is in progress', () => {
    const mode = deriveInteractionModeFromSession(
      { active: true, isRangePickMode: true },
      'fill_drag'
    )
    expect(mode).toBe('fill_drag')
  })

  it('resolves mode after fill back to formula range-pick when session is still active', () => {
    expect(resolveModeAfterFill({ active: true, isRangePickMode: true })).toBe('formula_range_pick')
    expect(resolveModeAfterFill({ active: true, isRangePickMode: false })).toBe('normal')
  })

  it('disables fill handle whenever a formula session is active', () => {
    expect(shouldEnableFillHandle(true)).toBe(false)
    expect(shouldEnableFillHandle(false)).toBe(true)
  })

  it('suppresses formula selection processing only during fill drag mode', () => {
    const normalMode: GridInteractionMode = 'normal'
    const formulaMode: GridInteractionMode = 'formula_range_pick'
    const fillMode: GridInteractionMode = 'fill_drag'
    expect(shouldProcessFormulaSelection(normalMode)).toBe(true)
    expect(shouldProcessFormulaSelection(formulaMode)).toBe(true)
    expect(shouldProcessFormulaSelection(fillMode)).toBe(false)
  })

  it('defers formula reference apply only during pointer drag in range-pick mode', () => {
    expect(shouldDeferFormulaSelectionApply('formula_range_pick', true)).toBe(true)
    expect(shouldDeferFormulaSelectionApply('formula_range_pick', false)).toBe(false)
    expect(shouldDeferFormulaSelectionApply('normal', true)).toBe(false)
    expect(shouldDeferFormulaSelectionApply('fill_drag', true)).toBe(false)
  })

  it('blocks fill when formula session is active or in formula range-pick mode', () => {
    expect(shouldBlockFillPattern(true, 'normal')).toBe(true)
    expect(shouldBlockFillPattern(false, 'formula_range_pick')).toBe(true)
    expect(shouldBlockFillPattern(false, 'normal')).toBe(false)
    expect(shouldBlockFillPattern(false, 'fill_drag')).toBe(false)
  })
})
