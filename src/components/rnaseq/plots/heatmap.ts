/**
 * Heatmap Builder for RNA-seq
 *
 * Creates Plotly heatmap preview without clustering.
 * Clustering is handled in the Python renderer for export consistency.
 * Supports sorting by p-value or adjusted p-value.
 *
 * Features:
 * - Uses input order (no JS clustering)
 * - Color scale for expression Z-scores
 * - Gene symbol labels
 * - P-value/padj based gene selection
 */

import type { Data, Layout } from 'plotly.js'
import type { DEGeneResult, HeatmapOptions } from '@/types/rnaseq'

export interface HeatmapPlotData {
  data: Data[]
  layout: Partial<Layout>
}

export interface HeatmapInput {
  genes: DEGeneResult[]
  normalizedCounts: number[][] | undefined
  sampleIds: string[]
}

const DEFAULT_OPTIONS: HeatmapOptions = {
  nTopGenes: 50,
  clusterRows: true,
  clusterCols: true,
  showGeneSymbols: true,
  colorScale: 'RdYlBu',
  legendSpacing: 0,
}

/**
 * Compute Z-scores for each row (gene) of the matrix
 */
function computeZScores(matrix: number[][]): number[][] {
  return matrix.map((row) => {
    const mean = row.reduce((a, b) => a + b, 0) / row.length
    const n = row.length
    const denom = n > 1 ? n - 1 : n
    const variance = denom
      ? row.reduce((a, b) => a + (b - mean) ** 2, 0) / denom
      : 0
    const std = Math.sqrt(variance) || 1 // Avoid division by zero
    return row.map((val) => (val - mean) / std)
  })
}

/**
 * Build expression heatmap preview (ordering handled upstream).
 */
export function buildHeatmap(
  input: HeatmapInput,
  options: Partial<HeatmapOptions> & { usePadj?: boolean } = {}
): HeatmapPlotData {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const usePadj = options.usePadj ?? true
  const pvalKey = usePadj ? 'padj' : 'pvalue'

  const { genes, normalizedCounts, sampleIds } = input

  // Handle missing data
  if (!normalizedCounts || normalizedCounts.length === 0) {
    return {
      data: [],
      layout: {
        title: { text: 'Heatmap - No expression data available', font: { size: 14 } },
        annotations: [{
          text: 'VST-transformed expression data not available.<br>Re-run analysis with VST enabled.',
          showarrow: false,
          font: { size: 14 },
          xref: 'paper',
          yref: 'paper',
          x: 0.5,
          y: 0.5,
        }],
      },
    }
  }

  // Select top genes by p-value or padj
  const genesWithPval = genes.filter((g) => {
    const pval = g[pvalKey]
    return pval !== null && Number.isFinite(pval)
  })

  // Sort by p-value (ascending - most significant first)
  genesWithPval.sort((a, b) => {
    const pvalA = a[pvalKey] ?? 1
    const pvalB = b[pvalKey] ?? 1
    return pvalA - pvalB
  })

  // Take top N genes
  const topGenes = genesWithPval.slice(0, opts.nTopGenes)

  if (topGenes.length === 0) {
    // Fallback: use top genes by absolute LFC if no significant genes
    const genesByLfc = genes
      .filter((g) => g.log2FoldChange !== null)
      .sort((a, b) => Math.abs(b.log2FoldChange ?? 0) - Math.abs(a.log2FoldChange ?? 0))
      .slice(0, opts.nTopGenes)

    if (genesByLfc.length === 0) {
      return {
        data: [],
        layout: {
          title: { text: 'Heatmap - No genes available', font: { size: 14 } },
        },
      }
    }

    topGenes.push(...genesByLfc)
  }

  // Map gene IDs to their indices in normalizedCounts
  // Assumption: normalizedCounts rows are in same order as genes array
  const geneIdToIndex = new Map<string, number>()
  genes.forEach((g, i) => {
    geneIdToIndex.set(g.geneId, i)
  })

  // Build expression matrix for selected genes
  const selectedIndices: number[] = []
  const selectedGenes: DEGeneResult[] = []

  for (const gene of topGenes) {
    const idx = geneIdToIndex.get(gene.geneId)
    if (idx !== undefined && idx < normalizedCounts.length) {
      selectedIndices.push(idx)
      selectedGenes.push(gene)
    }
  }

  if (selectedIndices.length === 0) {
    return {
      data: [],
      layout: {
        title: { text: 'Heatmap - Gene data mismatch', font: { size: 14 } },
      },
    }
  }

  // Extract expression values for selected genes
  const expressionMatrix: number[][] = selectedIndices
    .map((idx) => normalizedCounts[idx])
    .filter((row): row is number[] => row !== undefined)

  if (expressionMatrix.length === 0 || !expressionMatrix[0] || expressionMatrix[0].length === 0) {
    return {
      data: [],
      layout: {
        title: { text: 'Heatmap - Expression data unavailable', font: { size: 14 } },
      },
    }
  }

  // Compute Z-scores (row-wise normalization)
  const zScores = computeZScores(expressionMatrix)

  // Keep input order; clustering is handled in Python for the exported heatmap image.
  const rowOrder = zScores.map((_, i) => i)
  const colOrder = (zScores[0] ?? []).map((_, i) => i)

  // Reorder data according to clustering
  const clusteredZScores = rowOrder.map((rowIdx) =>
    colOrder.map((colIdx) => zScores[rowIdx]?.[colIdx] ?? 0)
  )
  const clusteredGeneLabels = rowOrder.map((idx) =>
    opts.showGeneSymbols
      ? selectedGenes[idx]?.geneSymbol ?? selectedGenes[idx]?.geneId ?? ''
      : selectedGenes[idx]?.geneId ?? ''
  )
  const sampleCount = clusteredZScores[0]?.length ?? 0
  const resolvedSampleIds =
    sampleIds.length === sampleCount
      ? sampleIds
      : Array.from({ length: sampleCount }, (_, i) => sampleIds[i] ?? `Sample ${i + 1}`)
  const clusteredSampleLabels = colOrder.map((idx) => resolvedSampleIds[idx] ?? `Sample ${idx + 1}`)
  const rowPositions = clusteredGeneLabels.map((_, idx) => idx)
  const colPositions = clusteredSampleLabels.map((_, idx) => idx)

  // Color scale - match pheatmap default (rev(RdYlBu))
  const colorscale =
    opts.colorScale === 'RdYlBu'
      ? [
          [0.0, '#313695'],
          [0.1, '#4575B4'],
          [0.2, '#74ADD1'],
          [0.3, '#ABD9E9'],
          [0.4, '#E0F3F8'],
          [0.5, '#FFFFBF'],
          [0.6, '#FEE090'],
          [0.7, '#FDAE61'],
          [0.8, '#F46D43'],
          [0.9, '#D73027'],
          [1.0, '#A50026'],
        ]
      : opts.colorScale === 'RdBu'
        ? [
            [0, '#2166AC'],    // Blue (low)
            [0.25, '#67A9CF'],
            [0.5, '#F7F7F7'],  // White (center)
            [0.75, '#EF8A62'],
            [1, '#B2182B'],    // Red (high)
          ]
        : opts.colorScale === 'viridis'
          ? 'Viridis'
          : 'Plasma'

  // Calculate z-score range for symmetric colorbar
  const allZ = clusteredZScores.flat()
  const maxAbsZ = Math.max(...allZ.map(Math.abs).filter(Number.isFinite))
  const zRange = maxAbsZ && Number.isFinite(maxAbsZ) && maxAbsZ > 0 ? maxAbsZ : 1

  const maxGeneLabelLength = clusteredGeneLabels.reduce(
    (max, label) => Math.max(max, label.length),
    0
  )
  const rightMargin = Math.min(240, Math.max(120, maxGeneLabelLength * 6 + 40))
  // Base colorbar position + optional spacing (legendSpacing is 0-100%)
  const baseColorbarX = 1 + Math.min(0.25, rightMargin / 400)
  const colorbarX = baseColorbarX + (opts.legendSpacing ?? 0) / 100

  // Create heatmap trace
  const customdata = clusteredGeneLabels.map((geneLabel) =>
    clusteredSampleLabels.map((sampleLabel) => [sampleLabel, geneLabel])
  )
  const heatmapTrace: Data = {
    type: 'heatmap',
    z: clusteredZScores,
    x: colPositions,
    y: rowPositions,
    xgap: 0, // No gaps between cells
    ygap: 0,
    colorscale: colorscale as unknown as string,
    zmin: -zRange,
    zmax: zRange,
    colorbar: {
      title: 'Z-score',
      titleside: 'right',
      thickness: 15,
      len: 0.7,
      x: colorbarX,
      xanchor: 'left',
    },
    customdata,
    hovertemplate:
      '<b>%{customdata[1]}</b><br>' +
      'Sample: %{customdata[0]}<br>' +
      'Z-score: %{z:.2f}<br>' +
      '<extra></extra>',
  }

  const rowCount = clusteredGeneLabels.length
  const colCount = clusteredSampleLabels.length

  // Layout
  const layout: Partial<Layout> = {
    title: {
      text: `Expression Heatmap (Top ${selectedGenes.length} genes by ${usePadj ? 'padj' : 'p-value'})`,
      font: { size: 14 },
    },
    xaxis: {
      title: 'Samples',
      tickangle: 90,
      tickfont: { size: 10 },
      tickvals: colPositions,
      ticktext: clusteredSampleLabels,
      side: 'bottom',
      range: [-0.5, colCount - 0.5],
      showgrid: false,
      zeroline: false,
      showline: false,
    },
    yaxis: {
      title: '',
      tickfont: { size: 9 },
      automargin: true,
      tickvals: rowPositions,
      ticktext: clusteredGeneLabels,
      autorange: 'reversed',
      range: [rowCount - 0.5, -0.5],
      showgrid: false,
      zeroline: false,
      showline: false,
      side: 'right', // Gene names on right side of heatmap
    },
    margin: {
      t: 60,
      b: 120,
      l: 40, // Reduced left margin (no gene labels)
      r: rightMargin, // Increased right margin for gene labels + colorbar
    },
  }

  return { data: [heatmapTrace], layout }
}

export type { HeatmapOptions }
