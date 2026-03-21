/**
 * Volcano Plot Builder
 *
 * Creates Plotly volcano plot showing -log10(p-value) vs log2 fold change.
 *
 * Features:
 * - Color-coded by significance and direction
 * - Threshold lines for significance and LFC
 * - Hover labels with gene info
 * - Top gene labels
 */

import type { Data, Layout } from 'plotly.js'
import type { DEGeneResult, VolcanoOptions } from '@/types/rnaseq'
import { repelLabels } from './labelRepel'

export interface VolcanoPlotData {
  data: Data[]
  layout: Partial<Layout>
}

const PVAL_FLOOR = 1e-300

const DEFAULT_OPTIONS: VolcanoOptions = {
  pvalueThreshold: 0.05,
  lfcThreshold: 1.0,
  nLabels: 10,
  usePadj: true,
  repelForce: 1.0,
}

export function buildVolcanoPlot(
  genes: DEGeneResult[],
  options: Partial<VolcanoOptions> = {}
): VolcanoPlotData {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const pvalKey = opts.usePadj ? 'padj' : 'pvalue'
  const safeNegLog10 = (pval: number | null) => {
    if (pval === null || !Number.isFinite(pval)) return null
    const clamped = pval <= 0 ? PVAL_FLOOR : pval
    return -Math.log10(clamped)
  }
  const thresholdPval =
    Number.isFinite(opts.pvalueThreshold) && opts.pvalueThreshold > 0
      ? opts.pvalueThreshold
      : PVAL_FLOOR
  const thresholdNegLog = -Math.log10(Math.max(thresholdPval, PVAL_FLOOR))

  // Categorize genes
  const upSig: DEGeneResult[] = []
  const downSig: DEGeneResult[] = []
  const notSig: DEGeneResult[] = []

  for (const gene of genes) {
    const pval = gene[pvalKey]
    const lfc = gene.log2FoldChange

    if (pval === null || lfc === null || !Number.isFinite(pval) || !Number.isFinite(lfc)) continue

    if (pval < opts.pvalueThreshold) {
      if (lfc > opts.lfcThreshold) {
        upSig.push(gene)
      } else if (lfc < -opts.lfcThreshold) {
        downSig.push(gene)
      } else {
        notSig.push(gene)
      }
    } else {
      notSig.push(gene)
    }
  }

  // Create traces
  const traces: Data[] = []

  // Not significant (grey)
  if (notSig.length > 0) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      name: `Not Significant (${notSig.length})`,
      x: notSig.map((g) => g.log2FoldChange),
      y: notSig.map((g) => safeNegLog10(g[pvalKey]) ?? 0),
      text: notSig.map((g) => g.geneSymbol),
      customdata: notSig.map((g) => ({
        geneId: g.geneId,
        baseMean: g.baseMean,
        pvalue: g.pvalue,
        padj: g.padj,
      })),
      hovertemplate:
        '<b>%{text}</b><br>' +
        'log2FC: %{x:.3f}<br>' +
        '-log10(p): %{y:.2f}<br>' +
        '<extra></extra>',
      marker: {
        color: '#9CA3AF',
        size: 5,
        opacity: 0.6,
      },
    })
  }

  // Upregulated (red)
  if (upSig.length > 0) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      name: `Upregulated (${upSig.length})`,
      x: upSig.map((g) => g.log2FoldChange),
      y: upSig.map((g) => safeNegLog10(g[pvalKey]) ?? 0),
      text: upSig.map((g) => g.geneSymbol),
      customdata: upSig.map((g) => ({
        geneId: g.geneId,
        baseMean: g.baseMean,
        pvalue: g.pvalue,
        padj: g.padj,
      })),
      hovertemplate:
        '<b>%{text}</b><br>' +
        'log2FC: %{x:.3f}<br>' +
        '-log10(p): %{y:.2f}<br>' +
        '<extra></extra>',
      marker: {
        color: '#EF4444',
        size: 6,
        opacity: 0.8,
      },
    })
  }

  // Downregulated (blue)
  if (downSig.length > 0) {
    traces.push({
      type: 'scatter',
      mode: 'markers',
      name: `Downregulated (${downSig.length})`,
      x: downSig.map((g) => g.log2FoldChange),
      y: downSig.map((g) => safeNegLog10(g[pvalKey]) ?? 0),
      text: downSig.map((g) => g.geneSymbol),
      customdata: downSig.map((g) => ({
        geneId: g.geneId,
        baseMean: g.baseMean,
        pvalue: g.pvalue,
        padj: g.padj,
      })),
      hovertemplate:
        '<b>%{text}</b><br>' +
        'log2FC: %{x:.3f}<br>' +
        '-log10(p): %{y:.2f}<br>' +
        '<extra></extra>',
      marker: {
        color: '#3B82F6',
        size: 6,
        opacity: 0.8,
      },
    })
  }

  // Calculate axis ranges
  const allLfc = genes.map((g) => g.log2FoldChange).filter((v): v is number => v !== null)
  const allNegLogP = genes
    .map((g) => safeNegLog10(g[pvalKey]))
    .filter((v): v is number => v !== null && Number.isFinite(v))

  const finiteLfc = allLfc.filter((v) => Number.isFinite(v))
  const maxAbsLfc = Math.max(...finiteLfc.map(Math.abs), opts.lfcThreshold * 1.5)
  const minThresholdNegLog = thresholdNegLog * 1.5
  const maxNegLogP =
    allNegLogP.length > 0 ? Math.max(...allNegLogP, minThresholdNegLog) : minThresholdNegLog

  // Threshold lines (typed inline for Plotly layout)
  const shapes: Array<Record<string, unknown>> = [
    // Horizontal p-value threshold
    {
      type: 'line',
      x0: -maxAbsLfc * 1.1,
      x1: maxAbsLfc * 1.1,
      y0: thresholdNegLog,
      y1: thresholdNegLog,
      line: { color: '#6B7280', width: 1, dash: 'dash' },
    },
    // Vertical LFC threshold (positive)
    {
      type: 'line',
      x0: opts.lfcThreshold,
      x1: opts.lfcThreshold,
      y0: 0,
      y1: maxNegLogP * 1.1,
      line: { color: '#6B7280', width: 1, dash: 'dash' },
    },
    // Vertical LFC threshold (negative)
    {
      type: 'line',
      x0: -opts.lfcThreshold,
      x1: -opts.lfcThreshold,
      y0: 0,
      y1: maxNegLogP * 1.1,
      line: { color: '#6B7280', width: 1, dash: 'dash' },
    },
  ]

  // Top gene labels (typed inline for Plotly layout)
  const annotations: Array<Record<string, unknown>> = []

  if (opts.nLabels > 0) {
    // Get top significant genes by p-value
    const sigGenes = [...upSig, ...downSig]
    sigGenes.sort((a, b) => (a[pvalKey] ?? 1) - (b[pvalKey] ?? 1))
    const topGenes = sigGenes.slice(0, opts.nLabels)

    const xRangeMin = -maxAbsLfc * 1.1
    const xRangeMax = maxAbsLfc * 1.1
    const yRangeMin = 0
    const yRangeMax = maxNegLogP * 1.1
    const baseOffsetX = (xRangeMax - xRangeMin) * 0.035
    const baseOffsetY = (yRangeMax - yRangeMin) * 0.03

    const labelInputs = topGenes
      .map((gene) => {
        const x = gene.log2FoldChange
        const y = safeNegLog10(gene[pvalKey])
        const text = gene.geneSymbol || gene.geneId || ''
        if (x === null || y === null || !text) return null
        const nudgeY = y > yRangeMax * 0.85 ? -baseOffsetY : baseOffsetY
        return {
          anchorX: x,
          anchorY: y,
          labelX: x + (x >= 0 ? baseOffsetX : -baseOffsetX),
          labelY: y + nudgeY,
          text,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

    const repelled = repelLabels(labelInputs, {
      xRange: [xRangeMin, xRangeMax],
      yRange: [yRangeMin, yRangeMax],
      padding: Math.min(xRangeMax - xRangeMin, yRangeMax - yRangeMin) * 0.015,
      pull: 0.02,
      step: 0.35,
      repelForce: opts.repelForce ?? 1.0,
    })

    for (const label of repelled) {
      annotations.push({
        x: label.labelX,
        y: label.labelY,
        xref: 'x',
        yref: 'y',
        ax: label.anchorX,
        ay: label.anchorY,
        axref: 'x',
        ayref: 'y',
        text: label.text,
        showarrow: true,
        arrowhead: 0,
        arrowsize: 0.5,
        arrowwidth: 1,
        arrowcolor: '#6B7280',
        font: { size: 10 },
        xanchor: label.labelX >= label.anchorX ? 'left' : 'right',
        yanchor: label.labelY >= label.anchorY ? 'bottom' : 'top',
      })
    }
  }

  // Add threshold info annotation below legend
  const thresholdText = [
    `Thresholds:`,
    `${opts.usePadj ? 'padj' : 'p-value'} < ${opts.pvalueThreshold}`,
    `|log<sub>2</sub>FC| > ${opts.lfcThreshold}`,
  ].join('<br>')

  annotations.push({
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
  })

  // Layout
  const layout: Partial<Layout> = {
    title: {
      text: 'Volcano Plot',
      font: { size: 16 },
    },
    xaxis: {
      title: 'log<sub>2</sub> Fold Change',
      zeroline: true,
      zerolinecolor: '#E5E7EB',
      range: [-maxAbsLfc * 1.1, maxAbsLfc * 1.1],
    },
    yaxis: {
      title: `-log<sub>10</sub>(${opts.usePadj ? 'padj' : 'p-value'})`,
      rangemode: 'tozero',
      range: [0, maxNegLogP * 1.1],
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
