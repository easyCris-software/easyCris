/**
 * Sort Dialog - Simple dialog for sorting data by column
 *
 * Features:
 * - Column selector dropdown
 * - Ascending/Descending direction radio buttons
 * - Clear sort button
 */

import { useState, useEffect } from 'react'
import type { ColumnMetadata } from '@/store/data-store'
import type { SortKey } from '@/lib/grid/sortCycle'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface SortDialogProps {
  isOpen: boolean
  onClose: () => void
  columns: ColumnMetadata[]
  sortModel: SortKey[]
  onSort: (columnId: string, direction: 'asc' | 'desc') => void | Promise<void>
  onClearSort: () => void
}

export function SortDialog({
  isOpen,
  onClose,
  columns,
  sortModel,
  onSort,
  onClearSort,
}: SortDialogProps) {
  const primaryKey = sortModel[0] ?? null
  const [selectedColumn, setSelectedColumn] = useState<string>(
    primaryKey?.colId ?? ''
  )
  const [direction, setDirection] = useState<'asc' | 'desc'>(
    primaryKey?.dir ?? 'asc'
  )

  // Sync local state when the dialog opens or when the active sort changes while open.
  // The isOpen guard prevents resetting user edits while the dialog is closed between renders.
  // Primitive deps (colId/dir strings) avoid spurious resets on array identity changes.
  useEffect(() => {
    if (!isOpen) return
    setSelectedColumn(primaryKey?.colId ?? '')
    setDirection(primaryKey?.dir ?? 'asc')
  }, [isOpen, primaryKey?.colId, primaryKey?.dir])

  const handleApply = () => {
    if (selectedColumn) {
      onSort(selectedColumn, direction)
      onClose()
    }
  }

  const handleClear = () => {
    onClearSort()
    setSelectedColumn('')
    onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sort Data</DialogTitle>
          <DialogDescription>
            Choose a column and direction for the active sort.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="sort-column">Sort by column</Label>
            <Select
              value={selectedColumn || undefined}
              onValueChange={value => setSelectedColumn(value)}
            >
              <SelectTrigger id="sort-column" className="w-full">
                <SelectValue placeholder="Select a column..." />
              </SelectTrigger>
              <SelectContent>
                {columns.map(col => (
                  <SelectItem key={col.id} value={col.id}>
                    {col.name} ({col.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Direction</Label>
            <div className="flex gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="direction"
                  value="asc"
                  checked={direction === 'asc'}
                  onChange={() => setDirection('asc')}
                />
                <span>Ascending (A-Z, 0-9)</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="direction"
                  value="desc"
                  checked={direction === 'desc'}
                  onChange={() => setDirection('desc')}
                />
                <span>Descending (Z-A, 9-0)</span>
              </label>
            </div>
          </div>
        </div>

        <DialogFooter>
          {primaryKey && (
            <Button variant="outline" onClick={handleClear}>
              Clear Sort
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={!selectedColumn}>
            Apply Sort
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
