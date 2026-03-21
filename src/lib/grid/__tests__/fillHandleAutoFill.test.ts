import { describe, expect, it } from 'vitest'
import {
  buildAutoFillDownDestination,
  isPointInFillHandleZone,
} from '@/lib/grid/fillHandleAutoFill'

describe('fillHandleAutoFill', () => {
  describe('isPointInFillHandleZone', () => {
    const cellBounds = { x: 100, y: 200, width: 80, height: 28 }

    it('returns true when point is near fill-handle center', () => {
      const result = isPointInFillHandleZone(cellBounds, { x: 178, y: 226 })
      expect(result).toBe(true)
    })

    it('returns false when point is outside fill-handle zone', () => {
      const result = isPointInFillHandleZone(cellBounds, { x: 160, y: 210 })
      expect(result).toBe(false)
    })
  })

  describe('buildAutoFillDownDestination', () => {
    it('expands destination from source top through last view row', () => {
      const destination = buildAutoFillDownDestination(
        { x: 2, y: 4, width: 1, height: 2 },
        12
      )
      expect(destination).toEqual({ x: 2, y: 4, width: 1, height: 9 })
    })

    it('returns null when source already reaches last view row', () => {
      const destination = buildAutoFillDownDestination(
        { x: 2, y: 4, width: 1, height: 3 },
        6
      )
      expect(destination).toBeNull()
    })
  })
})
