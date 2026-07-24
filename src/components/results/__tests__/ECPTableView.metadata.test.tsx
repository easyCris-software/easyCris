import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ECPTableView } from '@/components/results/ECPTableView'
import type { ECPTableCollection } from '@/types/ecpStyleTables'

describe('ECPTableView metadata header', () => {
  it('renders labeled counts instead of generic N when metadata.counts is present', () => {
    const tableCollection: ECPTableCollection = {
      testType: 'lmm_anova',
      testFamily: 'parametric',
      tables: [
        {
          title: 'Model Summary',
          columns: [
            { key: 'metric', header: 'Metric', align: 'left' },
            { key: 'value', header: 'Value', align: 'left' },
          ],
          rows: [
            {
              isHeader: true,
              cells: [
                { value: 'Metric', isHeader: true, align: 'left' },
                { value: 'Value', isHeader: true, align: 'left' },
              ],
            },
          ],
          testName: 'lmm_model_summary',
        },
      ],
      metadata: {
        timestamp: '2026-03-10T18:15:00.000Z',
        counts: [
          { label: 'Subjects', value: 24 },
          { label: 'Observations', value: 72 },
        ],
      },
    }

    render(<ECPTableView tableCollection={tableCollection} />)

    expect(screen.getByText('Subjects = 24')).toBeInTheDocument()
    expect(screen.getByText('Observations = 72')).toBeInTheDocument()
    expect(screen.queryByText('N = 72')).not.toBeInTheDocument()
  })
})
