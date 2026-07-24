/**
 * Fill Handle Tests - Phase 7
 *
 * Tests formula shifting for drag-to-fill operations.
 * Validates relative and absolute reference handling.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createFormulaService } from '../formulas/formulaService'

describe('Fill Handle - Formula Shifting', () => {
  let formulaService: ReturnType<typeof createFormulaService>
  let rowData: Map<number, Record<string, unknown>>

  beforeEach(() => {
    rowData = new Map([
      [0, { 'col-a': 10, 'col-b': 20 }],
      [1, { 'col-a': 5, 'col-b': 15 }],
      [2, { 'col-a': 8, 'col-b': 12 }],
    ])

    formulaService = createFormulaService(() => rowData, [
      { id: 'col-a' },
      { id: 'col-b' },
      { id: 'col-c' },
    ])
  })

  describe('Single cell references', () => {
    it('should shift cell reference down (A1 -> A2)', () => {
      const result = formulaService.getFilledFormula('=A1*2', { row: 1, col: 1 }, { row: 2, col: 1 })
      expect(result).toBe('=A2*2')
    })

    it('should shift cell reference right (A1 -> B1)', () => {
      const result = formulaService.getFilledFormula('=A1*2', { row: 1, col: 1 }, { row: 1, col: 2 })
      expect(result).toBe('=B1*2')
    })

    it('should shift cell reference diagonally (A1 -> B2)', () => {
      const result = formulaService.getFilledFormula('=A1*2', { row: 1, col: 1 }, { row: 2, col: 2 })
      expect(result).toBe('=B2*2')
    })

    it('should shift multiple cell references (A1+B1 -> A2+B2)', () => {
      const result = formulaService.getFilledFormula('=A1+B1', { row: 1, col: 1 }, { row: 2, col: 1 })
      expect(result).toBe('=A2+B2')
    })

    it('should return original formula if no shift', () => {
      const result = formulaService.getFilledFormula('=A1*2', { row: 1, col: 1 }, { row: 1, col: 1 })
      expect(result).toBe('=A1*2')
    })

    it('should return #REF! if shifted out of bounds (row < 1)', () => {
      const result = formulaService.getFilledFormula('=A2*2', { row: 2, col: 1 }, { row: 1, col: 1 })
      expect(result).toBe('=A1*2') // Row 2 -> Row 1 is valid

      const invalid = formulaService.getFilledFormula('=A1*2', { row: 1, col: 1 }, { row: 0, col: 1 })
      expect(invalid).toBe('=#REF!*2') // Row 1 -> Row 0 is invalid
    })

    it('should return #REF! if shifted out of bounds (col < 0)', () => {
      const result = formulaService.getFilledFormula('=B1*2', { row: 1, col: 2 }, { row: 1, col: 1 })
      expect(result).toBe('=A1*2') // Col B -> Col A is valid

      const invalid = formulaService.getFilledFormula('=A1*2', { row: 1, col: 1 }, { row: 1, col: 0 })
      expect(invalid).toBe('=#REF!*2') // Col A -> Col before A is invalid
    })
  })

  describe('Range references', () => {
    it('should shift range reference down (A1:B3 -> A2:B4)', () => {
      const result = formulaService.getFilledFormula(
        '=SUM(A1:B3)',
        { row: 1, col: 1 },
        { row: 2, col: 1 }
      )
      expect(result).toBe('=SUM(A2:B4)')
    })

    it('should shift range reference right (A1:B3 -> B1:C3)', () => {
      const result = formulaService.getFilledFormula(
        '=SUM(A1:B3)',
        { row: 1, col: 1 },
        { row: 1, col: 2 }
      )
      expect(result).toBe('=SUM(B1:C3)')
    })

    it('should shift range reference diagonally (A1:B3 -> B2:C4)', () => {
      const result = formulaService.getFilledFormula(
        '=SUM(A1:B3)',
        { row: 1, col: 1 },
        { row: 2, col: 2 }
      )
      expect(result).toBe('=SUM(B2:C4)')
    })

    it('should shift multiple ranges (SUMPRODUCT)', () => {
      const result = formulaService.getFilledFormula(
        '=SUMPRODUCT(A1:A3,B1:B3)',
        { row: 1, col: 1 },
        { row: 2, col: 1 }
      )
      expect(result).toBe('=SUMPRODUCT(A2:A4,B2:B4)')
    })
  })

  describe('Absolute references', () => {
    it('should NOT shift absolute row ($A$1 -> $A$1)', () => {
      const result = formulaService.getFilledFormula(
        '=$A$1*2',
        { row: 1, col: 1 },
        { row: 2, col: 2 }
      )
      expect(result).toBe('=$A$1*2')
    })

    it('should NOT shift absolute column but shift row ($A1 -> $A2)', () => {
      const result = formulaService.getFilledFormula(
        '=$A1*2',
        { row: 1, col: 1 },
        { row: 2, col: 1 }
      )
      expect(result).toBe('=$A2*2')
    })

    it('should shift column but NOT absolute row (A$1 -> B$1)', () => {
      const result = formulaService.getFilledFormula('=A$1*2', { row: 1, col: 1 }, { row: 1, col: 2 })
      expect(result).toBe('=B$1*2')
    })

    it('should handle mixed absolute/relative references', () => {
      const result = formulaService.getFilledFormula(
        '=$A$1+A1+$A1+A$1',
        { row: 1, col: 1 },
        { row: 2, col: 2 }
      )
      expect(result).toBe('=$A$1+B2+$A2+B$1')
    })

    it('should handle absolute references in ranges ($A$1:$B$3 -> $A$1:$B$3)', () => {
      const result = formulaService.getFilledFormula(
        '=SUM($A$1:$B$3)',
        { row: 1, col: 1 },
        { row: 5, col: 5 }
      )
      expect(result).toBe('=SUM($A$1:$B$3)')
    })

    it('should handle mixed absolute/relative in ranges ($A1:B$3 -> $A2:C$3)', () => {
      const result = formulaService.getFilledFormula(
        '=SUM($A1:B$3)',
        { row: 1, col: 1 },
        { row: 2, col: 2 }
      )
      expect(result).toBe('=SUM($A2:C$3)')
    })
  })

  describe('Complex formulas', () => {
    it('should shift formula with multiple functions', () => {
      const result = formulaService.getFilledFormula(
        '=IF(A1>10,SUM(B1:B3),AVERAGE(C1:C3))',
        { row: 1, col: 1 },
        { row: 2, col: 1 }
      )
      expect(result).toBe('=IF(A2>10,SUM(B2:B4),AVERAGE(C2:C4))')
    })

    it('should shift formula with nested functions', () => {
      const result = formulaService.getFilledFormula(
        '=SUM(A1:A3)*AVERAGE(B1:B3)',
        { row: 1, col: 1 },
        { row: 3, col: 1 }
      )
      expect(result).toBe('=SUM(A3:A5)*AVERAGE(B3:B5)')
    })

    it('should preserve constants and operators', () => {
      const result = formulaService.getFilledFormula(
        '=A1*2+B1*3-100',
        { row: 1, col: 1 },
        { row: 2, col: 1 }
      )
      expect(result).toBe('=A2*2+B2*3-100')
    })

    it('should handle formulas with string literals', () => {
      const result = formulaService.getFilledFormula(
        '=IF(A1="test",B1,C1)',
        { row: 1, col: 1 },
        { row: 2, col: 1 }
      )
      expect(result).toBe('=IF(A2="test",B2,C2)')
    })
  })

  describe('Edge cases', () => {
    it('should handle formulas without references', () => {
      const result = formulaService.getFilledFormula('=1+1', { row: 1, col: 1 }, { row: 2, col: 1 })
      expect(result).toBe('=1+1')
    })

    it('should handle formulas with only functions', () => {
      const result = formulaService.getFilledFormula(
        '=PI()*2',
        { row: 1, col: 1 },
        { row: 2, col: 1 }
      )
      expect(result).toBe('=PI()*2')
    })

    it('should handle column letters beyond single character (AA, AB, etc.)', () => {
      const result = formulaService.getFilledFormula(
        '=AA1+AB1',
        { row: 1, col: 27 }, // Column AA
        { row: 2, col: 27 }
      )
      expect(result).toBe('=AA2+AB2')
    })
  })
})
