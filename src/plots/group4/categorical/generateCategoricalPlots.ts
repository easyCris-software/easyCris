/**
 * Group 4 categorical plot generators.
 */

import type { Data, Layout } from 'plotly.js'
import type { TestResult } from '@/store/results-store'
import type { PlotBuilderInput, PlotBuilderOutput } from '@/utils/plotBuilders'
import { groupedBarBuilder, mosaicBuilder, buildMatrixHeatmap } from '@/utils/plotBuilders'
import { createBaseLayout, createDefaultConfig, DEFAULT_COLORS } from '@/utils/plotBuilders/common'
import { chiSquareInv, chiSquarePdf } from '@/utils/statistics/chiSquare'
import { toNumber } from '@/services/plotResult/common/normalize'

type ContingencyData = {
  table: number[][]
  rowLabels: string[]
  colLabels: string[]
  rowVariable: string
  colVariable: string
  total: number
}

type GofData = {
  observed: number[]
  expected: number[]
  labels: string[]
  valueLabel: string
  totalObserved: number
  totalExpected: number
}

function resolveRawOutput(result: TestResult): Record<string, unknown> | null {
  const raw = result.rawOutput as Record<string, unknown> | string | undefined
  if (!raw) return null

  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }

  const nested = raw.results
  if (nested && typeof nested === 'object') {
    return nested as Record<string, unknown>
  }

  return raw
}

function toNumberArray(values: unknown): number[] {
  if (!Array.isArray(values)) return []
  return values.map((value) => toNumber(value) ?? 0)
}

function toNumberMatrix(values: unknown): number[][] {
  if (!Array.isArray(values)) return []
  const rows = values
    .map((row) => (Array.isArray(row) ? row.map((value) => toNumber(value) ?? 0) : []))
    .filter((row) => row.length > 0)
  if (rows.length === 0) return []
  const minCols = Math.min(...rows.map((row) => row.length))
  return rows.map((row) => row.slice(0, minCols))
}

function resolveLabels(raw: unknown, fallbackPrefix: string, count: number): string[] {
  const labels = Array.isArray(raw) ? raw.map((item) => String(item)) : []
  if (labels.length >= count) return labels.slice(0, count)
  return Array.from({ length: count }, (_, idx) => `${fallbackPrefix} ${idx + 1}`)
}

function resolveContingencyData(result: TestResult): ContingencyData | null {
  const raw = resolveRawOutput(result)
  if (!raw) return null

  const table = toNumberMatrix(raw.observed_frequencies ?? raw.table)
  if (table.length === 0 || table[0]?.length === 0) return null

  // Also check plotPayload.data for labels (sent by frontend but not echoed by backend)
  const payloadData = (result.plotPayload?.data ?? {}) as Record<string, unknown>

  // Try raw output first, then fallback to payload data
  const rowLabels = resolveLabels(
    raw.row_labels ?? payloadData.row_labels,
    'Row',
    table.length
  )
  const colLabels = resolveLabels(
    raw.column_labels ?? payloadData.col_labels,
    'Column',
    table[0]?.length ?? 0
  )

  // Variable names: prefer raw, then payload, then fallback
  const rawRowVar = typeof raw.row_variable === 'string' && raw.row_variable.trim() ? raw.row_variable : null
  const payloadRowVar = typeof payloadData.row_variable === 'string' && (payloadData.row_variable as string).trim() ? payloadData.row_variable as string : null
  const rowVariable = rawRowVar ?? payloadRowVar ?? 'Row'

  const rawColVar = typeof raw.col_variable === 'string' && raw.col_variable.trim() ? raw.col_variable : null
  const payloadColVar = typeof payloadData.col_variable === 'string' && (payloadData.col_variable as string).trim() ? payloadData.col_variable as string : null
  const colVariable = rawColVar ?? payloadColVar ?? 'Column'

  const total = table.reduce((sum, row) => sum + row.reduce((rowSum, value) => rowSum + value, 0), 0)

  return { table, rowLabels, colLabels, rowVariable, colVariable, total }
}

function resolveGofData(result: TestResult): GofData | null {
  const raw = resolveRawOutput(result)
  if (!raw) return null

  const observed = toNumberArray(raw.observed_frequencies)
  if (observed.length === 0) return null

  let expected = toNumberArray(raw.expected_frequencies)
  if (expected.length === 0) {
    const total = observed.reduce((sum, value) => sum + value, 0)
    expected = Array.from({ length: observed.length }, () => total / observed.length)
  }

  const count = Math.min(observed.length, expected.length)
  const payloadData = (result.plotPayload?.data ?? {}) as Record<string, unknown>
  const labels = resolveLabels(raw.category_labels ?? payloadData.category_labels, 'Category', count)
  const rawValueLabel = typeof raw.value_column === 'string' && raw.value_column.trim()
    ? raw.value_column
    : typeof raw.column_name === 'string' && raw.column_name.trim()
      ? raw.column_name
      : null
  const payloadValueLabel =
    typeof payloadData.value_column === 'string' && (payloadData.value_column as string).trim()
      ? (payloadData.value_column as string)
      : typeof payloadData.column_name === 'string' && (payloadData.column_name as string).trim()
        ? (payloadData.column_name as string)
        : null
  const valueLabel = rawValueLabel ?? payloadValueLabel ?? 'Category'

  const observedSlice = observed.slice(0, count)
  const expectedSlice = expected.slice(0, count)

  return {
    observed: observedSlice,
    expected: expectedSlice,
    labels,
    valueLabel,
    totalObserved: observedSlice.reduce((sum, value) => sum + value, 0),
    totalExpected: expectedSlice.reduce((sum, value) => sum + value, 0),
  }
}

function buildGroupedBarFromTable(
  result: TestResult,
  tableData: ContingencyData,
  title: string,
): PlotBuilderOutput {
  const xValues: string[] = []
  const groupValues: string[] = []
  const yValues: number[] = []

  tableData.table.forEach((row, rowIdx) => {
    row.forEach((value, colIdx) => {
      xValues.push(tableData.rowLabels[rowIdx] ?? '')
      groupValues.push(tableData.colLabels[colIdx] ?? '')
      yValues.push(value)
    })
  })

  const input: PlotBuilderInput = {
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: tableData.rowVariable,
        columnName: tableData.rowVariable,
        values: xValues,
        inferredType: 'categorical',
      },
      {
        role: 'group',
        columnId: tableData.colVariable,
        columnName: tableData.colVariable,
        values: groupValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'count',
        columnName: 'Count',
        values: yValues,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title,
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType: 'none',
    },
  }

  const output = groupedBarBuilder(input)
  return {
    ...output,
    stats: {
      ...output.stats,
      table_rows: tableData.rowLabels.length,
      table_cols: tableData.colLabels.length,
      table_total: tableData.total,
    },
  }
}

export function buildChiSquareMosaicPlot(result: TestResult): PlotBuilderOutput | null {
  const tableData = resolveContingencyData(result)
  if (!tableData) return null

  const xValues: string[] = []
  const yValues: string[] = []
  const sizeValues: number[] = []

  tableData.table.forEach((row, rowIdx) => {
    row.forEach((value, colIdx) => {
      xValues.push(tableData.rowLabels[rowIdx] ?? '')
      yValues.push(tableData.colLabels[colIdx] ?? '')
      sizeValues.push(value)
    })
  })

  const input: PlotBuilderInput = {
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: tableData.rowVariable,
        columnName: tableData.rowVariable,
        values: xValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: tableData.colVariable,
        columnName: tableData.colVariable,
        values: yValues,
        inferredType: 'categorical',
      },
      {
        role: 'size',
        columnId: 'count',
        columnName: 'Count',
        values: sizeValues,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: 'Mosaic Plot',
      showLegend: true,
      showGrid: false,
      colorPalette: DEFAULT_COLORS,
    },
  }

  const output = mosaicBuilder(input)

  // Post-process to add text labels (percent values) - initially hidden
  const dataWithText = output.data.map((trace) => {
    const t = trace as Record<string, unknown>
    const customdata = t.customdata as Array<[number, number, number, number, string]> | undefined
    if (!customdata) return trace

    // Format as "count (total%)" for each cell
    const textLabels = customdata.map(([count, , , totalPercent]) => {
      const pct = (totalPercent * 100).toFixed(1)
      return `${count}\n(${pct}%)`
    })

    return {
      ...trace,
      text: textLabels,
      textposition: 'none', // Hidden by default, toggle shows them
      textfont: { size: 10, color: '#111827' },
    }
  })

  return {
    ...output,
    data: dataWithText,
    layout: {
      ...output.layout,
      meta: {
        ...(output.layout.meta ?? {}),
        plotType: 'mosaic',
        supportsDataLabels: true,
        showDataLabels: false,
      },
    },
    stats: {
      ...output.stats,
      table_rows: tableData.rowLabels.length,
      table_cols: tableData.colLabels.length,
      table_total: tableData.total,
    },
  }
}

export function buildChiSquareGroupedBarPlot(result: TestResult): PlotBuilderOutput | null {
  const tableData = resolveContingencyData(result)
  if (!tableData) return null

  const raw = resolveRawOutput(result) ?? {}
  let expected = toNumberMatrix(raw.expected_frequencies)

  // Calculate expected frequencies if not provided
  if (expected.length === 0) {
    const { table } = tableData
    const rowTotals = table.map((row) => row.reduce((sum, v) => sum + v, 0))
    const colTotals = tableData.colLabels.map((_, colIdx) =>
      table.reduce((sum, row) => sum + (row[colIdx] ?? 0), 0)
    )
    const total = tableData.total
    expected = table.map((row, rowIdx) =>
      row.map((_, colIdx) => {
        const rowTotal = rowTotals[rowIdx] ?? 0
        const colTotal = colTotals[colIdx] ?? 0
        return total > 0 ? (rowTotal * colTotal) / total : 0
      })
    )
  }

  // Build data for Expected vs Actual grouped bar
  // Structure: X = Row/ColLabel combo, Group = Expected/Actual, Y = count
  const xValues: string[] = []
  const groupValues: string[] = []
  const yValues: number[] = []
  const xAxisLabel = `${tableData.rowVariable}/${tableData.colVariable}`

  tableData.table.forEach((row, rowIdx) => {
    row.forEach((observedValue, colIdx) => {
      const cellLabel = `${tableData.rowLabels[rowIdx]}/${tableData.colLabels[colIdx]}`
      const expectedValue = expected[rowIdx]?.[colIdx] ?? 0

      // Actual bar
      xValues.push(cellLabel)
      groupValues.push('Actual')
      yValues.push(observedValue)

      // Expected bar
      xValues.push(cellLabel)
      groupValues.push('Expected')
      yValues.push(expectedValue)
    })
  })

  const input: PlotBuilderInput = {
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: 'cell',
        columnName: xAxisLabel,
        values: xValues,
        inferredType: 'categorical',
      },
      {
        role: 'group',
        columnId: 'series',
        columnName: 'Series',
        values: groupValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'count',
        columnName: 'Count',
        values: yValues,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: 'Expected vs Actual Counts',
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType: 'none',
    },
  }

  const output = groupedBarBuilder(input)
  return {
    ...output,
    stats: {
      ...output.stats,
      table_rows: tableData.rowLabels.length,
      table_cols: tableData.colLabels.length,
      table_total: tableData.total,
    },
  }
}

export function buildChiSquareResidualHeatmap(result: TestResult): PlotBuilderOutput | null {
  const tableData = resolveContingencyData(result)
  if (!tableData) return null

  const raw = resolveRawOutput(result) ?? {}
  let residuals = toNumberMatrix(raw.standardized_residuals ?? raw.residuals)

  if (residuals.length === 0) {
    const { table } = tableData
    const rowTotals = table.map((row) => row.reduce((sum, value) => sum + value, 0))
    const colTotals = tableData.colLabels.map((_, colIdx) =>
      table.reduce((sum, row) => sum + (row[colIdx] ?? 0), 0)
    )
    const total = tableData.total
    residuals = table.map((row, rowIdx) =>
      row.map((value, colIdx) => {
        const rowTotal = rowTotals[rowIdx] ?? 0
        const colTotal = colTotals[colIdx] ?? 0
        const expected = total > 0 ? (rowTotal * colTotal) / total : 0
        if (expected <= 0) return 0
        return (value - expected) / Math.sqrt(expected)
      })
    )
  }

  const rowCount = residuals.length
  const colCount = residuals[0]?.length ?? 0
  if (rowCount === 0 || colCount === 0) return null

  const rowLabels = tableData.rowLabels.slice(0, rowCount).map((label) => String(label))
  const colLabels = tableData.colLabels.slice(0, colCount).map((label) => String(label))

  const heatmap = buildMatrixHeatmap({
    matrix: residuals,
    xLabels: colLabels,
    yLabels: rowLabels,
    title: 'Observed vs Expected (Std Residuals)',
    xAxisTitle: tableData.colVariable,
    yAxisTitle: tableData.rowVariable,
    colorbarTitle: 'Std Residual',
    symmetricScale: true,
    showText: true,
    textDecimals: 2,
  })

  return {
    data: heatmap.data,
    layout: {
      ...heatmap.layout,
      xaxis: {
        ...(heatmap.layout.xaxis ?? {}),
        type: 'category',
      },
      yaxis: {
        ...(heatmap.layout.yaxis ?? {}),
        type: 'category',
      },
    },
    config: createDefaultConfig(),
    stats: {
      ...heatmap.stats,
      table_rows: tableData.rowLabels.length,
      table_cols: tableData.colLabels.length,
      table_total: tableData.total,
    },
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }
}

export function buildGofObservedExpectedBarPlot(result: TestResult): PlotBuilderOutput | null {
  const gofData = resolveGofData(result)
  if (!gofData) return null

  const xValues: string[] = []
  const groupValues: string[] = []
  const yValues: number[] = []

  gofData.labels.forEach((label, idx) => {
    xValues.push(label, label)
    groupValues.push('Observed', 'Expected')
    yValues.push(gofData.observed[idx] ?? 0, gofData.expected[idx] ?? 0)
  })

  const input: PlotBuilderInput = {
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: gofData.valueLabel,
        columnName: gofData.valueLabel,
        values: xValues,
        inferredType: 'categorical',
      },
      {
        role: 'group',
        columnId: 'series',
        columnName: 'Series',
        values: groupValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'count',
        columnName: 'Count',
        values: yValues,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: 'Observed vs Expected',
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType: 'none',
    },
  }

  const output = groupedBarBuilder(input)
  return {
    ...output,
    stats: {
      ...output.stats,
      category_count: gofData.labels.length,
      observed_total: gofData.totalObserved,
      expected_total: gofData.totalExpected,
    },
  }
}

export function buildChiSquareDistributionPlot(params: {
  df: number
  alpha: number
  testStatistic?: number | null
  pValue?: number | null
  title?: string
}): PlotBuilderOutput | null {
  const df = params.df
  if (!Number.isFinite(df) || df <= 0) return null

  const alpha = Number.isFinite(params.alpha) ? params.alpha : 0.05
  const critical = chiSquareInv(1 - alpha, df)
  const testStatistic = params.testStatistic ?? null

  if (!Number.isFinite(critical)) return null

  const baseMax = Math.max(
    critical,
    typeof testStatistic === 'number' && Number.isFinite(testStatistic) ? testStatistic : 0,
    df + 6 * Math.sqrt(2 * df)
  )
  const maxX = baseMax * 1.2

  const pointCount = 200
  const xValues: number[] = []
  const yValues: number[] = []
  for (let i = 0; i < pointCount; i += 1) {
    const x = (i / (pointCount - 1)) * maxX
    xValues.push(x)
    yValues.push(chiSquarePdf(x, df))
  }

  const maxY = Math.max(...yValues)
  const tailX: number[] = []
  const tailY: number[] = []
  for (let i = 0; i < xValues.length; i += 1) {
    if (xValues[i]! >= critical) {
      tailX.push(xValues[i]!)
      tailY.push(yValues[i]!)
    }
  }

  const criticalLabel = `Critical = ${critical.toFixed(3)}`
  const criticalTrace: Data = {
    type: 'scatter',
    mode: 'lines',
    x: [critical, critical],
    y: [0, maxY],
    name: 'Critical value',
    line: { color: '#ef4444', width: 1.5, dash: 'dash' },
    hoverinfo: 'skip',
  }

  const data: Data[] = [
    {
      type: 'scatter',
      mode: 'lines',
      x: xValues,
      y: yValues,
      name: 'Chi-square PDF',
      line: { color: '#2563eb', width: 2 },
      hovertemplate: 'Chi-square: %{x:.3f}<br>Density: %{y:.4f}<extra></extra>',
    },
    {
      type: 'scatter',
      mode: 'lines',
      x: tailX,
      y: tailY,
      name: `Rejection region (alpha = ${alpha})`,
      fill: 'tozeroy',
      fillcolor: 'rgba(239, 68, 68, 0.25)',
      line: { color: 'rgba(239, 68, 68, 0.8)', width: 1 },
      hoverinfo: 'skip',
    },
    criticalTrace,
  ]

  const shapes: Layout['shapes'] = []
  const annotations: NonNullable<Layout['annotations']> = [
    {
      name: 'critical_label',
      x: critical,
      y: maxY,
      xref: 'x',
      yref: 'y',
      text: criticalLabel,
      showarrow: false,
      xanchor: 'left',
      yanchor: 'bottom',
      font: { family: 'Inter, sans-serif', size: 12, color: '#ef4444' },
      meta: { role: 'critical-label' },
    },
  ]

  if (typeof testStatistic === 'number' && Number.isFinite(testStatistic)) {
    const statLineHeight = maxY * 0.35
    shapes.push({
      type: 'line',
      x0: testStatistic,
      x1: testStatistic,
      y0: 0,
      y1: statLineHeight,
      line: { color: '#111827', width: 1.5 },
    })
    annotations.push({
      name: 'test_stat_label',
      x: testStatistic,
      y: statLineHeight,
      xref: 'x',
      yref: 'y',
      text: `Chi-square = ${testStatistic.toFixed(3)}`,
      showarrow: false,
      xanchor: 'left',
      yanchor: 'bottom',
      font: { family: 'Inter, sans-serif', size: 12, color: '#111827' },
    })
  }

  const stats: Record<string, number> = {
    df,
    alpha,
    critical_value: critical,
    max_density: maxY,
    n_points: xValues.length,
  }

  if (typeof testStatistic === 'number' && Number.isFinite(testStatistic)) {
    stats.test_statistic = testStatistic
  }
  if (typeof params.pValue === 'number' && Number.isFinite(params.pValue)) {
    stats.p_value = params.pValue
  }

  return {
    data,
    layout: {
      ...createBaseLayout({ title: params.title ?? 'Chi-Square Distribution', showLegend: true }),
      xaxis: {
        title: { text: 'Chi-Square', font: { weight: 700 } },
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
        range: [0, maxX],
      },
      yaxis: {
        title: { text: 'Density', font: { weight: 700 } },
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
        rangemode: 'tozero',
      },
      shapes,
      annotations,
      meta: {
        plotType: 'line',
      },
    },
    config: {
      ...createDefaultConfig(),
      edits: {
        annotationPosition: true,
        annotationText: false,
      },
    },
    stats,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }
}

export function buildFisherExactForestPlot(result: TestResult): PlotBuilderOutput | null {
  const raw = resolveRawOutput(result) ?? {}
  const oddsRatio = toNumber(raw.odds_ratio) ?? null
  const ciLower = toNumber(raw.odds_ratio_ci_lower ?? raw.ci_95_lower) ?? null
  const ciUpper = toNumber(raw.odds_ratio_ci_upper ?? raw.ci_95_upper) ?? null

  if (oddsRatio === null || !Number.isFinite(oddsRatio) || oddsRatio <= 0) return null

  const label = 'Odds Ratio'
  const errMinus = ciLower !== null ? oddsRatio - ciLower : 0
  const errPlus = ciUpper !== null ? ciUpper - oddsRatio : 0

  const data: Data[] = [
    {
      type: 'scatter',
      mode: 'markers',
      x: [oddsRatio],
      y: [label],
      marker: { color: '#2563eb', size: 8 },
      error_x: {
        type: 'data',
        array: [errPlus],
        arrayminus: [errMinus],
        visible: true,
        color: '#333',
        thickness: 1.2,
      },
    },
  ]

  const annotations: NonNullable<Layout['annotations']> = [
    {
      name: 'or_header',
      xref: 'paper',
      yref: 'paper',
      x: 0.74,
      y: 1.04,
      text: 'OR (95% CI)',
      showarrow: false,
      xanchor: 'left',
      yanchor: 'bottom',
      font: { family: 'Inter, sans-serif', size: 12, color: '#111827' },
    },
  ]

  const ciText =
    ciLower !== null && ciUpper !== null
      ? `${oddsRatio.toFixed(2)} (${ciLower.toFixed(2)}, ${ciUpper.toFixed(2)})`
      : oddsRatio.toFixed(2)

  annotations.push({
    name: `or_value_${label}`,
    xref: 'paper',
    yref: 'y',
    x: 0.74,
    y: label,
    text: ciText,
    showarrow: false,
    xanchor: 'left',
    yanchor: 'middle',
    font: { family: 'Inter, sans-serif', size: 12, color: '#111827' },
  })

  const stats: Record<string, number> = {
    odds_ratio: oddsRatio,
  }
  if (ciLower !== null) stats.ci_lower = ciLower
  if (ciUpper !== null) stats.ci_upper = ciUpper

  return {
    data,
    layout: {
      ...createBaseLayout({ title: 'Odds Ratio Forest Plot', showLegend: true }),
      margin: { t: 60, r: 200, b: 60, l: 140 },
      xaxis: {
        title: { text: 'Odds Ratio', font: { weight: 700 } },
        type: 'log',
        domain: [0, 0.7],
        tickformat: '.4~g',
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      yaxis: {
        tickfont: { weight: 700 },
        tickwidth: 4,
        ticklen: 6,
        ticklabelshift: 1,
      },
      annotations,
      shapes: [
        {
          type: 'line',
          x0: 1,
          x1: 1,
          y0: 0,
          y1: 1,
          yref: 'y domain',
          line: { color: '#9ca3af', width: 1, dash: 'dash' },
        },
      ],
    },
    config: createDefaultConfig(),
    stats,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }
}

export function buildFisherExactGroupedBarPlot(result: TestResult): PlotBuilderOutput | null {
  const tableData = resolveContingencyData(result)
  if (!tableData) return null
  return buildGroupedBarFromTable(result, tableData, 'Grouped Bar Chart')
}

export function buildMcNemarPairedBarPlot(result: TestResult): PlotBuilderOutput | null {
  const tableData = resolveContingencyData(result)
  if (!tableData) return null

  const rowTotals = tableData.table.map((row) => row.reduce((sum, value) => sum + value, 0))
  const colTotals = tableData.colLabels.map((_, colIdx) =>
    tableData.table.reduce((sum, row) => sum + (row[colIdx] ?? 0), 0)
  )

  const categories = tableData.rowLabels.length === colTotals.length
    ? tableData.rowLabels
    : resolveLabels(null, 'Category', colTotals.length)

  const xValues: string[] = []
  const groupValues: string[] = []
  const yValues: number[] = []

  const beforeLabel = tableData.rowVariable
  const afterLabel = tableData.colVariable

  categories.forEach((label, idx) => {
    xValues.push(label, label)
    groupValues.push(beforeLabel, afterLabel)
    yValues.push(rowTotals[idx] ?? 0, colTotals[idx] ?? 0)
  })

  const input: PlotBuilderInput = {
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: 'category',
        columnName: 'Category',
        values: xValues,
        inferredType: 'categorical',
      },
      {
        role: 'group',
        columnId: 'timepoint',
        columnName: 'Timepoint',
        values: groupValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'count',
        columnName: 'Count',
        values: yValues,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: 'Paired Bar Chart',
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType: 'none',
    },
  }

  const output = groupedBarBuilder(input)
  return {
    ...output,
    stats: {
      ...output.stats,
      category_count: categories.length,
      before_total: rowTotals.reduce((sum, value) => sum + value, 0),
      after_total: colTotals.reduce((sum, value) => sum + value, 0),
    },
  }
}

export function buildFisherExactChiSquareDistribution(result: TestResult): PlotBuilderOutput | null {
  const tableData = resolveContingencyData(result)
  if (!tableData) return null

  const { table } = tableData
  const rowTotals = table.map((row) => row.reduce((sum, value) => sum + value, 0))
  const colTotals = tableData.colLabels.map((_, colIdx) =>
    table.reduce((sum, row) => sum + (row[colIdx] ?? 0), 0)
  )
  const total = tableData.total

  let chiSquare = 0
  table.forEach((row, rowIdx) => {
    row.forEach((value, colIdx) => {
      const rowTotal = rowTotals[rowIdx] ?? 0
      const colTotal = colTotals[colIdx] ?? 0
      const expected = total > 0 ? (rowTotal * colTotal) / total : 0
      if (expected > 0) {
        const diff = value - expected
        chiSquare += (diff * diff) / expected
      }
    })
  })

  const alpha = toNumber((resolveRawOutput(result) ?? {}).alpha) ?? 0.05
  const pValue = toNumber((resolveRawOutput(result) ?? {}).p_value) ?? null

  return buildChiSquareDistributionPlot({
    df: 1,
    alpha,
    testStatistic: chiSquare,
    pValue: pValue ?? undefined,
    title: 'Chi-Square Distribution',
  })
}

export function buildGofChiSquareDistribution(result: TestResult): PlotBuilderOutput | null {
  const raw = resolveRawOutput(result) ?? {}
  const df = toNumber(raw.degrees_of_freedom) ?? null
  const chiSquare = toNumber(raw.chi_square ?? raw.chi_squared) ?? null
  const alpha = toNumber(raw.alpha) ?? 0.05
  const pValue = toNumber(raw.p_value) ?? null

  if (df === null) return null

  return buildChiSquareDistributionPlot({
    df,
    alpha,
    testStatistic: chiSquare ?? undefined,
    pValue: pValue ?? undefined,
    title: 'Chi-Square Distribution',
  })
}
