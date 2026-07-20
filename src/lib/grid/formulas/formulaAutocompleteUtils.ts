import type { FunctionSuggestion } from './formulaService'
import { getFunctionSuggestionsWithHints } from './formulaService'

export type FormulaTokenContext = {
  tokenStart: number
  tokenEnd: number
  prefix: string
}

const TOKEN_CHAR_REGEX = /[A-Za-z.]/
const TOKEN_CONTEXT_LEFT_REGEX = /[=+\-*/^&,<(]\s*$/

function isCaretInsideStringLiteral(text: string, caretIndex: number): boolean {
  let inString = false
  for (let i = 0; i < Math.min(caretIndex, text.length); i += 1) {
    const char = text[i]
    if (char === '"') {
      const prev = i > 0 ? text[i - 1] : ''
      if (prev !== '\\') {
        inString = !inString
      }
    }
  }
  return inString
}

export function getFormulaTokenContext(
  text: string,
  caretIndex: number
): FormulaTokenContext | null {
  if (!text.startsWith('=')) return null
  if (isCaretInsideStringLiteral(text, caretIndex)) return null

  const safeCaret = Math.max(0, Math.min(caretIndex, text.length))

  let tokenStart = safeCaret
  while (tokenStart > 0 && TOKEN_CHAR_REGEX.test(text[tokenStart - 1]!)) {
    tokenStart -= 1
  }

  let tokenEnd = safeCaret
  while (tokenEnd < text.length && TOKEN_CHAR_REGEX.test(text[tokenEnd]!)) {
    tokenEnd += 1
  }

  const prefix = text.slice(tokenStart, safeCaret)
  if (prefix.length === 0) return null
  if (!/^[A-Za-z.]+$/.test(prefix)) return null

  const left = text.slice(0, tokenStart)
  if (!TOKEN_CONTEXT_LEFT_REGEX.test(left)) return null

  return {
    tokenStart,
    tokenEnd,
    prefix: prefix.toUpperCase(),
  }
}

export function getSuggestionsForFormulaToken(
  text: string,
  caretIndex: number,
  limit: number = 8
): { suggestions: FunctionSuggestion[]; context: FormulaTokenContext | null } {
  const context = getFormulaTokenContext(text, caretIndex)
  if (!context) {
    return { suggestions: [], context: null }
  }

  return {
    suggestions: getFunctionSuggestionsWithHints(context.prefix, limit),
    context,
  }
}

export function applyFunctionSuggestion(
  text: string,
  caretIndex: number,
  suggestionName: string
): { text: string; caretIndex: number } | null {
  const context = getFormulaTokenContext(text, caretIndex)
  if (!context) return null

  const left = text.slice(0, context.tokenStart)
  let right = text.slice(context.tokenEnd)
  if (right.startsWith('(')) {
    right = right.slice(1)
  }

  const replacement = `${suggestionName.toUpperCase()}(`
  const nextText = `${left}${replacement}${right}`
  const nextCaret = left.length + replacement.length

  return {
    text: nextText,
    caretIndex: nextCaret,
  }
}
