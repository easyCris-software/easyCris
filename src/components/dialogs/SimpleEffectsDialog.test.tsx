import { render, screen } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { SimpleEffectsDialog } from './SimpleEffectsDialog'

describe('SimpleEffectsDialog copy', () => {
  it('describes the dialog as a two-way ANOVA feature only', () => {
    render(
      <SimpleEffectsDialog
        open
        onOpenChange={() => {}}
        factor1Name="factor1"
        factor2Name="factor2"
        factor1Levels={['A', 'B']}
        factor2Levels={['X', 'Y']}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText('Simple Effects (Two-Way ANOVA)')).toBeInTheDocument()
    expect(screen.queryByText(/Scheirer-Ray-Hare/i)).not.toBeInTheDocument()
  })
})
