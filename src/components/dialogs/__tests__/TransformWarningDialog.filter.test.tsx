/**
 * TransformWarningDialog.filter.test.tsx
 *
 * Phase 4 TDD tests for transform filter guardrails.
 * Written RED-first — tests describe the desired behavior before implementation.
 *
 * Tests:
 *   TRANSFORM_LABEL_DISTINCT      - filter transform label is visually distinct
 *                                   from view filter label (must contain "Permanent")
 *   TRANSFORM_ALWAYS_WARNS        - warning dialog renders when open for filter type
 *   TRANSFORM_CANCEL_NO_MUTATION  - clicking Cancel calls onCancel, never onConfirm
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TransformWarningDialog } from '../TransformWarningDialog'
import { getTransformLabel } from '@/lib/grid/getTransformLabel'

// ---------------------------------------------------------------------------

describe('TransformWarningDialog — filter type (Phase 4 guardrails)', () => {
  it('TRANSFORM_LABEL_DISTINCT: filter transform label contains "Permanent" to distinguish from view filter', () => {
    render(
      <TransformWarningDialog
        open
        transformType="filter"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    // The dialog must contain the word "Permanent" somewhere in its visible text
    // so users understand this is a destructive, irreversible operation — not the
    // non-destructive view filter.
    expect(screen.getByRole('dialog')).toHaveTextContent(/permanent/i)
  })

  it('TRANSFORM_ALWAYS_WARNS: warning dialog renders its title when open for filter type', () => {
    render(
      <TransformWarningDialog
        open
        transformType="filter"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    // The dialog must present a title so the user knows they are about to do something destructive.
    // Heading text should reference the filter operation being applied.
    expect(screen.getByRole('heading')).toBeInTheDocument()
    expect(screen.getByRole('heading')).toHaveTextContent(/filter/i)
  })

  it('TRANSFORM_CANCEL_NO_MUTATION: clicking Cancel calls onCancel, never calls onConfirm', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <TransformWarningDialog
        open
        transformType="filter"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('TRANSFORM_LABEL_PROPAGATES: dialog visible label matches getTransformLabel("filter") — no drift possible', () => {
    render(
      <TransformWarningDialog
        open
        transformType="filter"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    // If TransformWarningDialog ever reverts to a local TRANSFORM_LABELS map that
    // diverges from getTransformLabel, this test catches it.
    const canonicalLabel = getTransformLabel('filter')
    expect(screen.getByRole('dialog')).toHaveTextContent(canonicalLabel)
  })
})
