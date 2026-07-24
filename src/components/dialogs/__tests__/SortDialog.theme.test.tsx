import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SortDialog } from '../SortDialog'

describe('SortDialog theme integration', () => {
  it('uses the shared themed dialog surface instead of an inline light surface', () => {
    render(
      <SortDialog
        isOpen
        onClose={vi.fn()}
        columns={[
          { id: 'col-1', name: 'Column 1', type: 'numeric' },
          { id: 'col-2', name: 'Column 2', type: 'text' },
        ]}
        sortModel={[]}
        onSort={vi.fn()}
        onClearSort={vi.fn()}
      />
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('bg-background')
    expect(dialog.getAttribute('style') ?? '').not.toContain('background')

    const styledDescendants = Array.from(dialog.querySelectorAll('[style]'))
    expect(
      styledDescendants.filter(node => {
        const style = node.getAttribute('style') ?? ''
        return /background|color/i.test(style)
      })
    ).toHaveLength(0)

    const classedDescendants = [
      dialog,
      ...Array.from(dialog.querySelectorAll('[class]')),
    ]
    expect(
      classedDescendants.filter(node =>
        /\b(bg-white|bg-gray-50|text-gray-[4-9]00|border-gray-[2-4]00)\b/.test(
          node.getAttribute('class') ?? ''
        )
      )
    ).toHaveLength(0)
  })
})
