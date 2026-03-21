import { render, screen, fireEvent } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { LmmSimpleEffectsDialog } from './LmmSimpleEffectsDialog'
import { MultiFactorialSimpleEffectsDialog } from './MultiFactorialSimpleEffectsDialog'

const FACTOR_NAMES = ['Treatment', 'Day']
const FACTOR_LEVELS = { Treatment: ['VEH', 'THC'], Day: ['Day1', 'Day7'] }

describe('LmmSimpleEffectsDialog', () => {
  it('renders LMM-specific title and description', () => {
    render(
      <LmmSimpleEffectsDialog
        open
        onOpenChange={() => {}}
        factorNames={FACTOR_NAMES}
        factorLevels={FACTOR_LEVELS}
        testIdPrefix="lmm"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText('LMM Simple Effects')).toBeInTheDocument()
    expect(
      screen.getByText(/predictors that remain inside each subgroup or pooled mixed model/i)
    ).toBeInTheDocument()
  })

  it('renders LMM-specific explanation copy, not ANOVA copy', () => {
    render(
      <LmmSimpleEffectsDialog
        open
        onOpenChange={() => {}}
        factorNames={FACTOR_NAMES}
        factorLevels={FACTOR_LEVELS}
        testIdPrefix="lmm"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText(/What are simple effects in mixed models/i)).toBeInTheDocument()
    expect(screen.getByText(/Drug A vs Control differs at each Day level/i)).toBeInTheDocument()
    expect(screen.queryByText(/multi-factorial designs/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Scheirer-Ray-Hare/i)).not.toBeInTheDocument()
  })

  it('does not render adjustment controls', () => {
    render(
      <LmmSimpleEffectsDialog
        open
        onOpenChange={() => {}}
        factorNames={FACTOR_NAMES}
        factorLevels={FACTOR_LEVELS}
        testIdPrefix="lmm"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.queryByTestId('lmm-adjustment-select')).not.toBeInTheDocument()
  })

  it('emits only simple effects when adjustment controls are hidden', () => {
    const onConfirm = vi.fn()
    render(
      <LmmSimpleEffectsDialog
        open
        onOpenChange={() => {}}
        factorNames={FACTOR_NAMES}
        factorLevels={FACTOR_LEVELS}
        testIdPrefix="lmm"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('lmm-run-button'))

    expect(onConfirm).toHaveBeenCalledWith({ simpleEffects: [] })
  })
})

describe('MultiFactorialSimpleEffectsDialog', () => {
  it('renders ANOVA-specific title and description', () => {
    render(
      <MultiFactorialSimpleEffectsDialog
        open
        onOpenChange={() => {}}
        factorNames={FACTOR_NAMES}
        factorLevels={FACTOR_LEVELS}
        testIdPrefix="multi"
        showAdjustmentControls
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText('Multi-Factorial Simple Effects (ANOVA)')).toBeInTheDocument()
    expect(screen.getByText(/Scheirer-Ray-Hare/i)).toBeInTheDocument()
    expect(screen.queryByText(/mixed model/i)).not.toBeInTheDocument()
  })

  it('renders adjustment controls for ANOVA path', () => {
    render(
      <MultiFactorialSimpleEffectsDialog
        open
        onOpenChange={() => {}}
        factorNames={FACTOR_NAMES}
        factorLevels={FACTOR_LEVELS}
        testIdPrefix="multi"
        showAdjustmentControls
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByTestId('multi-adjustment-select')).toBeInTheDocument()
  })
})
