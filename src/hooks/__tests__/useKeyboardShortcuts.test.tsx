import { fireEvent, render } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { useKeyboardShortcuts } from '../useKeyboardShortcuts'
import { useRef } from 'react'

function KeyboardHarness({ onRecalculate }: { onRecalculate: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useKeyboardShortcuts({
    onRecalculate,
  } as any, { containerRef })

  return (
    <div>
      <div ref={containerRef} data-testid="keyboard-harness">
        <button type="button" data-testid="inside-button">Inside</button>
        <input data-testid="inside-input" />
      </div>
      <button type="button" data-testid="outside-button">Outside</button>
      <input data-testid="outside-input" />
    </div>
  )
}

describe('useKeyboardShortcuts', () => {
  it('invokes recalculate on F9 when spreadsheet context is active', () => {
    const onRecalculate = vi.fn()

    const { getByTestId } = render(<KeyboardHarness onRecalculate={onRecalculate} />)
    ;(getByTestId('inside-button') as HTMLButtonElement).focus()

    fireEvent.keyDown(window, { key: 'F9', code: 'F9' })

    expect(onRecalculate).toHaveBeenCalledTimes(1)
  })

  it('does not invoke recalculate while an editable field is focused', () => {
    const onRecalculate = vi.fn()

    const { getByTestId } = render(<KeyboardHarness onRecalculate={onRecalculate} />)
    ;(getByTestId('inside-input') as HTMLInputElement).focus()

    fireEvent.keyDown(window, { key: 'F9', code: 'F9' })

    expect(onRecalculate).not.toHaveBeenCalled()
  })

  it('does not invoke recalculate outside spreadsheet context', () => {
    const onRecalculate = vi.fn()

    const { getByTestId } = render(<KeyboardHarness onRecalculate={onRecalculate} />)
    ;(getByTestId('outside-button') as HTMLButtonElement).focus()

    fireEvent.keyDown(window, { key: 'F9', code: 'F9' })

    expect(onRecalculate).not.toHaveBeenCalled()
  })
})
