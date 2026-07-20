/**
 * Find & Replace Dialog
 *
 * Floating panel for searching and replacing values in the spreadsheet.
 * Works with streaming row provider, formulas, and undo/redo.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import {
  searchDataset,
  replaceOne,
  replaceAll,
  checkReplaceAllGuardrails,
  type FindReplaceOptions,
  type SearchMatch,
} from '@/lib/grid/findReplace'
import cacheService from '@/services/cacheService'
import type { ColumnMetadata } from '@/store/data-store'
import type { FormulaService } from '@/lib/grid/formulas/formulaService'
import type { EditExecutor } from '@/lib/grid/editExecutor'
import { ChevronUp, ChevronDown, X, Replace } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FindReplaceDialogProps {
  isOpen: boolean
  mode: 'find' | 'replace'
  onClose: () => void
  onModeChange?: (mode: 'find' | 'replace') => void
  datasetId: string
  columns: ColumnMetadata[]
  dataRowCount: number
  formulaService: FormulaService | null
  editExecutor: EditExecutor | null
  selectedColumnIds?: string[]
  onNavigateToCell: (modelRow: number, columnId: string) => void
  onHighlightMatches: (matches: SearchMatch[], currentIndex: number) => void
}

export function FindReplaceDialog({
  isOpen,
  mode,
  onClose,
  onModeChange,
  datasetId,
  columns,
  dataRowCount,
  formulaService,
  editExecutor,
  selectedColumnIds,
  onNavigateToCell,
  onHighlightMatches,
}: FindReplaceDialogProps) {
  const [options, setOptions] = useState<FindReplaceOptions>({
    searchText: '',
    replaceText: '',
    caseSensitive: false,
    wholeWord: false,
    searchScope: 'all',
    searchIn: 'values',
    selectedColumnIds,
  })

  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [columnsData, setColumnsData] = useState<Record<string, unknown[]>>({})
  const [userScopeOverride, setUserScopeOverride] = useState(false)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Draggable position (null = use default top-right anchoring)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null)

  // Focus search input when dialog opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50)
    }
  }, [isOpen])

  // Update selected columns when grid selection changes (even if cleared)
  // Allows selecting columns AFTER opening the dialog for scoped search
  // Also adjusts scope:
  // - If user hasn't explicitly chosen a scope, auto-switch to "selected" when a column selection appears.
  // - If scope is "selected" but selection is cleared, fall back to "all".
  useEffect(() => {
    if (!isOpen) return

    const nextSelected =
      selectedColumnIds && selectedColumnIds.length > 0 ? selectedColumnIds : undefined

    setOptions((prev) => {
      const prevSelected = prev.selectedColumnIds ?? undefined
      const selectionsEqual =
        (prevSelected?.length ?? 0) === (nextSelected?.length ?? 0) &&
        (prevSelected ?? []).every((id, idx) => id === (nextSelected ?? [])[idx])

      const shouldFallbackToAll = prev.searchScope === 'selected' && !nextSelected
      const shouldAutoSelect =
        !userScopeOverride && nextSelected && prev.searchScope === 'all'

      const nextScope = shouldFallbackToAll
        ? 'all'
        : shouldAutoSelect
          ? 'selected'
          : prev.searchScope

      if (selectionsEqual && nextScope === prev.searchScope) return prev
      return { ...prev, selectedColumnIds: nextSelected, searchScope: nextScope }
    })
  }, [selectedColumnIds, isOpen, userScopeOverride])

  // Reset user scope override when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setUserScopeOverride(false)
    }
  }, [isOpen])

  // Clear highlights when dialog closes
  useEffect(() => {
    if (!isOpen) {
      onHighlightMatches([], 0)
    }
  }, [isOpen, onHighlightMatches])

  // Reset matches when dataset changes to avoid stale replacements.
  useEffect(() => {
    if (!isOpen) return
    setMatches([])
    setColumnsData({})
    setCurrentIndex(0)
    onHighlightMatches([], 0)
  }, [datasetId, isOpen, onHighlightMatches])

  // Debounced search
  useEffect(() => {
    if (!options.searchText || !isOpen) {
      setMatches([])
      setColumnsData({})
      onHighlightMatches([], 0)
      return
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      setIsSearching(true)
      try {
        await cacheService.ensureLatestCache(datasetId)
        if (cancelled) return
        const { matches: results, columnsData: data } = await searchDataset(
          datasetId,
          columns,
          dataRowCount,
          formulaService,
          options
        )
        if (cancelled) return
        setMatches(results)
        setColumnsData(data)
        setCurrentIndex(0)
        onHighlightMatches(results, 0)

        // Navigate to first match
        if (results.length > 0 && results[0]) {
          onNavigateToCell(results[0].modelRow, results[0].columnId)
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Search failed:', error)
          toast.error('Search failed')
        }
      } finally {
        if (!cancelled) {
          setIsSearching(false)
        }
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    options.searchText,
    options.caseSensitive,
    options.wholeWord,
    options.searchIn,
    options.searchScope,
    options.selectedColumnIds,
    datasetId,
    columns,
    dataRowCount,
    formulaService,
    isOpen,
    onHighlightMatches,
    onNavigateToCell,
  ])

  const handleFindNext = useCallback(() => {
    if (matches.length === 0) return
    const nextIndex = (currentIndex + 1) % matches.length
    setCurrentIndex(nextIndex)
    onHighlightMatches(matches, nextIndex)
    const match = matches[nextIndex]
    if (match) onNavigateToCell(match.modelRow, match.columnId)
  }, [matches, currentIndex, onNavigateToCell, onHighlightMatches])

  const handleFindPrevious = useCallback(() => {
    if (matches.length === 0) return
    const prevIndex = (currentIndex - 1 + matches.length) % matches.length
    setCurrentIndex(prevIndex)
    onHighlightMatches(matches, prevIndex)
    const match = matches[prevIndex]
    if (match) onNavigateToCell(match.modelRow, match.columnId)
  }, [matches, currentIndex, onNavigateToCell, onHighlightMatches])

  const handleReplaceOne = async () => {
    if (matches.length === 0 || !editExecutor) return
    const match = matches[currentIndex]
    if (!match) return

    const columnType = columns.find((c) => c.id === match.columnId)?.type
    const result = await replaceOne(match, options, columnsData, editExecutor, columnType)

    // Show warning if formula cell was skipped, then auto-advance to next replaceable match
    if (result.skippedFormula) {
      toast.warning('This cell contains a formula. Edit manually or use Formulas mode.')

      // Auto-advance to next replaceable match (if any)
      const nextReplaceableIndex = matches.findIndex(
        (m, idx) => idx > currentIndex && !m.isFormula
      )
      if (nextReplaceableIndex !== -1) {
        setCurrentIndex(nextReplaceableIndex)
        onHighlightMatches(matches, nextReplaceableIndex)
        const nextMatch = matches[nextReplaceableIndex]
        if (nextMatch) onNavigateToCell(nextMatch.modelRow, nextMatch.columnId)
      }
      return
    }

    // Re-search to update matches
    await cacheService.ensureLatestCache(datasetId)
    const { matches: results, columnsData: data } = await searchDataset(
      datasetId,
      columns,
      dataRowCount,
      formulaService,
      options
    )
    setMatches(results)
    setColumnsData(data)
    const newIndex = Math.min(currentIndex, Math.max(0, results.length - 1))
    setCurrentIndex(newIndex)
    onHighlightMatches(results, newIndex)

    // Navigate to current match after replacement
    if (results.length > 0 && results[newIndex]) {
      onNavigateToCell(results[newIndex].modelRow, results[newIndex].columnId)
    }
  }

  const handleReplaceAll = async () => {
    if (matches.length === 0 || !editExecutor) return

    // Check guardrails (includes formula skip count and formula safety guard)
    const guardrail = checkReplaceAllGuardrails(matches, dataRowCount, options)

    if (guardrail.replaceableCount === 0 && guardrail.formulaSkipCount > 0) {
      toast.info(
        `All ${guardrail.formulaSkipCount} matches are in formula cells. Edit manually or use Formulas mode.`
      )
      return
    }

    if (guardrail.requiresConfirmation) {
      const confirmed = window.confirm(guardrail.message)
      if (!confirmed) return
    }

    const result = await replaceAll(matches, options, columnsData, editExecutor, columns)

    // Show result with formula skip info
    if (result.skippedFormulaCount > 0) {
      toast.success(
        `Replaced ${result.replacedCount} cell${result.replacedCount !== 1 ? 's' : ''}. ` +
          `${result.skippedFormulaCount} formula cell${result.skippedFormulaCount !== 1 ? 's' : ''} skipped - edit manually or use Formulas mode.`
      )
    } else {
      toast.success(`Replaced ${result.replacedCount} cell${result.replacedCount !== 1 ? 's' : ''}`)
    }

    // Re-search to update matches (should be empty or reduced)
    await cacheService.ensureLatestCache(datasetId)
    const { matches: results, columnsData: data } = await searchDataset(
      datasetId,
      columns,
      dataRowCount,
      formulaService,
      options
    )
    setMatches(results)
    setColumnsData(data)
    setCurrentIndex(0)
    onHighlightMatches(results, 0)
  }

  // Handle keyboard shortcuts within the dialog
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleFindNext()
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault()
        handleFindPrevious()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [handleFindNext, handleFindPrevious, onClose]
  )

  // Drag handlers for floating dialog
  const handleDragMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return

      // Skip drag when interacting with buttons/inputs marked as no-drag
      const target = e.target as HTMLElement
      if (target.closest('[data-no-drag="true"]')) {
        return
      }

      if (!dialogRef.current) return

      const rect = dialogRef.current.getBoundingClientRect()
      dragOffsetRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      }
      setIsDragging(true)
      e.preventDefault()
    },
    []
  )

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragOffsetRef.current) return
      const { x, y } = dragOffsetRef.current
      setPosition({
        x: e.clientX - x,
        y: e.clientY - y,
      })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      dragOffsetRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  if (!isOpen) return null

  return (
    <div
      ref={dialogRef}
      className="absolute top-2 right-2 z-50 p-3 bg-background border rounded-lg shadow-lg w-80"
      style={
        position
          ? {
              position: 'fixed',
              top: position.y,
              left: position.x,
            }
          : undefined
      }
      onKeyDown={handleKeyDown}
    >
      {/* Header with mode toggle */}
      <div
        className="flex items-center justify-between mb-2 cursor-move select-none"
        onMouseDown={handleDragMouseDown}
      >
        {onModeChange ? (
          <div className="flex items-center gap-0.5 bg-muted rounded-md p-0.5">
            <Button
              variant={mode === 'find' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-6 px-2.5 text-xs"
              data-no-drag="true"
              onClick={() => onModeChange('find')}
            >
              Find
            </Button>
            <Button
              variant={mode === 'replace' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-6 px-2.5 text-xs"
              data-no-drag="true"
              onClick={() => onModeChange('replace')}
            >
              Replace
            </Button>
          </div>
        ) : (
          <span className="text-sm font-medium">
            {mode === 'find' ? 'Find' : 'Find & Replace'}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={onClose}
          data-no-drag="true"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Search Input */}
      <div className="flex items-center gap-1 mb-2">
        <Input
          ref={searchInputRef}
          placeholder="Find..."
          value={options.searchText}
          onChange={(e) => setOptions((prev) => ({ ...prev, searchText: e.target.value }))}
          className="flex-1 h-8"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleFindPrevious}
          disabled={matches.length === 0}
          title="Previous (Shift+Enter)"
        >
          <ChevronUp className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleFindNext}
          disabled={matches.length === 0}
          title="Next (Enter)"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
      </div>

      {/* Replace Input (only in replace mode) */}
      {mode === 'replace' && (
        <div className="flex items-center gap-1 mb-2">
          <Input
            placeholder="Replace with..."
            value={options.replaceText}
            onChange={(e) => setOptions((prev) => ({ ...prev, replaceText: e.target.value }))}
            className="flex-1 h-8"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={handleReplaceOne}
            disabled={matches.length === 0 || !editExecutor}
            title="Replace current match"
          >
            <Replace className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2"
            onClick={handleReplaceAll}
            disabled={matches.length === 0 || !editExecutor}
            title="Replace all matches"
          >
            All
          </Button>
        </div>
      )}

      {/* Options Row 1 */}
      <div className="flex items-center gap-3 mb-2 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <Checkbox
            checked={options.caseSensitive}
            onCheckedChange={(checked) =>
              setOptions((prev) => ({ ...prev, caseSensitive: !!checked }))
            }
            className="h-3.5 w-3.5"
          />
          <span>Match case</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <Checkbox
            checked={options.wholeWord}
            onCheckedChange={(checked) =>
              setOptions((prev) => ({ ...prev, wholeWord: !!checked }))
            }
            className="h-3.5 w-3.5"
          />
          <span>Whole word</span>
        </label>
      </div>

      {/* Options Row 2 */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex-1">
          <Label className="text-xs text-muted-foreground mb-1 block">Search in</Label>
          <Select
            value={options.searchIn}
            onValueChange={(value) =>
              setOptions((prev) => ({ ...prev, searchIn: value as 'values' | 'formulas' }))
            }
          >
            <SelectTrigger className="h-7 text-xs" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="values">Values</SelectItem>
              <SelectItem value="formulas">Formulas</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1">
          <Label className="text-xs text-muted-foreground mb-1 block">Scope</Label>
          <Select
            value={options.searchScope}
            onValueChange={(value) => {
              setOptions((prev) => ({ ...prev, searchScope: value as 'all' | 'selected' }))
              setUserScopeOverride(true)
            }}
          >
            <SelectTrigger className="h-7 text-xs" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All columns</SelectItem>
              <SelectItem value="selected" disabled={!selectedColumnIds?.length}>
                Selected ({selectedColumnIds?.length ?? 0})
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Status */}
      <div
        className={cn(
          'text-xs',
          matches.length > 0 ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {isSearching ? (
          'Searching...'
        ) : matches.length > 0 ? (
          <>
            <span className="font-medium">{currentIndex + 1}</span> of{' '}
            <span className="font-medium">{matches.length}</span> match
            {matches.length !== 1 ? 'es' : ''}
            {options.searchIn === 'values' &&
              matches.some((m) => m.isFormula) &&
              ` (${matches.filter((m) => m.isFormula).length} in formulas)`}
          </>
        ) : options.searchText ? (
          'No matches found'
        ) : (
          'Type to search'
        )}
      </div>
    </div>
  )
}
