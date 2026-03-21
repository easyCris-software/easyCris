/**
 * Data Cleaning Guide Dialog
 *
 * Card-based reference for data cleaning / reshaping tools.
 * Mirrors the layout of StatisticalTestsGuideDialog.
 */

import { useMemo, useState } from 'react'
import {
  ResizableDialog,
  ResizableDialogContent,
  ResizableDialogDescription,
  ResizableDialogHeader,
  ResizableDialogTitle,
} from '@/components/ui/resizable-dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowRight } from 'lucide-react'
import {
  DATA_TOOL_CATEGORIES,
  getToolsByCategory,
  type BeforeAfterExample,
  type DataCleaningActionId,
  type DataToolDefinition,
} from '@/config/dataCleaningGuideRegistry'

interface DataCleaningGuideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenTool?: (actionId: DataCleaningActionId) => void
}

function MiniTable({ rows, highlight }: { rows: string[][]; highlight?: boolean }) {
  if (rows.length === 0) return null
  const [header, ...body] = rows
  return (
    <div className="overflow-x-auto">
      <table className={`text-[11px] border-collapse w-full ${highlight ? 'ring-1 ring-primary/30 rounded' : ''}`}>
        <thead>
          <tr>
            {header?.map((cell, i) => (
              <th
                key={i}
                className="border border-border/60 bg-muted/60 px-2 py-0.5 text-left font-semibold text-muted-foreground whitespace-nowrap"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="border border-border/40 px-2 py-0.5 whitespace-nowrap"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BeforeAfter({ example }: { example: BeforeAfterExample }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Before</p>
          <MiniTable rows={example.before} />
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-6" />
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">After</p>
          <MiniTable rows={example.after} highlight />
        </div>
      </div>
      {example.caption && (
        <p className="text-[10px] text-muted-foreground italic">{example.caption}</p>
      )}
    </div>
  )
}

export function DataCleaningGuideDialog({
  open,
  onOpenChange,
  onOpenTool,
}: DataCleaningGuideDialogProps) {
  const [query, setQuery] = useState('')

  const allTools = useMemo(() => getToolsByCategory(), [])

  const filteredGrouped = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return allTools

    const filtered: Array<[string, DataToolDefinition[]]> = []
    for (const [category, tools] of allTools) {
      const matching = tools.filter((tool) => {
        const haystack = [
          tool.title,
          tool.summary,
          ...tool.keywords,
          ...tool.whenToUse,
        ]
          .join(' ')
          .toLowerCase()
        return haystack.includes(needle)
      })
      if (matching.length > 0) {
        filtered.push([category, matching])
      }
    }
    return filtered
  }, [query, allTools])

  const totalCount = useMemo(
    () => filteredGrouped.reduce((sum, [, tools]) => sum + tools.length, 0),
    [filteredGrouped]
  )

  return (
    <ResizableDialog
      open={open}
      onOpenChange={onOpenChange}
      defaultWidth={1050}
      defaultHeight={780}
      minWidth={840}
      minHeight={640}
      persistKey="data-cleaning-guide"
    >
      <ResizableDialogContent className="flex flex-col p-0">
        <ResizableDialogHeader className="px-6 pt-6 pb-4 border-b">
          <ResizableDialogTitle className="text-xl">Data Cleaning Guide</ResizableDialogTitle>
          <ResizableDialogDescription>
            Quick reference for cleaning and reshaping workflows before analysis.
          </ResizableDialogDescription>
          <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tools (e.g., pivot, filter, group)…"
            />
            <div className="text-xs text-muted-foreground">
              {totalCount} topic{totalCount === 1 ? '' : 's'}
            </div>
          </div>
        </ResizableDialogHeader>

        <div className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <div className="p-6 space-y-6">
              {filteredGrouped.length === 0 && (
                <div className="rounded-lg border border-dashed border-border/60 p-6 text-sm text-muted-foreground">
                  No topics match your search.
                </div>
              )}

              {filteredGrouped.map(([category, tools]) => (
                <section key={category} className="space-y-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {DATA_TOOL_CATEGORIES[category as keyof typeof DATA_TOOL_CATEGORIES] ?? category}
                    </h3>
                    <span className="text-xs text-muted-foreground">
                      {tools.length} tool{tools.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {tools.map((tool) => (
                      <Card key={tool.id} className="border-border/60">
                        <CardHeader className="space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1">
                              <CardTitle className="text-base">{tool.title}</CardTitle>
                              <CardDescription className="text-xs">
                                {tool.summary}
                              </CardDescription>
                            </div>
                            <Badge variant="secondary" className="uppercase text-[10px]">
                              {tool.badgeLabel ?? DATA_TOOL_CATEGORIES[tool.category]}
                            </Badge>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4 text-sm">
                          {/* When to Use */}
                          <div className="space-y-1">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              When to Use
                            </p>
                            <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                              {tool.whenToUse.map((item, i) => (
                                <li key={i}>{item}</li>
                              ))}
                            </ul>
                          </div>

                          {/* Required Inputs */}
                          <div className="space-y-1">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Required Inputs
                            </p>
                            <ul className="text-xs text-muted-foreground space-y-1">
                              {tool.requiredInputs.map((item, i) => (
                                <li key={i}>{item}</li>
                              ))}
                            </ul>
                          </div>

                          {/* What Changes */}
                          <div className="space-y-1">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              What Changes in Dataset
                            </p>
                            <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                              {tool.whatChanges.map((item, i) => (
                                <li key={i}>{item}</li>
                              ))}
                            </ul>
                          </div>

                          {/* Pitfalls */}
                          <div className="space-y-1">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Common Pitfalls
                            </p>
                            <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                              {tool.pitfalls.map((item, i) => (
                                <li key={i}>{item}</li>
                              ))}
                            </ul>
                          </div>

                          {/* Before/After Example */}
                          <div className="space-y-1.5">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Example
                            </p>
                            <BeforeAfter example={tool.exampleBeforeAfter} />
                          </div>

                          {/* Open Tool button */}
                          {tool.actionId && onOpenTool && (
                            <div className="flex items-center gap-2 pt-1">
                              <Button
                                size="sm"
                                onClick={() => {
                                  const actionId = tool.actionId
                                  if (!actionId) return
                                  onOpenTool(actionId)
                                  onOpenChange(false)
                                }}
                              >
                                Open Tool
                              </Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </ScrollArea>
        </div>
      </ResizableDialogContent>
    </ResizableDialog>
  )
}

export default DataCleaningGuideDialog
