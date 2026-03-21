import { describe, expect, it } from 'vitest'
import type { Data } from 'plotly.js'
import { applyAutoBarOutlines } from '@/utils/plotDisplayDefaults'
import {
  applyColorToAllBarCategories,
  setBarCategoryFrame,
} from '@/lib/plots/barCategoryStyles'

describe('plotDisplayDefaults applyAutoBarOutlines', () => {
  it('does not re-enable outlines when width array is all off', () => {
    const input: Data[] = [
      {
        type: 'bar',
        x: ['A', 'B'],
        y: [2, 3],
        marker: {
          color: ['#ffffff', '#ff0000'],
          line: { width: [0, 0], color: ['#ffffff', '#ff0000'] },
        },
      } as Data,
    ]

    const output = applyAutoBarOutlines(input)
    const line = (output.data[0] as any).marker.line

    expect(output.changed).toBe(false)
    expect(line.width).toEqual([0, 0])
  })

  it('preserves mixed array widths (off/on) and never coerces to scalar', () => {
    const input: Data[] = [
      {
        type: 'bar',
        x: ['A', 'B'],
        y: [2, 3],
        marker: {
          color: ['#ffffff', '#ff0000'],
          line: { width: [0, 1], color: ['#ffffff', '#ff0000'] },
        },
      } as Data,
    ]

    const output = applyAutoBarOutlines(input)
    const line = (output.data[0] as any).marker.line

    expect(Array.isArray(line.width)).toBe(true)
    expect(line.width).toEqual([0, 1])
  })

  it('normalizes legacy scalar line color to per-category outline colors for array fills', () => {
    const input: Data[] = [
      {
        type: 'bar',
        x: ['A', 'B'],
        y: [2, 3],
        marker: {
          color: ['#ffffff', '#ffffff'],
          line: { width: [1, 1], color: '#ffffff' },
        },
      } as Data,
    ]

    const output = applyAutoBarOutlines(input)
    const line = (output.data[0] as any).marker.line

    expect(output.changed).toBe(true)
    expect(Array.isArray(line.color)).toBe(true)
    expect(line.color).toEqual(['#000000', '#000000'])
  })

  it('keeps frame-off intent through toggle-off -> recolor -> render flow', () => {
    const base = {
      type: 'bar',
      x: ['A', 'B'],
      y: [2, 4],
      marker: {
        color: ['#00aa00', '#0000aa'],
      },
    } as Data

    const framedOff = setBarCategoryFrame(base, 0, false)
    const recolored = applyColorToAllBarCategories(framedOff, '#ff0000')
    const output = applyAutoBarOutlines([recolored])
    const line = (output.data[0] as any).marker.line

    expect(output.changed).toBe(false)
    expect(Array.isArray(line.width)).toBe(true)
    expect(line.width[0]).toBe(0)
    expect(line.width[1]).toBe(1)
  })
})
