import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { tauriApi, type SampleDataset } from '@/services/tauriApi'

interface SampleDatasetsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImportDataset: (dataset: SampleDataset) => void
  initialSearch?: string
  pendingTestName?: string
}

type CsvPreview = {
  headers: string[]
  rows: string[][]
}

const parseCsvPreview = (content: string): CsvPreview => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)

  if (lines.length === 0) {
    return { headers: [], rows: [] }
  }

  const headerLine = lines[0]
  if (!headerLine) {
    return { headers: [], rows: [] }
  }
  const headers = headerLine.split(',').map((cell) => cell.trim())
  const rows = lines.slice(1).map((line) => line.split(',').map((cell) => cell.trim()))
  return { headers, rows }
}

export function SampleDatasetsDialog({
  open,
  onOpenChange,
  onImportDataset,
  initialSearch,
  pendingTestName,
}: SampleDatasetsDialogProps) {
  const [datasets, setDatasets] = useState<SampleDataset[]>([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<SampleDataset | null>(null)
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setSearch(initialSearch ?? '')
    setIsLoading(true)
    tauriApi
      .getSampleDatasets()
      .then((list) => {
        setDatasets(list)
        setSelected(list[0] ?? null)
      })
      .finally(() => setIsLoading(false))
  }, [open, initialSearch])

  useEffect(() => {
    if (!selected) {
      setPreview(null)
      return
    }
    setPreviewLoading(true)
    tauriApi
      .readSampleDatasetPreview(selected.file, 6)
      .then((content) => setPreview(parseCsvPreview(content)))
      .catch(() => setPreview(null))
      .finally(() => setPreviewLoading(false))
  }, [selected])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return datasets
    return datasets.filter((dataset) =>
      [
        dataset.name,
        dataset.id,
        dataset.group,
        dataset.description,
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    )
  }, [datasets, search])

  useEffect(() => {
    if (!open) return
    if (filtered.length === 0) {
      setSelected(null)
      return
    }
    if (!selected || !filtered.some((dataset) => dataset.id === selected.id)) {
      setSelected(filtered[0] ?? null)
    }
  }, [filtered, open, selected])

  const grouped = useMemo(() => {
    const map = new Map<string, SampleDataset[]>()
    for (const dataset of filtered) {
      const key = dataset.group
      if (!map.has(key)) {
        map.set(key, [])
      }
      map.get(key)!.push(dataset)
    }
    return Array.from(map.entries())
  }, [filtered])

  const importButtonLabel = pendingTestName ? 'Import & Continue' : 'Import Dataset'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1100px] w-[95vw] sm:max-w-[1100px] max-h-[calc(100dvh-2rem)] p-0 flex flex-col overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
          <DialogTitle>Statistics Sample Datasets</DialogTitle>
          {pendingTestName && (
            <p className="text-xs text-muted-foreground">
              Import a dataset to continue with <span className="font-medium text-foreground">{pendingTestName}</span>
            </p>
          )}
        </DialogHeader>
        <div className="px-6 pb-4 shrink-0">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search datasets…"
          />
        </div>
        <div className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-4 px-6 pb-4">
          <ScrollArea className="min-h-[220px] lg:h-full min-w-0 rounded-md border border-border/60">
            <div className="p-3 space-y-4">
              {isLoading && (
                <p className="text-sm text-muted-foreground">Loading datasets…</p>
              )}
              {!isLoading && grouped.length === 0 && (
                <p className="text-sm text-muted-foreground">No datasets found.</p>
              )}
              {grouped.map(([group, items]) => (
                <div key={group} className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.replace(/_/g, ' ')}
                  </p>
                  <div className="space-y-1">
                    {items.map((dataset) => (
                      <button
                        key={dataset.id}
                        type="button"
                        onClick={() => setSelected(dataset)}
                        className={cn(
                          'w-full text-left rounded-md px-3 py-2 transition-colors',
                          'border border-transparent hover:bg-accent',
                          selected?.id === dataset.id && 'bg-accent border-border/70'
                        )}
                      >
                        <p className="text-sm font-medium">{dataset.name}</p>
                        <p className="text-xs text-muted-foreground">{dataset.description}</p>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>

          <div className="flex flex-col gap-3 min-h-0">
            <div className="rounded-md border border-border/60 p-4">
              {selected ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold">{selected.name}</p>
                  <p className="text-xs text-muted-foreground">{selected.description}</p>
                  <p className="text-xs text-muted-foreground">
                    Group: {selected.group.replace(/_/g, ' ')}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Select a dataset to preview.</p>
              )}
            </div>
            <div className="flex-1 min-h-0 rounded-md border border-border/60 p-4 overflow-auto">
              {previewLoading && (
                <p className="text-sm text-muted-foreground">Loading preview…</p>
              )}
              {!previewLoading && preview && preview.headers.length > 0 && (
                <>
                  <table className="w-full text-xs">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        {preview.headers.map((header) => (
                          <th key={header} className="pb-2 pr-4 font-medium whitespace-nowrap">
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, rowIndex) => (
                        <tr key={rowIndex} className="border-t border-border/30">
                          {row.map((cell, cellIndex) => (
                            <td key={`${rowIndex}-${cellIndex}`} className="py-2 pr-4 whitespace-nowrap">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {selected?.rows != null && selected?.columns != null
                      ? `Showing ${Math.min(preview.rows.length, selected.rows)} of ${selected.rows} rows (${selected.columns} columns). Full dataset will be imported.`
                      : `Preview: first ${preview.rows.length} rows. Full dataset will be imported.`}
                  </p>
                </>
              )}
              {!previewLoading && (!preview || preview.headers.length === 0) && (
                <p className="text-sm text-muted-foreground">Preview unavailable.</p>
              )}
            </div>
          </div>
        </div>
        <DialogFooter className="px-6 pb-6 pt-3 border-t bg-background/95 backdrop-blur shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={() => selected && onImportDataset(selected)}
            disabled={!selected}
          >
            {importButtonLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
