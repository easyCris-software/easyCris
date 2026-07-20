/**
 * Formula Utilities
 *
 * Helper functions for A1 notation conversion and cell key management.
 */

import type { CellPosition, CellRef } from './formulaTypes'

/**
 * Convert column index (0-based) to Excel column letter (A, B, ..., Z, AA, AB, ...)
 */
export function columnIndexToLetter(index: number): string {
  let letter = ''
  let num = index

  while (num >= 0) {
    letter = String.fromCharCode((num % 26) + 65) + letter
    num = Math.floor(num / 26) - 1
  }

  return letter
}

/**
 * Convert Excel column letter to 0-based column index
 */
export function columnLetterToIndex(letter: string): number {
  let index = 0
  const upper = letter.toUpperCase()

  for (let i = 0; i < upper.length; i++) {
    index = index * 26 + (upper.charCodeAt(i) - 64)
  }

  return index - 1
}

/**
 * Convert cell position to A1 notation (e.g., { row: 1, col: 0 } → "A1")
 */
export function positionToA1(position: CellPosition): string {
  const col = columnIndexToLetter(position.col)
  const row = position.row // Already 1-based for Excel
  return `${col}${row}`
}

/**
 * Parse A1 notation to cell position
 * Returns null if invalid format
 */
export function a1ToPosition(a1: string, sheet: string = 'Sheet1'): CellPosition | null {
  const match = a1.match(/^([A-Za-z]+)(\d+)$/)
  if (!match) return null

  const colLetter = match[1]!
  const rowStr = match[2]!

  const col = columnLetterToIndex(colLetter)
  const row = parseInt(rowStr, 10)

  if (isNaN(row) || row < 1) return null

  return { row, col, sheet }
}

/**
 * Convert CellRef from dependency parser to cell key format
 * Note: fast-formula-parser uses 1-based rows
 */
export function cellRefToKey(ref: CellRef, columnIdLookup: (colIndex: number) => string): string {
  // Convert 1-based row from parser to 0-based for our internal format
  const row = ref.row - 1
  const columnId = columnIdLookup(ref.col)
  return `${row}:${columnId}`
}

/**
 * Convert cell key to CellPosition for formula parser
 * Note: Returns 1-based row for parser compatibility
 */
export function keyToPosition(
  key: string,
  columnIndexLookup: (columnId: string) => number,
  sheet: string = 'Sheet1'
): CellPosition | null {
  const parts = key.split(':')
  if (parts.length !== 2) return null

  const row = parseInt(parts[0]!, 10)
  if (isNaN(row)) return null

  const columnId = parts[1]!
  const col = columnIndexLookup(columnId)

  if (col < 0) return null

  // Convert 0-based row to 1-based for parser
  return { row: row + 1, col, sheet }
}

/**
 * Check if a value is a formula (starts with '=')
 */
export function isFormula(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('=')
}

/**
 * Strip the '=' prefix from a formula string
 */
export function stripFormulaPrefix(formula: string): string {
  return formula.startsWith('=') ? formula.slice(1) : formula
}

/**
 * Annotate A1 references in a formula with column display names.
 *
 * This is purely a UI helper; the returned string is NOT meant to be parsed.
 * Example: "=A1+1" → "=A1 (Blood_Pressure)+1"
 */
export function annotateA1WithColumnNames(
  formula: string,
  getColumnNameByIndex: (columnIndex0: number) => string | undefined
): string {
  // Matches: A1, $A$1, AA10, etc.
  const cellRefRegex = /(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g

  return formula.replace(cellRefRegex, (match, dollar1, letters, dollar2, digits) => {
    const colIndex = columnLetterToIndex(String(letters))
    if (colIndex < 0) return match

    const name = getColumnNameByIndex(colIndex)
    if (!name) return match

    // Keep the original reference unchanged, only add annotation.
    return `${dollar1}${String(letters).toUpperCase()}${dollar2}${digits} (${name})`
  })
}

export type FormulaReferenceRegion = {
  token: string
  range: {
    x: number
    y: number
    width: number
    height: number
  }
  tokenIndex: number
}

export type FormulaReferenceTokenSpan = {
  token: string
  start: number
  end: number
  tokenIndex: number
}

function parseA1ReferenceToken(reference: string): { col: number; row: number } | null {
  const match = reference.match(/^\$?([A-Za-z]{1,3})\$?(\d+)$/)
  if (!match) return null

  const col = columnLetterToIndex(match[1] ?? '')
  const row = Number.parseInt(match[2] ?? '', 10) - 1

  if (!Number.isFinite(col) || !Number.isFinite(row) || col < 0 || row < 0) {
    return null
  }

  return { col, row }
}

function buildStringLiteralSpans(expression: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let inString = false
  let spanStart = -1

  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i]
    if (!inString && char === "'") {
      const quotedSheetNameEnd = findQuotedSheetNameEnd(expression, i)
      if (quotedSheetNameEnd !== null) {
        // Exclude quoted sheet names from regex fallback tokenization.
        spans.push({ start: i, end: quotedSheetNameEnd - 1 })
        i = quotedSheetNameEnd - 1
        continue
      }
    }
    if (char !== '"') continue

    if (inString && expression[i + 1] === '"') {
      i += 1
      continue
    }

    if (!inString) {
      inString = true
      spanStart = i
      continue
    }

    spans.push({ start: spanStart, end: i })
    inString = false
    spanStart = -1
  }

  if (inString && spanStart >= 0) {
    spans.push({ start: spanStart, end: expression.length - 1 })
  }

  return spans
}

function isMatchInsideStringLiteral(
  index: number,
  spans: Array<{ start: number; end: number }>
): boolean {
  for (const span of spans) {
    if (index >= span.start && index <= span.end) {
      return true
    }
  }
  return false
}

function hasInvalidReferenceBoundary(
  expression: string,
  matchStart: number,
  matchEnd: number
): boolean {
  const charBefore = matchStart > 0 ? expression[matchStart - 1] ?? '' : ''
  if (charBefore && /[A-Za-z0-9_$.]/.test(charBefore)) {
    return true
  }

  const charAfter = matchEnd < expression.length ? expression[matchEnd] ?? '' : ''
  // A1-like tokens immediately followed by '!' are sheet identifiers (e.g. S2!A1), not cell refs.
  if (charAfter === '!') {
    return true
  }
  if (charAfter && /[A-Za-z0-9_$]/.test(charAfter)) {
    return true
  }

  return false
}

function isLikelyFunctionToken(
  expression: string,
  token: string,
  matchEnd: number
): boolean {
  if (token.includes(':')) return false
  if (!/^[A-Za-z]{2,3}\d+$/.test(token)) return false
  return /^\s*\(/.test(expression.slice(matchEnd))
}

type ParsedReferenceTokenAt = {
  token: string
  nextIndex: number
}

function findQuotedSheetNameEnd(expression: string, startIndex: number): number | null {
  if (expression[startIndex] !== "'") return null
  let index = startIndex + 1

  while (index < expression.length) {
    const current = expression[index]
    if (current !== "'") {
      index += 1
      continue
    }

    // Escaped apostrophe inside quoted sheet name, e.g. 'Bob''s Sheet'!A1
    if (expression[index + 1] === "'") {
      index += 2
      continue
    }

    let afterQuote = index + 1
    while (afterQuote < expression.length && /\s/.test(expression[afterQuote] ?? '')) {
      afterQuote += 1
    }
    if (expression[afterQuote] !== '!') {
      return null
    }
    return afterQuote + 1
  }

  return null
}

function parseReferenceTokenAt(
  expression: string,
  startIndex: number
): ParsedReferenceTokenAt | null {
  let index = startIndex
  if (expression[index] === '$') {
    index += 1
  }

  const letterStart = index
  while (index < expression.length && /[A-Za-z]/.test(expression[index] ?? '')) {
    index += 1
  }
  const letterCount = index - letterStart
  if (letterCount < 1 || letterCount > 3) return null

  if (expression[index] === '$') {
    index += 1
  }

  const digitStart = index
  while (index < expression.length && /\d/.test(expression[index] ?? '')) {
    index += 1
  }
  if (index === digitStart) return null

  const token = expression.slice(startIndex, index)
  if (!parseA1ReferenceToken(token)) return null

  return { token, nextIndex: index }
}

function extractFormulaReferenceRegionsRegexFallback(
  expression: string,
  maxRegions: number
): FormulaReferenceTokenSpan[] {
  const literalSpans = buildStringLiteralSpans(expression)
  const pattern = /(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?/g
  const regions: FormulaReferenceTokenSpan[] = []

  let match: RegExpExecArray | null
  while ((match = pattern.exec(expression)) !== null) {
    if (isMatchInsideStringLiteral(match.index, literalSpans)) {
      continue
    }

    const rawToken = match[0] ?? ''
    const matchStart = match.index
    const matchEnd = matchStart + rawToken.length
    if (hasInvalidReferenceBoundary(expression, matchStart, matchEnd)) {
      continue
    }
    if (isLikelyFunctionToken(expression, rawToken, matchEnd)) {
      continue
    }

    const startRef = parseA1ReferenceToken(match[1] ?? '')
    if (!startRef) continue

    const endRef = match[2] ? parseA1ReferenceToken(match[2]) : startRef
    if (!endRef) continue

    regions.push({
      token: rawToken.toUpperCase(),
      start: matchStart + 1, // offset for leading '=' in caller-facing formula string
      end: matchEnd + 1,
      tokenIndex: regions.length,
    })

    if (regions.length >= maxRegions) {
      break
    }
  }

  return regions
}

export function extractFormulaReferenceTokenSpans(
  formula: string,
  maxTokens: number = 128
): FormulaReferenceTokenSpan[] {
  if (!formula || !formula.startsWith('=')) {
    return []
  }

  const expression = formula.slice(1)
  const regions: FormulaReferenceTokenSpan[] = []

  let inString = false
  for (let index = 0; index < expression.length; ) {
    const currentChar = expression[index] ?? ''

    if (currentChar === '"') {
      if (inString && expression[index + 1] === '"') {
        index += 2
        continue
      }
      inString = !inString
      index += 1
      continue
    }

    if (inString) {
      index += 1
      continue
    }

    if (currentChar === "'") {
      const quotedSheetNameEnd = findQuotedSheetNameEnd(expression, index)
      if (quotedSheetNameEnd !== null) {
        index = quotedSheetNameEnd
        continue
      }
      index += 1
      continue
    }

    if (!/[A-Za-z$]/.test(currentChar)) {
      index += 1
      continue
    }

    const parsedStart = parseReferenceTokenAt(expression, index)
    if (!parsedStart) {
      index += 1
      continue
    }

    let parsedEnd = parsedStart
    let tokenEnd = parsedStart.nextIndex
    let token = parsedStart.token

    if (expression[parsedStart.nextIndex] === ':') {
      const parsedRangeEnd = parseReferenceTokenAt(expression, parsedStart.nextIndex + 1)
      if (parsedRangeEnd) {
        parsedEnd = parsedRangeEnd
        tokenEnd = parsedRangeEnd.nextIndex
        token = expression.slice(index, tokenEnd)
      }
    }

    if (hasInvalidReferenceBoundary(expression, index, tokenEnd)) {
      index = parsedStart.nextIndex
      continue
    }
    if (isLikelyFunctionToken(expression, token, tokenEnd)) {
      index = parsedStart.nextIndex
      continue
    }

    const startRef = parseA1ReferenceToken(parsedStart.token)
    const endRef = parseA1ReferenceToken(parsedEnd.token)
    if (!startRef || !endRef) {
      index = parsedStart.nextIndex
      continue
    }

    regions.push({
      token: token.toUpperCase(),
      start: index + 1, // offset for leading '=' in formula string
      end: tokenEnd + 1,
      tokenIndex: regions.length,
    })

    if (regions.length >= maxTokens) {
      return regions
    }

    index = tokenEnd
  }

  if (regions.length > 0) {
    return regions
  }

  return extractFormulaReferenceRegionsRegexFallback(expression, maxTokens)
}

/**
 * Extract formula reference regions (single-cell and A1:A10 ranges) for UI highlighting.
 * Unlike `extractCellReferences`, this returns contiguous rectangles and preserves token order.
 */
export function extractFormulaReferenceRegions(
  formula: string,
  maxRegions: number = 128
): FormulaReferenceRegion[] {
  if (!formula || !formula.startsWith('=')) {
    return []
  }
  const spans = extractFormulaReferenceTokenSpans(formula, maxRegions)
  const regions: FormulaReferenceRegion[] = []
  for (const span of spans) {
    const [startToken, endToken] = span.token.split(':')
    const startRef = parseA1ReferenceToken(startToken ?? '')
    const endRef = parseA1ReferenceToken(endToken ?? startToken ?? '')
    if (!startRef || !endRef) continue
    regions.push({
      token: span.token,
      tokenIndex: span.tokenIndex,
      range: {
        x: Math.min(startRef.col, endRef.col),
        y: Math.min(startRef.row, endRef.row),
        width: Math.abs(endRef.col - startRef.col) + 1,
        height: Math.abs(endRef.row - startRef.row) + 1,
      },
    })
  }
  return regions
}

/**
 * Extract all cell references from a formula for highlighting
 * Returns array of {col, row} positions (0-based)
 *
 * Examples:
 * - "=C1" → [{col: 2, row: 0}]
 * - "=A1+B2" → [{col: 0, row: 0}, {col: 1, row: 1}]
 * - "=SUM(A1:A10)" → [{col: 0, row: 0}, {col: 0, row: 1}, ... {col: 0, row: 9}]
 * - "=$A$1" → [{col: 0, row: 0}]
 */
export function extractCellReferences(formula: string): Array<{ col: number; row: number }> {
  if (!formula || !formula.startsWith('=')) {
    return []
  }

  const tokenSpans = extractFormulaReferenceTokenSpans(formula, 256)
  if (tokenSpans.length > 0) {
    const results: Array<{ col: number; row: number }> = []
    const seen = new Set<string>()
    const maxCells = 1000
    let totalCells = 0

    for (const span of tokenSpans) {
      const [startToken, endToken] = span.token.split(':')
      const startRef = parseA1ReferenceToken(startToken ?? '')
      const endRef = parseA1ReferenceToken(endToken ?? startToken ?? '')
      if (!startRef || !endRef) continue

      const minRow = Math.min(startRef.row, endRef.row)
      const maxRow = Math.max(startRef.row, endRef.row)
      const minCol = Math.min(startRef.col, endRef.col)
      const maxCol = Math.max(startRef.col, endRef.col)

      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          const key = `${c}:${r}`
          if (seen.has(key)) continue
          seen.add(key)
          results.push({ col: c, row: r })
          totalCells += 1
          if (totalCells >= maxCells) {
            return results
          }
        }
      }
    }

    return results
  }

  const results: Array<{ col: number; row: number }> = []
  const seen = new Set<string>() // Deduplicate

  // Remove the '=' prefix
  const expr = formula.slice(1)

  // Regex to match cell references (A1, $A$1, AA10, etc.)
  // Captures: optional $, column letters, optional $, row digits
  const cellRefRegex = /(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g

  let match: RegExpExecArray | null
  while ((match = cellRefRegex.exec(expr)) !== null) {
    const letters = match[2]
    const digits = match[4]

    if (!letters || !digits) continue

    const col = columnLetterToIndex(letters)
    const row = parseInt(digits, 10) - 1 // Convert to 0-based

    if (col < 0 || row < 0 || isNaN(row)) continue

    const key = `${col}:${row}`
    if (!seen.has(key)) {
      seen.add(key)
      results.push({ col, row })
    }
  }

  // Also handle range references (A1:B5) - expand to individual cells
  const rangeRegex = /(\$?)([A-Za-z]{1,3})(\$?)(\d+):(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g

  while ((match = rangeRegex.exec(expr)) !== null) {
    const startCol = columnLetterToIndex(match[2]!)
    const startRow = parseInt(match[4]!, 10) - 1
    const endCol = columnLetterToIndex(match[6]!)
    const endRow = parseInt(match[8]!, 10) - 1

    if (startCol < 0 || startRow < 0 || endCol < 0 || endRow < 0) continue
    if (isNaN(startRow) || isNaN(endRow)) continue

    // Expand range (limit to reasonable size to avoid performance issues)
    const maxCells = 1000
    let cellCount = 0

    for (let r = Math.min(startRow, endRow); r <= Math.max(startRow, endRow); r++) {
      for (let c = Math.min(startCol, endCol); c <= Math.max(startCol, endCol); c++) {
        const key = `${c}:${r}`
        if (!seen.has(key)) {
          seen.add(key)
          results.push({ col: c, row: r })
          cellCount++
          if (cellCount > maxCells) break
        }
      }
      if (cellCount > maxCells) break
    }
  }

  return results
}

/**
 * Topological sort for dependency order calculation
 * Returns cells in order they should be recalculated (dependencies first)
 * Detects circular references and returns affected cells
 */
export function topologicalSort(
  startCells: string[],
  getDependents: (cell: string) => string[]
): { sorted: string[]; circular: string[] } {
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const sorted: string[] = []
  const circularSet = new Set<string>() // Use Set to avoid duplicates

  function visit(cell: string): boolean {
    if (inStack.has(cell)) {
      // Circular reference detected - add to set and stop traversing this path
      circularSet.add(cell)
      return false
    }

    if (visited.has(cell)) {
      return true
    }

    visited.add(cell)
    inStack.add(cell)

    const dependents = getDependents(cell)
    for (const dep of dependents) {
      if (!visit(dep)) {
        // Propagate circular marker up the chain, but don't duplicate
        circularSet.add(cell)
      }
    }

    inStack.delete(cell)
    sorted.push(cell)
    return true
  }

  for (const cell of startCells) {
    visit(cell)
  }

  // Reverse to get correct recalculation order (dependencies before dependents)
  return { sorted: sorted.reverse(), circular: Array.from(circularSet) }
}
