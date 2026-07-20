import { fireEvent, render } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { useKeyboardShortcuts } from '../useKeyboardShortcuts'
import { useRef } from 'react'

function KeyboardHarness({
  onRecalculate,
  onSelectAll,
  onCut,
  onCopy,
}: {
  onRecalculate: () => void
  onSelectAll?: () => boolean | Promise<boolean>
  onCut?: () => boolean | Promise<boolean>
  onCopy?: () => boolean | Promise<boolean>
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useKeyboardShortcuts({
    onRecalculate,
    onSelectAll,
    onCut,
    onCopy,
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

  it('does not prevent default for Ctrl+A when onSelectAll returns false', () => {
    const onRecalculate = vi.fn()
    const onSelectAll = vi.fn(() => false)
    render(<KeyboardHarness onRecalculate={onRecalculate} onSelectAll={onSelectAll} />)

    const event = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      cancelable: true,
    })
    window.dispatchEvent(event)

    expect(onSelectAll).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
  })

  it('prevents default for Ctrl+A when onSelectAll returns true', () => {
    const onRecalculate = vi.fn()
    const onSelectAll = vi.fn(() => true)
    render(<KeyboardHarness onRecalculate={onRecalculate} onSelectAll={onSelectAll} />)

    const event = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      cancelable: true,
    })
    window.dispatchEvent(event)

    expect(onSelectAll).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not prevent default for Ctrl+A when onSelectAll returns Promise<boolean>', async () => {
    const onRecalculate = vi.fn()
    const onSelectAll = vi.fn(async () => true)
    render(<KeyboardHarness onRecalculate={onRecalculate} onSelectAll={onSelectAll} />)

    const event = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      cancelable: true,
    })
    window.dispatchEvent(event)

    expect(onSelectAll).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores repeated Ctrl+X before dispatching cut', () => {
    const onRecalculate = vi.fn()
    const onCut = vi.fn(() => true)
    render(<KeyboardHarness onRecalculate={onRecalculate} onCut={onCut} />)

    const event = new KeyboardEvent('keydown', {
      key: 'x',
      code: 'KeyX',
      ctrlKey: true,
      repeat: true,
      cancelable: true,
    })
    window.dispatchEvent(event)

    expect(onCut).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('still dispatches non-repeated Ctrl+X', () => {
    const onRecalculate = vi.fn()
    const onCut = vi.fn(() => true)
    render(<KeyboardHarness onRecalculate={onRecalculate} onCut={onCut} />)

    const event = new KeyboardEvent('keydown', {
      key: 'x',
      code: 'KeyX',
      ctrlKey: true,
      cancelable: true,
    })
    window.dispatchEvent(event)

    expect(onCut).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not suppress repeated Ctrl+C', () => {
    const onRecalculate = vi.fn()
    const onCopy = vi.fn(() => true)
    render(<KeyboardHarness onRecalculate={onRecalculate} onCopy={onCopy} />)

    const event = new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      repeat: true,
      cancelable: true,
    })
    window.dispatchEvent(event)

    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })
})
