/**
 * Group & Aggregate Dialog
 *
 * Groups data by one or more columns and applies aggregation functions
 * to the remaining columns.
 */

import { useState, useMemo, useEffect, useCallback } from 'react'
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
import { Checkbox } from '@/components/ui/checkbox'
import type { ColumnMetadata } from '@/store/data-store'
import type { AggregationFunction, GroupAggregateConfig } from '@/services/dataTransformService'

interface GroupAggregateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  columnMetadata: ColumnMetadata[]
  onApply: (config: GroupAggregateConfig) => void
  initialConfig?: GroupAggregateConfig | null
}

const AGGREGATION_LABELS: Record<AggregationFunction, string> = {
  sum: 'Sum',
  avg: 'Average (Mean)',
  count: 'Count (non-null)',
  min: 'Minimum',
  max: 'Maximum',
  median: 'Median',
  stdev: 'Std Deviation',
  none: 'None (exclude)',
}

const VALID_AGGREGATION_VALUES = new Set<AggregationFunction>(
  Object.keys(AGGREGATION_LABELS) as AggregationFunction[]
)

const NUMERIC_ONLY_AGGREGATIONS = new Set<AggregationFunction>([
  'sum',
  'avg',
  'median',
  'stdev',
])

export function GroupAggregateDialog({
  open,
  onOpenChange,
  columnMetadata,
  onApply,
  initialConfig,
}: GroupAggregateDialogProps) {
  const [groupByColumns, setGroupByColumns] = useState<string[]>([])
  const [aggregations, setAggregations] = useState<Record<string, AggregationFunction>>({})

  const isKnownAggregationValue = useCallback((value: unknown): value is AggregationFunction => {
    return typeof value === 'string' && VALID_AGGREGATION_VALUES.has(value as AggregationFunction)
  }, [])

  const isAggregationAllowed = useCallback(
    (column: ColumnMetadata, aggregation: AggregationFunction): boolean => {
      if (!NUMERIC_ONLY_AGGREGATIONS.has(aggregation)) {
        return true
      }
      return column.type === 'numeric'
    },
    []
  )

  const buildDefaultAggregations = useCallback((columns: ColumnMetadata[]) => {
    const defaults: Record<string, AggregationFunction> = {}
    columns.forEach((col) => {
      defaults[col.id] = col.type === 'numeric' ? 'avg' : 'count'
    })
    return defaults
  }, [])

  // Reset aggregations when columns or groupBy changes
  useEffect(() => {
    const availableIds = new Set(columnMetadata.map((col) => col.id))
    setGroupByColumns((prev) => prev.filter((id) => availableIds.has(id)))

    // Initialize aggregations for new columns
    setAggregations((prev) => {
      const newAggregations: Record<string, AggregationFunction> = {}
      columnMetadata.forEach((col) => {
        const existing = prev[col.id]
        if (
          existing !== undefined &&
          isKnownAggregationValue(existing) &&
          isAggregationAllowed(col, existing)
        ) {
          newAggregations[col.id] = existing
        } else {
          newAggregations[col.id] = col.type === 'numeric' ? 'avg' : 'count'
        }
      })
      return newAggregations
    })
  }, [columnMetadata, isAggregationAllowed, isKnownAggregationValue])

  useEffect(() => {
    if (!open) return

    if (initialConfig) {
      const availableIds = new Set(columnMetadata.map((col) => col.id))
      const nextGroupBy = (initialConfig.groupByColumns ?? []).filter((id) => availableIds.has(id))
      const defaults = buildDefaultAggregations(columnMetadata)
      const sanitizedInitialAggregations = Object.fromEntries(
        Object.entries(initialConfig.aggregations ?? {}).filter(([colId, aggregation]) => {
          const column = columnMetadata.find((col) => col.id === colId)
          if (!column) return false
          if (!isKnownAggregationValue(aggregation)) return false
          return isAggregationAllowed(column, aggregation)
        })
      ) as Record<string, AggregationFunction>
      const nextAggregations = {
        ...defaults,
        ...sanitizedInitialAggregations,
      }
      setGroupByColumns(nextGroupBy)
      setAggregations(nextAggregations)
      return
    }

    setGroupByColumns([])
    setAggregations(buildDefaultAggregations(columnMetadata))
  }, [open, initialConfig, columnMetadata, buildDefaultAggregations, isAggregationAllowed, isKnownAggregationValue])

  const toggleGroupByColumn = (columnId: string) => {
    setGroupByColumns((prev) =>
      prev.includes(columnId) ? prev.filter((id) => id !== columnId) : [...prev, columnId]
    )
  }

  const setColumnAggregation = (columnId: string, aggregation: AggregationFunction) => {
    if (!isKnownAggregationValue(aggregation)) {
      return
    }
    setAggregations((prev) => ({ ...prev, [columnId]: aggregation }))
  }

  // Columns to aggregate (not in groupBy)
  const aggregateColumns = useMemo(() => {
    const groupBySet = new Set(groupByColumns)
    return columnMetadata.filter((col) => !groupBySet.has(col.id))
  }, [columnMetadata, groupByColumns])

  // Count of columns that will be included in output
  const outputColumnCount = useMemo(() => {
    let count = groupByColumns.length
    aggregateColumns.forEach((col) => {
      if (aggregations[col.id] !== 'none') {
        count++
      }
    })
    return count
  }, [groupByColumns, aggregateColumns, aggregations])

  const hasAggregations = useMemo(() => {
    return aggregateColumns.some((col) => aggregations[col.id] !== 'none')
  }, [aggregateColumns, aggregations])

  const handleApply = () => {
    if (groupByColumns.length === 0) return

    // Filter out columns with 'none' aggregation
    const groupBySet = new Set(groupByColumns)
    const availableIds = new Set(columnMetadata.map((col) => col.id))
    const columnById = new Map(columnMetadata.map((col) => [col.id, col] as const))
    const finalAggregations: Record<string, AggregationFunction> = {}
    Object.entries(aggregations).forEach(([colId, agg]) => {
      if (!isKnownAggregationValue(agg)) return
      const column = columnById.get(colId)
      if (!column) return
      if (agg !== 'none' && !groupBySet.has(colId) && availableIds.has(colId) && isAggregationAllowed(column, agg)) {
        finalAggregations[colId] = agg
      }
    })

    if (Object.keys(finalAggregations).length === 0) {
      return
    }

    const config: GroupAggregateConfig = {
      groupByColumns,
      aggregations: finalAggregations,
    }

    onApply(config)
    onOpenChange(false)
  }

  const handleReset = () => {
    setGroupByColumns([])
    setAggregations(buildDefaultAggregations(columnMetadata))
  }

  return (
    <ResizableDialog
      open={open}
      onOpenChange={onOpenChange}
      defaultWidth={800}
      defaultHeight={600}
      minWidth={600}
      minHeight={400}
      persistKey="group-aggregate"
    >
      <ResizableDialogContent>
        <ResizableDialogHeader>
          <ResizableDialogTitle>Group & Aggregate</ResizableDialogTitle>
          <ResizableDialogDescription>
            Group data by columns and apply aggregation functions to create a summary dataset
          </ResizableDialogDescription>
        </ResizableDialogHeader>

        <div className="flex-1 space-y-6 p-6 overflow-y-auto">
          {/* Group by columns (multi-select) */}
          <div className="space-y-2">
            <Label>Group by columns</Label>
            <div className="rounded-md border p-3 max-h-48 overflow-y-auto space-y-2">
              {columnMetadata.map((col) => (
                <div key={col.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`group-${col.id}`}
                    checked={groupByColumns.includes(col.id)}
                    onCheckedChange={() => toggleGroupByColumn(col.id)}
                  />
                  <label
                    htmlFor={`group-${col.id}`}
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                  >
                    {col.name} ({col.type})
                  </label>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Select one or more columns to group by (e.g., Category, Date, Treatment)
            </p>
          </div>

          {/* Aggregation functions for remaining columns */}
          {aggregateColumns.length > 0 && (
            <div className="space-y-2">
              <Label>Aggregation functions</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Choose how to aggregate each column. Select "None" to exclude a column from the
                output.
              </p>
              <div className="rounded-md border divide-y max-h-96 overflow-y-auto">
                {aggregateColumns.map((col) => (
                  <div
                    key={col.id}
                    className="flex items-center justify-between gap-4 p-3 hover:bg-muted/50"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{col.name}</p>
                      <p className="text-xs text-muted-foreground">{col.type}</p>
                    </div>
                    <Select
                      value={aggregations[col.id] || 'none'}
                      onValueChange={(value) =>
                        setColumnAggregation(col.id, value as AggregationFunction)
                      }
                    >
                      <SelectTrigger className="w-52 flex-shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(AGGREGATION_LABELS) as AggregationFunction[])
                          .filter((agg) => isAggregationAllowed(col, agg))
                          .map((agg) => (
                          <SelectItem key={agg} value={agg}>
                            {AGGREGATION_LABELS[agg]}
                          </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Preview */}
          {groupByColumns.length > 0 && (
            <div className="space-y-2">
              <Label>Output preview</Label>
              <div className="rounded-md border p-3 bg-muted/50 space-y-1">
                <p className="text-sm">
                  <span className="font-medium">Grouped by:</span>{' '}
                  {groupByColumns
                    .map((id) => columnMetadata.find((c) => c.id === id)?.name)
                    .join(', ')}
                </p>
                <p className="text-sm">
                  <span className="font-medium">Output columns:</span> {outputColumnCount}
                </p>
                <p className="text-xs text-muted-foreground mt-2">
                  A new dataset will be created with one row per unique combination of group-by
                  columns
                </p>
                {!hasAggregations && (
                  <p className="text-xs text-amber-600">
                    Select at least one aggregation to enable Apply.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <ResizableDialogFooter>
          <Button variant="outline" onClick={handleReset}>
            Reset
          </Button>
          <Button onClick={handleApply} disabled={groupByColumns.length === 0 || !hasAggregations}>
            Apply Grouping
          </Button>
        </ResizableDialogFooter>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}
