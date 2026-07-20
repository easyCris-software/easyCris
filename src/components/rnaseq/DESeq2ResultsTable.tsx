/**
 * PyDESeq2ResultsTable Component
 *
 * Displays differential expression results from PyDESeq2 analysis.
 *
 * Features:
 * - Sortable columns (by LFC, p-value, padj, baseMean)
 * - Filterable by significance and direction
 * - Summary statistics panel
 * - Export to CSV/Excel
 * - Click to view gene details
 */

import { useState, useMemo, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  Filter,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DESeqResult, DEGeneResult, DESeqSummary } from '@/types/rnaseq'

interface DESeq2ResultsTableProps {
  result: DESeqResult
  onGeneClick?: (gene: DEGeneResult) => void
  className?: string
}

type SortField = 'geneSymbol' | 'baseMean' | 'log2FoldChange' | 'pvalue' | 'padj'
type SortDirection = 'asc' | 'desc'
type SignificanceFilter = 'all' | 'significant' | 'up' | 'down' | 'ns'

const MAX_GENE_ROWS = 500

export function DESeq2ResultsTable({
  result,
  onGeneClick,
  className,
}: DESeq2ResultsTableProps) {
  const searchInputId = 'rnaseq-gene-search'
  // Filter & sort state
  const [searchQuery, setSearchQuery] = useState('')
  const [significanceFilter, setSignificanceFilter] = useState<SignificanceFilter>('all')
  const [sortField, setSortField] = useState<SortField>('padj')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const isNullModel = Boolean(result.parameters?.useNullModel)

  if (isNullModel) {
    return (
      <div className={cn('flex flex-col h-full', className)}>
        <SummaryPanel
          summary={result.summary}
          ensemblVersion={result.ensemblVersion}
          ensemblVersionSource={result.ensemblVersionSource}
          geneIdType={result.geneIdType}
          geneLabelSource={result.geneLabelSource ?? result.parameters?.geneLabelSource}
          annotationSource={result.annotationSource}
          annotationSourceName={result.annotationSourceName}
          annotationSourceVersion={result.annotationSourceVersion}
          vstTransform={result.parameters?.vstTransform ?? null}
          warnings={result.warnings}
        />
        <div className="border-t bg-muted/30 text-muted-foreground text-sm p-6">
          QC null model (~1) run: differential expression results are not computed. Use the PCA
          biplot in the Plots tab for sample QC.
        </div>
      </div>
    )
  }

  // Filter genes
  const filteredGenes = useMemo(() => {
    let genes = [...result.genes]

    // Text search (gene ID or symbol)
    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      genes = genes.filter((g) => {
        const geneId = g.geneId ?? ''
        const geneSymbol = g.geneSymbol ?? ''
        return (
          geneId.toLowerCase().includes(query) ||
          geneSymbol.toLowerCase().includes(query)
        )
      })
    }

    // Significance filter
    switch (significanceFilter) {
      case 'significant':
        genes = genes.filter((g) => g.significant)
        break
      case 'up':
        genes = genes.filter((g) => g.significant && g.direction === 'up')
        break
      case 'down':
        genes = genes.filter((g) => g.significant && g.direction === 'down')
        break
      case 'ns':
        genes = genes.filter((g) => !g.significant)
        break
    }

    return genes
  }, [result.genes, searchQuery, significanceFilter])

  // Sort genes
  const sortedGenes = useMemo(() => {
    const sorted = [...filteredGenes]

    sorted.sort((a, b) => {
      let aVal: number | string | null
      let bVal: number | string | null

      switch (sortField) {
        case 'geneSymbol':
          aVal = a.geneSymbol
          bVal = b.geneSymbol
          break
        case 'baseMean':
          aVal = a.baseMean
          bVal = b.baseMean
          break
        case 'log2FoldChange':
          aVal = a.log2FoldChange
          bVal = b.log2FoldChange
          break
        case 'pvalue':
          aVal = a.pvalue
          bVal = b.pvalue
          break
        case 'padj':
          aVal = a.padj
          bVal = b.padj
          break
        default:
          return 0
      }

      // Handle null values (sort to end)
      if (aVal === null && bVal === null) return 0
      if (aVal === null) return 1
      if (bVal === null) return -1

      // Compare values
      let comparison: number
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        comparison = aVal.localeCompare(bVal)
      } else {
        comparison = (aVal as number) - (bVal as number)
      }

      return sortDirection === 'asc' ? comparison : -comparison
    })

    return sorted
  }, [filteredGenes, sortField, sortDirection])

  const displayedCount = Math.min(sortedGenes.length, MAX_GENE_ROWS)
  const filteredTotal = sortedGenes.length
  const overallTotal = result.genes.length
  const countSuffix = filteredTotal !== overallTotal ? ` (filtered from ${overallTotal})` : ''

  // Handle sort toggle
  const handleSort = useCallback((field: SortField) => {
    setSortField((current) => {
      if (current === field) {
        setSortDirection((dir) => (dir === 'asc' ? 'desc' : 'asc'))
        return field
      } else {
        setSortDirection('asc')
        return field
      }
    })
  }, [])

  // Format number for display
  const formatNumber = (value: number | null, decimals = 3): string => {
    if (value === null) return 'NA'
    if (Math.abs(value) < 0.001 && value !== 0) {
      return value.toExponential(decimals)
    }
    return value.toFixed(decimals)
  }

  // Format p-value
  const formatPValue = (value: number | null): string => {
    if (value === null) return 'NA'
    if (value < 0.0001) return value.toExponential(2)
    return value.toFixed(4)
  }

  // Get significance badge
  const getSignificanceBadge = (gene: DEGeneResult) => {
    if (!gene.significant) {
      return <Badge variant="secondary">NS</Badge>
    }

    if (gene.direction === 'up') {
      return <Badge className="bg-red-500">Up</Badge>
    }

    return <Badge className="bg-blue-500">Down</Badge>
  }

  // Sort indicator component
  const SortIndicator = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="h-3 w-3 ml-1 opacity-50" />
    }
    return sortDirection === 'asc' ? (
      <ArrowUp className="h-3 w-3 ml-1" />
    ) : (
      <ArrowDown className="h-3 w-3 ml-1" />
    )
  }

  const getAriaSort = (field: SortField): 'none' | 'ascending' | 'descending' => {
    if (sortField !== field) return 'none'
    return sortDirection === 'asc' ? 'ascending' : 'descending'
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Summary Panel */}
      <SummaryPanel
        summary={result.summary}
        ensemblVersion={result.ensemblVersion}
        ensemblVersionSource={result.ensemblVersionSource}
        geneIdType={result.geneIdType}
        geneLabelSource={result.geneLabelSource ?? result.parameters?.geneLabelSource}
        annotationSource={result.annotationSource}
        annotationSourceName={result.annotationSourceName}
        annotationSourceVersion={result.annotationSourceVersion}
        vstTransform={result.parameters?.vstTransform ?? null}
        warnings={result.warnings}
      />

      {/* Filter Controls */}
      <div className="flex items-center gap-4 p-4 border-b">
        <div className="flex items-center gap-2 flex-1">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Label htmlFor={searchInputId} className="sr-only">
            Search genes
          </Label>
          <Input
            id={searchInputId}
            name="gene_search"
            aria-label="Search genes"
            autoComplete="off"
            placeholder="Search genes…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="max-w-xs"
          />
        </div>

        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <Select
            value={significanceFilter}
            onValueChange={(v) => setSignificanceFilter(v as SignificanceFilter)}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Genes ({result.genes.length})</SelectItem>
              <SelectItem value="significant">
                Significant ({result.summary.significantPadj05})
              </SelectItem>
              <SelectItem value="up">Upregulated ({result.summary.upregulated})</SelectItem>
              <SelectItem value="down">
                Downregulated ({result.summary.downregulated})
              </SelectItem>
              <SelectItem value="ns">
                Not Significant (
                {result.genes.length - result.summary.significantPadj05})
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Results Count */}
      <div className="px-4 py-2 text-sm text-muted-foreground border-b">
        Showing {displayedCount} of {filteredTotal} genes{countSuffix}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm border-collapse border-spacing-0 table-auto">
          <thead className="sticky top-0 bg-background border-b">
            <tr>
              <th className="w-[100px] px-4 py-3 text-left font-medium">Status</th>
              <th className="w-[200px] px-4 py-3 text-left font-medium" aria-sort={getAriaSort('geneSymbol')}>
                <button
                  type="button"
                  onClick={() => handleSort('geneSymbol')}
                  className="inline-flex items-center select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm"
                >
                  Gene
                  <SortIndicator field="geneSymbol" />
                </button>
              </th>
              <th className="w-[120px] px-4 py-3 text-right font-medium" aria-sort={getAriaSort('baseMean')}>
                <button
                  type="button"
                  onClick={() => handleSort('baseMean')}
                  className="inline-flex items-center justify-end w-full select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm"
                >
                  Base Mean
                  <SortIndicator field="baseMean" />
                </button>
              </th>
              <th className="w-[110px] px-4 py-3 text-right font-medium" aria-sort={getAriaSort('log2FoldChange')}>
                <button
                  type="button"
                  onClick={() => handleSort('log2FoldChange')}
                  className="inline-flex items-center justify-end w-full select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm"
                >
                  log2FC
                  <SortIndicator field="log2FoldChange" />
                </button>
              </th>
              <th className="w-[100px] px-4 py-3 text-right font-medium">lfcSE</th>
              <th className="w-[110px] px-4 py-3 text-right font-medium" aria-sort={getAriaSort('pvalue')}>
                <button
                  type="button"
                  onClick={() => handleSort('pvalue')}
                  className="inline-flex items-center justify-end w-full select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm"
                >
                  p-value
                  <SortIndicator field="pvalue" />
                </button>
              </th>
              <th className="w-[110px] px-4 py-3 text-right font-medium" aria-sort={getAriaSort('padj')}>
                <button
                  type="button"
                  onClick={() => handleSort('padj')}
                  className="inline-flex items-center justify-end w-full select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-sm"
                >
                  padj
                  <SortIndicator field="padj" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedGenes.slice(0, MAX_GENE_ROWS).map((gene) => (
              <tr
                key={gene.geneId}
                className={cn(
                  'cursor-pointer hover:bg-muted/50 border-b',
                  gene.significant && gene.direction === 'up' && 'bg-red-50 dark:bg-red-950/20',
                  gene.significant && gene.direction === 'down' && 'bg-blue-50 dark:bg-blue-950/20'
                )}
                onClick={() => onGeneClick?.(gene)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onGeneClick?.(gene)
                }}
                role="button"
                tabIndex={0}
                aria-label={`View gene ${gene.geneSymbol || gene.geneId}`}
              >
                <td className="px-4 py-3">{getSignificanceBadge(gene)}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{gene.geneSymbol}</div>
                  {gene.geneSymbol !== gene.geneId && (
                    <div className="text-xs text-muted-foreground">{gene.geneId}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {formatNumber(gene.baseMean, 1)}
                </td>
                <td
                  className={cn(
                    'px-4 py-3 text-right font-mono',
                    gene.log2FoldChange !== null &&
                      gene.log2FoldChange > 0 &&
                      'text-red-600',
                    gene.log2FoldChange !== null &&
                      gene.log2FoldChange < 0 &&
                      'text-blue-600'
                  )}
                >
                  {formatNumber(gene.log2FoldChange)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-muted-foreground">
                  {formatNumber(gene.lfcSE)}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {formatPValue(gene.pvalue)}
                </td>
                <td
                  className={cn(
                    'px-4 py-3 text-right font-mono',
                    gene.padj !== null && gene.padj < 0.05 && 'font-semibold'
                  )}
                >
                  {formatPValue(gene.padj)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {sortedGenes.length > MAX_GENE_ROWS && (
          <div className="p-4 text-center text-sm text-muted-foreground">
            Showing first {MAX_GENE_ROWS} genes. Use filters to narrow down results.
          </div>
        )}

        {sortedGenes.length === 0 && (
          <div className="p-8 text-center text-muted-foreground">
            No genes match the current filters.
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Summary statistics panel
 */
function SummaryPanel({
  summary,
  ensemblVersion,
  ensemblVersionSource,
  geneIdType,
  geneLabelSource,
  annotationSource,
  annotationSourceName,
  annotationSourceVersion,
  warnings,
}: {
  summary: DESeqSummary
  ensemblVersion?: string | null
  ensemblVersionSource?: 'cache' | 'online' | null
  geneIdType?: 'ensembl' | 'entrez' | 'uniprot' | 'uniprot_swissprot'
  geneLabelSource?: 'id_lookup' | 'user_provided'
  annotationSource?: string
  annotationSourceName?: string | null
  annotationSourceVersion?: string | null
  vstTransform?: 'vst' | 'log2' | null
  warnings?: string[]
}) {
  const [warningsDismissed, setWarningsDismissed] = useState(false)
  const formatSourceLabel = useCallback((value: string) => (
    value
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
  ), [])
  const resolveSourceName = useCallback((): string | null => {
    const sourceKey = (annotationSourceName ?? '').trim().toLowerCase()
    const geneType = geneIdType ?? 'ensembl'

    if (sourceKey === 'ensembl' || geneType === 'ensembl') return 'Ensembl'
    if (sourceKey === 'entrez' || geneType === 'entrez') return 'NCBI Entrez'
    if (sourceKey === 'uniprot_swissprot' || geneType === 'uniprot_swissprot') {
      return 'UniProtKB/Swiss-Prot'
    }
    if (sourceKey === 'uniprot' || geneType === 'uniprot') return 'UniProt'
    if (sourceKey) return formatSourceLabel(sourceKey)
    return null
  }, [annotationSourceName, formatSourceLabel, geneIdType])
  const resolveSourceLocation = useCallback((): string => {
    const source = (annotationSource ?? '').trim().toLowerCase()
    if (!source || source === 'local_cache' || source === 'cache') return 'bundled cache'
    if (source === 'online' || source === 'remote') return 'online source'
    if (geneIdType === 'ensembl' && ensemblVersionSource === 'online') return 'online source'
    if (geneIdType === 'ensembl' && ensemblVersionSource === 'cache') return 'bundled cache'
    return formatSourceLabel(source)
  }, [annotationSource, ensemblVersionSource, formatSourceLabel, geneIdType])
  const annotationLabel =
    geneLabelSource === 'user_provided'
      ? 'User provided labels'
      : geneIdType === 'ensembl'
        ? ensemblVersion
          ? `Ensembl ${ensemblVersion}`
          : 'Ensembl (version unavailable)'
        : 'Offline annotation cache'
  const geneIdLabel =
    geneLabelSource === 'user_provided'
      ? 'User provided'
      : geneIdType
        ? geneIdType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        : 'Ensembl'
  const sourceName = geneLabelSource === 'user_provided'
    ? null
    : resolveSourceName()
  const sourceLocation = geneLabelSource === 'user_provided'
    ? null
    : resolveSourceLocation()
  const sourceVersion = geneLabelSource === 'user_provided'
    ? null
    : (annotationSourceVersion ?? (geneIdType === 'ensembl' ? ensemblVersion : null))
  const sourceSummary = geneLabelSource === 'user_provided' || !sourceName || !sourceLocation
    ? null
    : sourceVersion
      ? sourceName === 'Ensembl'
        ? `Source: ${sourceName} release ${sourceVersion} (${sourceLocation})`
        : `Source: ${sourceName} ${sourceVersion} (${sourceLocation})`
      : `Source: ${sourceName} (version unavailable, ${sourceLocation})`
  const significantCount =
    summary.significanceMethod === 'pvalue'
      ? summary.significantP05
      : summary.significantPadj05
  const significantStat =
    summary.significanceMethod === 'pvalue' ? 'significant_p05' : 'significant_padj05'
  return (
    <div className="grid grid-cols-6 gap-4 p-4 bg-muted/50 border-b">
      <div>
        <Label className="text-xs text-muted-foreground">Total Genes</Label>
        <div
          className="text-lg font-semibold"
          data-stat="total_genes"
          data-value={summary.totalGenes}
        >
          {summary.totalGenes.toLocaleString()}
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Tested</Label>
        <div
          className="text-lg font-semibold"
          data-stat="tested_genes"
          data-value={summary.testedGenes}
        >
          {summary.testedGenes.toLocaleString()}
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">
          Significant ({summary.significanceMethod} &lt; {summary.alpha})
        </Label>
        <div
          className="text-lg font-semibold"
          data-stat={significantStat}
          data-value={significantCount}
        >
          {significantCount.toLocaleString()}
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Upregulated</Label>
        <div
          className="text-lg font-semibold text-red-600"
          data-stat="upregulated"
          data-value={summary.upregulated}
        >
          {summary.upregulated.toLocaleString()}
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Downregulated</Label>
        <div
          className="text-lg font-semibold text-blue-600"
          data-stat="downregulated"
          data-value={summary.downregulated}
        >
          {summary.downregulated.toLocaleString()}
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Annotation</Label>
        <div className="text-sm font-medium">{annotationLabel}</div>
        {geneLabelSource !== 'user_provided' && (
          <div className="text-xs text-muted-foreground">ID Type: {geneIdLabel}</div>
        )}
        {sourceSummary && <div className="text-xs text-muted-foreground">{sourceSummary}</div>}
      </div>
      <div className="hidden">
        <span data-stat="significant_p05" data-value={summary.significantP05} />
        <span data-stat="significant_p01" data-value={summary.significantP01} />
        <span data-stat="significant_p001" data-value={summary.significantP001} />
        <span data-stat="alpha" data-value={summary.alpha} />
      </div>
      {warnings && warnings.length > 0 && !warningsDismissed && (
        <div className="col-span-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 relative">
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-1 right-1 h-6 w-6 text-amber-700 hover:text-amber-900 hover:bg-amber-100"
            onClick={() => setWarningsDismissed(true)}
            aria-label="Dismiss warnings"
          >
            <X className="h-4 w-4" />
          </Button>
          <div className="font-medium pr-6">Warnings</div>
          <ul className="mt-1 space-y-1">
            {warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default DESeq2ResultsTable
