/**
 * rebuildBracketShapes — pure utility tests
 *
 * Given a set of shapes (some are sig_bracket_*, some are not),
 * rebuildBracketShapes returns updated shapes with new geometry
 * while leaving non-bracket shapes unchanged.
 *
 * Path format (8-number): M xL,tipY L xL,baseY L xR,baseY L xR,tipY
 * center X = (xL + xR) / 2  — preserved across rebuilds
 */
import { describe, it, expect } from 'vitest'
import {
  rebuildBracketShapes,
  BRACKET_THIN_PARAMS,
  BRACKET_FAT_PARAMS,
  BRACKET_DEBUG_VISIBLE_PARAMS,
} from '@/utils/plotBuilders/rebuildBracketShapes'

// Helpers

function makeShape(name: string, xL: number, xR: number, baseY: number, tipY: number, lineWidth = 0.5) {
  return {
    type: 'path',
    name,
    path: `M ${xL},${tipY} L ${xL},${baseY} L ${xR},${baseY} L ${xR},${tipY}`,
    line: { color: 'rgba(0,0,0,0.15)', width: lineWidth },
  }
}

function parseNums(path: string): number[] {
  return path.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)!.map(Number)
}

const THIN_PARAMS = { halfWidth: 0.15, tickHeightRatio: 0.001, lineWidth: 0.5, lineColor: 'rgba(0,0,0,0)' }
const FAT_PARAMS  = { halfWidth: 0.15, tickHeightRatio: 0.04,  lineWidth: 3,   lineColor: 'rgba(0,0,0,0)' }

describe('rebuildBracketShapes', () => {
  it('returns same number of shapes as input', () => {
    const shapes = [
      makeShape('sig_bracket_0', -0.15, 0.15, 10, 10.004),
      makeShape('sig_bracket_1', 0.85, 1.15, 12, 12.004),
      { type: 'line', name: 'other_shape', x0: 0, y0: 0, x1: 1, y1: 1 },
    ]
    const result = rebuildBracketShapes(shapes, 4, FAT_PARAMS)
    expect(result).toHaveLength(3)
  })

  it('does not modify non-sig_bracket shapes', () => {
    const nonBracket = { type: 'line', name: 'some_other', x0: 0, y0: 0, x1: 1, y1: 1 }
    const shapes = [makeShape('sig_bracket_0', -0.15, 0.15, 10, 10.004), nonBracket]
    const result = rebuildBracketShapes(shapes, 4, FAT_PARAMS)
    expect(result[1]).toEqual(nonBracket)
  })

  it('preserves center X of each bracket after rebuild', () => {
    const centerX = 2
    const shape = makeShape('sig_bracket_0', centerX - 0.15, centerX + 0.15, 10, 10.004)
    const [rebuilt] = rebuildBracketShapes([shape], 4, FAT_PARAMS)
    const nums = parseNums((rebuilt as any).path)
    const xLeft  = nums[0]!
    const xRight = nums[4]!
    const newCenter = (xLeft + xRight) / 2
    expect(newCenter).toBeCloseTo(centerX, 5)
  })

  it('applies fat params: wider tickHeight and wider lineWidth in edit mode', () => {
    const yRange = 10
    const shape = makeShape('sig_bracket_0', -0.15, 0.15, 20, 20 + yRange * THIN_PARAMS.tickHeightRatio)
    const [rebuilt] = rebuildBracketShapes([shape], yRange, FAT_PARAMS)
    const nums = parseNums((rebuilt as any).path)
    const tipY  = nums[1]!
    const baseY = nums[3]!
    const newTickHeight = Math.abs(tipY - baseY)
    expect(newTickHeight).toBeCloseTo(yRange * FAT_PARAMS.tickHeightRatio, 5)
    expect((rebuilt as any).line.width).toBe(FAT_PARAMS.lineWidth)
  })

  it('applies thin params: restores near-zero tickHeight and thin lineWidth', () => {
    const yRange = 10
    // Start from fat shape
    const fatShape = makeShape('sig_bracket_0', -0.15, 0.15, 20, 20 + yRange * FAT_PARAMS.tickHeightRatio, FAT_PARAMS.lineWidth)
    const [rebuilt] = rebuildBracketShapes([fatShape], yRange, THIN_PARAMS)
    const nums = parseNums((rebuilt as any).path)
    const tipY  = nums[1]!
    const baseY = nums[3]!
    const newTickHeight = Math.abs(tipY - baseY)
    expect(newTickHeight).toBeCloseTo(yRange * THIN_PARAMS.tickHeightRatio, 5)
    expect((rebuilt as any).line.width).toBe(THIN_PARAMS.lineWidth)
  })

  it('preserves halfWidth from params (not capped by original shape halfWidth)', () => {
    const wideParams = { halfWidth: 0.3, tickHeightRatio: 0.001, lineWidth: 0.5 }
    const shape = makeShape('sig_bracket_0', -0.15, 0.15, 10, 10.004)
    const [rebuilt] = rebuildBracketShapes([shape], 4, wideParams)
    const nums = parseNums((rebuilt as any).path)
    const xLeft  = nums[0]!
    const xRight = nums[4]!
    expect(xRight - xLeft).toBeCloseTo(wideParams.halfWidth * 2, 5)
  })

  it('preserves base Y (bracket does not move vertically)', () => {
    const baseY = 42
    const shape = makeShape('sig_bracket_0', -0.15, 0.15, baseY, baseY + 0.004)
    const [rebuilt] = rebuildBracketShapes([shape], 4, FAT_PARAMS)
    const nums = parseNums((rebuilt as any).path)
    expect(nums[3]).toBeCloseTo(baseY, 5)  // baseY position preserved
  })

  it('output path is still 8-number format (M xL,tipY L xL,baseY L xR,baseY L xR,tipY)', () => {
    const shape = makeShape('sig_bracket_0', -0.15, 0.15, 10, 10.004)
    const [rebuilt] = rebuildBracketShapes([shape], 4, FAT_PARAMS)
    const path = (rebuilt as any).path as string
    const nums = parseNums(path)
    expect(nums).toHaveLength(8)
    // xL appears at positions 0 and 2
    expect(nums[0]).toBeCloseTo(nums[2]!, 5)
    // xR appears at positions 4 and 6
    expect(nums[4]).toBeCloseTo(nums[6]!, 5)
  })

  it('applies lineColor from params to rebuilt shape line', () => {
    const shape = makeShape('sig_bracket_0', -0.15, 0.15, 10, 10.004)
    const [thin] = rebuildBracketShapes([shape], 4, THIN_PARAMS)
    const [fat]  = rebuildBracketShapes([shape], 4, FAT_PARAMS)
    expect((thin as any).line.color).toBe('rgba(0,0,0,0)')
    expect((fat  as any).line.color).toBe('rgba(0,0,0,0)')
  })
})

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

describe('exported bracket params constants', () => {
  it('BRACKET_THIN_PARAMS is fully transparent', () => {
    expect(BRACKET_THIN_PARAMS.lineColor).toBe('rgba(0,0,0,0)')
  })

  it('BRACKET_FAT_PARAMS is fully transparent (bigger hit target, not visible)', () => {
    expect(BRACKET_FAT_PARAMS.lineColor).toBe('rgba(0,0,0,0)')
    expect(BRACKET_FAT_PARAMS.lineWidth).toBeGreaterThan(BRACKET_THIN_PARAMS.lineWidth)
  })

  it('BRACKET_DEBUG_VISIBLE_PARAMS has a non-transparent color for dev use', () => {
    expect(BRACKET_DEBUG_VISIBLE_PARAMS.lineColor).not.toBe('rgba(0,0,0,0)')
    expect(BRACKET_DEBUG_VISIBLE_PARAMS.lineWidth).toBeGreaterThan(1)
  })
})
