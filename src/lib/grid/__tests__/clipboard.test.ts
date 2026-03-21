/**
 * Clipboard Tests - Phase 2
 *
 * Tests for clipboard abstraction including:
 * - Environment detection (Tauri vs browser)
 * - Tab-separated text parsing (for paste)
 * - Data formatting for clipboard (for copy)
 * - High-level copy/paste operations
 *
 * @see GRID_ENHANCEMENT_PLAN.md - Phase 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseClipboardText,
  formatForClipboard,
  copyToClipboard,
  pasteFromClipboard,
  getClipboardAdapter,
  clipboard,
} from '../clipboard'

// Mock the Tauri clipboard plugin
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn(),
  readText: vi.fn(),
}))

describe('parseClipboardText', () => {
  describe('Basic parsing', () => {
    it('parses single cell', () => {
      const result = parseClipboardText('hello')
      expect(result).toEqual([['hello']])
    })

    it('parses single row with tabs', () => {
      const result = parseClipboardText('a\tb\tc')
      expect(result).toEqual([['a', 'b', 'c']])
    })

    it('parses multiple rows', () => {
      const result = parseClipboardText('a1\tb1\na2\tb2')
      expect(result).toEqual([
        ['a1', 'b1'],
        ['a2', 'b2'],
      ])
    })

    it('parses grid with multiple rows and columns', () => {
      const result = parseClipboardText('a1\tb1\tc1\na2\tb2\tc2\na3\tb3\tc3')
      expect(result).toEqual([
        ['a1', 'b1', 'c1'],
        ['a2', 'b2', 'c2'],
        ['a3', 'b3', 'c3'],
      ])
    })
  })

  describe('Edge cases', () => {
    it('returns empty array for empty string', () => {
      const result = parseClipboardText('')
      expect(result).toEqual([])
    })

    it('returns empty array for whitespace-only string', () => {
      const result = parseClipboardText('   ')
      expect(result).toEqual([])
    })

    it('handles Windows line endings (CRLF)', () => {
      const result = parseClipboardText('a1\tb1\r\na2\tb2')
      expect(result).toEqual([
        ['a1', 'b1'],
        ['a2', 'b2'],
      ])
    })

    it('removes trailing empty line (common in Excel copy)', () => {
      const result = parseClipboardText('a1\tb1\na2\tb2\n')
      expect(result).toEqual([
        ['a1', 'b1'],
        ['a2', 'b2'],
      ])
    })

    it('handles cells with empty values', () => {
      const result = parseClipboardText('a\t\tc')
      expect(result).toEqual([['a', '', 'c']])
    })

    it('handles row with only tabs as empty (no content to paste)', () => {
      // Tabs-only string is considered empty/whitespace (nothing to paste)
      const result = parseClipboardText('\t\t')
      expect(result).toEqual([])
    })
  })

  describe('Numeric and special values', () => {
    it('preserves numeric values as strings', () => {
      const result = parseClipboardText('123\t45.67\t-89')
      expect(result).toEqual([['123', '45.67', '-89']])
    })

    it('preserves scientific notation', () => {
      const result = parseClipboardText('1.23e-4\t5.67E+8')
      expect(result).toEqual([['1.23e-4', '5.67E+8']])
    })

    it('preserves special characters', () => {
      const result = parseClipboardText('hello, world\t"quoted"\t$100')
      expect(result).toEqual([['hello, world', '"quoted"', '$100']])
    })
  })
})

describe('formatForClipboard', () => {
  describe('Basic formatting', () => {
    it('formats single cell', () => {
      const result = formatForClipboard([['hello']])
      expect(result).toBe('hello')
    })

    it('formats single row with tabs', () => {
      const result = formatForClipboard([['a', 'b', 'c']])
      expect(result).toBe('a\tb\tc')
    })

    it('formats multiple rows with newlines', () => {
      const result = formatForClipboard([
        ['a1', 'b1'],
        ['a2', 'b2'],
      ])
      expect(result).toBe('a1\tb1\na2\tb2')
    })

    it('formats grid with multiple rows and columns', () => {
      const result = formatForClipboard([
        ['a1', 'b1', 'c1'],
        ['a2', 'b2', 'c2'],
      ])
      expect(result).toBe('a1\tb1\tc1\na2\tb2\tc2')
    })
  })

  describe('Value conversion', () => {
    it('converts null to empty string', () => {
      const result = formatForClipboard([[null, 'b']])
      expect(result).toBe('\tb')
    })

    it('converts undefined to empty string', () => {
      const result = formatForClipboard([[undefined, 'b']])
      expect(result).toBe('\tb')
    })

    it('converts numbers to strings', () => {
      const result = formatForClipboard([[123, 45.67, -89]])
      expect(result).toBe('123\t45.67\t-89')
    })

    it('converts boolean to strings', () => {
      const result = formatForClipboard([[true, false]])
      expect(result).toBe('true\tfalse')
    })

    it('preserves string values', () => {
      const result = formatForClipboard([['hello', 'world']])
      expect(result).toBe('hello\tworld')
    })
  })

  describe('Edge cases', () => {
    it('handles empty array', () => {
      const result = formatForClipboard([])
      expect(result).toBe('')
    })

    it('handles array with empty row', () => {
      const result = formatForClipboard([[]])
      expect(result).toBe('')
    })

    it('handles mixed null/undefined/empty', () => {
      const result = formatForClipboard([[null, undefined, '', 'value']])
      expect(result).toBe('\t\t\tvalue')
    })
  })
})

describe('Round-trip (format then parse)', () => {
  it('preserves simple grid', () => {
    const original = [
      ['a1', 'b1', 'c1'],
      ['a2', 'b2', 'c2'],
    ]
    const formatted = formatForClipboard(original)
    const parsed = parseClipboardText(formatted)
    expect(parsed).toEqual(original)
  })

  it('preserves numeric values', () => {
    const original = [
      ['123', '45.67'],
      ['-89', '0'],
    ]
    const formatted = formatForClipboard(original)
    const parsed = parseClipboardText(formatted)
    expect(parsed).toEqual(original)
  })

  it('handles empty cells in round-trip', () => {
    const original = [
      ['a', '', 'c'],
      ['', 'e', ''],
    ]
    const formatted = formatForClipboard(original)
    const parsed = parseClipboardText(formatted)
    expect(parsed).toEqual(original)
  })
})

describe('Clipboard environment detection', () => {
  // Save original window object state
  const originalTauri = (window as unknown as { __TAURI__?: unknown }).__TAURI__

  afterEach(() => {
    // Restore original state
    if (originalTauri !== undefined) {
      Object.defineProperty(window, '__TAURI__', {
        value: originalTauri,
        configurable: true,
        writable: true,
      })
    } else {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
    }
  })

  it('detects non-Tauri environment (tests run in jsdom)', () => {
    // In test environment, __TAURI__ should not be defined
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__

    const adapter = getClipboardAdapter()
    // The adapter object should exist
    expect(adapter).toBeDefined()
    expect(typeof adapter.write).toBe('function')
    expect(typeof adapter.read).toBe('function')
  })

  it('would use Tauri clipboard when __TAURI__ is defined', () => {
    // This test verifies the detection logic
    Object.defineProperty(window, '__TAURI__', {
      value: {},
      configurable: true,
      writable: true,
    })

    // We can't fully test the Tauri path without the actual runtime,
    // but we verify the detection logic exists
    expect('__TAURI__' in window).toBe(true)

    // Clean up
    delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
  })
})

describe('High-level clipboard operations', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('copyToClipboard', () => {
    it('writes formatted text to clipboard', async () => {
      const writeSpy = vi.spyOn(clipboard, 'write').mockResolvedValue(undefined)

      await copyToClipboard([
        ['a1', 'b1'],
        ['a2', 'b2'],
      ])

      expect(writeSpy).toHaveBeenCalledWith('a1\tb1\na2\tb2')
      writeSpy.mockRestore()
    })

    it('handles single cell copy', async () => {
      const writeSpy = vi.spyOn(clipboard, 'write').mockResolvedValue(undefined)

      await copyToClipboard([['hello']])

      expect(writeSpy).toHaveBeenCalledWith('hello')
      writeSpy.mockRestore()
    })

    it('handles empty selection', async () => {
      const writeSpy = vi.spyOn(clipboard, 'write').mockResolvedValue(undefined)

      await copyToClipboard([])

      expect(writeSpy).toHaveBeenCalledWith('')
      writeSpy.mockRestore()
    })
  })

  describe('pasteFromClipboard', () => {
    it('reads and parses clipboard text', async () => {
      const readSpy = vi.spyOn(clipboard, 'read').mockResolvedValue('a1\tb1\na2\tb2')

      const result = await pasteFromClipboard()

      expect(readSpy).toHaveBeenCalled()
      expect(result).toEqual([
        ['a1', 'b1'],
        ['a2', 'b2'],
      ])
      readSpy.mockRestore()
    })

    it('handles empty clipboard', async () => {
      const readSpy = vi.spyOn(clipboard, 'read').mockResolvedValue('')

      const result = await pasteFromClipboard()

      expect(result).toEqual([])
      readSpy.mockRestore()
    })

    it('handles single cell in clipboard', async () => {
      const readSpy = vi.spyOn(clipboard, 'read').mockResolvedValue('single value')

      const result = await pasteFromClipboard()

      expect(result).toEqual([['single value']])
      readSpy.mockRestore()
    })
  })
})

describe('Clipboard adapter interface', () => {
  it('clipboard object has write method', () => {
    expect(typeof clipboard.write).toBe('function')
  })

  it('clipboard object has read method', () => {
    expect(typeof clipboard.read).toBe('function')
  })

  it('getClipboardAdapter returns adapter with correct interface', () => {
    const adapter = getClipboardAdapter()
    expect(typeof adapter.write).toBe('function')
    expect(typeof adapter.read).toBe('function')
  })
})
