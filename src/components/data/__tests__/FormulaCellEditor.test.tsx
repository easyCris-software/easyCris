import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { GridCellKind } from '@glideapps/glide-data-grid'
import { FormulaCellEditor } from '../FormulaCellEditor'

describe('FormulaCellEditor scroll migration', () => {
  it('migrates range-pick edit to formula bar on grid scroll even when input is not focused', async () => {
    const onFinishedEditing = vi.fn()

    render(
      <FormulaCellEditor
        onChange={vi.fn()}
        onFinishedEditing={onFinishedEditing}
        isHighlighted={false}
        value={
          {
            kind: GridCellKind.Text,
            data: '',
            displayData: '',
            allowOverlay: true,
          } as any
        }
        initialValue="=SUM("
        target={{ x: 10, y: 20, width: 120, height: 24 } as any}
        forceEditMode
        theme={{} as any}
      />
    )

    const input = screen.getByDisplayValue('=SUM(') as HTMLInputElement
    input.setSelectionRange(5, 5)
    input.blur()

    const scroller = document.createElement('div')
    scroller.className = 'dvn-scroller'
    document.body.appendChild(scroller)

    fireEvent.wheel(scroller)

    await waitFor(() => {
      expect(onFinishedEditing).toHaveBeenCalled()
      const lastCall = onFinishedEditing.mock.calls.at(-1)
      expect(lastCall?.[0]).toBeUndefined()
    })
  })

  it('keeps formula draft out of grid onChange until explicit commit', () => {
    const onFinishedEditing = vi.fn()
    const onChange = vi.fn()

    render(
      <FormulaCellEditor
        onChange={onChange}
        onFinishedEditing={onFinishedEditing}
        isHighlighted={false}
        value={
          {
            kind: GridCellKind.Text,
            data: '',
            displayData: '',
            allowOverlay: true,
          } as any
        }
        initialValue=""
        target={{ x: 10, y: 20, width: 120, height: 24 } as any}
        forceEditMode
        theme={{} as any}
      />
    )

    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '=SUM(' } })

    expect(onChange).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onFinishedEditing).toHaveBeenCalled()
    const commitArg = onFinishedEditing.mock.calls[0]?.[0]
    expect(commitArg?.data).toBe('=SUM()')
  })

  it('emits a stable editorSessionId across inline draft updates', () => {
    const onFormulaSessionChange = vi.fn()

    render(
      <FormulaCellEditor
        onChange={vi.fn()}
        onFinishedEditing={vi.fn()}
        isHighlighted={false}
        value={
          {
            kind: GridCellKind.Text,
            data: '',
            displayData: '',
            allowOverlay: true,
          } as any
        }
        initialValue=""
        target={{ x: 10, y: 20, width: 120, height: 24 } as any}
        forceEditMode
        theme={{} as any}
        onFormulaSessionChange={onFormulaSessionChange}
      />
    )

    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: '=S' } })
    fireEvent.change(input, { target: { value: '=SU' } })

    const calls = onFormulaSessionChange.mock.calls
      .map((call) => call[0])
      .filter((snapshot) => snapshot && snapshot.source === 'cell')
    expect(calls.length).toBeGreaterThan(1)
    const firstId = calls[0].editorSessionId
    expect(typeof firstId).toBe('number')
    for (const snapshot of calls) {
      expect(snapshot.editorSessionId).toBe(firstId)
    }
  })

  it('commits plain edits on blur when not in range-pick mode', async () => {
    const onFinishedEditing = vi.fn()
    render(
      <FormulaCellEditor
        onChange={vi.fn()}
        onFinishedEditing={onFinishedEditing}
        isHighlighted={false}
        value={
          {
            kind: GridCellKind.Text,
            data: '',
            displayData: '',
            allowOverlay: true,
          } as any
        }
        initialValue=""
        target={{ x: 10, y: 20, width: 120, height: 24 } as any}
        forceEditMode
        theme={{} as any}
      />
    )

    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.blur(input)

    await waitFor(() => {
      expect(onFinishedEditing).toHaveBeenCalled()
      expect(onFinishedEditing.mock.calls[0]?.[0]?.data).toBe('hello')
    })
  })

  it('does not commit on blur while in formula range-pick mode', () => {
    const onFinishedEditing = vi.fn()
    render(
      <FormulaCellEditor
        onChange={vi.fn()}
        onFinishedEditing={onFinishedEditing}
        isHighlighted={false}
        value={
          {
            kind: GridCellKind.Text,
            data: '',
            displayData: '',
            allowOverlay: true,
          } as any
        }
        initialValue="=SUM("
        target={{ x: 10, y: 20, width: 120, height: 24 } as any}
        forceEditMode
        theme={{} as any}
      />
    )

    const input = screen.getByRole('textbox') as HTMLInputElement
    input.setSelectionRange(5, 5)
    fireEvent.blur(input)

    expect(onFinishedEditing).not.toHaveBeenCalled()
  })

  it('toggles absolute references with F4 while editing formulas', async () => {
    render(
      <FormulaCellEditor
        onChange={vi.fn()}
        onFinishedEditing={vi.fn()}
        isHighlighted={false}
        value={
          {
            kind: GridCellKind.Text,
            data: '',
            displayData: '',
            allowOverlay: true,
          } as any
        }
        initialValue="=A1"
        target={{ x: 10, y: 20, width: 120, height: 24 } as any}
        forceEditMode
        theme={{} as any}
      />
    )

    const input = screen.getByRole('textbox') as HTMLInputElement
    input.setSelectionRange(2, 2)
    fireEvent.keyDown(input, { key: 'F4' })

    await waitFor(() => {
      expect(input.value).toBe('=$A$1')
    })
  })

  it('routes arrow keys to range-pick callback instead of committing', () => {
    const onRangePickArrow = vi.fn()
    const onFinishedEditing = vi.fn()

    render(
      <FormulaCellEditor
        onChange={vi.fn()}
        onFinishedEditing={onFinishedEditing}
        isHighlighted={false}
        value={
          {
            kind: GridCellKind.Text,
            data: '',
            displayData: '',
            allowOverlay: true,
          } as any
        }
        initialValue="=SUM("
        target={{ x: 10, y: 20, width: 120, height: 24 } as any}
        forceEditMode
        theme={{} as any}
        onRangePickArrow={onRangePickArrow}
      />
    )

    const input = screen.getByRole('textbox') as HTMLInputElement
    input.setSelectionRange(5, 5)

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowRight', shiftKey: true })

    expect(onRangePickArrow).toHaveBeenNthCalledWith(1, [0, 1], false)
    expect(onRangePickArrow).toHaveBeenNthCalledWith(2, [1, 0], true)
    expect(onFinishedEditing).not.toHaveBeenCalled()
  })
})
