import { describe, expect, it } from 'vitest'
import { hasLocalClipboardColumns } from '../clipboardFastPath'

describe('hasLocalClipboardColumns', () => {
  it('returns false for an empty row object when columns are selected', () => {
    expect(hasLocalClipboardColumns({}, ['col-1'])).toBe(false)
  })

  it('returns false for sparse local row patches missing a selected column', () => {
    expect(hasLocalClipboardColumns({ 'col-1': 'typed' }, ['col-1', 'col-2'])).toBe(false)
  })

  it('returns true only when every selected column exists on the local row', () => {
    expect(
      hasLocalClipboardColumns(
        { 'col-1': 'typed', 'col-2': 'backend-col2', extra: 'ignored' },
        ['col-1', 'col-2']
      )
    ).toBe(true)
  })
})
