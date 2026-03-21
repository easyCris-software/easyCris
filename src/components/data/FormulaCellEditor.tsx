/**
 * Formula Cell Editor Component
 *
 * Custom cell editor for Glide Data Grid that provides formula autocomplete.
 * Reuses the same autocomplete logic as the formula bar for consistency.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { GridCellKind, type Rectangle, type Theme, type GridCell } from '@glideapps/glide-data-grid'
import { toast } from 'sonner'
import { useFormulaAutocomplete } from '@/hooks/useFormulaAutocomplete'
import { AutocompleteDropdown } from './AutocompleteDropdown'
import {
  isFormulaCaptureInput,
  isFormulaRangePickMode,
  normalizeFormulaBeforeCommit,
  toggleAbsoluteReferenceAtCaret,
} from '@/lib/grid/formulas/formulaEditUtils'

export type FormulaEditorTargetCell = {
  rowIndex: number
  colIndex: number
  columnId: string
}

export type FormulaEditorBridge = {
  applyDraft: (text: string, caretStart?: number, caretEnd?: number) => void
  focus: () => void
}

export type FormulaSessionSnapshot = {
  source: 'cell'
  editorSessionId: number
  targetCell: FormulaEditorTargetCell | null
  text: string
  caretStart: number
  caretEnd: number
  isRangePickMode: boolean
  preserveLastInsertedRange?: boolean
}

let formulaEditorSessionCounter = 1

interface FormulaCellEditorProps {
  readonly onChange: (newValue: GridCell) => void
  readonly onFinishedEditing: (newValue?: GridCell, movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => void
  readonly isHighlighted: boolean
  readonly value: GridCell
  readonly initialValue?: string
  readonly target: Rectangle
  readonly forceEditMode: boolean
  readonly isValid?: boolean
  readonly theme: Theme
  readonly onTextChange?: (text: string) => void // Callback for cell reference highlighting
  readonly activeCell?: FormulaEditorTargetCell | null
  readonly onFormulaSessionChange?: (snapshot: FormulaSessionSnapshot) => void
  readonly onFormulaSessionEnd?: () => void
  readonly onEditorBridgeChange?: (bridge: FormulaEditorBridge | null) => void
  readonly onRangePickArrow?: (
    movement: readonly [-1 | 0 | 1, -1 | 0 | 1],
    extendSelection: boolean
  ) => void
}

export const FormulaCellEditor: React.FC<FormulaCellEditorProps> = ({
  onChange,
  onFinishedEditing,
  value,
  initialValue,
  target,
  theme,
  onTextChange,
  activeCell,
  onFormulaSessionChange,
  onFormulaSessionEnd,
  onEditorBridgeChange,
  onRangePickArrow,
}) => {
  const [text, setText] = useState(() => {
    if (initialValue !== undefined) return initialValue

    // For cells with formulas, show the formula string instead of computed value
    const valueWithCopyData = value as GridCell & { copyData?: string }
    if (valueWithCopyData.copyData) return valueWithCopyData.copyData

    if (value.kind === GridCellKind.Text) return value.data
    if (value.kind === GridCellKind.Number && value.data !== undefined) return String(value.data)
    return ''
  })
  const inputRef = useRef<HTMLInputElement>(null)

  // Track initial target position to detect scroll
  const initialTargetRef = useRef<{ x: number; y: number } | null>(null)
  const commitPendingRef = useRef(false)

  // Track dropdown position using viewport coordinates (like Excel)
  // We compute this from the input's bounding rect so suggestions always
  // appear directly under the edited cell, regardless of grid layout.
  const [dropdownPosition, setDropdownPosition] = useState<{
    top: number
    left: number
  } | null>(null)

  // Only activate autocomplete for text/number cells
  const isEditableCell = value.kind === GridCellKind.Text || value.kind === GridCellKind.Number

  const selectingSuggestionRef = useRef(false)
  const emittedInitialSessionRef = useRef(false)
  const editorSessionIdRef = useRef<number>(formulaEditorSessionCounter++)
  const latestSessionSnapshotRef = useRef<{
    isRangePickMode: boolean
  }>({ isRangePickMode: false })

  const {
    suggestions,
    selectedIndex,
    updateSuggestions,
    insertSuggestion,
    selectIndex,
    navigateUp,
    navigateDown,
    clearSuggestions,
    currentSignature,
  } = useFormulaAutocomplete()

  // Auto-focus on mount and store initial target position
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
    // Store initial position to detect scroll
    initialTargetRef.current = { x: target.x, y: target.y }
  }, [])

  const emitSessionSnapshot = useCallback(
    (
      nextText: string,
      caretStart: number,
      caretEnd: number,
      preserveLastInsertedRange: boolean = false
    ) => {
      const rangePickMode = isFormulaRangePickMode(nextText, caretStart, caretEnd)
      latestSessionSnapshotRef.current = {
        isRangePickMode: rangePickMode,
      }
      if (!onFormulaSessionChange) return
      onFormulaSessionChange({
        source: 'cell',
        editorSessionId: editorSessionIdRef.current,
        targetCell: activeCell ?? null,
        text: nextText,
        caretStart,
        caretEnd,
        isRangePickMode: rangePickMode,
        preserveLastInsertedRange,
      })
    },
    [activeCell, onFormulaSessionChange]
  )

  useEffect(() => {
    if (emittedInitialSessionRef.current) return
    emittedInitialSessionRef.current = true
    emitSessionSnapshot(text, text.length, text.length)
  }, [emitSessionSnapshot, text])

  // Clear highlights when editor closes
  useEffect(() => {
    return () => {
      const preserveRangeSession = latestSessionSnapshotRef.current.isRangePickMode
      if (!preserveRangeSession) {
        onTextChange?.('')
        onFormulaSessionEnd?.()
      }
      onEditorBridgeChange?.(null)
    }
  }, [onEditorBridgeChange, onFormulaSessionEnd, onTextChange])

  // Recompute dropdown position whenever suggestions become visible
  useEffect(() => {
    if (!isEditableCell || suggestions.length === 0) {
      setDropdownPosition(null)
      return
    }

    const inputEl = inputRef.current
    if (!inputEl) {
      setDropdownPosition(null)
      return
    }

    const rect = inputEl.getBoundingClientRect()
    setDropdownPosition({
      top: rect.bottom,
      left: rect.left,
    })
  }, [isEditableCell, suggestions.length])

  const pushDraftToGrid = useCallback(
    (newText: string) => {
      // Notify parent of change
      if (value.kind === GridCellKind.Text) {
        onChange({
          ...value,
          data: newText,
        } as GridCell)
      } else if (value.kind === GridCellKind.Number) {
        // IMPORTANT: Preserve formulas as raw strings even in numeric cells.
        // Only coerce to number if not a formula and parseable.
        if (newText.startsWith('=')) {
          onChange({
            // Switch to Text cell so Glide can hold a string
            ...value,
            kind: GridCellKind.Text,
            data: newText,
          } as GridCell)
        } else {
          const trimmed = newText.trim()
          if (trimmed === '') {
            onChange({
              ...value,
              data: undefined,
            } as GridCell)
            return
          }

          const num = Number(trimmed)
          onChange({
            ...value,
            data: Number.isFinite(num) ? num : undefined,
          } as GridCell)
        }
      }
    },
    [onChange, value]
  )

  const handleTextChange = (newText: string, caretHint?: number) => {
    setText(newText)

    // Notify parent for cell reference highlighting
    onTextChange?.(newText)

    if (isEditableCell) {
      const safeCaret = typeof caretHint === 'number' ? caretHint : newText.length
      updateSuggestions(newText, safeCaret)
      emitSessionSnapshot(newText, safeCaret, safeCaret)
    }

    // Keep formula drafts local/session-owned until explicit commit.
    // This prevents premature evaluation (#ERROR) while users are still
    // building ranges like =SUM(A1:A10.
    if (!isFormulaCaptureInput(newText)) {
      pushDraftToGrid(newText)
    }
  }

  const applyExternalDraft = useCallback(
    (nextText: string, caretStart?: number, caretEnd?: number) => {
      const safeStart = Math.max(0, Math.min(caretStart ?? nextText.length, nextText.length))
      const safeEnd = Math.max(safeStart, Math.min(caretEnd ?? safeStart, nextText.length))
      setText(nextText)
      onTextChange?.(nextText)
      updateSuggestions(nextText, safeStart)
      emitSessionSnapshot(nextText, safeStart, safeEnd, true)
      if (!isFormulaCaptureInput(nextText)) {
        pushDraftToGrid(nextText)
      }

      requestAnimationFrame(() => {
        const input = inputRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(safeStart, safeEnd)
      })
    },
    [emitSessionSnapshot, onTextChange, pushDraftToGrid, updateSuggestions]
  )

  useEffect(() => {
    if (!onEditorBridgeChange) return
    onEditorBridgeChange({
      applyDraft: applyExternalDraft,
      focus: () => {
        inputRef.current?.focus()
      },
    })
    return () => {
      onEditorBridgeChange(null)
    }
  }, [applyExternalDraft, onEditorBridgeChange])

  const handleInsertSuggestion = useCallback((indexOverride?: number) => {
    const caret = inputRef.current?.selectionStart ?? text.length
    const result = insertSuggestion(text, caret, indexOverride)
    if (!result) return
    applyExternalDraft(result.text, result.caretIndex, result.caretIndex)
    clearSuggestions()
  }, [applyExternalDraft, clearSuggestions, insertSuggestion, text])

  const handleCommit = useCallback(
    (movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]): boolean => {
      const normalized = normalizeFormulaBeforeCommit(text)
      if (normalized.error) {
        toast.error(normalized.error)
        return false
      }
      const commitText = normalized.text
      if (normalized.autoClosedCount > 0) {
        setText(commitText)
      }

      // Create final cell value
      if (value.kind === GridCellKind.Text) {
        onFormulaSessionEnd?.()
        onFinishedEditing(
          {
            ...value,
            data: commitText,
          } as GridCell,
          movement
        )
      } else if (value.kind === GridCellKind.Number) {
        if (commitText.startsWith('=')) {
          // Commit formula string as Text cell for numeric columns
          onFormulaSessionEnd?.()
          onFinishedEditing(
            {
              ...value,
              kind: GridCellKind.Text,
              data: commitText,
            } as GridCell,
            movement
          )
        } else {
          const trimmed = commitText.trim()
          if (trimmed === '') {
            onFormulaSessionEnd?.()
            onFinishedEditing(
              {
                ...value,
                data: undefined,
              } as GridCell,
              movement
            )
            return true
          }

          const num = Number(trimmed)
          onFormulaSessionEnd?.()
          onFinishedEditing(
            {
              ...value,
              data: Number.isFinite(num) ? num : undefined,
            } as GridCell,
            movement
          )
        }
      }
      return true
    },
    [onFormulaSessionEnd, onFinishedEditing, text, value]
  )

  const commitOnce = useCallback(
    (movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => {
      if (commitPendingRef.current) return
      commitPendingRef.current = true
      const committed = handleCommit(movement)
      if (!committed) {
        commitPendingRef.current = false
      }
    },
    [handleCommit]
  )

  const transferEditingToFormulaBar = useCallback(() => {
    if (commitPendingRef.current) return
    commitPendingRef.current = true
    clearSuggestions()
    // Close inline editor without committing; SpreadsheetView preserves range-pick
    // session and migrates ownership to the formula bar.
    onFinishedEditing(undefined)
  }, [clearSuggestions, onFinishedEditing])

  // Detect scroll by monitoring target position changes
  // When the grid scrolls, the target rect changes - commit and close the editor
  useEffect(() => {
    // Skip if we haven't stored initial position yet (first render)
    if (!initialTargetRef.current) return
    // Skip if we're already committing
    if (commitPendingRef.current) return

    // Check if position changed significantly (more than 2px to account for rounding)
    const dx = Math.abs(target.x - initialTargetRef.current.x)
    const dy = Math.abs(target.y - initialTargetRef.current.y)

    if (dx > 2 || dy > 2) {
      const input = inputRef.current
      const caretStart = input?.selectionStart ?? text.length
      const caretEnd = input?.selectionEnd ?? caretStart
      if (isFormulaRangePickMode(text, caretStart, caretEnd)) {
        transferEditingToFormulaBar()
        return
      }
      // Grid scrolled while editing - commit and close
      commitOnce()
    }
  }, [target.x, target.y, commitOnce, text, transferEditingToFormulaBar])

  // Fallback: close the editor on wheel/scroll events (target doesn't always update during scroll).
  // Only triggers for scrolls inside the grid (dvn-scroller), not plots or other panels.
  useEffect(() => {
    const handleAnyScroll = (e: Event) => {
      const hasInputFocus = document.activeElement === inputRef.current
      const isRangePickSession = latestSessionSnapshotRef.current.isRangePickMode
      // During range-pick, focus often moves into the grid as users click/drag.
      // Keep migration active even without input focus.
      if (!hasInputFocus && !isRangePickSession) return

      // Only commit if scroll happened inside the Glide Data Grid scroller
      // Glide uses 'dvn-scroller' class for its virtual scroll container
      const targetEl = e.target instanceof HTMLElement ? e.target : null
      if (!targetEl) return

      const isGridScroll = targetEl.closest('.dvn-scroller') !== null

      if (isGridScroll) {
        const input = inputRef.current
        const caretStart = input?.selectionStart ?? text.length
        const caretEnd = input?.selectionEnd ?? caretStart
        if (isFormulaRangePickMode(text, caretStart, caretEnd)) {
          transferEditingToFormulaBar()
          return
        }
        commitOnce()
      }
    }

    window.addEventListener('scroll', handleAnyScroll, { passive: true, capture: true })
    window.addEventListener('wheel', handleAnyScroll, { passive: true, capture: true })

    return () => {
      window.removeEventListener('scroll', handleAnyScroll, true)
      window.removeEventListener('wheel', handleAnyScroll, true)
    }
  }, [commitOnce, text, transferEditingToFormulaBar])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'F4' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const input = inputRef.current
      const caretStart = input?.selectionStart ?? text.length
      const caretEnd = input?.selectionEnd ?? caretStart
      const toggled = toggleAbsoluteReferenceAtCaret(text, caretStart, caretEnd)
      if (toggled) {
        e.preventDefault()
        e.stopPropagation()
        applyExternalDraft(toggled.text, toggled.caretStart, toggled.caretEnd)
        clearSuggestions()
      }
      return
    }

    // Handle autocomplete navigation
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        navigateDown()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        navigateUp()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        handleInsertSuggestion()
        return
      }
    }

    // Grid navigation while editing:
    // - Up/Down always commit and move
    // - Left/Right only move when caret is at boundary (so normal cursor movement still works)
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const input = inputRef.current
      const selectionStart = input?.selectionStart ?? 0
      const selectionEnd = input?.selectionEnd ?? 0
      const hasSelection = selectionStart !== selectionEnd
      const textLength = input?.value.length ?? 0
      const isRangePick = isFormulaRangePickMode(text, selectionStart, selectionEnd)
      const movement: readonly [-1 | 0 | 1, -1 | 0 | 1] =
        e.key === 'ArrowUp'
          ? [0, -1]
          : e.key === 'ArrowDown'
            ? [0, 1]
            : e.key === 'ArrowLeft'
              ? [-1, 0]
              : [1, 0]

      if (isRangePick) {
        e.preventDefault()
        e.stopPropagation()
        onRangePickArrow?.(movement, e.shiftKey)
        return
      }

      let shouldMove = false
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        shouldMove = true
      } else if (!hasSelection) {
        if (e.key === 'ArrowLeft' && selectionStart === 0) {
          shouldMove = true
        }
        if (e.key === 'ArrowRight' && selectionEnd === textLength) {
          shouldMove = true
        }
      }

      if (shouldMove) {
        e.preventDefault()
        e.stopPropagation()
        handleCommit(movement)
        return
      }
    }

    // Handle commit/cancel
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (suggestions.length > 0) {
        handleInsertSuggestion()
      } else {
        handleCommit([0, 1]) // Move down after Enter
      }
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onFormulaSessionEnd?.()
      onFinishedEditing(undefined) // Cancel edit
      return
    }

    // Tab navigation
    if (e.key === 'Tab' && suggestions.length === 0) {
      e.preventDefault()
      e.stopPropagation()
      handleCommit([e.shiftKey ? -1 : 1, 0]) // Move left/right
      return
    }
  }

  const handleSuggestionSelect = (index?: number) => {
    selectingSuggestionRef.current = true
    handleInsertSuggestion(typeof index === 'number' ? index : undefined)
    requestAnimationFrame(() => {
      selectingSuggestionRef.current = false
    })
    inputRef.current?.focus()
  }

  const handleBlur = () => {
    if (selectingSuggestionRef.current) {
      selectingSuggestionRef.current = false
      return
    }

    const input = inputRef.current
    const caretStart = input?.selectionStart ?? text.length
    const caretEnd = input?.selectionEnd ?? caretStart
    const isRangePick = isFormulaRangePickMode(text, caretStart, caretEnd)
    if (suggestions.length === 0 && !isRangePick) {
      handleCommit()
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => {
          const caret = e.target.selectionStart ?? e.target.value.length
          handleTextChange(e.target.value, caret)
        }}
        onClick={() => {
          const input = inputRef.current
          if (!input) return
          emitSessionSnapshot(text, input.selectionStart ?? text.length, input.selectionEnd ?? text.length)
        }}
        onKeyUp={() => {
          const input = inputRef.current
          if (!input) return
          emitSessionSnapshot(text, input.selectionStart ?? text.length, input.selectionEnd ?? text.length)
        }}
        onSelect={() => {
          const input = inputRef.current
          if (!input) return
          emitSessionSnapshot(text, input.selectionStart ?? text.length, input.selectionEnd ?? text.length)
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          outline: 'none',
          padding: '0 8px',
          fontSize: theme.baseFontStyle?.split(' ')[0] || '13px',
          fontFamily: 'monospace',
          backgroundColor: 'transparent',
          color: theme.textDark,
        }}
      />

      {isEditableCell && suggestions.length > 0 && dropdownPosition && (
        <AutocompleteDropdown
          suggestions={suggestions}
          selectedIndex={selectedIndex}
          position={{
            top: dropdownPosition.top,
            left: dropdownPosition.left,
          }}
          onSelect={handleSuggestionSelect}
          onHover={selectIndex}
          positionMode="fixed"
          usePortal={true}
          signature={currentSignature ?? undefined}
          onInteractionStart={() => {
            selectingSuggestionRef.current = true
          }}
        />
      )}
    </div>
  )
}
