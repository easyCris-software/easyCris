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
  return typeof window !== 'undefined' && '__TAURI__' in window
}

/**
 * Unified clipboard interface
 */
export interface ClipboardAdapter {
  write(text: string): Promise<void>
  read(): Promise<string>
}

/**
 * Tauri clipboard implementation
 * Uses dynamic import to avoid import-time errors in non-Tauri environments
 */
const tauriClipboard: ClipboardAdapter = {
  async write(text: string): Promise<void> {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
  },

  async read(): Promise<string> {
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
    const result = await readText()
    return result ?? ''
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
 * Uses Tauri in production, browser API in tests
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

  // Split by newlines, then by tabs
  const lines = text.split(/\r?\n/)

  // Remove trailing empty line (common in clipboard data)
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines.map((line) => line.split('\t'))
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
