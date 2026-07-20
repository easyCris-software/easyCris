/**
 * Clipboard Abstraction
 *
 * Provides a unified clipboard API that:
 * - Uses Tauri plugin in desktop environment
 * - Falls back to navigator.clipboard in tests/browser
 *
 * This abstraction ensures:
 * 1. Desktop-native clipboard behavior in production
 * 2. Testable clipboard operations without Tauri
 *
 * NOTE: Tauri clipboard plugin is dynamically imported to avoid
 * import-time errors in non-Tauri environments (tests, browser).
 */

/**
 * Detect if running in Tauri environment
 */
function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI__' in window || '__TAURI_INTERNALS__' in window
}

/**
 * Unified clipboard interface
 */
export interface ClipboardAdapter {
  write(text: string): Promise<void>
  read(): Promise<string>
}

const e2eClipboardFallbackEnabled =
  import.meta.env.MODE === 'e2e' || import.meta.env.VITE_E2E_ENABLED === 'true'

let e2eClipboardBuffer = ''
let didWarnE2EClipboardWriteFallback = false
let didWarnE2EClipboardReadFallback = false

/**
 * Tauri clipboard implementation
 * Uses dynamic import to avoid import-time errors in non-Tauri environments
 */
const tauriClipboard: ClipboardAdapter = {
  async write(text: string): Promise<void> {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
      await writeText(text)
      if (e2eClipboardFallbackEnabled) {
        e2eClipboardBuffer = text
      }
      return
    } catch (error) {
      if (e2eClipboardFallbackEnabled) {
        if (!didWarnE2EClipboardWriteFallback) {
          console.warn('[clipboard] E2E fallback write activated after clipboard plugin failure')
          didWarnE2EClipboardWriteFallback = true
        }
        e2eClipboardBuffer = text
        return
      }
      throw error
    }
  },

  async read(): Promise<string> {
    try {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
      const result = await readText()
      if (result !== null && result !== undefined) {
        if (e2eClipboardFallbackEnabled) {
          e2eClipboardBuffer = result
        }
        return result
      }
      if (e2eClipboardFallbackEnabled) {
        e2eClipboardBuffer = ''
      }
      return ''
    } catch (error) {
      if (e2eClipboardFallbackEnabled) {
        if (!didWarnE2EClipboardReadFallback) {
          console.warn('[clipboard] E2E fallback read activated after clipboard plugin failure')
          didWarnE2EClipboardReadFallback = true
        }
        return e2eClipboardBuffer
      }
      throw error
    }
  },
}

/**
 * Browser/test clipboard implementation
 */
const browserClipboard: ClipboardAdapter = {
  async write(text: string): Promise<void> {
    await navigator.clipboard.writeText(text)
  },

  async read(): Promise<string> {
    return await navigator.clipboard.readText()
  },
}

/**
 * Get the appropriate clipboard adapter based on environment
 */
export function getClipboardAdapter(): ClipboardAdapter {
  return isTauriEnvironment() ? tauriClipboard : browserClipboard
}

/**
 * Default clipboard instance
 * Uses Tauri in desktop mode, browser API in browser/tests.
 * In E2E builds, clipboard plugin failures fall back to an in-memory buffer.
 */
export const clipboard: ClipboardAdapter = {
  async write(text: string): Promise<void> {
    const adapter = getClipboardAdapter()
    await adapter.write(text)
  },

  async read(): Promise<string> {
    const adapter = getClipboardAdapter()
    return await adapter.read()
  },
}

/**
 * Parse tab-separated clipboard text into a 2D array
 * Used for parsing Excel/spreadsheet paste data
 */
export function parseClipboardText(text: string): string[][] {
  if (!text || text.trim() === '') {
    return []
  }

  const rows: string[][] = []
  let currentRow: string[] = []
  let currentCell = ''
  let inQuotedCell = false

  const finishCell = (): void => {
    currentRow.push(currentCell)
    currentCell = ''
  }

  const finishRow = (): void => {
    finishCell()
    rows.push(currentRow)
    currentRow = []
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]

    if (inQuotedCell) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          currentCell += '"'
          index += 1
        } else {
          inQuotedCell = false
        }
      } else if (char === '\r' && text[index + 1] === '\n') {
        currentCell += '\n'
        index += 1
      } else if (char === '\r') {
        continue
      } else {
        currentCell += char
      }
      continue
    }

    if (char === '"' && currentCell === '') {
      inQuotedCell = true
      continue
    }

    if (char === '\t') {
      finishCell()
      continue
    }

    if (char === '\n') {
      finishRow()
      continue
    }

    if (char === '\r' && text[index + 1] === '\n') {
      finishRow()
      index += 1
      continue
    }

    currentCell += char
  }

  finishRow()

  const isBlankTailRow = (row: string[]): boolean => row.every((cell) => cell === '')

  // Remove trailing blank rows (including tab-only rows)
  while (rows.length > 0 && isBlankTailRow(rows[rows.length - 1] ?? [])) {
    rows.pop()
  }

  return rows
}

/**
 * Format a 2D array as tab-separated text for clipboard
 * Used for copying cells to clipboard
 */
export function formatForClipboard(data: unknown[][]): string {
  return data
    .map((row) =>
      row
        .map((cell) => {
          if (cell === null || cell === undefined) {
            return ''
          }
          return String(cell)
        })
        .join('\t')
    )
    .join('\n')
}

/**
 * Copy cells to clipboard
 * @param cells 2D array of cell values
 */
export async function copyToClipboard(cells: unknown[][]): Promise<void> {
  const text = formatForClipboard(cells)
  await clipboard.write(text)
}

/**
 * Read and parse cells from clipboard
 * @returns 2D array of cell values
 */
export async function pasteFromClipboard(): Promise<string[][]> {
  const text = await clipboard.read()
  return parseClipboardText(text)
}
