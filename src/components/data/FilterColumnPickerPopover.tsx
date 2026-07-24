/**
 * FilterColumnPickerPopover
 *
 * Column picker popover for the Action bar Filter button (Phase 3).
 * Lists columns with data; selecting a column delegates to the parent
 * via `onSelectColumn(colId)` to open the per-column quick-filter.
 */

import { useState } from 'react'
import { FilterIcon, RotateCcw, X } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import type { ColumnMetadata } from '@/store/data-store'
import type { FilterConfig } from '@/services/dataTransformService'

export interface FilterColumnPickerPopoverProps {
  columns: ColumnMetadata[]
  viewFilterConfig: FilterConfig | null
  /**
   * Called when a column is selected.
   * Passes the column ID and the clicked item's bounding rect so the parent
   * can anchor the column quick-filter popover near the picker item.
   */
  onSelectColumn: (colId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  /** Controlled open state. When provided, the component acts as a controlled popover. */
  open?: boolean
  /** Called when popover open state should change. Required when `open` is provided. */
  onOpenChange?: (open: boolean) => void
  /**
   * Bounding rect of the element that triggered the picker.
   * Required in controlled mode so the popover anchors near the trigger button
   * rather than at the page origin.
   */
  anchorBounds?: { x: number; y: number; width: number; height: number }
  /** True when filter undo history is non-empty (Phase 5) */
  canUndoFilter?: boolean
  /** Called when Undo Filter is clicked — runs filter-only undo, returns true if undone (Phase 5) */
  onUndoFilter?: () => boolean
  /** Called when Clear Filter is clicked — wipes the active filter config (Phase 5) */
  onClearFilter?: () => void
}

export function FilterColumnPickerPopover({
  columns,
  viewFilterConfig,
  onSelectColumn,
  open: controlledOpen,
  onOpenChange,
  anchorBounds,
  canUndoFilter = false,
  onUndoFilter,
  onClearFilter,
}: FilterColumnPickerPopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen
  const setOpen = (value: boolean) => {
    if (onOpenChange) onOpenChange(value)
    else setUncontrolledOpen(value)
  }

  // Derive set of column IDs that have active filter conditions
  const activeColumnIds = new Set<string>()
  if (viewFilterConfig?.groups) {
    for (const group of viewFilterConfig.groups) {
      for (const condition of group.conditions) {
        activeColumnIds.add(condition.columnId)
      }
    }
  }

  const handleSelectColumn = (colId: string, e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    onSelectColumn(colId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    setOpen(false)
  }

  const isControlled = controlledOpen !== undefined

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {isControlled ? (
        // In controlled mode the parent (e.g. ActionToolbar Filter button) owns the trigger.
        // Use a fixed-position PopoverAnchor at the supplied bounds so the popover
        // appears near the button rather than at the page origin.
        <PopoverAnchor
          style={{
            position: 'fixed',
            left: anchorBounds?.x ?? 0,
            top: (anchorBounds?.y ?? 0) + (anchorBounds?.height ?? 0),
            width: anchorBounds?.width ?? 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      ) : (
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Filter columns"
            className="inline-flex items-center justify-center rounded px-1 hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <FilterIcon className="h-4 w-4 text-muted-foreground" />
          </button>
        </PopoverTrigger>
      )}

      <PopoverContent align="start" className="w-48 p-2">
        {/* Undo / Clear filter actions (Phase 5) — shown whenever filter callbacks are wired */}
        {(onUndoFilter || onClearFilter) && (
          <>
            <div className="flex flex-col gap-0.5 mb-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-sm"
                aria-label="Undo filter"
                disabled={!canUndoFilter}
                onClick={() => { if (onUndoFilter?.()) setOpen(false) }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Undo filter
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2 text-sm text-destructive hover:text-destructive"
                aria-label="Clear filter"
                disabled={viewFilterConfig === null}
                onClick={() => onClearFilter?.()}
              >
                <X className="h-3.5 w-3.5" />
                Clear filter
              </Button>
            </div>
            <Separator className="mb-1" />
          </>
        )}
        {columns.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">No columns with data</p>
        ) : (
          <ScrollArea className="max-h-64 overflow-x-hidden">
            <ul role="list" aria-label="Column list" className="flex flex-col gap-0.5">
              {columns.map((col) => {
                const isActive = activeColumnIds.has(col.id)
                return (
                  <li key={col.id} className="min-w-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start truncate text-sm"
                      data-active={isActive ? 'true' : undefined}
                      aria-label={col.name}
                      onClick={(e) => handleSelectColumn(col.id, e)}
                    >
                      <span className="min-w-0 truncate">{col.name}</span>
                    </Button>
                  </li>
                )
              })}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  )
}
