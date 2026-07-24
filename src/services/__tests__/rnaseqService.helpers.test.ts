import { describe, it, expect } from 'vitest'
import type { Dataset } from '@/store/data-store'
import type { DESeqModel } from '@/types/rnaseq'
import { __testHelpers } from '@/services/rnaseqService'

const makeDataset = (): Dataset => ({
  id: 'ds_counts',
  name: 'Counts',
  rowCount: 3,
  dataRowCount: 3,
  columnCount: 3,
  columns: [
    { id: 'col-0', name: 'Gene', type: 'text' },
    { id: 'col-1', name: 'S1', type: 'numeric' },
    { id: 'col-2', name: 'S2', type: 'numeric' },
  ],
  importedAt: new Date(),
  modifiedAt: new Date(),
})

const makeRows = () => ([
  { 'col-0': 'GeneA', 'col-1': 1, 'col-2': 2 },
  { 'col-0': 'GeneA', 'col-1': 3, 'col-2': 4 },
  { 'col-0': 'GeneB', 'col-1': 5, 'col-2': 6 },
])

describe('rnaseqService helper duplicate policies', () => {
  it('user_provided + sum_duplicates aggregates duplicate rows', () => {
    const { counts, warnings } = __testHelpers.buildCountsPayload(makeDataset(), makeRows(), {
      geneLabelSource: 'user_provided',
      duplicatePolicy: 'sum_duplicates',
    })

    expect(counts.GeneA).toEqual({ S1: 4, S2: 6 })
    expect(counts.GeneB).toEqual({ S1: 5, S2: 6 })
    expect(warnings[0]).toContain('Applied duplicate policy: sum_duplicates')
  })

  it('user_provided + keep_first keeps only first duplicate row', () => {
    const { counts, warnings } = __testHelpers.buildCountsPayload(makeDataset(), makeRows(), {
      geneLabelSource: 'user_provided',
      duplicatePolicy: 'keep_first',
    })

    expect(counts.GeneA).toEqual({ S1: 1, S2: 2 })
    expect(counts.GeneB).toEqual({ S1: 5, S2: 6 })
    expect(warnings[0]).toContain('Applied duplicate policy: keep_first')
  })

  it('drops rows with empty gene labels and reports stats', () => {
    const rowsWithGaps = [
      { 'col-0': 'GeneA', 'col-1': 1, 'col-2': 2 },
      { 'col-0': '   ', 'col-1': 10, 'col-2': 20 },
      { 'col-0': '', 'col-1': 30, 'col-2': 40 },
      { 'col-0': null, 'col-1': 50, 'col-2': 60 },
      { 'col-0': 'GeneB', 'col-1': 5, 'col-2': 6 },
    ] as unknown as Record<string, unknown>[]

    const { counts, warnings, missingLabelRows, usableLabelRows } = __testHelpers.buildCountsPayload(
      makeDataset(),
      rowsWithGaps,
      { geneLabelSource: 'id_lookup' }
    )

    expect(counts.GeneA).toEqual({ S1: 1, S2: 2 })
    expect(counts.GeneB).toEqual({ S1: 5, S2: 6 })
    expect(missingLabelRows).toBe(3)
    expect(usableLabelRows).toBe(2)
    expect(warnings[0]).toContain('Dropped 3 row(s) with empty gene labels before analysis')
  })

  it('drops structurally empty sample columns before payload build', () => {
    const datasetWithPadding = {
      ...makeDataset(),
      columnCount: 4,
      columns: [
        { id: 'col-0', name: 'Gene', type: 'text' as const },
        { id: 'col-1', name: 'S1', type: 'numeric' as const },
        { id: 'col-2', name: 'S2', type: 'numeric' as const },
        { id: 'col-3', name: 'Column 4', type: 'text' as const },
      ],
    } as Dataset
    const rows = [
      { 'col-0': 'GeneA', 'col-1': 1, 'col-2': 2, 'col-3': '' },
      { 'col-0': 'GeneB', 'col-1': 3, 'col-2': 4, 'col-3': '   ' },
      { 'col-0': 'GeneC', 'col-1': 5, 'col-2': 6, 'col-3': null },
    ] as unknown as Record<string, unknown>[]

    const { counts, warnings, usableSampleColumnCount, droppedStructurallyEmptySampleColumns } =
      __testHelpers.buildCountsPayload(datasetWithPadding, rows, { geneLabelSource: 'id_lookup' })

    expect(usableSampleColumnCount).toBe(2)
    expect(droppedStructurallyEmptySampleColumns).toBe(1)
    expect(warnings[0]).toContain('Dropped 1 structurally empty sample column(s)')
    expect(counts.GeneA).toEqual({ S1: 1, S2: 2 })
    expect(Object.prototype.hasOwnProperty.call(counts.GeneA, 'Column 4')).toBe(false)
  })

  it('ignores structurally non-empty sample values on rows with empty gene labels', () => {
    const datasetWithPadding = {
      ...makeDataset(),
      columnCount: 4,
      columns: [
        { id: 'col-0', name: 'Gene', type: 'text' as const },
        { id: 'col-1', name: 'S1', type: 'numeric' as const },
        { id: 'col-2', name: 'S2', type: 'numeric' as const },
        { id: 'col-3', name: 'Column 4', type: 'text' as const },
      ],
    } as Dataset
    const rows = [
      { 'col-0': '', 'col-1': 1, 'col-2': 2, 'col-3': 'ghost' },
      { 'col-0': '   ', 'col-1': 3, 'col-2': 4, 'col-3': 'ghost2' },
      { 'col-0': 'GeneA', 'col-1': 5, 'col-2': 6, 'col-3': '' },
      { 'col-0': 'GeneB', 'col-1': 7, 'col-2': 8, 'col-3': null },
    ] as unknown as Record<string, unknown>[]

    const { counts, missingLabelRows, usableSampleColumnCount, droppedStructurallyEmptySampleColumns } =
      __testHelpers.buildCountsPayload(datasetWithPadding, rows, { geneLabelSource: 'id_lookup' })

    expect(missingLabelRows).toBe(2)
    expect(usableSampleColumnCount).toBe(2)
    expect(droppedStructurallyEmptySampleColumns).toBe(1)
    expect(counts.GeneA).toEqual({ S1: 5, S2: 6 })
    expect(counts.GeneB).toEqual({ S1: 7, S2: 8 })
    expect(Object.prototype.hasOwnProperty.call(counts.GeneA, 'Column 4')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(counts.GeneB, 'Column 4')).toBe(false)
  })
})

describe('rnaseqService helper warning filtering', () => {
  it('suppresses structurally empty sample-column warning but keeps other warnings', () => {
    const warnings = __testHelpers.dedupeWarnings([
      'Dropped 75 structurally empty sample column(s) before sample matching.',
      '72858 Ensembl IDs with version suffixes were merged by base ID. Examples: A -> B.',
      '72858 Ensembl IDs with version suffixes were merged by base ID. Examples: A -> B.',
    ])

    expect(warnings).toEqual([
      '72858 Ensembl IDs with version suffixes were merged by base ID. Examples: A -> B.',
    ])
  })
})

describe('rnaseqService helper parameter mapping', () => {
  it('maps gene label metadata into parameters', () => {
    const model = {
      id: 'm1',
      name: 'Model',
      designFormula: '~condition',
      mainFactor: 'condition',
      mainFactorReference: 'A',
      mainFactorTest: 'B',
      covariates: [],
      applyShrinkage: false,
      shrinkageMethod: 'apeglm',
      organism: 'mmusculus',
      geneIdType: 'ensembl',
      geneLabelSource: 'user_provided',
      alpha: 0.05,
      minCount: 10,
      minSamples: 3,
      usePadjForSignificance: true,
      pcaTopGenes: 500,
      pcaGeneSelectionMode: 'significant_then_variable',
    } as DESeqModel

    const mapped = __testHelpers.mapParameters(
      {
        gene_label_source: 'user_provided',
        duplicate_policy: 'keep_first',
        duplicate_count: 12,
      },
      model
    )

    expect(mapped.geneLabelSource).toBe('user_provided')
    expect(mapped.duplicatePolicy).toBe('keep_first')
    expect(mapped.duplicateCount).toBe(12)
    expect(mapped.missingLabelRows).toBe(0)
    expect(mapped.usableLabelRows).toBe(0)
    expect(mapped.missingLabelPct).toBe(0)
  })
})

describe('rnaseqService helper PCA mapping', () => {
  it('maps backend gene_selection fields to frontend PCAResult shape', () => {
    const mapped = __testHelpers.mapPca({
      samples: [],
      loadings: [],
      variance_explained: [71.2, 12.3],
      genes_used: 500,
      gene_selection: {
        mode: 'significant_then_variable',
        effective_mode: 'significant_then_variable',
        significant_used: 37,
        padded_with_variance: true,
        fallback_to_variance_when_empty: false,
        target_top_genes: 500,
        auto_switched_to_significant_then_variable: false,
        significant_only_min_genes: 15,
      },
    })

    expect(mapped?.varianceExplained).toEqual([71.2, 12.3])
    expect(mapped?.genesUsed).toBe(500)
    expect(mapped?.geneSelection).toEqual({
      mode: 'significant_then_variable',
      effectiveMode: 'significant_then_variable',
      significantUsed: 37,
      paddedWithVariance: true,
      fallbackToVarianceWhenEmpty: false,
      targetTopGenes: 500,
      autoSwitchedToSignificantThenVariable: false,
      significantOnlyMinGenes: 15,
    })
  })
})
