/**
 * Bulk RNA-seq Guide Dialog
 *
 * Card-based reference for the easyCris RNA-seq workflow.
 * Mirrors the layout of DataCleaningGuideDialog.
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
import {
  RNASEQ_GUIDE_CATEGORIES,
  getGuidesByCategory,
  type RNAseqGuideCategory,
  type RNAseqGuideDefinition,
} from '@/config/rnaseqGuideRegistry'

interface BulkRNAseqGuideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImportSample?: () => void
  onOpenConfigure?: () => void
}

export function BulkRNAseqGuideDialog({
  open,
  onOpenChange,
  onImportSample,
  onOpenConfigure,
}: BulkRNAseqGuideDialogProps) {
  const [query, setQuery] = useState('')

  const allGuides = useMemo(() => getGuidesByCategory(), [])

  const filteredGrouped = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return allGuides

    const filtered: Array<[RNAseqGuideCategory, RNAseqGuideDefinition[]]> = []
    for (const [category, guides] of allGuides) {
      const matching = guides.filter((guide) => {
        const haystack = [
          guide.title,
          guide.summary,
          ...guide.keywords,
          ...guide.whenToUse,
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
  }, [query, allGuides])

  const totalCount = useMemo(
    () => filteredGrouped.reduce((sum, [, guides]) => sum + guides.length, 0),
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
      persistKey="bulk-rnaseq-guide"
    >
      <ResizableDialogContent className="flex flex-col p-0">
        <ResizableDialogHeader className="px-6 pt-6 pb-4 border-b">
          <ResizableDialogTitle className="text-xl">Bulk RNA-seq Guide</ResizableDialogTitle>
          <ResizableDialogDescription>
            Step-by-step reference for setting up and running differential expression analysis in easyCris.
          </ResizableDialogDescription>
          <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search topics (e.g., batch, interaction, PCA)..."
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

              {filteredGrouped.map(([category, guides]) => (
                <section key={category} className="space-y-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {RNASEQ_GUIDE_CATEGORIES[category]}
                    </h3>
                    <span className="text-xs text-muted-foreground">
                      {guides.length} topic{guides.length === 1 ? '' : 's'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {guides.map((guide) => (
                      <Card key={guide.id} className="border-border/60">
                        <CardHeader className="space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1">
                              <CardTitle className="text-base">{guide.title}</CardTitle>
                              <CardDescription className="text-xs">
                                {guide.summary}
                              </CardDescription>
                            </div>
                            <Badge variant="secondary" className="uppercase text-[10px]">
                              {guide.badgeLabel ?? RNASEQ_GUIDE_CATEGORIES[guide.category]}
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
                              {guide.whenToUse.map((item, i) => (
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
                              {guide.requiredInputs.map((item, i) => (
                                <li key={i}>{item}</li>
                              ))}
                            </ul>
                          </div>

                          {/* What to Expect */}
                          <div className="space-y-1">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              What to Expect
                            </p>
                            <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                              {guide.whatToExpect.map((item, i) => (
                                <li key={i}>{item}</li>
                              ))}
                            </ul>
                          </div>

                          {/* Common Pitfalls */}
                          <div className="space-y-1">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Common Pitfalls
                            </p>
                            <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                              {guide.pitfalls.map((item, i) => (
                                <li key={i}>{item}</li>
                              ))}
                            </ul>
                          </div>

                          {/* CTA buttons */}
                          {(onImportSample || onOpenConfigure) && (
                            <div className="flex items-center gap-2 pt-1">
                              {onImportSample && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    onImportSample()
                                    onOpenChange(false)
                                  }}
                                >
                                  Import RNA-seq Sample Dataset
                                </Button>
                              )}
                              {onOpenConfigure && (
                                <Button
                                  size="sm"
                                  onClick={() => {
                                    onOpenConfigure()
                                    onOpenChange(false)
                                  }}
                                >
                                  Open RNA-seq Workspace
                                </Button>
                              )}
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

export default BulkRNAseqGuideDialog
