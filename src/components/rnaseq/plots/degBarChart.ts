/**
 * DEG Bar Chart Builder
 *
 * Creates Plotly bar chart showing counts of differentially expressed genes.
 *
 * Features:
 * - Stacked or grouped bars
 * - Up/down regulation counts
 * - Significance threshold categories
 */

import type { Data, Layout } from 'plotly.js'
import type { DESeqSummary } from '@/types/rnaseq'

export interface DEGBarChartData {
  data: Data[]
  layout: Partial<Layout>
}

export interface DEGBarChartOptions {
  showByThreshold: boolean // Show breakdown by p-value threshold
}

const DEFAULT_OPTIONS: DEGBarChartOptions = {
  showByThreshold: false,
}

export function buildDEGBarChart(
  summary: DESeqSummary,
  options: Partial<DEGBarChartOptions> = {}
): DEGBarChartData {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const traces: Data[] = []

  if (opts.showByThreshold) {
    const totalSignificant = summary.significantPadj05
    const upRatio = totalSignificant > 0 ? summary.upregulated / totalSignificant : 0
    const downRatio = totalSignificant > 0 ? summary.downregulated / totalSignificant : 0

    // Detailed breakdown by threshold
    traces.push(
      {
        type: 'bar',
        name: 'p < 0.001',
        x: ['Upregulated', 'Downregulated'],
        y: [
          Math.round(summary.significantP001 * upRatio),
          Math.round(summary.significantP001 * downRatio),
        ],
        marker: { color: '#DC2626' },
      },
      {
        type: 'bar',
        name: 'p < 0.01',
        x: ['Upregulated', 'Downregulated'],
        y: [
          Math.round(
            (summary.significantP01 - summary.significantP001) *
              upRatio
          ),
          Math.round(
            (summary.significantP01 - summary.significantP001) *
              downRatio
          ),
        ],
        marker: { color: '#F59E0B' },
      },
      {
        type: 'bar',
        name: 'p < 0.05',
        x: ['Upregulated', 'Downregulated'],
        y: [
          Math.round(
            (summary.significantP05 - summary.significantP01) *
              upRatio
          ),
          Math.round(
            (summary.significantP05 - summary.significantP01) *
              downRatio
          ),
        ],
        marker: { color: '#84CC16' },
      }
    )
  } else {
    // Simple up/down counts
    traces.push({
      type: 'bar',
      x: ['Upregulated', 'Downregulated', 'Not Significant'],
      y: [
        summary.upregulated,
        summary.downregulated,
        summary.testedGenes - summary.significantPadj05,
      ],
      marker: {
        color: ['#EF4444', '#3B82F6', '#9CA3AF'],
      },
      text: [
        summary.upregulated.toLocaleString(),
        summary.downregulated.toLocaleString(),
        (summary.testedGenes - summary.significantPadj05).toLocaleString(),
      ],
      textposition: 'outside',
      hovertemplate: '%{x}: %{y}<extra></extra>',
    })
  }

  // Layout
  const layout: Partial<Layout> = {
    title: {
      text: 'Differentially Expressed Genes',
      font: { size: 16 },
    },
    xaxis: {
      title: '',
    },
    yaxis: {
      title: 'Gene Count',
    },
    barmode: opts.showByThreshold ? 'stack' : 'group',
    legend: opts.showByThreshold
      ? {
          orientation: 'v',
          yanchor: 'top',
          y: 1,
          xanchor: 'left',
          x: 1.02,
        }
      : undefined,
    showlegend: opts.showByThreshold,
    margin: { t: 80, b: 60, l: 60, r: opts.showByThreshold ? 100 : 40 },
  }

  return { data: traces, layout }
}
