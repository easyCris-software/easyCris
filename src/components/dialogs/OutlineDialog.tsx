/**
 * Outline Dialog
 *
 * Configure visual grouping/outlining of data by column
 */

import { useState, useEffect } from 'react'
import {
  ResizableDialog,
  ResizableDialogContent,
  ResizableDialogHeader,
  ResizableDialogTitle,
  ResizableDialogFooter,
  ResizableDialogDescription,
} from '@/components/ui/resizable-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ColumnMetadata } from '@/store/data-store'

interface OutlineDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  columnMetadata: ColumnMetadata[]
  currentOutlineColumnId: string | null
  onApply: (columnId: string | null) => void
}

export function OutlineDialog({
  open,
  onOpenChange,
  columnMetadata,
  currentOutlineColumnId,
  onApply,
}: OutlineDialogProps) {
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(
    currentOutlineColumnId
  )

  useEffect(() => {
    setSelectedColumnId(currentOutlineColumnId)
  }, [currentOutlineColumnId, open])

  const handleApply = () => {
    onApply(selectedColumnId)
    onOpenChange(false)
  }

  const handleClear = () => {
    setSelectedColumnId(null)
    onApply(null)
    onOpenChange(false)
  }

  return (
    <ResizableDialog
      open={open}
      onOpenChange={onOpenChange}
      defaultWidth={500}
      defaultHeight={300}
      minWidth={400}
      minHeight={250}
      persistKey="outline"
    >
      <ResizableDialogContent>
        <ResizableDialogHeader>
          <ResizableDialogTitle>Outline Data</ResizableDialogTitle>
          <ResizableDialogDescription>
            Create expandable/collapsible groups by column value
          </ResizableDialogDescription>
        </ResizableDialogHeader>

        <div className="flex-1 space-y-6 p-6 overflow-y-auto">
          <div className="space-y-2">
            <Label htmlFor="outline-column">Outline by Column</Label>
            <Select
              value={selectedColumnId || 'none'}
              onValueChange={(value) => setSelectedColumnId(value === 'none' ? null : value)}
            >
              <SelectTrigger id="outline-column">
                <SelectValue placeholder="Select column to group by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No outline</SelectItem>
                {columnMetadata.map((col) => (
                  <SelectItem key={col.id} value={col.id}>
                    {col.name} ({col.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Rows will be grouped by unique values in the selected column
            </p>
          </div>
        </div>

        <ResizableDialogFooter>
          {selectedColumnId && (
            <Button variant="outline" onClick={handleClear}>
              Clear Outline
            </Button>
          )}
          <Button onClick={handleApply}>Apply</Button>
        </ResizableDialogFooter>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}
