import { describe, expect, it } from 'vitest'
import type { PCAResult } from '@/types/rnaseq'
import { buildPCABiplot } from '@/components/rnaseq/plots/pcaBiplot'

const makePcaResult = (groups: string[], groupKey: string = 'condition'): PCAResult => ({
  samples: groups.map((group, index) => ({
    sampleId: `S${index + 1}`,
    PC1: index * 1.1,
    PC2: index * -0.9,
    metadata: { [groupKey]: group },
  })),
  loadings: [],
  varianceExplained: [55.1, 21.3],
  genesUsed: 500,
})

function getTraceColorByName(plot: ReturnType<typeof buildPCABiplot>, name: string): string | null {
  const trace = plot.data.find((entry) => String((entry as { name?: unknown }).name) === name)
  if (!trace) return null
  const markerColor = (trace as { marker?: { color?: unknown } }).marker?.color
  return typeof markerColor === 'string' ? markerColor : null
}

describe('buildPCABiplot contrast-aware colors', () => {
  it('maps reference/test to blue/red regardless of names', () => {
    const result = makePcaResult(['untreated', 'treated', 'untreated', 'treated'])
    const plot = buildPCABiplot(result, {
      colorBy: 'condition',
      useContrastRoleColors: true,
      referenceLevel: 'untreated',
      testLevel: 'treated',
      showEllipses: false,
      showLabels: false,
      nGeneArrows: 0,
    })

    expect(getTraceColorByName(plot, 'untreated')).toBe('#0000FF')
    expect(getTraceColorByName(plot, 'treated')).toBe('#FF0000')
  })

  it('keeps extra levels away from reserved blue/red in non-null model', () => {
    const result = makePcaResult(['untreated', 'treated', 'mid', 'other'])
    const plot = buildPCABiplot(result, {
      colorBy: 'condition',
      useContrastRoleColors: true,
      referenceLevel: 'untreated',
      testLevel: 'treated',
      showEllipses: false,
      showLabels: false,
      nGeneArrows: 0,
    })

    expect(getTraceColorByName(plot, 'untreated')).toBe('#0000FF')
    expect(getTraceColorByName(plot, 'treated')).toBe('#FF0000')
    expect(getTraceColorByName(plot, 'mid')).not.toBe('#0000FF')
    expect(getTraceColorByName(plot, 'mid')).not.toBe('#FF0000')
    expect(getTraceColorByName(plot, 'other')).not.toBe('#0000FF')
    expect(getTraceColorByName(plot, 'other')).not.toBe('#FF0000')
  })

  it('does not force blue/red in null model mapping', () => {
    const result = makePcaResult(['untreated', 'treated', 'other'])
    const plot = buildPCABiplot(result, {
      colorBy: 'condition',
      useContrastRoleColors: false,
      referenceLevel: 'untreated',
      testLevel: 'treated',
      showEllipses: false,
      showLabels: false,
      nGeneArrows: 0,
    })

    expect(getTraceColorByName(plot, 'untreated')).not.toBe('#0000FF')
    expect(getTraceColorByName(plot, 'untreated')).not.toBe('#FF0000')
    expect(getTraceColorByName(plot, 'treated')).not.toBe('#0000FF')
    expect(getTraceColorByName(plot, 'treated')).not.toBe('#FF0000')
  })

  it('returns legend entries consistent with runtime sample traces', () => {
    const result = makePcaResult(['untreated', 'treated', 'other'])
    const plot = buildPCABiplot(result, {
      colorBy: 'condition',
      useContrastRoleColors: true,
      referenceLevel: 'untreated',
      testLevel: 'treated',
      showEllipses: false,
      showLabels: false,
      nGeneArrows: 0,
    })

    for (const entry of plot.sampleLegend) {
      expect(getTraceColorByName(plot, entry.label)).toBe(entry.color)
    }
  })
})

