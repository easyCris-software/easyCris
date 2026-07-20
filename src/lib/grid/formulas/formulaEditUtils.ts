import { getFunctionSuggestions } from './formulaService'
import { columnIndexToLetter, extractFormulaReferenceTokenSpans } from './formulaUtils'

export type FormulaInsertionSpan = {
  start: number
  end: number
}

const REFERENCE_TOKEN_REGEX = /^\$?[A-Z]{1,4}\$?\d+(?::\$?[A-Z]{1,4}\$?\d+)?$/i
const FUNCTION_CALL_START_REGEX = /^([A-Za-z][A-Za-z0-9.]*)\(/
const TRAILING_FUNCTION_TOKEN_REGEX = /(?:^|[=+\-*/^&,:(<>]\s*)([A-Za-z][A-Za-z0-9.]*)\s*$/
const RANGE_CAPTURE_LEFT_REGEX = /[=+\-*/^&,:(<>]\s*$/
const PARTIAL_REFERENCE_LEFT_REGEX = /(?:\$?[A-Z]{1,4}\$?\d+:\$?[A-Z]{0,4}\$?\d*|\$?[A-Z]{1,4}\$?\d*:)\s*$/i
const A1_TOKEN_PARTS_REGEX = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/
const FULL_COLUMN_RANGE_REGEX = /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}$/i
const FULL_ROW_RANGE_REGEX = /^\$?\d+:\$?\d+$/
const FULL_RANGE_SCAN_MAX_CHARS = 64

function parseCellReferenceTokenAt(text: string, startIndex: number): number | null {
  let index = startIndex
  if (text[index] === '$') {
    index += 1
  }
  const letterStart = index
  while (index < text.length && /[A-Za-z]/.test(text[index] ?? '')) {
    index += 1
  }
  const letterCount = index - letterStart
  if (letterCount < 1 || letterCount > 3) return null
  if (text[index] === '$') {
    index += 1
  }
  const digitStart = index
  while (index < text.length && /\d/.test(text[index] ?? '')) {
    index += 1
  }
  if (index === digitStart) return null
  return index
}

function parseReferenceTokenEnd(text: string, startIndex: number): number | null {
  const cellEnd = parseCellReferenceTokenAt(text, startIndex)
  if (cellEnd !== null) {
    if (text[cellEnd] === ':') {
      const rangeEnd = parseCellReferenceTokenAt(text, cellEnd + 1)
      if (rangeEnd !== null) {
        return rangeEnd
      }
    }
    return cellEnd
  }

  // Support full-column or full-row ranges for compatibility stripping.
  // Use longest valid match to avoid truncation (e.g. A:AA -> A:A, 1:10 -> 1:1).
  let longestMatchEnd: number | null = null
  for (
    let end = startIndex + 1;
    end <= Math.min(text.length, startIndex + FULL_RANGE_SCAN_MAX_CHARS);
    end += 1
  ) {
    const token = text.slice(startIndex, end)
    if (FULL_COLUMN_RANGE_REGEX.test(token) || FULL_ROW_RANGE_REGEX.test(token)) {
      longestMatchEnd = end
    }
  }
  return longestMatchEnd
}

function findQuotedSheetQualifierEnd(text: string, startIndex: number): number | null {
  if (text[startIndex] !== "'") return null
  let index = startIndex + 1
  while (index < text.length) {
    const current = text[index]
    if (current !== "'") {
      index += 1
      continue
    }
    if (text[index + 1] === "'") {
      index += 2
      continue
    }
    let afterQuote = index + 1
    while (afterQuote < text.length && /\s/.test(text[afterQuote] ?? '')) {
      afterQuote += 1
    }
    if (text[afterQuote] === '!') {
      return afterQuote + 1
    }
    return null
  }
  return null
}

function findBareSheetQualifierEnd(text: string, startIndex: number): number | null {
  const first = text[startIndex] ?? ''
  if (!/[A-Za-z_]/.test(first)) return null
  let index = startIndex + 1
  while (index < text.length && /[A-Za-z0-9_.]/.test(text[index] ?? '')) {
    index += 1
  }
  let afterName = index
  while (afterName < text.length && /\s/.test(text[afterName] ?? '')) {
    afterName += 1
  }
  if (text[afterName] === '!') {
    return afterName + 1
  }
  return null
}

function parseSheetQualifiedReferenceAt(
  text: string,
  startIndex: number
): { qualifierEnd: number; refStart: number; refEnd: number } | null {
  const qualifierEnd =
    findQuotedSheetQualifierEnd(text, startIndex) ?? findBareSheetQualifierEnd(text, startIndex)
  if (qualifierEnd === null) return null

  let refStart = qualifierEnd
  while (refStart < text.length && /\s/.test(text[refStart] ?? '')) {
    refStart += 1
  }
  const refEnd = parseReferenceTokenEnd(text, refStart)
  if (refEnd === null) return null

  return { qualifierEnd, refStart, refEnd }
}

function isKnownFunctionName(name: string): boolean {
  const fnName = name.toUpperCase()
  return getFunctionSuggestions(fnName, 512).includes(fnName)
}

function isKnownFunctionCallPrefix(text: string): boolean {
  const match = text.match(FUNCTION_CALL_START_REGEX)
  if (!match || !match[1]) return false
  return isKnownFunctionName(match[1])
}

function hasTrailingKnownFunctionToken(left: string): boolean {
  const match = left.match(TRAILING_FUNCTION_TOKEN_REGEX)
  if (!match || !match[1]) return false
  return isKnownFunctionName(match[1])
}

export function isFormulaCaptureInput(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('=') || isKnownFunctionCallPrefix(trimmed)
}

export function normalizeFormulaCaptureDraft(
  text: string,
  caretStart: number,
  caretEnd: number
): { text: string; caretStart: number; caretEnd: number } {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('=')) {
    return { text, caretStart, caretEnd }
  }
  if (!isKnownFunctionCallPrefix(trimmed)) {
    return { text, caretStart, caretEnd }
  }

  const leftWhitespaceLength = text.length - trimmed.length
  const nextText = `${text.slice(0, leftWhitespaceLength)}=${trimmed}`
  const nextCaretStart = Math.min(nextText.length, caretStart + 1)
  const nextCaretEnd = Math.min(nextText.length, caretEnd + 1)
  return {
    text: nextText,
    caretStart: nextCaretStart,
    caretEnd: nextCaretEnd,
  }
}

export function normalizeFormulaDraftForCommit(text: string): string {
  return normalizeFormulaBeforeCommit(text).text
}

export type FormulaCommitNormalizationResult = {
  text: string
  autoClosedCount: number
  error: string | null
}

export function normalizeFormulaBeforeCommit(text: string): FormulaCommitNormalizationResult {
  const normalized = normalizeFormulaCaptureDraft(text, text.length, text.length)
  const normalizedText = normalized.text
  const trimmed = normalizedText.trimStart()

  if (!trimmed.startsWith('=')) {
    return {
      text: normalizedText,
      autoClosedCount: 0,
      error: null,
    }
  }

  if (hasSheetQualifiedReferences(normalizedText)) {
    return {
      text: normalizedText,
      autoClosedCount: 0,
      error: 'Sheet-qualified references are not supported. Use A1 references in the active grid.',
    }
  }

  let openCount = 0
  let closeCount = 0
  let inString = false

  for (let i = 0; i < normalizedText.length; i += 1) {
    const char = normalizedText[i]
    if (char === '"') {
      if (inString && normalizedText[i + 1] === '"') {
        i += 1
        continue
      }
      inString = !inString
      continue
    }

    if (inString) continue

    if (char === '(') {
      openCount += 1
      continue
    }
    if (char === ')') {
      closeCount += 1
      if (closeCount > openCount) {
        return {
          text: normalizedText,
          autoClosedCount: 0,
          error: 'Unmatched closing parenthesis in formula.',
        }
      }
    }
  }

  const missingClosers = Math.max(0, openCount - closeCount)
  if (missingClosers === 0) {
    return {
      text: normalizedText,
      autoClosedCount: 0,
      error: null,
    }
  }

  return {
    text: `${normalizedText}${')'.repeat(missingClosers)}`,
    autoClosedCount: missingClosers,
    error: null,
  }
}

export function hasSheetQualifiedReferences(text: string): boolean {
  if (!text) return false

  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? ''

    if (ch === '"') {
      if (inString && text[i + 1] === '"') {
        i += 1
        continue
      }
      inString = !inString
      continue
    }

    if (inString) continue

    const parsed = parseSheetQualifiedReferenceAt(text, i)
    if (parsed) return true
  }

  return false
}

export function stripSheetQualifiedReferences(text: string): { text: string; converted: boolean } {
  if (!text) return { text, converted: false }

  let inString = false
  let converted = false
  let output = ''

  for (let i = 0; i < text.length; ) {
    const ch = text[i] ?? ''

    if (ch === '"') {
      if (inString && text[i + 1] === '"') {
        output += '""'
        i += 2
        continue
      }
      inString = !inString
      output += ch
      i += 1
      continue
    }

    if (!inString) {
      const parsed = parseSheetQualifiedReferenceAt(text, i)
      if (parsed) {
        output += text.slice(parsed.refStart, parsed.refEnd)
        i = parsed.refEnd
        converted = true
        continue
      }
    }

    output += ch
    i += 1
  }

  return { text: output, converted }
}

export function buildA1ReferenceFromRect(
  rect: { x: number; y: number; width: number; height: number },
  columnCount: number
): string | null {
  if (columnCount <= 0) return null

  const left = Math.max(0, Math.min(rect.x, columnCount - 1))
  const right = Math.max(0, Math.min(rect.x + rect.width - 1, columnCount - 1))
  const top = rect.y
  const bottom = rect.y + rect.height - 1

  if (top < 0 || bottom < 0) return null

  const start = `${columnIndexToLetter(Math.min(left, right))}${Math.min(top, bottom) + 1}`
  const end = `${columnIndexToLetter(Math.max(left, right))}${Math.max(top, bottom) + 1}`

  if (start === end) {
    return start
  }

  return `${start}:${end}`
}

export function doesRectContainCell(
  rect: { x: number; y: number; width: number; height: number },
  cell: { x: number; y: number }
): boolean {
  const left = Math.min(rect.x, rect.x + rect.width - 1)
  const right = Math.max(rect.x, rect.x + rect.width - 1)
  const top = Math.min(rect.y, rect.y + rect.height - 1)
  const bottom = Math.max(rect.y, rect.y + rect.height - 1)
  return cell.x >= left && cell.x <= right && cell.y >= top && cell.y <= bottom
}

type RectBounds = {
  left: number
  right: number
  top: number
  bottom: number
}

function toBounds(rect: { x: number; y: number; width: number; height: number }): RectBounds {
  return {
    left: Math.min(rect.x, rect.x + rect.width - 1),
    right: Math.max(rect.x, rect.x + rect.width - 1),
    top: Math.min(rect.y, rect.y + rect.height - 1),
    bottom: Math.max(rect.y, rect.y + rect.height - 1),
  }
}

function fromBounds(bounds: RectBounds): { x: number; y: number; width: number; height: number } {
  return {
    x: bounds.left,
    y: bounds.top,
    width: bounds.right - bounds.left + 1,
    height: bounds.bottom - bounds.top + 1,
  }
}

function rectArea(bounds: RectBounds): number {
  return Math.max(0, bounds.right - bounds.left + 1) * Math.max(0, bounds.bottom - bounds.top + 1)
}

function containsPoint(bounds: RectBounds, point: { x: number; y: number }): boolean {
  return (
    point.x >= bounds.left &&
    point.x <= bounds.right &&
    point.y >= bounds.top &&
    point.y <= bounds.bottom
  )
}

function pickPreferredRect(
  candidates: RectBounds[],
  dragEndpoint?: { x: number; y: number } | null
): RectBounds | null {
  if (candidates.length === 0) return null
  const valid = candidates.filter((candidate) => rectArea(candidate) > 0)
  if (valid.length === 0) return null

  const endpointMatches = dragEndpoint
    ? valid.filter((candidate) => containsPoint(candidate, dragEndpoint))
    : []
  const pool = endpointMatches.length > 0 ? endpointMatches : valid

  return pool.reduce((best, current) => (rectArea(current) > rectArea(best) ? current : best))
}

export function excludeCellFromRect(
  rect: { x: number; y: number; width: number; height: number },
  cell: { x: number; y: number },
  dragEndpoint?: { x: number; y: number } | null
): { rect: { x: number; y: number; width: number; height: number } | null; excluded: boolean } {
  const bounds = toBounds(rect)
  if (!containsPoint(bounds, cell)) {
    return { rect, excluded: false }
  }

  const width = bounds.right - bounds.left + 1
  const height = bounds.bottom - bounds.top + 1

  if (width === 1 && height === 1) {
    return { rect: null, excluded: true }
  }

  if (height === 1) {
    const candidates: RectBounds[] = []
    if (cell.x > bounds.left) {
      candidates.push({ left: bounds.left, right: cell.x - 1, top: bounds.top, bottom: bounds.bottom })
    }
    if (cell.x < bounds.right) {
      candidates.push({ left: cell.x + 1, right: bounds.right, top: bounds.top, bottom: bounds.bottom })
    }
    const picked = pickPreferredRect(candidates, dragEndpoint)
    return { rect: picked ? fromBounds(picked) : null, excluded: true }
  }

  if (width === 1) {
    const candidates: RectBounds[] = []
    if (cell.y > bounds.top) {
      candidates.push({ left: bounds.left, right: bounds.right, top: bounds.top, bottom: cell.y - 1 })
    }
    if (cell.y < bounds.bottom) {
      candidates.push({ left: bounds.left, right: bounds.right, top: cell.y + 1, bottom: bounds.bottom })
    }
    const picked = pickPreferredRect(candidates, dragEndpoint)
    return { rect: picked ? fromBounds(picked) : null, excluded: true }
  }

  const candidates: RectBounds[] = []
  if (cell.x > bounds.left) {
    candidates.push({ left: bounds.left, right: cell.x - 1, top: bounds.top, bottom: bounds.bottom })
  }
  if (cell.x < bounds.right) {
    candidates.push({ left: cell.x + 1, right: bounds.right, top: bounds.top, bottom: bounds.bottom })
  }
  if (cell.y > bounds.top) {
    candidates.push({ left: bounds.left, right: bounds.right, top: bounds.top, bottom: cell.y - 1 })
  }
  if (cell.y < bounds.bottom) {
    candidates.push({ left: bounds.left, right: bounds.right, top: cell.y + 1, bottom: bounds.bottom })
  }
  const picked = pickPreferredRect(candidates, dragEndpoint)
  return { rect: picked ? fromBounds(picked) : null, excluded: true }
}

function findReferenceTokenAroundCaret(
  text: string,
  caretStart: number,
  caretEnd: number
): FormulaInsertionSpan | null {
  if (caretStart !== caretEnd) {
    return null
  }

  const caret = Math.max(0, Math.min(caretStart, text.length))
  let start = caret
  let end = caret

  while (start > 0 && /[A-Za-z0-9:$]/.test(text[start - 1]!)) {
    start -= 1
  }
  while (end < text.length && /[A-Za-z0-9:$]/.test(text[end]!)) {
    end += 1
  }

  if (start === end) return null
  const candidate = text.slice(start, end)
  if (!REFERENCE_TOKEN_REGEX.test(candidate)) return null
  return { start, end }
}

type AbsoluteA1TokenParts = {
  column: string
  row: string
  absoluteColumn: boolean
  absoluteRow: boolean
}

function parseAbsoluteA1TokenParts(token: string): AbsoluteA1TokenParts | null {
  const match = token.match(A1_TOKEN_PARTS_REGEX)
  if (!match) return null
  return {
    absoluteColumn: match[1] === '$',
    column: match[2]?.toUpperCase() ?? '',
    absoluteRow: match[3] === '$',
    row: match[4] ?? '',
  }
}

function formatAbsoluteA1Token(parts: AbsoluteA1TokenParts): string {
  return `${parts.absoluteColumn ? '$' : ''}${parts.column}${parts.absoluteRow ? '$' : ''}${parts.row}`
}

function cycleAbsoluteA1Token(token: string): string | null {
  const parsed = parseAbsoluteA1TokenParts(token)
  if (!parsed) return null

  let next: AbsoluteA1TokenParts
  if (!parsed.absoluteColumn && !parsed.absoluteRow) {
    // A1 -> $A$1
    next = { ...parsed, absoluteColumn: true, absoluteRow: true }
  } else if (parsed.absoluteColumn && parsed.absoluteRow) {
    // $A$1 -> A$1
    next = { ...parsed, absoluteColumn: false, absoluteRow: true }
  } else if (!parsed.absoluteColumn && parsed.absoluteRow) {
    // A$1 -> $A1
    next = { ...parsed, absoluteColumn: true, absoluteRow: false }
  } else {
    // $A1 -> A1
    next = { ...parsed, absoluteColumn: false, absoluteRow: false }
  }

  return formatAbsoluteA1Token(next)
}

export type FormulaAbsoluteReferenceToggleResult = {
  text: string
  caretStart: number
  caretEnd: number
}

export function toggleAbsoluteReferenceAtCaret(
  text: string,
  caretStart: number,
  caretEnd: number
): FormulaAbsoluteReferenceToggleResult | null {
  if (!text.startsWith('=')) return null
  if (caretStart !== caretEnd) return null

  const safeCaret = Math.max(0, Math.min(caretStart, text.length))
  const spans = extractFormulaReferenceTokenSpans(text, 512)
  if (spans.length === 0) return null

  const activeSpan = spans.find((span) => {
    const start = Math.max(0, Math.min(span.start, text.length))
    const end = Math.max(start, Math.min(span.end, text.length))
    // span.end is exclusive for slice() usage, but include end boundary so F4 at token edge still toggles.
    return safeCaret >= start && safeCaret <= end
  })
  if (!activeSpan) return null

  const spanStart = Math.max(0, Math.min(activeSpan.start, text.length))
  const spanEnd = Math.max(spanStart, Math.min(activeSpan.end, text.length))
  const token = text.slice(spanStart, spanEnd)
  if (!token) return null

  let nextToken = token
  let nextCaretWithinToken = token.length

  const colonIndex = token.indexOf(':')
  if (colonIndex >= 0) {
    const startToken = token.slice(0, colonIndex)
    const endToken = token.slice(colonIndex + 1)
    const localCaret = Math.max(0, Math.min(safeCaret - spanStart, token.length))
    const toggleEndToken = localCaret > colonIndex
    if (toggleEndToken) {
      const cycledEnd = cycleAbsoluteA1Token(endToken)
      if (!cycledEnd) return null
      nextToken = `${startToken}:${cycledEnd}`
      nextCaretWithinToken = nextToken.length
    } else {
      const cycledStart = cycleAbsoluteA1Token(startToken)
      if (!cycledStart) return null
      nextToken = `${cycledStart}:${endToken}`
      nextCaretWithinToken = cycledStart.length
    }
  } else {
    const cycled = cycleAbsoluteA1Token(token)
    if (!cycled) return null
    nextToken = cycled
    nextCaretWithinToken = nextToken.length
  }

  const nextText = `${text.slice(0, spanStart)}${nextToken}${text.slice(spanEnd)}`
  const nextCaret = Math.max(0, Math.min(spanStart + nextCaretWithinToken, nextText.length))
  return {
    text: nextText,
    caretStart: nextCaret,
    caretEnd: nextCaret,
  }
}

export function isFormulaRangePickMode(
  text: string,
  caretStart: number,
  caretEnd: number
): boolean {
  const normalized = normalizeFormulaCaptureDraft(text, caretStart, caretEnd)
  const draft = normalized.text
  if (!draft.trimStart().startsWith('=')) return false

  const safeStart = Math.max(0, Math.min(normalized.caretStart, draft.length))
  const safeEnd = Math.max(0, Math.min(normalized.caretEnd, draft.length))
  if (safeStart !== safeEnd) return false

  const left = draft.slice(0, safeStart)
  if (left.trim() === '=') return true
  if (RANGE_CAPTURE_LEFT_REGEX.test(left)) return true
  if (hasTrailingKnownFunctionToken(left)) return true
  if (PARTIAL_REFERENCE_LEFT_REGEX.test(left)) return true
  return findReferenceTokenAroundCaret(draft, safeStart, safeEnd) !== null
}

export function insertReferenceIntoFormulaDraft(
  text: string,
  reference: string,
  caretStart: number,
  caretEnd: number,
  previousInsertion: FormulaInsertionSpan | null
): {
  text: string
  caretStart: number
  caretEnd: number
  insertedSpan: FormulaInsertionSpan
} {
  const normalized = normalizeFormulaCaptureDraft(text, caretStart, caretEnd)
  const draft = normalized.text
  let start = normalized.caretStart
  let end = normalized.caretEnd

  if (previousInsertion && previousInsertion.start >= 0 && previousInsertion.end <= draft.length) {
    start = previousInsertion.start
    end = previousInsertion.end
  } else {
    const tokenSpan = findReferenceTokenAroundCaret(draft, start, end)
    if (tokenSpan) {
      start = tokenSpan.start
      end = tokenSpan.end
    }
  }

  const left = draft.slice(0, start)
  const right = draft.slice(end)
  const shouldAutoOpenFunctionCall = hasTrailingKnownFunctionToken(left)
  let rightForInsertion = right
  if (shouldAutoOpenFunctionCall) {
    const leadingWhitespaceLength = rightForInsertion.match(/^\s*/)?.[0].length ?? 0
    const openingParenIndex = leadingWhitespaceLength
    if (rightForInsertion[openingParenIndex] === '(') {
      rightForInsertion = `${rightForInsertion.slice(0, openingParenIndex)}${rightForInsertion.slice(openingParenIndex + 1)}`
    }
  }
  const charBefore = left.slice(-1)
  const shouldPrefixComma =
    !shouldAutoOpenFunctionCall &&
    charBefore.length > 0 &&
    /[A-Za-z0-9_$)]/.test(charBefore) &&
    !/[=+\-*/^&,:(<]/.test(charBefore)

  const insertionText = shouldAutoOpenFunctionCall
    ? `(${reference}`
    : shouldPrefixComma
      ? `,${reference}`
      : reference
  const insertedStart = left.length
  const insertedEnd = insertedStart + insertionText.length
  const nextText = `${left}${insertionText}${rightForInsertion}`

  return {
    text: nextText,
    caretStart: insertedEnd,
    caretEnd: insertedEnd,
    insertedSpan: {
      start: insertedStart,
      end: insertedEnd,
    },
  }
}
