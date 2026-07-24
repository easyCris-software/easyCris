import { describe, expect, it } from 'vitest'
import type { PCAResult } from '@/types/rnaseq'
import { getPcaGeneSelectionText } from '@/components/rnaseq/RNAseqPlotPanel'

function makePcaData(overrides: Partial<PCAResult> = {}): PCAResult {
  return {
    samples: [],
    loadings: [],
    varianceExplained: [65.1, 12.8],
    genesUsed: 500,
    ...overrides,
  }
}

describe('RNAseqPlotPanel PCA selection text helper', () => {
  it('renders significant_then_variable summary and fallback note', () => {
    const text = getPcaGeneSelectionText(
      makePcaData({
        genesUsed: 500,
        geneSelection: {
          mode: 'significant_then_variable',
          significantUsed: 42,
          paddedWithVariance: true,
          fallbackToVarianceWhenEmpty: true,
          targetTopGenes: 500,
        },
      })
    )

    expect(text.summary).toBe(
      'Significant genes used: 42, supplemented with high-variance genes to 500'
    )
    expect(text.note).toBe(
      'No significant genes met threshold; transitioned to high-variance genes for PCA stability.'
    )
  })

  it('renders significant_only summary without max cap', () => {
    const text = getPcaGeneSelectionText(
      makePcaData({
        genesUsed: 88,
        geneSelection: {
          mode: 'significant_only',
          significantUsed: 88,
          paddedWithVariance: false,
          fallbackToVarianceWhenEmpty: false,
          targetTopGenes: 500,
        },
      })
    )

    expect(text.summary).toBe('Significant genes used: 88')
    expect(text.note).toBeNull()
  })

  it('renders auto-switch note when significant_only has too few significant genes', () => {
    const text = getPcaGeneSelectionText(
      makePcaData({
        genesUsed: 500,
        geneSelection: {
          mode: 'significant_only',
          effectiveMode: 'significant_then_variable',
          significantUsed: 7,
          paddedWithVariance: true,
          fallbackToVarianceWhenEmpty: false,
          targetTopGenes: 500,
          autoSwitchedToSignificantThenVariable: true,
          significantOnlyMinGenes: 15,
        },
      })
    )

    expect(text.summary).toBe(
      'Significant genes used: 7, supplemented with high-variance genes to 500'
    )
    expect(text.note).toBe(
      '7 significant gene(s) detected (< 15), so high-variance genes were added to stabilize PCA.'
    )
  })
})
