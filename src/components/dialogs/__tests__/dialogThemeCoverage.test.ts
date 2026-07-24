import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIALOGS_DIR = join(process.cwd(), 'src', 'components', 'dialogs')

const DEFERRED_DIALOGS = new Set([
  // Large LMM configuration surface intentionally left for a separate focused pass.
  'LmmAnovaConfigDialog.tsx',
])

const LIGHT_ONLY_PATTERNS = [
  /\bbg-white\b/,
  /\bbg-gray-50\b/,
  /\bbg-zinc-50\b/,
  /\btext-gray-[4-9]00\b/,
  /\btext-zinc-[4-9]00\b/,
  /\bborder-gray-[2-4]00\b/,
  /\bborder-zinc-[1-4]00\b/,
  /\bbg-(blue|amber|green|purple|violet|red|orange)-50\b/,
]

describe('dialog dark theme coverage', () => {
  it('keeps non-deferred dialogs from introducing unpaired light-only utility classes', () => {
    const violations = readdirSync(DIALOGS_DIR)
      .filter(fileName => fileName.endsWith('.tsx'))
      .filter(fileName => !fileName.endsWith('.test.tsx'))
      .filter(fileName => !DEFERRED_DIALOGS.has(fileName))
      .flatMap(fileName => {
        const source = readFileSync(join(DIALOGS_DIR, fileName), 'utf8')
        return source
          .split(/\r?\n/)
          .map((line, index) => ({ fileName, line, lineNumber: index + 1 }))
          .filter(({ line }) =>
            LIGHT_ONLY_PATTERNS.some(pattern => pattern.test(line))
          )
          .filter(({ line }) => !line.includes('dark:'))
          .map(
            ({ fileName, line, lineNumber }) =>
              `${fileName}:${lineNumber}: ${line.trim()}`
          )
      })

    expect(violations).toEqual([])
  })
})
