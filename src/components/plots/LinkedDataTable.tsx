/**
 * LinkedDataTable - shows data snapshot for the active plot
 */

import { useMemo } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { PlotSpec } from '@/store/plots-store'

export interface LinkedDataTableProps {
  plot: PlotSpec | null | undefined
  maxRows?: number
}

export function LinkedDataTable({ plot, maxRows = 12 }: LinkedDataTableProps) {
  const snapshot = plot?.sourceType === 'user_derived' ? plot.dataSnapshot : null

  const tableData = useMemo(() => {
    if (!snapshot) return null
    const columns = snapshot.columns
    if (columns.length === 0) return null

    const rowCount = Math.min(
      ...columns.map((col) => col.values.length)
    )
    const rows = []
    const limit = Math.min(rowCount, maxRows)

    for (let i = 0; i < limit; i++) {
      rows.push(columns.map((col) => col.values[i]))
    }

    return { columns, rows }
  }, [snapshot, maxRows])

  if (!plot) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a plot to see linked data
      </div>
    )
  }

  if (!snapshot) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Linked data is available for user-derived plots only
      </div>
    )
  }

  if (!tableData) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        No linked data to display
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-card">
      <div className="px-3 py-2 border-b text-xs text-muted-foreground">
        Linked Data ({tableData.rows.length} of {snapshot.metadata.sampledRows} rows)
      </div>
      <ScrollArea className="flex-1">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background border-b">
            <tr>
              <th className="px-2 py-1 text-left text-muted-foreground">#</th>
              {tableData.columns.map((col) => (
                <th key={col.columnId} className="px-2 py-1 text-left">
                  {col.columnName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableData.rows.map((row, idx) => (
              <tr key={idx} className="border-b last:border-b-0">
                <td className="px-2 py-1 text-muted-foreground">{idx + 1}</td>
                {row.map((value, colIdx) => (
                  <td key={colIdx} className="px-2 py-1">
                    {value === null || value === undefined ? '' : String(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  )
}

export default LinkedDataTable
