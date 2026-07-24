import { describe, expect, it } from 'vitest'
import type { Data } from 'plotly.js'
import {
  applyColorToAllBarCategories,
  applyBarCategoryStyles,
  extractBarCategoryStyles,
  setBarCategoryColor,
  setBarCategoryFrame,
  setBarCategoryPattern,
} from '../barCategoryStyles'

const buildTrace = (): Data =>
  ({
    type: 'bar',
    x: ['B', 'A', 'C'],
    y: [2, 4, 6],
    marker: {
      color: ['#ff0000', '#00ff00', '#0000ff'],
    },
  }) as Data

describe('barCategoryStyles', () => {
  it('extracts defaults for bars without explicit pattern/line arrays', () => {
    const styles = extractBarCategoryStyles(buildTrace())
    expect(styles).toHaveLength(3)
    expect(styles[0]?.color).toBe('#ff0000')
    expect(styles[1]?.patternShape).toBe('solid')
    expect(styles[2]?.lineWidth).toBe(1)
  })

  it('persists category styles by label so reorder keeps assignments', () => {
    const base = buildTrace()
    const styled = setBarCategoryColor(base, 0, '#123456')
    const reordered = {
      ...(styled as any),
      x: ['A', 'B', 'C'],
    } as Data
    const styles = extractBarCategoryStyles(reordered)
    expect(styles[0]?.color).toBe('#00ff00')
    expect(styles[1]?.color).toBe('#123456')
  })

  it('supports per-category pattern and frame updates', () => {
    const base = buildTrace()
    const patterned = setBarCategoryPattern(base, 1, 'x')
    const framed = setBarCategoryFrame(patterned, 1, false)
    const styles = extractBarCategoryStyles(framed)
    expect(styles[1]?.patternShape).toBe('x')
    expect(styles[1]?.patternBgcolor).toBe(styles[1]?.color)
    expect(styles[1]?.lineWidth).toBe(0)
  })

  it('enabling frame forces black outline for visibility', () => {
    const base = {
      type: 'bar',
      x: ['A'],
      y: [2],
      marker: {
        color: ['#ff0000'],
        line: { color: ['#ff0000'], width: [0] },
      },
    } as Data

    const updated = setBarCategoryFrame(base, 0, true)
    const styles = extractBarCategoryStyles(updated)

    expect(styles[0]?.lineWidth).toBeGreaterThan(0)
    expect(styles[0]?.lineColor).toBe('#000000')
  })

  it('applies one color to all categories explicitly', () => {
    const base = buildTrace()
    const updated = applyColorToAllBarCategories(base, '#222222')
    const styles = extractBarCategoryStyles(updated)
    expect(styles.map((entry) => entry.color)).toEqual([
      '#222222',
      '#222222',
      '#222222',
    ])
  })

  it('global recolor keeps frame intent and normalizes outline color to black', () => {
    const base = {
      type: 'bar',
      x: ['A', 'B'],
      y: [2, 4],
      marker: {
        color: ['#00aa00', '#0000aa'],
        line: { width: [0, 0], color: ['#00aa00', '#0000aa'] },
      },
    } as Data

    const updated = applyColorToAllBarCategories(base, '#ff0000')
    const styles = extractBarCategoryStyles(updated)

    expect(styles.map((entry) => entry.lineWidth)).toEqual([0, 0])
    expect(styles.map((entry) => entry.lineColor)).toEqual(['#000000', '#000000'])
  })

  it('normalizes scalar legacy pattern/line values to arrays on first category edit', () => {
    const legacy = {
      type: 'bar',
      x: ['A', 'B'],
      y: [1, 2],
      marker: {
        color: ['#aa0000', '#00aa00'],
        pattern: { shape: '/', size: 7, solidity: 0.4, bgcolor: '#ffffff', fgcolor: '#111111' },
        line: { width: 1, color: '#000000' },
      },
    } as Data
    const updated = setBarCategoryPattern(legacy, 0, 'solid') as any
    expect(Array.isArray(updated.marker.pattern.shape)).toBe(true)
    expect(Array.isArray(updated.marker.line.width)).toBe(true)
  })

  it('fills deterministic defaults for newly added categories', () => {
    const base = buildTrace()
    const styled = setBarCategoryColor(base, 0, '#123456')
    const expanded = { ...(styled as any), x: ['B', 'A', 'C', 'D'], y: [2, 4, 6, 8] } as Data
    const normalized = applyBarCategoryStyles(expanded, extractBarCategoryStyles(expanded))
    const styles = extractBarCategoryStyles(normalized)
    expect(styles).toHaveLength(4)
    expect(styles[0]?.color).toBe('#123456')
    expect(styles[3]?.color).toBeTruthy()
  })

  it('keeps duplicate-label categories independent', () => {
    const duplicateLabels = {
      type: 'bar',
      x: ['A', 'A', 'B'],
      y: [1, 2, 3],
      marker: {
        color: ['#111111', '#222222', '#333333'],
      },
    } as Data
    const updated = setBarCategoryColor(duplicateLabels, 0, '#abcdef')
    const styles = extractBarCategoryStyles(updated)
    expect(styles[0]?.color).toBe('#abcdef')
    expect(styles[1]?.color).toBe('#222222')
    expect(styles[2]?.color).toBe('#333333')
  })
})
