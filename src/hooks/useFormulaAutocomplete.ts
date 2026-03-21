/**
 * Formula Autocomplete Hook
 *
 * Reusable hook for formula function name autocomplete.
 * Used by both formula bar and inline cell editor.
 */

import { useState, useCallback, useMemo } from 'react'
import {
  applyFunctionSuggestion,
  getSuggestionsForFormulaToken,
} from '@/lib/grid/formulas/formulaAutocompleteUtils'
import type { FunctionSuggestion } from '@/lib/grid/formulas/formulaService'

export interface FormulaAutocompleteResult {
  suggestions: FunctionSuggestion[]
  selectedIndex: number
  updateSuggestions: (text: string, caretIndex?: number) => void
  insertSuggestion: (
    text: string,
    caretIndex: number,
    indexOverride?: number
  ) => { text: string; caretIndex: number } | null
  selectIndex: (index: number) => void
  navigateUp: () => void
  navigateDown: () => void
  clearSuggestions: () => void
  currentSignature: string | null
}

/**
 * Hook for managing formula autocomplete state and logic
 */
export function useFormulaAutocomplete(): FormulaAutocompleteResult {
  const [suggestions, setSuggestions] = useState<FunctionSuggestion[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)

  /**
   * Update suggestions based on current text
   */
  const updateSuggestions = useCallback((text: string, caretIndex?: number) => {
    const safeCaret = typeof caretIndex === 'number' ? caretIndex : text.length
    const { suggestions: newSuggestions } = getSuggestionsForFormulaToken(text, safeCaret, 8)
    setSuggestions(newSuggestions)
    setSelectedIndex(prev =>
      newSuggestions.length === 0 ? 0 : Math.max(0, Math.min(prev, newSuggestions.length - 1))
    )
  }, [])

  /**
   * Insert the selected autocomplete suggestion into the text
   * Returns the new text if successful, null otherwise
   */
  const insertSuggestion = useCallback(
    (
      text: string,
      caretIndex: number,
      indexOverride?: number
    ): { text: string; caretIndex: number } | null => {
      if (suggestions.length === 0) return null

      const index = typeof indexOverride === 'number' ? indexOverride : selectedIndex
      const selectedSuggestion = suggestions[index]
      if (!selectedSuggestion) return null

      return applyFunctionSuggestion(text, caretIndex, selectedSuggestion.name)
    },
    [suggestions, selectedIndex]
  )

  /**
   * Navigate to previous suggestion
   */
  const navigateUp = useCallback(() => {
    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev))
  }, [])

  /**
   * Navigate to next suggestion
   */
  const navigateDown = useCallback(() => {
    setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : prev))
  }, [suggestions.length])

  /**
   * Clear all suggestions
   */
  const clearSuggestions = useCallback(() => {
    setSuggestions([])
    setSelectedIndex(0)
  }, [])

  const currentSignature = useMemo(() => {
    if (suggestions.length === 0) return null
    const normalizedIndex = Math.min(selectedIndex, suggestions.length - 1)
    const suggestion = suggestions[normalizedIndex]
    if (!suggestion) return null
    // Don't show redundant signature in footer when it's just the function name
    if (suggestion.signature === suggestion.name) return null
    return suggestion.signature
  }, [suggestions, selectedIndex])

  const selectIndex = useCallback((index: number) => {
    setSelectedIndex(Math.max(0, Math.min(index, suggestions.length - 1)))
  }, [suggestions.length])

  return {
    suggestions,
    selectedIndex,
    updateSuggestions,
    insertSuggestion,
    selectIndex,
    navigateUp,
    navigateDown,
    clearSuggestions,
    currentSignature,
  }
}
