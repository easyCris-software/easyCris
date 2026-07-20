/**
 * MA Plot Builder
 *
 * Creates Plotly MA plot showing mean expression (A) vs log2 fold change (M).
 *
 * Features:
 * - Color-coded by significance
 * - Threshold line at LFC = 0
 * - Hover labels with gene info
 */

import type { Data, Layout } from 'plotly.js'
import type { DEGeneResult } from '@/types/rnaseq'

export interface MAPlotData {
  data: Data[]
  layout: Partial<Layout>
}

export interface MAPlotOptions {
  pvalueThreshold: number
  lfcThreshold: number
  usePadj: boolean
}

const DEFAULT_OPTIONS: MAPlotOptions = {
  pvalueThreshold: 0.05,
  lfcThreshold: 1.0,
  usePadj: true,
}

export function buildMAPlot(
  genes: DEGeneResult[],
  options: Partial<MAPlotOptions> = {}
): MAPlotData {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const pvalKey = opts.usePadj ? 'padj' : 'pvalue'

  // Filter genes with valid data
  const validGenes = genes.filter(
    (g) =>
      typeof g.baseMean === 'number' &&
      Number.isFinite(g.baseMean) &&
      g.baseMean > 0 &&
      typeof g.log2FoldChange === 'number' &&
      Number.isFinite(g.log2FoldChange)
  )

  // Categorize genes by significance and direction
  const upGenes: DEGeneResult[] = []
  const downGenes: DEGeneResult[] = []
  const notSigGenes: DEGeneResult[] = []

  for (const gene of validGenes) {
    const pval = gene[pvalKey]
    // Match R validation baseline: skip genes with missing/non-finite p-values entirely.
    if (pval === null || !Number.isFinite(pval)) continue

    if (pval < opts.pvalueThreshold) {
      if (gene.log2FoldChange !== null && gene.log2FoldChange > opts.lfcThreshold) {
        upGenes.push(gene)
      } else if (gene.log2FoldChange !== null && gene.log2FoldChange < -opts.lfcThreshold) {
        downGenes.push(gene)
      } else {
        notSigGenes.push(gene)
      }
    } else {
      notSigGenes.push(gene)
    }
  }

  // Create traces
  const traces: Data[] = []

  // Not significant (grey)
  if (notSigGenes.length > 0) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      name: `Not Significant (${notSigGenes.length})`,
      x: notSigGenes.map((g) => Math.log10(g.baseMean!)),
      y: notSigGenes.map((g) => g.log2FoldChange),
      text: notSigGenes.map((g) => g.geneSymbol),
      customdata: notSigGenes.map((g) => ({
        geneId: g.geneId,
        baseMean: g.baseMean,
        pvalue: g.pvalue,
        padj: g.padj,
      })),
      hovertemplate:
        '<b>%{text}</b><br>' +
        'log10(baseMean): %{x:.2f}<br>' +
        'log2FC: %{y:.3f}<br>' +
        '<extra></extra>',
      marker: {
        color: '#9CA3AF',
        size: 4,
        opacity: 0.5,
      },
    })
  }

  // Upregulated (red)
  if (upGenes.length > 0) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      name: `Upregulated (${upGenes.length})`,
      x: upGenes.map((g) => Math.log10(g.baseMean!)),
      y: upGenes.map((g) => g.log2FoldChange),
      text: upGenes.map((g) => g.geneSymbol),
      customdata: upGenes.map((g) => ({
        geneId: g.geneId,
        baseMean: g.baseMean,
        pvalue: g.pvalue,
        padj: g.padj,
      })),
      hovertemplate:
        '<b>%{text}</b><br>' +
        'log10(baseMean): %{x:.2f}<br>' +
        'log2FC: %{y:.3f}<br>' +
        '<extra></extra>',
      marker: {
        color: '#EF4444',
        size: 5,
        opacity: 0.7,
      },
    })
  }

  // Downregulated (blue)
  if (downGenes.length > 0) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      name: `Downregulated (${downGenes.length})`,
      x: downGenes.map((g) => Math.log10(g.baseMean!)),
      y: downGenes.map((g) => g.log2FoldChange),
      text: downGenes.map((g) => g.geneSymbol),
      customdata: downGenes.map((g) => ({
        geneId: g.geneId,
        baseMean: g.baseMean,
        pvalue: g.pvalue,
        padj: g.padj,
      })),
      hovertemplate:
        '<b>%{text}</b><br>' +
        'log10(baseMean): %{x:.2f}<br>' +
        'log2FC: %{y:.3f}<br>' +
        '<extra></extra>',
      marker: {
        color: '#3B82F6',
        size: 5,
        opacity: 0.7,
      },
    })
  }

  // Calculate axis ranges
  const allBaseMean = validGenes.map((g) => Math.log10(g.baseMean!))
  const allLfc = validGenes.map((g) => g.log2FoldChange).filter((v): v is number => v !== null)

  const xMin = allBaseMean.length > 0 ? Math.min(...allBaseMean) : 0
  const xMax = allBaseMean.length > 0 ? Math.max(...allBaseMean) : 1
  const yAbsMax = allLfc.length > 0 ? Math.max(...allLfc.map(Math.abs)) : opts.lfcThreshold * 1.5

  // Threshold line at LFC = 0 (typed inline for Plotly layout)
  const shapes: Array<Record<string, unknown>> = [
    {
      type: 'line',
      x0: xMin - 0.5,
      x1: xMax + 0.5,
      y0: 0,
      y1: 0,
      line: { color: '#6B7280', width: 1, dash: 'dash' },
    },
  ]

  // Add threshold info annotation
  const thresholdText = [
    `Thresholds:`,
    `${opts.usePadj ? 'padj' : 'p-value'} < ${opts.pvalueThreshold}`,
    `|log<sub>2</sub>FC| > ${opts.lfcThreshold}`,
  ].join('<br>')

  const annotations: Array<Record<string, unknown>> = [
    {
      text: thresholdText,
      xref: 'paper',
      yref: 'paper',
      x: 1.02,
      y: 0.02,
      xanchor: 'left',
      yanchor: 'bottom',
      showarrow: false,
      font: { size: 9, color: '#6B7280' },
      align: 'left',
    },
  ]

  // Layout
  const layout: Partial<Layout> = {
    title: {
      text: 'MA Plot',
      font: { size: 16 },
    },
    xaxis: {
      title: 'log<sub>10</sub>(mean expression)',
      range: [xMin - 0.5, xMax + 0.5],
    },
    yaxis: {
      title: 'log<sub>2</sub> Fold Change',
      range: [-yAbsMax * 1.1, yAbsMax * 1.1],
      zeroline: false,
    },
    shapes,
    annotations,
    legend: {
      orientation: 'v',
      yanchor: 'top',
      y: 1,
      xanchor: 'left',
      x: 1.02,
    },
    hovermode: 'closest',
    margin: { t: 80, b: 60, l: 60, r: 120 },
  }

  return { data: traces, layout }
}
