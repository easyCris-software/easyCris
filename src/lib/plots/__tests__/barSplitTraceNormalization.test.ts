import { describe, expect, it } from 'vitest'
import type { Data } from 'plotly.js'
import { normalizeBarSplitTraces, shouldNormalizeUserDerivedBarPlot } from '../barSplitTraceNormalization'

describe('barSplitTraceNormalization', () => {
  it('splits legacy single-trace multi-category bar into one trace per category', () => {
    const input: Data[] = [
      {
        type: 'bar',
        x: ['A', 'B'],
        y: [10, 20],
        marker: {
          color: ['#111111', '#222222'],
          pattern: { shape: ['/', 'x'], size: [6, 8], solidity: [0.4, 0.6] },
          line: { width: [1, 0], color: ['#000000', '#333333'] },
        },
      } as Data,
    ]

    const normalized = normalizeBarSplitTraces(input)
    expect(normalized.changed).toBe(true)
    expect(normalized.data).toHaveLength(2)
    const first = normalized.data[0] as any
    const second = normalized.data[1] as any
    expect(first.x).toEqual(['A'])
    expect(second.x).toEqual(['B'])
    expect(first.marker.color).toBe('#111111')
    expect(second.marker.color).toBe('#222222')
    expect(first.showlegend).toBe(true)
    expect(second.showlegend).toBe(true)
  })

  it('does not change already split traces', () => {
    const input: Data[] = [
      { type: 'bar', x: ['A'], y: [10], marker: { color: '#111111' }, name: 'A' } as Data,
      { type: 'bar', x: ['B'], y: [20], marker: { color: '#222222' }, name: 'B' } as Data,
    ]
    const normalized = normalizeBarSplitTraces(input)
    expect(normalized.changed).toBe(false)
    expect(normalized.data).toBe(input)
  })

  it('normalizes only user-derived bar plots per gating rule', () => {
    const legacy: Data[] = [
      { type: 'bar', x: ['A', 'B'], y: [1, 2], marker: { color: ['#aaa', '#bbb'] } } as Data,
    ]
    expect(shouldNormalizeUserDerivedBarPlot('user_derived', 'bar', legacy)).toBe(true)
    expect(shouldNormalizeUserDerivedBarPlot('test_result', 'bar', legacy)).toBe(false)
    expect(shouldNormalizeUserDerivedBarPlot('user_derived', 'pie', legacy)).toBe(false)
  })

  it('slices arrayOk fields like width/base/hovertext during split', () => {
    const input: Data[] = [
      {
        type: 'bar',
        x: ['A', 'B'],
        y: [10, 20],
        width: [0.2, 0.4],
        base: [1, 2],
        hovertext: ['ha', 'hb'],
      } as Data,
    ]
    const normalized = normalizeBarSplitTraces(input)
    expect(normalized.changed).toBe(true)
    const first = normalized.data[0] as any
    const second = normalized.data[1] as any
    expect(first.width).toEqual([0.2])
    expect(second.width).toEqual([0.4])
    expect(first.base).toEqual([1])
    expect(second.base).toEqual([2])
    expect(first.hovertext).toEqual(['ha'])
    expect(second.hovertext).toEqual(['hb'])
  })

  it('slices asymmetric error arrays including arrayminus/arrayplus', () => {
    const input: Data[] = [
      {
        type: 'bar',
        x: ['A', 'B'],
        y: [10, 20],
        error_y: {
          type: 'data',
          array: [1, 2],
          arrayminus: [0.5, 0.7],
          arrayplus: [1.5, 1.8],
          visible: true,
        },
      } as Data,
    ]
    const normalized = normalizeBarSplitTraces(input)
    const first = normalized.data[0] as any
    const second = normalized.data[1] as any
    expect(first.error_y.array).toEqual([1])
    expect(second.error_y.array).toEqual([2])
    expect(first.error_y.arrayminus).toEqual([0.5])
    expect(second.error_y.arrayminus).toEqual([0.7])
    expect(first.error_y.arrayplus).toEqual([1.5])
    expect(second.error_y.arrayplus).toEqual([1.8])
  })

  it('preserves per-category frame widths and colors during split', () => {
    const input: Data[] = [
      {
        type: 'bar',
        x: ['A', 'B'],
        y: [5, 6],
        marker: {
          color: ['#f00', '#0f0'],
          line: { width: [0, 1], color: ['#000000', '#000000'] },
        },
      } as Data,
    ]

    const normalized = normalizeBarSplitTraces(input)
    expect(normalized.changed).toBe(true)
    const first = normalized.data[0] as any
    const second = normalized.data[1] as any
    expect(first.marker.line.width).toBe(0)
    expect(second.marker.line.width).toBe(1)
    expect(first.marker.line.color).toBe('#000000')
    expect(second.marker.line.color).toBe('#000000')
  })
})
