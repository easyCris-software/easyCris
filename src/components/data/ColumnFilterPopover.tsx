/**
 * ColumnFilterPopover
 *
 * Per-column filter popover rendered as a small trigger button alongside the
 * column header. Opens a popover with:
 *   - Sort A→Z / Sort Z→A
 *   - Value checklist (unique values fetched on open)
 *   - "Open Advanced Filter…" link
 *   - "Clear filter for this column" (when a filter is active for this column)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDownIcon, ArrowUpIcon, ArrowDownIcon, FilterXIcon, SlidersHorizontalIcon } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { FilterCondition } from '@/services/dataTransformService'
import { VIEW_FILTER_BLANK_TOKEN } from '@/lib/grid/filterConfigHelpers'

// ---------------------------------------------------------------------------
// Shared content panel props — used by both the standalone wrapper and the
// SpreadsheetView anchor-based integration.
// ---------------------------------------------------------------------------

export interface ColumnFilterPopoverContentProps {
  columnId: string
  activeConditions: FilterCondition[] | null
  uniqueValues: string[]
  loading: boolean
  onApply: (conditions: FilterCondition[] | null) => void
  onSort: (dir: 'asc' | 'desc') => void
  onOpenAdvancedFilter: () => void
  onClose: () => void
}

export function ColumnFilterPopoverContent({
  columnId,
  activeConditions,
  uniqueValues,
  loading,
  onApply,
  onSort,
  onOpenAdvancedFilter,
  onClose,
}: ColumnFilterPopoverContentProps) {
  const [excluded, setExcluded] = useState<Set<string>>(() =>
    new Set(
      (activeConditions ?? [])
        .filter((c) => c.operator === 'ne')
        .map((c) => c.value === '' ? VIEW_FILTER_BLANK_TOKEN : String(c.value))
    )
  )

  // Stable content key — only re-sync exclusions when the actual excluded values
  // change, not just because the parent passed a new array reference.
  // (extractColumnConditions always returns a new array, causing spurious resets.)
  // Must apply the same '' → token mapping used by the effect body so that blank
  // exclusions are encoded consistently in both the key and the derived state.
  const activeKey = useMemo(
    () =>
      (activeConditions ?? [])
        .filter((c) => c.operator === 'ne')
        .map((c) => c.value === '' ? VIEW_FILTER_BLANK_TOKEN : String(c.value))
        .sort()
        .join('\u0000'),
    [activeConditions]
  )

  // Re-sync exclusions only when content changes (not on reference-only changes)
  useEffect(() => {
    setExcluded(
      new Set(
        (activeConditions ?? [])
          .filter((c) => c.operator === 'ne')
          .map((c) => c.value === '' ? VIEW_FILTER_BLANK_TOKEN : String(c.value))
      )
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey])

  const toggleValue = useCallback((value: string) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }, [])

  const handleApply = useCallback(() => {
    if (excluded.size === 0) {
      onApply(null)
    } else {
      onApply(
        Array.from(excluded).map((v) => ({
          columnId,
          operator: 'ne' as const,
          // Map the blank sentinel back to '' for the actual filter condition
          value: v === VIEW_FILTER_BLANK_TOKEN ? '' : v,
        }))
      )
    }
    onClose()
  }, [excluded, columnId, onApply, onClose])

  const isActive = activeConditions != null && activeConditions.length > 0

  return (
    <div className="flex flex-col gap-0.5 p-2">
      {/* Sort actions */}
      <Button variant="ghost" size="sm" className="justify-start gap-2" onClick={() => { onSort('asc'); onClose() }}>
        <ArrowUpIcon className="h-3.5 w-3.5" />
        Sort A→Z
      </Button>
      <Button variant="ghost" size="sm" className="justify-start gap-2" onClick={() => { onSort('desc'); onClose() }}>
        <ArrowDownIcon className="h-3.5 w-3.5" />
        Sort Z→A
      </Button>

      <Separator className="my-2" />

      {/* Value checklist */}
      {loading ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p>
      ) : (
        <ScrollArea className="max-h-48 overflow-x-hidden">
          <ul role="list" aria-label="Filter values" className="flex flex-col gap-1 py-1">
            {uniqueValues.map((val) => {
              const label = val === VIEW_FILTER_BLANK_TOKEN ? '(Blank)' : val
              return (
                <li key={val} className="flex min-w-0 items-center gap-2 px-1">
                  <Checkbox
                    id={`cfp-${columnId}-${val}`}
                    checked={!excluded.has(val)}
                    onCheckedChange={() => toggleValue(val)}
                    aria-label={label}
                  />
                  <label htmlFor={`cfp-${columnId}-${val}`} className="min-w-0 flex-1 cursor-pointer truncate text-sm">
                    {label}
                  </label>
                </li>
              )
            })}
          </ul>
        </ScrollArea>
      )}

      <div className="mt-2 flex justify-end">
        <Button size="sm" onClick={handleApply}>Apply</Button>
      </div>

      <Separator className="my-2" />

      {/* Advanced filter + clear */}
      <Button variant="ghost" size="sm" className="justify-start gap-2" onClick={() => { onOpenAdvancedFilter(); onClose() }}>
        <SlidersHorizontalIcon className="h-3.5 w-3.5" />
        Open Advanced Filter…
      </Button>

      {isActive && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-start gap-2 text-destructive hover:text-destructive"
          onClick={() => { onApply(null); onClose() }}
        >
          <FilterXIcon className="h-3.5 w-3.5" />
          Clear filter
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

export interface ColumnFilterPopoverProps {
  columnId: string
  columnName: string
  /**
   * Current `ne`-exclusion conditions active for this column from the global
   * FilterConfig. `null` means no filter is active for this column.
   */
  activeConditions: FilterCondition[] | null
  /** Called when popover opens — returns unique values for the column. */
  getUniqueValues: () => Promise<string[]>
  /**
   * Called with new conditions for this column, or `null` to clear the filter
   * for this column. The parent is responsible for merging into the global
   * FilterConfig.
   */
  onApply: (conditions: FilterCondition[] | null) => void
  onSort: (dir: 'asc' | 'desc') => void
  onOpenAdvancedFilter: () => void
}

// ---------------------------------------------------------------------------

export function ColumnFilterPopover({
  columnId,
  columnName,
  activeConditions,
  getUniqueValues,
  onApply,
  onSort,
  onOpenAdvancedFilter,
}: ColumnFilterPopoverProps) {
  const [open, setOpen] = useState(false)
  const [uniqueValues, setUniqueValues] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  const isActive = activeConditions != null && activeConditions.length > 0

  // When popover opens: fetch unique values.
  // The cancellation flag prevents a stale (superseded) fetch from overwriting
  // results from a more recent open cycle.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    getUniqueValues()
      .then((vals) => { if (!cancelled) setUniqueValues(vals) })
      .catch(() => { /* loading cleared in finally */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, getUniqueValues])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Filter options for ${columnName}`}
          data-active={isActive ? 'true' : undefined}
          className="inline-flex items-center justify-center rounded px-0.5 hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronDownIcon
            className={`h-3 w-3 ${isActive ? 'text-primary' : 'text-muted-foreground'}`}
          />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-56 p-0">
        <ColumnFilterPopoverContent
          columnId={columnId}
          activeConditions={activeConditions}
          uniqueValues={uniqueValues}
          loading={loading}
          onApply={onApply}
          onSort={onSort}
          onOpenAdvancedFilter={onOpenAdvancedFilter}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
