import { render, screen, waitFor } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { SampleDatasetsDialog } from '../SampleDatasetsDialog'

const tauriApiHarness = vi.hoisted(() => ({
  getSampleDatasets: vi.fn(),
  readSampleDatasetPreview: vi.fn(),
}))

vi.mock('@/services/tauriApi', () => ({ tauriApi: tauriApiHarness }))

describe('SampleDatasetsDialog', () => {
  it('sorts datasets alphabetically inside each group', async () => {
    tauriApiHarness.getSampleDatasets.mockResolvedValue([
      {
        id: 'lmm_anova',
        name: 'Linear Mixed Model',
        description: 'Sample dataset for Linear Mixed Model.',
        file: 'Group1_Hypothesis_Testing/linear_mixed_model.csv',
        group: 'Group1_Hypothesis_Testing',
        path: 'linear_mixed_model.csv',
        rows: 120,
        columns: 7,
      },
      {
        id: 'anova_one_way',
        name: 'Anova One Way',
        description: 'Sample dataset for Anova One Way.',
        file: 'Group1_Hypothesis_Testing/anova_one_way.csv',
        group: 'Group1_Hypothesis_Testing',
        path: 'anova_one_way.csv',
        rows: 24,
        columns: 2,
      },
    ])
    tauriApiHarness.readSampleDatasetPreview.mockResolvedValue('a,b\n1,2')

    render(
      <SampleDatasetsDialog
        open
        onOpenChange={vi.fn()}
        onImportDataset={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Anova One Way')).toBeInTheDocument()
      expect(screen.getAllByText('Linear Mixed Model').length).toBeGreaterThan(0)
    })

    const anova = screen.getByText('Anova One Way')
    const lmm = screen.getAllByText('Linear Mixed Model')[0]
    if (!lmm) throw new Error('Linear Mixed Model list entry not found')
    expect(anova.compareDocumentPosition(lmm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByText('Sample dataset for Linear Mixed Model.').length).toBeGreaterThan(0)
  })
})
