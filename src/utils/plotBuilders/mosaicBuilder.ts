/**
 * Mosaic Plot Builder
 *
 * Supports raw categorical pairs or aggregated counts (via role: 'size').
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { createBaseLayout, createDefaultConfig, getColor } from './common'
import { createPlaceholderOutputFromInput } from './placeholder'

type MosaicCounts = {
  rowLabels: string[]
  colLabels: string[]
  counts: number[][]
  total: number
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function buildCounts(
  xValues: unknown[],
  yValues: unknown[],
  sizeValues: unknown[] | null
): MosaicCounts | null {
  const rowLabels: string[] = []
  const colLabels: string[] = []
  const rowIndex = new Map<string, number>()
  const colIndex = new Map<string, number>()
  const counts: number[][] = []

  const len = Math.min(xValues.length, yValues.length, sizeValues?.length ?? Infinity)

  const ensureRow = (label: string): number => {
    const existing = rowIndex.get(label)
    if (existing !== undefined) return existing
    const idx = rowLabels.length
    rowLabels.push(label)
    rowIndex.set(label, idx)
    counts.push(new Array(colLabels.length).fill(0))
    return idx
  }

  const ensureCol = (label: string): number => {
    const existing = colIndex.get(label)
    if (existing !== undefined) return existing
    const idx = colLabels.length
    colLabels.push(label)
    colIndex.set(label, idx)
    counts.forEach((row) => row.push(0))
    return idx
  }

  for (let i = 0; i < len; i += 1) {
    const rawX = xValues[i]
    const rawY = yValues[i]
    if (rawX === null || rawX === undefined || rawY === null || rawY === undefined) continue
    const xLabel = String(rawX)
    const yLabel = String(rawY)
    if (!xLabel || !yLabel) continue

    const count = sizeValues ? toNumber(sizeValues[i]) : 1
    if (count === null || count <= 0) continue

    const rowIdx = ensureRow(xLabel)
    const colIdx = ensureCol(yLabel)
    counts[rowIdx]![colIdx] = (counts[rowIdx]![colIdx] ?? 0) + count
  }

  if (rowLabels.length === 0 || colLabels.length === 0) return null

  const total = counts.reduce(
    (sum, row) => sum + row.reduce((rowSum, value) => rowSum + value, 0),
    0
  )

  if (total <= 0) return null

  return { rowLabels, colLabels, counts, total }
}

export const mosaicBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  const { columns, options } = input
  const xColumn = columns.find((c) => c.role === 'x') ?? columns.find((c) => c.inferredType === 'categorical')
  const yColumn =
    columns.find((c) => c.role === 'y' && c !== xColumn) ??
    columns.find((c) => c.inferredType === 'categorical' && c !== xColumn)
  const sizeColumn = columns.find((c) => c.role === 'size' && c.inferredType === 'numeric')

  if (!xColumn || !yColumn) {
    return createPlaceholderOutputFromInput('mosaic', input, options.title)
  }

  const counts = buildCounts(xColumn.values, yColumn.values, sizeColumn?.values ?? null)
  if (!counts) {
    return createPlaceholderOutputFromInput('mosaic', input, options.title, 'No mosaic data available')
  }

  const { rowLabels, colLabels, counts: matrix, total } = counts
  const rowTotals = matrix.map((row) => row.reduce((sum, value) => sum + value, 0))
  const colTotals = colLabels.map((_, colIdx) =>
    matrix.reduce((sum, row) => sum + (row[colIdx] ?? 0), 0)
  )

  const rowEntries = rowTotals
    .map((rowTotal, rowIdx) => ({ rowIdx, rowTotal }))
    .filter((entry) => entry.rowTotal > 0)

  if (rowEntries.length === 0) {
    return createPlaceholderOutputFromInput('mosaic', input, options.title, 'No nonzero cells in mosaic data')
  }

  let cumulative = 0
  const xCenters: number[] = []
  const widths: number[] = []
  const rowOrder: number[] = []

  rowEntries.forEach((entry) => {
    const width = entry.rowTotal / total
    const center = cumulative + width / 2
    xCenters.push(center)
    widths.push(width)
    rowOrder.push(entry.rowIdx)
    cumulative += width
  })

  const data: PlotBuilderOutput['data'] = []
  const stats: Record<string, number> = {}
  const maxCell = Math.max(...matrix.flat())
  const minCell = Math.min(...matrix.flat())

  const baseByRow = new Array(rowOrder.length).fill(0)
  colLabels.forEach((colLabel, colIdx) => {
    const yValues: number[] = []
    const baseValues: number[] = []
    const customdata: Array<[number, number, number, number, string]> = []

    rowOrder.forEach((rowIdx, pos) => {
      const count = matrix[rowIdx]?.[colIdx] ?? 0
      const rowTotal = rowTotals[rowIdx] ?? 0
      const colTotal = colTotals[colIdx] ?? 0
      const rowPercent = rowTotal > 0 ? count / rowTotal : 0
      const colPercent = colTotal > 0 ? count / colTotal : 0
      const totalPercent = total > 0 ? count / total : 0

      yValues.push(rowPercent)
      baseValues.push(baseByRow[pos] ?? 0)
      baseByRow[pos] = (baseByRow[pos] ?? 0) + rowPercent
      customdata.push([count, rowPercent, colPercent, totalPercent, rowLabels[rowIdx] ?? ''])
    })

    data.push({
      type: 'bar',
      x: xCenters,
      y: yValues,
      base: baseValues,
      width: widths,
      name: colLabel,
      marker: {
        color: getColor(colIdx),
        line: { color: '#ffffff', width: 1 },
      },
      customdata,
      hovertemplate: `${xColumn.columnName}: %{customdata[4]}<br>${yColumn.columnName}: ${colLabel}` +
        `<br>Count: %{customdata[0]}<br>Row %: %{customdata[1]:.2%}` +
        `<br>Col %: %{customdata[2]:.2%}<br>Total %: %{customdata[3]:.2%}<extra></extra>`,
    })
  })

  stats.n_rows = rowLabels.length
  stats.n_cols = colLabels.length
  stats.total = total
  stats.max_cell = maxCell
  stats.min_cell = minCell

  return {
    data,
    layout: {
      ...createBaseLayout({ title: options.title || 'Mosaic Plot', showLegend: true }),
      barmode: 'stack',
      bargap: 0,
      bargroupgap: 0,
      xaxis: {
        title: {
          text: xColumn.columnName,
          font: { weight: 700 },
        },
        range: [0, 1],
        tickvals: xCenters,
        ticktext: rowOrder.map((rowIdx) => rowLabels[rowIdx] ?? ''),
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        title: {
          text: `Proportion of ${yColumn.columnName}`,
          font: { weight: 700 },
        },
        range: [0, 1],
        tickformat: '.0%',
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
    },
    config: createDefaultConfig(),
    stats,
    dataPolicy: input.dataPolicy,
    samplingConfig: input.samplingConfig,
    aggregationConfig: input.aggregationConfig,
  }
}

export default mosaicBuilder
