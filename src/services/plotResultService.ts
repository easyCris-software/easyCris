/**
 * Plot Result Service
 *
 * Converts TestResult visualizations into PlotSpec for the Plots panel.
 *
 * @locked VALIDATED - DO NOT MODIFY WITHOUT USER APPROVAL
 * This file contains GROUP1_PLOT_RECIPES array defining autogen plots for all
 * Group 1 hypothesis tests. Part of E2E validation suite (655 metrics).
 * All plot recipes validated against validation baseline. Validation date: January 14, 2026.
 * See CLAUDE.md "LOCKED E2E VALIDATION - GROUP 1 COMPLETE" section.
 */

import type { PlotType } from '@/config/plotRegistry'
import { getPrimaryPlot } from '@/config/plotRegistry'
import { getPlotBuilder, DEFAULT_COLORS } from '@/utils/plotBuilders'
import { canonicalizeBracketGroupKey, repairMojibakeForDisplay } from '@/utils/plotBuilders/bracketGroupKey'
import { buildDoseResponseCurveFromResult } from '@/utils/plotBuilders/doseResponseCurveBuilder'
import { buildDoseResponseCompareFromResult } from '@/utils/plotBuilders/doseResponseCompareBuilder'
import { buildSynergyContourFromResult } from '@/utils/plotBuilders/synergyContourBuilder'
import { buildSynergyHeatmapFromResult } from '@/utils/plotBuilders/synergyHeatmapBuilder'
import { buildLoeweIsobologramFromResult } from '@/utils/plotBuilders/loeweIsobologramBuilder'
import {
  generateCorrelationScatter,
  generatePearsonCorrelationHeatmap,
  generateSpearmanCorrelationHeatmap,
  generateKendallCorrelationHeatmap,
  generateLinearRegressionScatterWithFit,
  generateLinearRegressionResidualPlot,
  generateMultipleLinearForestPlot,
  generateMultipleLinearResidualPlot,
  generateBinaryLogisticForestPlot,
  generateBinaryLogisticROCCurve,
  generateMultinomialLogisticForestPlot,
  generateMultinomialLogisticROCPlot,
  type Group3PlotOutput,
} from '@/plots/group3'
import {
  buildChiSquareMosaicPlot,
  buildChiSquareGroupedBarPlot,
  buildChiSquareResidualHeatmap,
  buildGofObservedExpectedBarPlot,
  buildGofChiSquareDistribution,
  buildFisherExactForestPlot,
  buildFisherExactGroupedBarPlot,
  buildFisherExactChiSquareDistribution,
  buildMcNemarPairedBarPlot,
} from '@/plots/group4'
import {
  buildNormalityQQPlot,
  buildNormalityHistogramPlot,
  buildDescriptiveHistogramPlot,
  buildDescriptiveBoxPlot,
  buildDescriptiveViolinPlot,
  buildOutlierBoxPlot,
  buildOutlierScatterPlot,
} from '@/plots/group5'
import {
  buildKaplanMeierPlot,
  buildCoxForestPlot,
  buildCoxAdjustedSurvivalPlot,
  buildNelsonAalenCumulativeHazardPlot,
  buildNelsonAalenSmoothedHazardPlot,
} from '@/plots/group6'
import type { TestResult } from '@/store/results-store'
import type { PlotBuilderOutput } from '@/utils/plotBuilders/types'
import { useAppStore } from '@/store/app-store'
import {
  createTestResultPlotSpec,
  type PlotColumn,
  type TestResultPlotSpec,
} from '@/store/plots-store'
import type { BracketEffectMeta, BracketSettings, SignificanceBracket } from '@/utils/plotBuilders/types'
import { createDefaultBracketSettings, getBracketLabel } from '@/utils/plotBuilders/types'
import {
  calculateMeanSE,
  calculateErrorBar,
  calculateBarPlotRange,
  calculateQuartiles,
  createBracketShapes,
  formatBracketLabel,
  getColor,
  repelBracketLayout,
  stackBrackets,
} from '@/utils/plotBuilders/common'
import { extractPostHocBrackets } from '@/plots/common/brackets'
import {
  assignFactorRoles,
  getFactorLevelCounts,
  getFactorLevelOrder,
  normalizeFactorMapping,
  type CellMean,
} from '@/utils/plotBuilders/factorRoleAssignment'
import type { SimpleEffectBracket } from '@/utils/plotBuilders/filterSimpleEffectBrackets'
import type { Data, Layout } from 'plotly.js'

// ============================================================================
// PHASE A REFACTOR: Import helpers from modular common/ folder
// ============================================================================
import {
  mapFamily,
  mapPlotlyType,
  normalizeTestId,
  toNumber,
  toNumberArray,
  tCriticalFromDf,
  parseLabelList as _parseLabelList,
} from './plotResult/common/normalize'
import { buildLmmPlots } from './plotResult/lmm/buildLmmPlots'
import {
  getResultData,
  getPlotPayload,
  calculateDifferences,
  resolveIndependentTTestPrimaryPValue,
  resolveValueLabel,
  resolveGroupLabel,
  resolveGroupNames,
  buildPayloadSeries,
} from './plotResult/common/payload'
import { isBracketSignificant } from './plotResult/common/brackets'
import { calculateMedian, extractNumericStats, extractStatsFromPlotlyData } from './plotResult/common/stats'

interface PlotSpecWithStats {
  plot: TestResultPlotSpec
  stats: Record<string, number | string>
}

function getCorrelationMatrixSize(
  result: TestResult,
  type: 'pearson' | 'spearman' | 'kendall'
): number {
  const raw = result.rawOutput as Record<string, unknown> | string | undefined
  if (!raw) return 0
  let parsed: Record<string, unknown> | undefined
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return 0
    }
  } else {
    parsed = raw as Record<string, unknown>
  }
  const matrices = parsed.correlation_matrices as Record<string, unknown> | undefined
  const matrix = matrices?.[type] as unknown
  return Array.isArray(matrix) ? matrix.length : 0
}

// ============================================================================
// AUTO-PLOT RECIPE SYSTEM
// ============================================================================

/**
 * Recipe for auto-generating plots from test results
 * Separates auto-generation logic from UI discovery (plotRegistry)
 */
interface AutoPlotRecipe {
  /** Statistical test ID (normalized) */
  testId: string

  /** Ordered list of plots to generate (primary first) */
  plots: Array<{
    type: PlotType
    options?: {
      showJitter?: boolean
      errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
      bracketSettings?: BracketSettings
      histogramBins?: number
      [key: string]: unknown
    }
    title?: string // Optional custom title (defaults to test name)
    order?: number // Explicit order for PlotGallery (defaults to array index)
  }>

  /** Data extraction strategy */
  dataSource: 'plotlyJson' | 'cell_summaries' | 'raw_points'

  /** Custom builder function (optional, overrides default) */
  customBuilder?: (result: TestResult) => PlotSpecWithStats[]
}

/**
 * Auto-generation recipes for Group 1 hypothesis tests
 */
const GROUP1_PLOT_RECIPES: AutoPlotRecipe[] = [
  // Independent T-Test → Column Scatter + Bar + Box + Violin (all with significance brackets)
  {
    testId: 't_test_two_sample',
    plots: [
      {
        type: 'column_scatter',
        options: {
          errorBarType: 'se',
          showMeanLine: true,
          pointJitterX: 0.05,
          bracketSettings: { ...createDefaultBracketSettings(), showNs: true }
        },
        title: 'Column Scatter',
        order: 1
      },
      {
        type: 'bar',
        options: {
          errorBarType: 'se',
          bracketSettings: { ...createDefaultBracketSettings(), showNs: true }
        },
        title: 'Bar Plot',
        order: 2
      },
      {
        type: 'box',
        options: {
          showJitter: false,
          bracketSettings: { ...createDefaultBracketSettings(), showNs: true }
        },
        title: 'Box Plot',
        order: 3
      },
      {
        type: 'violin',
        options: {
          showJitter: false,
          bracketSettings: { ...createDefaultBracketSettings(), showNs: true }
        },
        title: 'Violin Plot',
        order: 4
      },
    ],
    dataSource: 'plotlyJson',
  },

  // Paired T-Test → Bar + Box + Violin (showing differences)
  {
    testId: 't_test_paired',
    plots: [
      { type: 'bar', options: { errorBarType: 'se' }, title: 'Bar Plot (Difference)', order: 1 },
      { type: 'box', options: { showJitter: false }, title: 'Box Plot (Differences)', order: 2 },
      { type: 'violin', options: { showJitter: false }, title: 'Violin Plot (Differences)', order: 3 },
    ],
    dataSource: 'plotlyJson',
  },

  // One-Sample T-Test → Column Scatter + Bar (with points) + Histogram
  {
    testId: 't_test_one_sample',
    plots: [
      { type: 'column_scatter', options: { showMeanLine: true, errorBarType: 'se', pointJitterX: 0.05 }, title: 'Column Scatter', order: 1 },
      { type: 'bar', options: { errorBarType: 'se', overlayPoints: true, pointJitterX: 0.05, pointSize: 8 }, title: 'Bar Plot', order: 2 },
      { type: 'histogram', options: { histogramBins: 30, showDensityCurve: true }, title: 'Histogram', order: 3 },
    ],
    dataSource: 'plotlyJson',
  },

  // One-Way ANOVA → Bar + Box + Violin (all with significance brackets)
  {
    testId: 'anova_one_way',
    plots: [
      {
        type: 'bar',
        options: { errorBarType: 'se', bracketSettings: createDefaultBracketSettings() },
        title: 'Bar Plot',
        order: 1,
      },
      {
        type: 'box',
        options: { showJitter: false, bracketSettings: createDefaultBracketSettings() },
        title: 'Box Plot',
        order: 2,
      },
      {
        type: 'violin',
        options: { showJitter: false, bracketSettings: createDefaultBracketSettings() },
        title: 'Violin Plot',
        order: 3,
      },
    ],
    dataSource: 'cell_summaries',
  },

  // Two-Way ANOVA → Grouped Bar + Interaction Plot
  {
    testId: 'anova_two_way',
    plots: [
      {
        type: 'grouped_bar',
        options: { errorBarType: 'se', bracketSettings: createDefaultBracketSettings() },
        title: 'Cell Means',
        order: 1,
      },
      {
        type: 'interaction',
        options: { errorBarType: 'se' },
        title: 'Interaction Plot',
        order: 2,
      },
    ],
    dataSource: 'cell_summaries',
  },

  // Multifactorial ANOVA → Grouped Bar (limited to 2 factors)
  {
    testId: 'multifactorial_anova',
    plots: [
      {
        type: 'grouped_bar',
        options: { errorBarType: 'se', bracketSettings: createDefaultBracketSettings() },
        title: 'Cell Means',
        order: 1,
      },
    ],
    dataSource: 'cell_summaries',
    customBuilder: buildMultifactorialPlots,
  },

  // Mann-Whitney U → Column Scatter + Bar + Box + Violin (all with significance brackets, median-based)
  {
    testId: 'mann_whitney_u',
    plots: [
      {
        type: 'column_scatter',
        options: {
          errorBarType: 'iqr',
          showMeanLine: true,
          pointJitterX: 0.05,
          bracketSettings: { ...createDefaultBracketSettings(), showNs: true }
        },
        title: 'Column Scatter (Medians)',
        order: 1,
      },
      {
        type: 'bar',
        options: {
          errorBarType: 'iqr',
          bracketSettings: { ...createDefaultBracketSettings(), showNs: true }
        },
        title: 'Bar Plot (Medians)',
        order: 2,
      },
      {
        type: 'box',
        options: { showJitter: true, bracketSettings: { ...createDefaultBracketSettings(), showNs: true } },
        title: 'Box Plot (Medians)',
        order: 3,
      },
      {
        type: 'violin',
        options: { showJitter: true, bracketSettings: { ...createDefaultBracketSettings(), showNs: true } },
        title: 'Violin Plot (Medians)',
        order: 4,
      },
    ],
    dataSource: 'plotlyJson',
  },

  // Wilcoxon Signed-Rank → Box + Violin (no line chart)
  {
    testId: 'wilcoxon_signed_rank',
    plots: [
      { type: 'box', options: { showJitter: true }, title: 'Box Plot (Differences)', order: 1 },
      { type: 'violin', options: { showJitter: true }, title: 'Violin Plot (Differences)', order: 2 },
    ],
    dataSource: 'plotlyJson',
  },

  // Kruskal-Wallis → Bar + Box + Violin (all with significance brackets from Dunn test)
  {
    testId: 'kruskal_wallis',
    plots: [
      {
        type: 'bar',
        options: { errorBarType: 'iqr', bracketSettings: createDefaultBracketSettings() },
        title: 'Bar Plot (Medians)',
        order: 1,
      },
      {
        type: 'box',
        options: { showJitter: false, bracketSettings: createDefaultBracketSettings() },
        title: 'Box Plot (Medians)',
        order: 2,
      },
      {
        type: 'violin',
        options: { showJitter: false, bracketSettings: createDefaultBracketSettings() },
        title: 'Violin Plot (Medians)',
        order: 3,
      },
    ],
    dataSource: 'cell_summaries',
  },

// Scheirer-Ray-Hare → Grouped Bar (IQR error bars from cell summaries)
{
  testId: 'scheirer_ray_hare',
  plots: [
    {
      type: 'grouped_bar',
      options: { errorBarType: 'iqr', bracketSettings: createDefaultBracketSettings() },
      title: 'Cell Medians (IQR)',
      order: 1,
    },
  ],
  dataSource: 'cell_summaries',
},
]

/**
 * Helper to build PlotSpecWithStats from dose-response builder output
 */
function buildDoseResponsePlotSpec(
  result: TestResult,
  output: ReturnType<typeof buildDoseResponseCurveFromResult>,
  title: string
): PlotSpecWithStats | null {
  if (!output) return null
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-dr`,
    type: 'doseresponse',
    title,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data as Data[],
    plotlyLayout: output.layout as Layout,
    plotlyConfig: output.config,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  })

  return { plot, stats: output.stats }
}

/**
 * Helper to build PlotSpecWithStats from synergy contour builder output
 */
function buildSynergyPlotSpec(
  result: TestResult,
  output: PlotBuilderOutput | null,
  title: string,
  plotType: 'synergy_contour' | 'synergy_heatmap' = 'synergy_contour',
  idSuffix?: string
): PlotSpecWithStats | null {
  if (!output) return null
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const suffix = idSuffix ? `-${idSuffix}` : ''
  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-${plotType}${suffix}`,
    type: plotType,
    title,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data as Data[],
    plotlyLayout: output.layout as Layout,
    plotlyConfig: output.config,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  })

  return { plot, stats: output.stats }
}

/**
 * Helper to build PlotSpecWithStats from Loewe isobologram builder output
 */
function buildLoeweIsobologramPlotSpec(
  result: TestResult,
  output: ReturnType<typeof buildLoeweIsobologramFromResult>,
  title: string
): PlotSpecWithStats | null {
  if (!output) return null
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-isobologram`,
    type: 'scatter',  // Isobologram is a scatter plot
    title,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data as Data[],
    plotlyLayout: output.layout as Layout,
    plotlyConfig: output.config,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  })

  return { plot, stats: output.stats }
}

/**
 * Helper to build PlotSpecWithStats from Group 3 plot generator output
 */
function buildGroup3PlotSpec(
  result: TestResult,
  output: Group3PlotOutput | null,
  title: string,
  plotType: PlotType,
  idSuffix: string
): PlotSpecWithStats | null {
  if (!output) return null
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-${idSuffix}`,
    type: plotType,
    title,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.plotlyData as Data[],
    plotlyLayout: output.plotlyLayout as Partial<Layout>,
    plotlyConfig: output.plotlyConfig,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  })

  const layoutStats =
    (output.plotlyLayout as { meta?: { stats?: Record<string, number> } }).meta?.stats ?? {}
  const statsCandidate = 'stats' in output
    ? (output as { stats?: Record<string, number> }).stats
    : undefined
  const stats = statsCandidate ?? layoutStats ?? {}

  plot.plotlyLayout = {
    ...(plot.plotlyLayout ?? {}),
    meta: {
      ...((plot.plotlyLayout as { meta?: Record<string, unknown> } | undefined)?.meta ?? {}),
      stats,
      plotType,
    },
  }

  return { plot, stats }
}

/**
 * Helper to build PlotSpecWithStats from Group 4 plot builder output
 */
function buildGroup4PlotSpec(
  result: TestResult,
  output: PlotBuilderOutput | null,
  title: string,
  plotType: PlotType,
  idSuffix: string
): PlotSpecWithStats | null {
  if (!output) return null
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-${idSuffix}`,
    type: plotType,
    title,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data as Data[],
    plotlyLayout: output.layout as Partial<Layout>,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  const stats = output.stats ?? {}

  plot.plotlyLayout = {
    ...(plot.plotlyLayout ?? {}),
      meta: {
        ...((plot.plotlyLayout as { meta?: Record<string, unknown> } | undefined)?.meta ?? {}),
        stats,
        plotType,
      },
  }

  return { plot, stats }
}

/**
 * Helper to build PlotSpecWithStats from Group 5 plot builder output
 */
function buildGroup5PlotSpec(
  result: TestResult,
  output: PlotBuilderOutput | null,
  title: string,
  plotType: PlotType,
  idSuffix: string
): PlotSpecWithStats | null {
  if (!output) return null
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-${idSuffix}`,
    type: plotType,
    title,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data as Data[],
    plotlyLayout: output.layout as Partial<Layout>,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  const stats = output.stats ?? {}

  plot.plotlyLayout = {
    ...(plot.plotlyLayout ?? {}),
    meta: {
      ...((plot.plotlyLayout as { meta?: Record<string, unknown> } | undefined)?.meta ?? {}),
      stats,
      plotType,
    },
  }

  return { plot, stats }
}

function buildGroup6PlotSpec(
  result: TestResult,
  output: PlotBuilderOutput | null,
  title: string,
  plotType: PlotType,
  idSuffix: string
): PlotSpecWithStats | null {
  if (!output) return null
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-${idSuffix}`,
    type: plotType,
    title,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data as Data[],
    plotlyLayout: output.layout as Partial<Layout>,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  const stats = output.stats ?? {}

  plot.plotlyLayout = {
    ...(plot.plotlyLayout ?? {}),
    meta: {
      ...((plot.plotlyLayout as { meta?: Record<string, unknown> } | undefined)?.meta ?? {}),
      stats,
      plotType,
    },
  }

  return { plot, stats }
}

function extractAlignedNumericPairs(payloadData: Record<string, unknown>): {
  x: number[]
  y: number[]
} {
  const xRaw = Array.isArray(payloadData.x) ? payloadData.x : []
  const yRaw = Array.isArray(payloadData.y) ? payloadData.y : []
  const len = Math.min(xRaw.length, yRaw.length)
  const x: number[] = []
  const y: number[] = []
  for (let i = 0; i < len; i++) {
    const xv = xRaw[i]
    const yv = yRaw[i]
    if (typeof xv !== 'number' || !Number.isFinite(xv)) continue
    if (typeof yv !== 'number' || !Number.isFinite(yv)) continue
    x.push(xv)
    y.push(yv)
  }
  return { x, y }
}

/**
 * Auto-generation recipes for Group 2 pharmacology tests (dose-response)
 */
const GROUP2_PLOT_RECIPES: AutoPlotRecipe[] = [
  // 3PL Dose-Response → Single curve with CI bands
  {
    testId: 'dose_response_3pl',
    plots: [
      {
        type: 'doseresponse',
        title: '3PL Dose-Response Curve',
        order: 1,
      },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const output = buildDoseResponseCurveFromResult(result)
      const spec = buildDoseResponsePlotSpec(result, output, '3PL Dose-Response Curve')
      return spec ? [spec] : []
    },
  },

  // 4PL Dose-Response → Single curve with CI bands
  {
    testId: 'dose_response_4pl',
    plots: [
      {
        type: 'doseresponse',
        title: '4PL Dose-Response Curve',
        order: 1,
      },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const output = buildDoseResponseCurveFromResult(result)
      const spec = buildDoseResponsePlotSpec(result, output, '4PL Dose-Response Curve')
      return spec ? [spec] : []
    },
  },

  // 5PL Dose-Response → Single curve with CI bands
  {
    testId: 'dose_response_5pl',
    plots: [
      {
        type: 'doseresponse',
        title: '5PL Dose-Response Curve',
        order: 1,
      },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const output = buildDoseResponseCurveFromResult(result)
      const spec = buildDoseResponsePlotSpec(result, output, '5PL Dose-Response Curve')
      return spec ? [spec] : []
    },
  },

  // Model Compare → Overlay plot with all models
  {
    testId: 'dose_response_compare',
    plots: [
      {
        type: 'doseresponse',
        title: 'Model Comparison Overlay',
        order: 1,
      },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const output = buildDoseResponseCompareFromResult(result)
      const spec = buildDoseResponsePlotSpec(result, output, 'Model Comparison Overlay')
      return spec ? [spec] : []
    },
  },

  // Bliss Synergy → 2D Filled Contour + Heatmap
  {
    testId: 'synergy_bliss',
    plots: [
      {
        type: 'synergy_contour',
        title: 'Bliss Synergy Contour',
        order: 1,
      },
      {
        type: 'synergy_heatmap',
        title: 'Bliss Synergy Heatmap',
        order: 2,
      },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const contourOutput = buildSynergyContourFromResult(result)
      const heatmapOutput = buildSynergyHeatmapFromResult(result)

      const contourSpec = buildSynergyPlotSpec(result, contourOutput, 'Bliss Synergy Contour', 'synergy_contour')
      const heatmapSpec = buildSynergyPlotSpec(result, heatmapOutput, 'Bliss Synergy Heatmap', 'synergy_heatmap')

      const specs: PlotSpecWithStats[] = []
      if (contourSpec) specs.push(contourSpec)
      if (heatmapSpec) specs.push(heatmapSpec)
      return specs
    },
  },

  // HSA Synergy → 2D Filled Contour + Heatmap
  {
    testId: 'synergy_hsa',
    plots: [
      {
        type: 'synergy_contour',
        title: 'HSA Synergy Contour',
        order: 1,
      },
      {
        type: 'synergy_heatmap',
        title: 'HSA Synergy Heatmap',
        order: 2,
      },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const contourOutput = buildSynergyContourFromResult(result)
      const heatmapOutput = buildSynergyHeatmapFromResult(result)

      const contourSpec = buildSynergyPlotSpec(result, contourOutput, 'HSA Synergy Contour', 'synergy_contour')
      const heatmapSpec = buildSynergyPlotSpec(result, heatmapOutput, 'HSA Synergy Heatmap', 'synergy_heatmap')

      const specs: PlotSpecWithStats[] = []
      if (contourSpec) specs.push(contourSpec)
      if (heatmapSpec) specs.push(heatmapSpec)
      return specs
    },
  },

  // Loewe Synergy → 2D Filled Contour + Heatmap + Isobologram
  {
    testId: 'synergy_loewe',
    plots: [
      {
        type: 'synergy_contour',
        title: 'Loewe Synergy Contour',
        order: 1,
      },
      {
        type: 'synergy_heatmap',
        title: 'Loewe Synergy Heatmap',
        order: 2,
      },
      {
        type: 'scatter',
        title: 'Loewe Isobologram',
        order: 3,
      },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const contourOutput = buildSynergyContourFromResult(result)
      const heatmapOutput = buildSynergyHeatmapFromResult(result)
      const isobologramOutput = buildLoeweIsobologramFromResult(result)

      const contourSpec = buildSynergyPlotSpec(result, contourOutput, 'Loewe Synergy Contour', 'synergy_contour')
      const heatmapSpec = buildSynergyPlotSpec(result, heatmapOutput, 'Loewe Synergy Heatmap', 'synergy_heatmap')
      const isobologramSpec = buildLoeweIsobologramPlotSpec(result, isobologramOutput, 'Loewe Isobologram')

      const specs: PlotSpecWithStats[] = []
      if (contourSpec) specs.push(contourSpec)
      if (heatmapSpec) specs.push(heatmapSpec)
      if (isobologramSpec) specs.push(isobologramSpec)
      return specs
    },
  },

  // ZIP Synergy → 2D Filled Contour + Heatmap
  {
    testId: 'synergy_zip',
    plots: [
      {
        type: 'synergy_contour',
        title: 'ZIP Synergy Contour',
        order: 1,
      },
      {
        type: 'synergy_heatmap',
        title: 'ZIP Synergy Heatmap',
        order: 2,
      },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const contourOutput = buildSynergyContourFromResult(result)
      const heatmapOutput = buildSynergyHeatmapFromResult(result)

      const contourSpec = buildSynergyPlotSpec(result, contourOutput, 'ZIP Synergy Contour', 'synergy_contour')
      const heatmapSpec = buildSynergyPlotSpec(result, heatmapOutput, 'ZIP Synergy Heatmap', 'synergy_heatmap')

      const specs: PlotSpecWithStats[] = []
      if (contourSpec) specs.push(contourSpec)
      if (heatmapSpec) specs.push(heatmapSpec)
      return specs
    },
  },

  // Synergy All → Per-model contour plots + Loewe isobologram
]

/**
 * Auto-generation recipes for Group 3 regression/correlation tests
 */
const GROUP3_PLOT_RECIPES: AutoPlotRecipe[] = [
  // Correlation (Pearson) → Scatter
  {
    testId: 'correlation_pearson',
    plots: [
      { type: 'scatter', title: 'Pearson Correlation Scatter', order: 1 },
      { type: 'heatmap', title: 'Pearson Correlation Heatmap', order: 2 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const payload = getPlotPayload(result)
      const payloadData = (payload?.data ?? {}) as Record<string, unknown>
      const { x: xValues, y: yValues } = extractAlignedNumericPairs(payloadData)
      const xName = typeof payloadData.x_name === 'string' ? payloadData.x_name : 'X'
      const yName = typeof payloadData.y_name === 'string' ? payloadData.y_name : 'Y'

      const specs: PlotSpecWithStats[] = []

      if (xValues.length > 0 && yValues.length > 0) {
        const pearsonScatter = generateCorrelationScatter(
          result,
          { columnId: 'x', columnName: xName, values: xValues },
          { columnId: 'y', columnName: yName, values: yValues },
          'Pearson Correlation',
        )
        const pearsonSpec = buildGroup3PlotSpec(
          result,
          pearsonScatter,
          'Pearson Correlation Scatter',
          'scatter',
          'scatter-pearson'
        )
        if (pearsonSpec) specs.push(pearsonSpec)
      }

      const matrixSize = getCorrelationMatrixSize(result, 'pearson')
      if (matrixSize >= 3) {
        const heatmapOutput = generatePearsonCorrelationHeatmap(result)
        const heatmapSpec = buildGroup3PlotSpec(
          result,
          heatmapOutput,
          'Pearson Correlation Heatmap',
          'heatmap',
          'heatmap-pearson'
        )
        if (heatmapSpec) specs.push(heatmapSpec)
      }

      return specs
    },
  },
  // Spearman Correlation → (plots hidden for now)
  {
    testId: 'correlation_spearman',
    plots: [{ type: 'heatmap', title: 'Spearman Correlation Heatmap', order: 1 }],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const matrixSize = getCorrelationMatrixSize(result, 'spearman')
      if (matrixSize < 3) return []
      const heatmapOutput = generateSpearmanCorrelationHeatmap(result)
      const heatmapSpec = buildGroup3PlotSpec(
        result,
        heatmapOutput,
        'Spearman Correlation Heatmap',
        'heatmap',
        'heatmap-spearman'
      )
      return heatmapSpec ? [heatmapSpec] : []
    },
  },
  // Kendall Correlation → (plots hidden for now)
  {
    testId: 'correlation_kendall',
    plots: [{ type: 'heatmap', title: 'Kendall Correlation Heatmap', order: 1 }],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const matrixSize = getCorrelationMatrixSize(result, 'kendall')
      if (matrixSize < 3) return []
      const heatmapOutput = generateKendallCorrelationHeatmap(result)
      const heatmapSpec = buildGroup3PlotSpec(
        result,
        heatmapOutput,
        'Kendall Correlation Heatmap',
        'heatmap',
        'heatmap-kendall'
      )
      return heatmapSpec ? [heatmapSpec] : []
    },
  },

  // Simple Linear Regression → Scatter + Fit + CI + Residuals
  {
    testId: 'linear_regression',
    plots: [
      { type: 'scatter', title: 'Regression Scatter with Fit', order: 1 },
      { type: 'residual', title: 'Residual vs Fitted', order: 2 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const payload = getPlotPayload(result)
      const payloadData = (payload?.data ?? {}) as Record<string, unknown>
      const { x: xValues, y: yValues } = extractAlignedNumericPairs(payloadData)
      const xName = typeof payloadData.predictor_name === 'string' ? payloadData.predictor_name : 'Predictor'
      const yName = typeof payloadData.dependent_name === 'string' ? payloadData.dependent_name : 'Outcome'

      const specs: PlotSpecWithStats[] = []

      if (xValues.length > 0 && yValues.length > 0) {
        const scatterOutput = generateLinearRegressionScatterWithFit(result, xValues, yValues, xName, yName)
        const scatterSpec = buildGroup3PlotSpec(result, scatterOutput, 'Regression Scatter with Fit', 'scatter', 'scatter')
        if (scatterSpec) specs.push(scatterSpec)
      }

      const residualOutput = generateLinearRegressionResidualPlot(result)
      const residualSpec = buildGroup3PlotSpec(result, residualOutput, 'Residual vs Fitted', 'residual', 'residual')
      if (residualSpec) specs.push(residualSpec)

      return specs
    },
  },

  // Multiple Linear Regression → Forest Plot + Residuals
  {
    testId: 'multiple_linear_regression',
    plots: [
      { type: 'forest', title: 'Coefficient Forest Plot', order: 1 },
      { type: 'residual', title: 'Residual vs Fitted', order: 2 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const forestOutput = generateMultipleLinearForestPlot(result)
      const residualOutput = generateMultipleLinearResidualPlot(result)

      const forestSpec = buildGroup3PlotSpec(result, forestOutput, 'Coefficient Forest Plot', 'forest', 'forest')
      const residualSpec = buildGroup3PlotSpec(result, residualOutput, 'Residual vs Fitted', 'residual', 'residual')

      const specs: PlotSpecWithStats[] = []
      if (forestSpec) specs.push(forestSpec)
      if (residualSpec) specs.push(residualSpec)
      return specs
    },
  },

  // Binary Logistic Regression → Forest Plot (OR) + ROC Curve
  {
    testId: 'logistic_binary',
    plots: [
      { type: 'forest', title: 'Odds Ratio Forest Plot', order: 1 },
      { type: 'scatter', title: 'ROC Curve', order: 2 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const forestOutput = generateBinaryLogisticForestPlot(result)
      const rocOutput = generateBinaryLogisticROCCurve(result)

      const forestSpec = buildGroup3PlotSpec(result, forestOutput, 'Odds Ratio Forest Plot', 'forest', 'forest')
      const rocSpec = buildGroup3PlotSpec(result, rocOutput, 'ROC Curve', 'scatter', 'roc')

      const specs: PlotSpecWithStats[] = []
      if (forestSpec) specs.push(forestSpec)
      if (rocSpec) specs.push(rocSpec)
      return specs
    },
  },

  // Multinomial Logistic Regression → Forest Plot (OR by class) + ROC Curves
  {
    testId: 'logistic_multinomial',
    plots: [
      { type: 'forest', title: 'Odds Ratio Forest Plot by Class', order: 1 },
      { type: 'scatter', title: 'ROC Curves (One-vs-Rest)', order: 2 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const forestOutput = generateMultinomialLogisticForestPlot(result)
      const rocOutput = generateMultinomialLogisticROCPlot(result)

      const forestSpec = buildGroup3PlotSpec(
        result,
        forestOutput,
        'Odds Ratio Forest Plot by Class',
        'forest',
        'forest',
      )
      const rocSpec = buildGroup3PlotSpec(
        result,
        rocOutput,
        'ROC Curves (One-vs-Rest)',
        'scatter',
        'roc',
      )

      const specs: PlotSpecWithStats[] = []
      if (forestSpec) specs.push(forestSpec)
      if (rocSpec) specs.push(rocSpec)
      return specs
    },
  },
]

/**
 * Auto-generation recipes for Group 4 categorical tests
 */
const GROUP4_PLOT_RECIPES: AutoPlotRecipe[] = [
  // Chi-Square Independence → Mosaic + Grouped Bar + Residual Heatmap
  {
    testId: 'chi_squared',
    plots: [
      { type: 'mosaic', title: 'Mosaic Plot', order: 1 },
      { type: 'grouped_bar', title: 'Grouped Bar Chart', order: 2 },
      { type: 'heatmap', title: 'Observed vs Expected (Std Residuals)', order: 3 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const mosaicOutput = buildChiSquareMosaicPlot(result)
      const groupedOutput = buildChiSquareGroupedBarPlot(result)
      const heatmapOutput = buildChiSquareResidualHeatmap(result)

      const specs: PlotSpecWithStats[] = []
      const mosaicSpec = buildGroup4PlotSpec(result, mosaicOutput, 'Mosaic Plot', 'mosaic', 'mosaic')
      const groupedSpec = buildGroup4PlotSpec(result, groupedOutput, 'Grouped Bar Chart', 'grouped_bar', 'grouped')
      const heatmapSpec = buildGroup4PlotSpec(
        result,
        heatmapOutput,
        'Observed vs Expected (Std Residuals)',
        'heatmap',
        'heatmap',
      )

      if (mosaicSpec) specs.push(mosaicSpec)
      if (groupedSpec) specs.push(groupedSpec)
      if (heatmapSpec) specs.push(heatmapSpec)
      return specs
    },
  },

  // Chi-Square Goodness of Fit → Distribution Plot + Observed vs Expected Bars
  {
    testId: 'chi_square_gof',
    plots: [
      { type: 'line', title: 'Chi-Square Distribution', order: 1 },
      { type: 'grouped_bar', title: 'Observed vs Expected', order: 2 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const distOutput = buildGofChiSquareDistribution(result)
      const barOutput = buildGofObservedExpectedBarPlot(result)

      const specs: PlotSpecWithStats[] = []
      const distSpec = buildGroup4PlotSpec(result, distOutput, 'Chi-Square Distribution', 'line', 'chi-square-dist')
      const barSpec = buildGroup4PlotSpec(result, barOutput, 'Observed vs Expected', 'grouped_bar', 'observed-expected')

      if (distSpec) specs.push(distSpec)
      if (barSpec) specs.push(barSpec)
      return specs
    },
  },

  // Fisher's Exact Test → Distribution Plot + Grouped Bar + Odds Ratio Forest
  {
    testId: 'fisher_exact',
    plots: [
      { type: 'line', title: 'Chi-Square Distribution', order: 1 },
      { type: 'grouped_bar', title: 'Grouped Bar Chart', order: 2 },
      { type: 'forest', title: 'Odds Ratio Forest Plot', order: 3 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const distOutput = buildFisherExactChiSquareDistribution(result)
      const barOutput = buildFisherExactGroupedBarPlot(result)
      const forestOutput = buildFisherExactForestPlot(result)

      const specs: PlotSpecWithStats[] = []
      const distSpec = buildGroup4PlotSpec(result, distOutput, 'Chi-Square Distribution', 'line', 'chi-square-dist')
      const barSpec = buildGroup4PlotSpec(result, barOutput, 'Grouped Bar Chart', 'grouped_bar', 'grouped')
      const forestSpec = buildGroup4PlotSpec(result, forestOutput, 'Odds Ratio Forest Plot', 'forest', 'forest')

      if (distSpec) specs.push(distSpec)
      if (barSpec) specs.push(barSpec)
      if (forestSpec) specs.push(forestSpec)
      return specs
    },
  },

  // McNemar's Test → Paired Bar Chart
  {
    testId: 'mcnemar',
    plots: [
      { type: 'grouped_bar', title: 'Paired Bar Chart', order: 1 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const barOutput = buildMcNemarPairedBarPlot(result)
      const barSpec = buildGroup4PlotSpec(result, barOutput, 'Paired Bar Chart', 'grouped_bar', 'paired')
      return barSpec ? [barSpec] : []
    },
  },
]

/**
 * Auto-generation recipes for Group 5 descriptive/distribution tests
 */
const GROUP5_NORMALITY_TESTS = [
  'normality_shapiro',
  'normality_ks',
  'normality_ad',
  'normality_cvm',
  'normality_jb',
  'normality_all',
  'normality_tests',
]

const GROUP5_PLOT_RECIPES: AutoPlotRecipe[] = [
  ...GROUP5_NORMALITY_TESTS.map<AutoPlotRecipe>((testId) => ({
    testId,
    plots: [
      { type: 'qq', title: 'Q-Q Plot', order: 1 },
      { type: 'histogram', title: 'Histogram (Density)', order: 2 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const qqOutput = buildNormalityQQPlot(result)
      const histOutput = buildNormalityHistogramPlot(result)

      const specs: PlotSpecWithStats[] = []
      const qqSpec = buildGroup5PlotSpec(result, qqOutput, 'Q-Q Plot', 'qq', 'qq')
      const histSpec = buildGroup5PlotSpec(
        result,
        histOutput,
        'Histogram (Density)',
        'histogram',
        'hist'
      )
      if (qqSpec) specs.push(qqSpec)
      if (histSpec) specs.push(histSpec)
    return specs
  },
})),

  // Descriptive Statistics → Histogram + Box + Violin
  {
    testId: 'descriptive_stats',
    plots: [
      { type: 'histogram', title: 'Histogram (Density)', order: 1 },
      { type: 'box', title: 'Box Plot', order: 2 },
      { type: 'violin', title: 'Violin Plot', order: 3 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const histOutput = buildDescriptiveHistogramPlot(result)
      const boxOutput = buildDescriptiveBoxPlot(result)
      const violinOutput = buildDescriptiveViolinPlot(result)

      const specs: PlotSpecWithStats[] = []
      const histSpec = buildGroup5PlotSpec(
        result,
        histOutput,
        'Histogram (Density)',
        'histogram',
        'hist'
      )
      const boxSpec = buildGroup5PlotSpec(result, boxOutput, 'Box Plot', 'box', 'box')
      const violinSpec = buildGroup5PlotSpec(result, violinOutput, 'Violin Plot', 'violin', 'violin')

      if (histSpec) specs.push(histSpec)
      if (boxSpec) specs.push(boxSpec)
      if (violinSpec) specs.push(violinSpec)
      return specs
    },
  },

  // Outlier Detection → Box + Column Scatter
  {
    testId: 'outlier_detection',
    plots: [
      { type: 'box', title: 'Box Plot (Outliers)', order: 1 },
      { type: 'column_scatter', title: 'Outlier Scatter', order: 2 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const boxOutput = buildOutlierBoxPlot(result)
      const scatterOutput = buildOutlierScatterPlot(result)

      const specs: PlotSpecWithStats[] = []
      const boxSpec = buildGroup5PlotSpec(result, boxOutput, 'Box Plot (Outliers)', 'box', 'box')
      const scatterSpec = buildGroup5PlotSpec(
        result,
        scatterOutput,
        'Outlier Scatter',
        'column_scatter',
        'scatter'
      )

      if (boxSpec) specs.push(boxSpec)
      if (scatterSpec) specs.push(scatterSpec)
      return specs
    },
  },
]

const GROUP6_PLOT_RECIPES: AutoPlotRecipe[] = [
  {
    testId: 'kaplan_meier',
    plots: [
      { type: 'survival', title: 'Kaplan-Meier Survival Curve', order: 1 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const output = buildKaplanMeierPlot(result)
      const spec = buildGroup6PlotSpec(result, output, 'Kaplan-Meier Survival Curve', 'survival', 'km')
      return spec ? [spec] : []
    },
  },
  {
    testId: 'cox_proportional_hazards',
    plots: [
      { type: 'forest', title: 'Hazard Ratio Forest Plot', order: 1 },
      { type: 'survival', title: 'Adjusted Survival Curves', order: 2 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const specs: PlotSpecWithStats[] = []
      const forestOutput = buildCoxForestPlot(result)
      const forestSpec = buildGroup6PlotSpec(result, forestOutput, 'Hazard Ratio Forest Plot', 'forest', 'cox-forest')
      if (forestSpec) specs.push(forestSpec)

      const adjustedOutput = buildCoxAdjustedSurvivalPlot(result)
      const adjustedSpec = buildGroup6PlotSpec(
        result,
        adjustedOutput,
        'Adjusted Survival Curves',
        'survival',
        'cox-adjusted'
      )
      if (adjustedSpec) specs.push(adjustedSpec)
      return specs
    },
  },
  {
    testId: 'nelson_aalen',
    plots: [
      { type: 'survival', title: 'Cumulative Hazard Curve', order: 1 },
      { type: 'line', title: 'Smoothed Hazard Rate', order: 2 },
    ],
    dataSource: 'raw_points',
    customBuilder: (result: TestResult) => {
      const specs: PlotSpecWithStats[] = []
      const cumHazOutput = buildNelsonAalenCumulativeHazardPlot(result)
      const cumHazSpec = buildGroup6PlotSpec(
        result,
        cumHazOutput,
        'Cumulative Hazard Curve',
        'survival',
        'na-cumhaz'
      )
      if (cumHazSpec) specs.push(cumHazSpec)

      const smoothOutput = buildNelsonAalenSmoothedHazardPlot(result)
      const smoothSpec = buildGroup6PlotSpec(
        result,
        smoothOutput,
        'Smoothed Hazard Rate',
        'line',
        'na-smoothed'
      )
      if (smoothSpec) specs.push(smoothSpec)
      return specs
    },
  },
]

/**
 * LMM ANOVA plot recipes — line-only (trajectory + contrast views)
 * Uses customBuilder path; no new PlotType union members required.
 * lmm_anova_stratified is aliased to lmm_anova by normalizeTestId.
 */
const LMM_PLOT_RECIPES: AutoPlotRecipe[] = [
  {
    testId: 'lmm_anova',
    plots: [
      { type: 'line', title: 'Trajectory (Mean ± SE)', order: 1 },
      { type: 'line', title: 'Contrast (Simple Effects)', order: 2 },
    ],
    dataSource: 'raw_points',
    // Initial generation only — no user overrides exist yet at this point.
    // Rebuilds with per-plot overrides go through rebuildTestResultPlot which
    // passes lmmStyleOverrides directly to buildLmmPlots.
    customBuilder: (result: TestResult) => buildLmmPlots(result),
  },
]

/** Combined recipes for all groups */
const ALL_PLOT_RECIPES = [
  ...GROUP1_PLOT_RECIPES,
  ...GROUP2_PLOT_RECIPES,
  ...GROUP3_PLOT_RECIPES,
  ...GROUP4_PLOT_RECIPES,
  ...GROUP5_PLOT_RECIPES,
  ...GROUP6_PLOT_RECIPES,
  ...LMM_PLOT_RECIPES,
]

/**
 * Get auto-plot recipe for a test
 */
function getPlotRecipe(testId: string): AutoPlotRecipe | null {
  const normalized = normalizeTestId(testId)
  return ALL_PLOT_RECIPES.find((r) => r.testId === normalized) ?? null
}

function fallbackPlotLabel(plotType: PlotType): string {
  switch (plotType) {
    case 'grouped_bar':
      return 'Grouped Bar Chart'
    case 'column_scatter':
      return 'Column Scatter'
    case 'faceted_grouped_bar':
      return 'Faceted Grouped Bar'
    case 'doseresponse':
      return 'Dose-Response Curve'
    case 'synergy_contour':
      return 'Synergy Contour'
    case 'synergy_heatmap':
      return 'Synergy Heatmap'
    default:
      return plotType
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
  }
}

/**
 * Get runtime auto-generated plot labels for a test.
 * Uses the same recipe system as buildPlotSpecsFromResult().
 */
export function getAutoGeneratedPlotLabelsForTest(testId: string): string[] {
  const normalized = normalizeTestId(testId)

  // Explicitly excluded from auto-plot guidance.
  if (normalized.includes('friedman')) {
    return []
  }

  const recipe = getPlotRecipe(normalized)
  if (recipe) {
    const labels = recipe.plots.map((plot) => {
      const titled = typeof plot.title === 'string' ? plot.title.trim() : ''
      return titled || fallbackPlotLabel(plot.type)
    })

    // Multifactorial custom builder also auto-generates interaction plots.
    if (normalized === 'multifactorial_anova') {
      labels.push('Interaction Plot(s)')
    }

    return Array.from(new Set(labels))
  }

  const primary = getPrimaryPlot(normalized)
  return primary ? [primary.displayName] : []
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
// ⚠️ PHASE A REFACTOR: These functions have been moved to ./plotResult/common/
// They are now imported at the top of this file and commented out here for reference.
// After typecheck + E2E tests pass, these commented blocks will be deleted.
// ============================================================================

// ❌ MOVED TO common/normalize.ts
/* eslint-disable @typescript-eslint/no-unused-vars */
// @ts-nocheck
/*
function mapFamily(family: string): Exclude<StatisticalFamily, 'user_derived'> {
  switch (family) {
    case 'parametric':
    case 'nonparametric':
      return 'hypothesis'
    case 'correlation':
    case 'regression':
      return 'regression'
    case 'distribution':
    case 'descriptive':
      return 'descriptive'
    case 'categorical':
      return 'categorical'
    case 'survival':
      return 'survival'
    case 'pharmacology':
      return 'pharmacology'
    case 'mediation':
    case 'moderation':
      return 'mediation'
    default:
      return 'hypothesis'
  }
}

function mapPlotlyType(plotlyType: string | undefined, plotlyMode?: string): PlotType {
  switch (plotlyType) {
    case 'scatter':
      if (plotlyMode?.includes('lines') && !plotlyMode.includes('markers')) {
        return 'line'
      }
      return 'scatter'
    case 'scattergl':
      return 'scattergl'
    case 'bar':
      return 'bar'
    case 'box':
      return 'box'
    case 'histogram':
      return 'histogram'
    case 'pie':
      return 'pie'
    case 'violin':
      return 'violin'
    case 'heatmap':
      return 'heatmap'
    case 'histogram2d':
    case 'histogram2dcontour':
    case 'contour':
      return 'heatmap'
    default:
      return 'scatter'
  }
}

function normalizeTestId(testId: string): string {
  switch (testId) {
    case 'independent_ttest':
      return 't_test_two_sample'
    case 'paired_ttest':
      return 't_test_paired'
    case 'one_sample_ttest':
      return 't_test_one_sample'
    case 'one_way_anova':
      return 'anova_one_way'
    case 'two_way_anova':
      return 'anova_two_way'
    case 'mann_whitney':
      return 'mann_whitney_u'
    case 'wilcoxon':
      return 'wilcoxon_signed_rank'
    case 'chi_square':
      return 'chi_squared'
    case 'fishers_exact':
      return 'fisher_exact'
    case 'cox_regression':
      return 'cox_proportional_hazards'
    case 'logistic_regression':
      return 'logistic_binary'
    case 'lmm_anova_stratified':
      return 'lmm_anova'
    default:
      return testId
  }
}

type PlotPayload = {
  test?: string
  data?: Record<string, unknown>
  parameters?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

function getResultData(result: TestResult): Record<string, unknown> {
  const rawOutput = result.rawOutput
  if (rawOutput && typeof rawOutput === 'object') {
    const rawObject = rawOutput as Record<string, unknown>
    const nested = rawObject.results
    if (nested && typeof nested === 'object') {
      return nested as Record<string, unknown>
    }
  }
  return result as unknown as Record<string, unknown>
}

function getPlotPayload(result: TestResult): PlotPayload | null {
  const payload = (result as { plotPayload?: PlotPayload }).plotPayload
  if (payload && typeof payload === 'object') {
    return payload
  }
  return null
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function isBracketSignificant(pValue: number, settings: BracketSettings): boolean {
  return Boolean(getBracketLabel(pValue, { ...settings, showNs: false }))
}

// @ts-expect-error - Utility function for future use
function _parseLabelList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item))
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    const separator = trimmed.includes(';') ? ';' : ','
    return trimmed
      .split(separator)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function toNumberArray(values: unknown): number[] {
  if (!Array.isArray(values)) return []
  return values
    .map((value) => toNumber(value))
    .filter((value): value is number => value !== null)
}

function resolveValueLabel(payload: PlotPayload | null, fallback: string): string {
  const data = payload?.data ?? {}
  const metadata = payload?.metadata ?? {}
  const candidates = [
    metadata.variable_name,
    data.value_name,
    data.dependent_name,
    data.value_column,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }
  return fallback
}

function resolveGroupLabel(payload: PlotPayload | null, fallback: string): string {
  const data = payload?.data ?? {}
  const metadata = payload?.metadata ?? {}
  const candidates = [metadata.grouping_variable, data.grouping_variable, data.group_column]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate
    }
  }
  return fallback
}

function resolveGroupNames(payload: PlotPayload | null, count: number): string[] {
  const data = payload?.data ?? {}
  const parameters = payload?.parameters ?? {}
  const fromData = Array.isArray(data.group_names) ? data.group_names.map((name) => String(name)) : []
  const fromDataLabels = Array.isArray(data.group_labels)
    ? data.group_labels.map((name) => String(name))
    : []
  const fromParams = Array.isArray(parameters.group_labels)
    ? parameters.group_labels.map((name) => String(name))
    : []

  const names =
    fromData.length >= count
      ? fromData
      : fromDataLabels.length >= count
        ? fromDataLabels
        : fromParams.length >= count
          ? fromParams
          : []
  if (names.length >= count) {
    return names.slice(0, count)
  }
  return Array.from({ length: count }, (_, index) => `Group ${index + 1}`)
}

function flattenGroupsWithLabels(
  groups: unknown[][],
  labels: string[]
): { yValues: number[]; groupValues: string[] } {
  const yValues: number[] = []
  const groupValues: string[] = []
  groups.forEach((group, index) => {
    const label = labels[index] ?? `Group ${index + 1}`
    for (const value of group) {
      const numeric = toNumber(value)
      if (numeric !== null) {
        yValues.push(numeric)
        groupValues.push(label)
      }
    }
  })
  return { yValues, groupValues }
}

function calculateDifferences(group1: unknown, group2: unknown): number[] {
  const g1 = toNumberArray(group1)
  const g2 = toNumberArray(group2)
  const len = Math.min(g1.length, g2.length)
  const diffs: number[] = []
  for (let i = 0; i < len; i++) {
    const v1 = g1[i]
    const v2 = g2[i]
    if (v1 !== undefined && v2 !== undefined) {
      diffs.push(v1 - v2)
    }
  }
  return diffs
}

function buildPayloadSeries(
  result: TestResult
): { yValues: number[]; groupValues?: string[]; yLabel: string; groupLabel?: string } | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null
  const data = payload.data
  const normalizedTestId = normalizeTestId(result.testId)

  if (normalizedTestId === 't_test_two_sample' || normalizedTestId === 'mann_whitney_u') {
    const group1 = toNumberArray(data.group1 ?? data.data1)
    const group2 = toNumberArray(data.group2 ?? data.data2)
    if (group1.length === 0 && group2.length === 0) return null

    const group1Name =
      (typeof data.group1_name === 'string' && data.group1_name) ||
      (typeof data.group_name1 === 'string' && data.group_name1) ||
      'Group 1'
    const group2Name =
      (typeof data.group2_name === 'string' && data.group2_name) ||
      (typeof data.group_name2 === 'string' && data.group_name2) ||
      'Group 2'

    const yValues = [...group1, ...group2]
    const groupValues = [
      ...Array(group1.length).fill(group1Name),
      ...Array(group2.length).fill(group2Name),
    ]

    return {
      yValues,
      groupValues,
      yLabel: resolveValueLabel(payload, 'Value'),
      groupLabel: resolveGroupLabel(payload, 'Group'),
    }
  }

  if (normalizedTestId === 't_test_paired' || normalizedTestId === 'wilcoxon_signed_rank') {
    const diffs = calculateDifferences(data.group1, data.group2)
    if (diffs.length === 0) return null
    const group1Name = typeof data.group1_name === 'string' ? data.group1_name : 'Group 1'
    const group2Name = typeof data.group2_name === 'string' ? data.group2_name : 'Group 2'
    const diffLabel = `${group1Name} - ${group2Name}`
    return {
      yValues: diffs,
      yLabel: diffLabel || 'Difference',
    }
  }

  if (normalizedTestId === 't_test_one_sample') {
    const values = toNumberArray(data.values)
    if (values.length === 0) return null
    return {
      yValues: values,
      yLabel: resolveValueLabel(payload, 'Value'),
    }
  }

  if (normalizedTestId === 'anova_one_way' || normalizedTestId === 'kruskal_wallis') {
    const groups = Array.isArray(data.groups) ? (data.groups as unknown[][]) : []
    if (groups.length === 0) return null
    const labels = resolveGroupNames(payload, groups.length)
    const { yValues, groupValues } = flattenGroupsWithLabels(groups, labels)
    if (yValues.length === 0) return null
    return {
      yValues,
      groupValues,
      yLabel: resolveValueLabel(payload, 'Value'),
      groupLabel: resolveGroupLabel(payload, 'Group'),
    }
  }

  return null
}

function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    const v1 = sorted[mid - 1]
    const v2 = sorted[mid]
    if (v1 !== undefined && v2 !== undefined) {
      return (v1 + v2) / 2
    }
    return 0
  }
  const medianValue = sorted[mid]
  return medianValue !== undefined ? medianValue : 0
}
*/
// ============================================================================
// END OF MOVED HELPER FUNCTIONS
// ============================================================================

function buildBarFromGroupData(
  result: TestResult,
  groups: number[][],
  groupNames: string[],
  opts: {
    title?: string
    groupLabel?: string
    errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
    bracketSettings?: BracketSettings
  } = {}
): PlotSpecWithStats | null {
  if (groups.length === 0) return null
  const errorBarType = opts.errorBarType ?? 'se'

  const categories: string[] = []
  const means: number[] = []
  const errors: Array<number | null> = []

  groups.forEach((group, index) => {
    const values = group.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (values.length === 0) return
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    categories.push(groupNames[index] ?? `Group ${index + 1}`)
    means.push(mean)
    errors.push(calculateErrorBar(values, errorBarType))
  })

  if (categories.length === 0) return null

  let brackets: SignificanceBracket[] | undefined
  if (opts.bracketSettings) {
    brackets = extractPostHocBrackets(result, opts.bracketSettings)
  }

  const builder = getPlotBuilder('bar')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: 'group',
        columnName: opts.groupLabel ?? 'Group',
        values: categories,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'mean',
        columnName: 'Mean',
        values: means,
        inferredType: 'numeric',
      },
      ...(errors.some((value) => typeof value === 'number' && Number.isFinite(value))
        ? [
            {
              role: 'error' as const,
              columnId: 'error',
              columnName: 'Error',
              values: errors.map((value) => (typeof value === 'number' ? value : null)),
              inferredType: 'numeric' as const,
            },
          ]
        : []),
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType,
      bracketSettings: opts.bracketSettings,
      brackets,
    },
  })

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...output.stats,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}`,
    type: 'bar',
    title: opts.title ?? result.testName,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: output.layout,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  return { plot, stats }
}

function buildGroupedBarFromPayload(result: TestResult): {
  data: unknown[]
  layout: unknown
  stats: Record<string, number | string>
} | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null

  const data = payload.data
  const dependentOrValues = data.dependent ?? data.values
  const valuesRaw: unknown[] = Array.isArray(dependentOrValues) ? dependentOrValues : []
  const factor1Raw = Array.isArray(data.factor1) ? data.factor1 : null
  const factor2Raw = Array.isArray(data.factor2) ? data.factor2 : null

  if (!factor1Raw || !factor2Raw || valuesRaw.length === 0) {
    return null
  }

  const factor1Name = typeof data.factor1_name === 'string' ? data.factor1_name : 'Factor 1'
  const factor2Name = typeof data.factor2_name === 'string' ? data.factor2_name : 'Factor 2'

  const factorLevels =
    data.factor_levels && typeof data.factor_levels === 'object'
      ? (data.factor_levels as Record<string, unknown>)
      : undefined

  const decodeLevel = (value: unknown, name: string): string => {
    const levels = factorLevels?.[name]
    if (Array.isArray(levels)) {
      const numeric = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(numeric)) {
        const index = Math.trunc(numeric)
        const label = levels[index]
        if (label !== undefined) return String(label)
      }
    }
    return String(value)
  }

  const pairs = Math.min(valuesRaw.length, factor1Raw.length, factor2Raw.length)
  const cellMap = new Map<string, number[]>()
  const factor1Labels: string[] = []
  const factor2Labels: string[] = []
  const factor1Set = new Set<string>()
  const factor2Set = new Set<string>()

  for (let i = 0; i < pairs; i++) {
    const value = toNumber(valuesRaw[i])
    if (value === null) continue
    const factor1Label = decodeLevel(factor1Raw[i], factor1Name)
    const factor2Label = decodeLevel(factor2Raw[i], factor2Name)
    if (!factor1Set.has(factor1Label)) {
      factor1Set.add(factor1Label)
      factor1Labels.push(factor1Label)
    }
    if (!factor2Set.has(factor2Label)) {
      factor2Set.add(factor2Label)
      factor2Labels.push(factor2Label)
    }
    const key = `${factor1Label}||${factor2Label}`
    const bucket = cellMap.get(key)
    if (bucket) {
      bucket.push(value)
    } else {
      cellMap.set(key, [value])
    }
  }

  const orderedFactor1 =
    Array.isArray(factorLevels?.[factor1Name])
      ? (factorLevels?.[factor1Name] as unknown[]).map((label) => String(label))
      : factor1Labels
  const orderedFactor2 =
    Array.isArray(factorLevels?.[factor2Name])
      ? (factorLevels?.[factor2Name] as unknown[]).map((label) => String(label))
      : factor2Labels

  const xValues: string[] = []
  const groupValues: string[] = []
  const yValues: number[] = []
  const useMedian = normalizeTestId(result.testId) === 'scheirer_ray_hare'

  for (const factor1Label of orderedFactor1) {
    for (const factor2Label of orderedFactor2) {
      const key = `${factor1Label}||${factor2Label}`
      const bucket = cellMap.get(key)
      if (!bucket || bucket.length === 0) continue
      const value = useMedian ? calculateMedian(bucket) : bucket.reduce((sum, v) => sum + v, 0) / bucket.length
      xValues.push(factor1Label)
      groupValues.push(factor2Label)
      yValues.push(value)
    }
  }

  if (xValues.length === 0) return null

  const builder = getPlotBuilder('grouped_bar')
  const yLabel = useMedian ? 'Median' : 'Mean'
  const yColumnId = useMedian ? 'median' : 'mean'
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: factor1Name,
        columnName: factor1Name,
        values: xValues,
        inferredType: 'categorical',
      },
      {
        role: 'group',
        columnId: factor2Name,
        columnName: factor2Name,
        values: groupValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: yColumnId,
        columnName: yLabel,
        values: yValues,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: result.testName,
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
  })

  return { data: output.data, layout: output.layout, stats: output.stats }
}

function getFactorNamesFromResult(resultData: Record<string, unknown>): string[] {
  const factorNames: string[] = []
  const label1 =
    typeof resultData.factor1_label === 'string'
      ? resultData.factor1_label
      : typeof resultData.factor1_name === 'string'
        ? resultData.factor1_name
        : undefined
  const label2 =
    typeof resultData.factor2_label === 'string'
      ? resultData.factor2_label
      : typeof resultData.factor2_name === 'string'
        ? resultData.factor2_name
        : undefined
  const label3 =
    typeof resultData.factor3_label === 'string'
      ? resultData.factor3_label
      : typeof resultData.factor3_name === 'string'
        ? resultData.factor3_name
        : undefined

  if (label1) factorNames.push(label1)
  if (label2) factorNames.push(label2)
  if (label3) factorNames.push(label3)

  if (factorNames.length >= 2) {
    return factorNames
  }

  const fromArray = Array.isArray(resultData.factor_names)
    ? resultData.factor_names.map((name) => String(name))
    : []
  return fromArray.length > 0 ? fromArray : factorNames
}

type CellSummarySource = {
  summaries: Record<string, unknown>[]
  meansType: 'cell_mean' | 'lsmean' | 'median' | 'unknown'
}

function resolveCellSummarySource(resultData: Record<string, unknown>): CellSummarySource | null {
  const meansTypeRaw =
    typeof resultData.means_type === 'string' ? resultData.means_type.trim().toLowerCase() : null
  const counts = resultData.cell_counts as
    | { is_balanced?: boolean; isBalanced?: boolean }
    | undefined
  const isBalanced =
    typeof counts?.is_balanced === 'boolean'
      ? counts.is_balanced
      : typeof counts?.isBalanced === 'boolean'
        ? counts.isBalanced
        : null

  const emmeans = Array.isArray(resultData.cell_emmeans)
    ? (resultData.cell_emmeans as Record<string, unknown>[])
    : null

  const summaries =
    (resultData.cell_summaries as unknown[] | undefined) ??
    (resultData.cell_means as unknown[] | undefined) ??
    (resultData.cell_medians as unknown[] | undefined)

  if (
    Array.isArray(emmeans) &&
    emmeans.length > 0 &&
    (meansTypeRaw === 'lsmean' || isBalanced === false || !summaries)
  ) {
    return { summaries: emmeans as Record<string, unknown>[], meansType: 'lsmean' }
  }

  if (!Array.isArray(summaries) || summaries.length === 0) {
    return null
  }

  const meansType: CellSummarySource['meansType'] =
    Array.isArray(resultData.cell_medians) ? 'median' : 'cell_mean'
  return { summaries: summaries as Record<string, unknown>[], meansType }
}

function parseCellFactors(
  cell: Record<string, unknown>,
  factorLabels?: { factor1: string; factor2: string }
): Record<string, string> | null {
  // First priority: explicit factors object
  const rawFactors = cell.factors
  if (rawFactors && typeof rawFactors === 'object' && !Array.isArray(rawFactors)) {
    const entries = Object.entries(rawFactors as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])
    if (entries.length > 0) {
      return Object.fromEntries(entries)
    }
  }

  // Second priority: factor1_level/factor2_level fields (Python backend format)
  const factor1 = cell.factor1_level ?? cell.factor1Level ?? cell.factor1
  const factor2 = cell.factor2_level ?? cell.factor2Level ?? cell.factor2
  if (factor1 !== null && factor1 !== undefined && factor2 !== null && factor2 !== undefined) {
    const factor1Name = factorLabels?.factor1 ?? 'factor1'
    const factor2Name = factorLabels?.factor2 ?? 'factor2'
    return {
      [factor1Name]: String(factor1),
      [factor2Name]: String(factor2),
    }
  }

  // Fallback: factor names used directly as keys (e.g., "InterventionGroup")
  const labeledFactor1 =
    factorLabels?.factor1 && cell[factorLabels.factor1] !== undefined
      ? cell[factorLabels.factor1]
      : undefined
  const labeledFactor2 =
    factorLabels?.factor2 && cell[factorLabels.factor2] !== undefined
      ? cell[factorLabels.factor2]
      : undefined
  if (labeledFactor1 !== undefined && labeledFactor2 !== undefined) {
    return {
      [factorLabels!.factor1]: String(labeledFactor1),
      [factorLabels!.factor2]: String(labeledFactor2),
    }
  }

  // Third priority: parse from cell_label (fallback)
  const label = typeof cell.cell_label === 'string' ? cell.cell_label : ''
  if (!label) return null

  const factor1Name = factorLabels?.factor1 ?? 'factor1'
  const factor2Name = factorLabels?.factor2 ?? 'factor2'

  if (/\s+[xX]\s+/.test(label)) {
    const parts = label
      .split(/\s+[xX]\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length >= 2) {
      return {
        [factor1Name]: parts[0] ?? '',
        [factor2Name]: parts[1] ?? '',
      }
    }
  }

  const factors: Record<string, string> = {}
  label
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const [key, value] = part.split('=').map((segment) => segment.trim())
      if (key && value) {
        factors[key] = value
      }
    })

  return Object.keys(factors).length > 0 ? factors : null
}

function buildGroupedBarFromCellSummaries(
  result: TestResult,
  opts: { errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none' } = {}
): {
  data: unknown[]
  layout: unknown
  stats: Record<string, number | string>
} | null {
  const resultData = getResultData(result)
  const errorBarType = opts.errorBarType ?? 'se'
  const summarySource = resolveCellSummarySource(resultData)
  const summaries = summarySource?.summaries
  const meansType = summarySource?.meansType ?? 'unknown'
  const normalizedErrorBarType =
    meansType === 'lsmean' && (errorBarType === 'sd' || errorBarType === 'iqr')
      ? 'se'
      : errorBarType
  const normalizedTestId = normalizeTestId(result.testId)
  const statsSource =
    typeof result.statistics === 'object' && result.statistics !== null
      ? (result.statistics as Record<string, unknown>)
      : null
  const pooledMs =
    toNumber((resultData as Record<string, unknown>)?.ms_within) ??
    toNumber((resultData as Record<string, unknown>)?.residual_ms) ??
    toNumber((resultData as Record<string, unknown>)?.ms_residual) ??
    toNumber((resultData as Record<string, unknown>)?.mse) ??
    (statsSource ? toNumber(statsSource.ms_within ?? statsSource.residual_ms ?? statsSource.ms_residual ?? statsSource.mse) : null)
  const usePooledSe =
    (normalizedTestId === 'anova_two_way' || normalizedTestId === 'multifactorial_anova') &&
    meansType === 'cell_mean' &&
    normalizedErrorBarType === 'se' &&
    pooledMs !== null

  if (!Array.isArray(summaries) || summaries.length === 0) {
    return null
  }

  const factorNames = getFactorNamesFromResult(resultData)
  const factorLabels =
    factorNames.length >= 2 ? { factor1: factorNames[0] ?? 'factor1', factor2: factorNames[1] ?? 'factor2' } : undefined

  const firstFactors = parseCellFactors(summaries[0] as Record<string, unknown>, factorLabels)
  if (!firstFactors) return null
  const factorKeys = Object.keys(firstFactors)
  if (factorKeys.length < 2) return null

  const factorAKey = factorKeys[0] ?? 'Factor A'
  const factorBKey = factorKeys[1] ?? 'Factor B'

  const xValues: string[] = []
  const groupValues: string[] = []
  const yValues: number[] = []
  const errorValues: Array<number | null> = []
  const useMedian = normalizeTestId(result.testId) === 'scheirer_ray_hare' || meansType === 'median'

  summaries.forEach((cell) => {
    const factors = parseCellFactors(cell as Record<string, unknown>, factorLabels)
    if (!factors) return
    const record = cell as Record<string, unknown>
    const rawValue = useMedian
      ? record.median ?? record.mean
      : record.emmean ?? record.mean ?? record.median
    const value = toNumber(rawValue)
    if (value === null) return
    const a = factors[factorAKey]
    const b = factors[factorBKey]
    if (!a || !b) return
    const n = Number(record.n ?? record.count ?? 0)
    const errorValue = usePooledSe && n > 0
      ? Math.sqrt(pooledMs! / n)
      : resolveCellErrorValue(record, normalizedErrorBarType)
    xValues.push(a)
    groupValues.push(b)
    yValues.push(value)
    errorValues.push(errorValue)
  })

  if (xValues.length === 0) return null

  const builder = getPlotBuilder('grouped_bar')
  const yLabel = meansType === 'lsmean' ? 'Predicted Mean' : useMedian ? 'Median' : 'Mean'
  const yColumnId = meansType === 'lsmean' ? 'emmean' : useMedian ? 'median' : 'mean'
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: factorAKey,
        columnName: factorAKey,
        values: xValues,
        inferredType: 'categorical',
      },
      {
        role: 'group',
        columnId: factorBKey,
        columnName: factorBKey,
        values: groupValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: yColumnId,
        columnName: yLabel,
        values: yValues,
        inferredType: 'numeric',
      },
      ...(errorValues.some((value) => typeof value === 'number' && Number.isFinite(value))
        ? [
            {
              role: 'error' as const,
              columnId: 'error',
              columnName: 'Error',
              values: errorValues.map((value) =>
                typeof value === 'number' && Number.isFinite(value) ? value : null
              ),
              inferredType: 'numeric' as const,
            },
          ]
        : []),
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: result.testName,
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType: normalizedErrorBarType,
    },
  })
  const layoutBase = (output.layout as { meta?: Record<string, unknown> } | undefined) ?? {}
  const nextLayout = {
    ...layoutBase,
    meta: {
      ...(layoutBase.meta ?? {}),
      meansType,
      isBalanced:
        typeof (resultData.cell_counts as { is_balanced?: boolean } | undefined)?.is_balanced ===
        'boolean'
          ? (resultData.cell_counts as { is_balanced?: boolean }).is_balanced
          : undefined,
      errorBarType: normalizedErrorBarType,
    },
  }

  return { data: output.data, layout: nextLayout, stats: output.stats }
}

function resolveCellErrorValue(
  cell: Record<string, unknown>,
  errorBarType: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
): number | null {
  const se = Number(cell.se ?? cell.sem ?? cell.stderr)
  const std = Number(cell.std)
  const n = Number(cell.n ?? cell.count)
  const ciLower = Number(cell.ci_lower ?? cell.ci_95_lower)
  const ciUpper = Number(cell.ci_upper ?? cell.ci_95_upper)
  const q1 = Number(cell.q1)
  const q3 = Number(cell.q3)
  const iqrValue = Number(cell.iqr)

  if (errorBarType === 'sd' && Number.isFinite(std)) {
    return std
  }
  if (errorBarType === 'ci' && Number.isFinite(ciLower) && Number.isFinite(ciUpper)) {
    return (ciUpper - ciLower) / 2
  }
  if (errorBarType === 'iqr') {
    if (Number.isFinite(iqrValue)) {
      return iqrValue / 2
    }
    if (Number.isFinite(q1) && Number.isFinite(q3)) {
      return (q3 - q1) / 2
    }
  }
  if (Number.isFinite(se)) {
    return se
  }
  if (Number.isFinite(std) && Number.isFinite(n) && n > 0) {
    return std / Math.sqrt(n)
  }
  return null
}

function buildBarFromCellSummaries(
  result: TestResult,
  opts: {
    title?: string
    errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
    bracketSettings?: BracketSettings
  } = {}
): PlotSpecWithStats | null {
  const normalizedTestId = normalizeTestId(result.testId)
  const resultData = getResultData(result)
  const errorBarType = opts.errorBarType ?? 'se'
  const groupSummaries = Array.isArray(resultData.group_summaries)
    ? (resultData.group_summaries as Record<string, unknown>[])
    : null

  if (groupSummaries && groupSummaries.length > 0) {
    const statsSource =
      typeof result.statistics === 'object' && result.statistics !== null
        ? (result.statistics as Record<string, unknown>)
        : null
    const pooledMs =
      toNumber((resultData as Record<string, unknown>)?.ms_within) ??
      toNumber((resultData as Record<string, unknown>)?.residual_ms) ??
      toNumber((resultData as Record<string, unknown>)?.ms_residual) ??
      toNumber((resultData as Record<string, unknown>)?.mse) ??
      (statsSource
        ? toNumber(statsSource.ms_within ?? statsSource.residual_ms ?? statsSource.ms_residual ?? statsSource.mse)
        : null)
    const usePooledSe = normalizedTestId === 'anova_one_way' && errorBarType === 'se' && pooledMs !== null
    const factorKey =
      typeof resultData.group_column === 'string'
        ? resultData.group_column
        : typeof resultData.grouping_variable === 'string'
          ? resultData.grouping_variable
          : 'Group'
    const categories: string[] = []
    const means: number[] = []
    const errors: Array<number | null> = []

    groupSummaries.forEach((summary, index) => {
      const label =
        typeof summary.label === 'string'
          ? summary.label
          : typeof summary.group === 'string'
            ? summary.group
            : `Group ${index + 1}`
      const mean = toNumber(summary.mean)
      if (mean === null) return
      categories.push(label)
      means.push(mean)
      if (usePooledSe) {
        const n = Number(summary.n ?? summary.count ?? summary.N ?? 0)
        errors.push(n > 0 ? Math.sqrt(pooledMs! / n) : null)
      } else {
        errors.push(resolveCellErrorValue(summary, errorBarType))
      }
    })

    if (categories.length === 0) return null

    let brackets: SignificanceBracket[] | undefined
    if (opts.bracketSettings) {
      brackets = extractPostHocBrackets(result, opts.bracketSettings)
    }

    const builder = getPlotBuilder('bar')
    const output = builder({
      source: 'test_result',
      testResult: result,
      columns: [
        {
          role: 'x',
          columnId: factorKey,
          columnName: factorKey,
          values: categories,
          inferredType: 'categorical',
        },
        {
          role: 'y',
          columnId: 'mean',
          columnName: 'Mean',
          values: means,
          inferredType: 'numeric',
        },
        ...(errors.some((value) => typeof value === 'number' && Number.isFinite(value))
          ? [
              {
                role: 'error' as const,
                columnId: 'error',
                columnName: 'Error',
                values: errors.map((value) => (typeof value === 'number' ? value : null)),
                inferredType: 'numeric' as const,
              },
            ]
          : []),
      ],
      dataPolicy: 'aggregated',
      samplingConfig: null,
      aggregationConfig: null,
      options: {
        title: opts.title ?? result.testName,
        showLegend: false,
        showGrid: true,
        colorPalette: DEFAULT_COLORS,
        errorBarType,
        bracketSettings: opts.bracketSettings,
        brackets,
      },
    })

    const testFamily = mapFamily(result.family)
    const statisticsFamilyId =
      result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

    const stats = {
      ...extractNumericStats(result.statistics),
      ...extractNumericStats(result.modelFit),
      ...output.stats,
    }

    const plot = createTestResultPlotSpec({
      id: `plot-${result.id}`,
      type: 'bar',
      title: opts.title ?? result.testName,
      statisticsFamilyId,
      resultId: result.id,
      testType: result.testId,
      testFamily,
      plotlyData: output.data,
      plotlyLayout: output.layout,
      plotlyConfig: output.config,
      dataPolicy: output.dataPolicy,
      samplingConfig: output.samplingConfig,
      aggregationConfig: output.aggregationConfig,
    })

    return { plot, stats }
  }

  const summaries =
    (resultData.cell_summaries as unknown[] | undefined) ??
    (resultData.cell_means as unknown[] | undefined)

  if (!Array.isArray(summaries) || summaries.length === 0) {
    return null
  }

  const firstFactors = parseCellFactors(summaries[0] as Record<string, unknown>)
  if (!firstFactors) return null
  const factorKeys = Object.keys(firstFactors)
  if (factorKeys.length !== 1) return null

  const factorKey = factorKeys[0] ?? 'Factor'
  const categories: string[] = []
  const means: number[] = []
  const errors: Array<number | null> = []

  for (const cell of summaries) {
    const record = cell as Record<string, unknown>
    const factors = parseCellFactors(record)
    if (!factors) continue
    const label = factors[factorKey]
    if (!label) continue
    const mean = Number(record.mean)
    if (!Number.isFinite(mean)) continue
    categories.push(label)
    means.push(mean)
    errors.push(resolveCellErrorValue(record, errorBarType))
  }

  if (categories.length === 0) return null

  let brackets: SignificanceBracket[] | undefined
  if (opts.bracketSettings) {
    brackets = extractPostHocBrackets(result, opts.bracketSettings)
  }

  const builder = getPlotBuilder('bar')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: factorKey,
        columnName: factorKey,
        values: categories,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'mean',
        columnName: 'Mean',
        values: means,
        inferredType: 'numeric',
      },
      ...(errors.some((value) => typeof value === 'number' && Number.isFinite(value))
        ? [
            {
              role: 'error' as const,
              columnId: 'error',
              columnName: 'Error',
              values: errors.map((value) => (typeof value === 'number' ? value : null)),
              inferredType: 'numeric' as const,
            },
          ]
        : []),
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      showLegend: false,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType,
      bracketSettings: opts.bracketSettings,
      brackets,
    },
  })

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...output.stats,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}`,
    type: 'bar',
    title: opts.title ?? result.testName,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: output.layout,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  return { plot, stats }
}

function tryConvertBoxToBar(
  plotlyData: Array<Record<string, unknown>>
): { data: unknown[]; layout: unknown } | null {
  if (plotlyData.length === 0) return null
  const hasBox = plotlyData.some((trace) => trace.type === 'box')
  if (!hasBox) return null

  const labels: string[] = []
  const means: number[] = []
  const ses: number[] = []
  const colors: Array<string | number> = []

  for (const trace of plotlyData) {
    const values = Array.isArray(trace.y) ? trace.y.filter((v) => typeof v === 'number') as number[] : []
    if (values.length === 0) continue
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const variance =
      values.length > 1
        ? values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1)
        : 0
    const se = Math.sqrt(variance) / Math.sqrt(values.length)

    labels.push(String(trace.name ?? `Group ${labels.length + 1}`))
    means.push(mean)
    ses.push(se)
    if (trace.marker && typeof trace.marker === 'object') {
      const marker = trace.marker as { color?: string | number }
      if (marker.color !== undefined) {
        colors.push(marker.color)
      }
    }
  }

  if (labels.length === 0) return null

  return {
    data: [
      {
        type: 'bar',
        x: labels,
        y: means,
        marker: { color: colors.length === labels.length ? colors : undefined },
        error_y: {
          type: 'data',
          array: ses,
          visible: true,
          color: '#333',
          thickness: 1.5,
          width: 4,
        },
      },
    ],
    layout: {},
  }
}

// ❌ MOVED TO common/stats.ts
/*
function extractNumericStats(source: unknown, prefix = ''): Record<string, number> {
  const stats: Record<string, number> = {}
  if (!source || typeof source !== 'object') return stats

  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const nextKey = prefix ? `${prefix}_${key}` : key
    if (typeof value === 'number' && !Number.isNaN(value)) {
      stats[nextKey] = value
    } else if (value && typeof value === 'object') {
      Object.assign(stats, extractNumericStats(value, nextKey))
    }
  }
  return stats
}
*/

// ❌ MOVED TO common/stats.ts
/*
/**
 * Extract plot-specific stats from Plotly trace data
 * Ensures E2E tests can validate group_count, n, mean, std from plots
 *\/
function extractStatsFromPlotlyData(data: Data[]): Record<string, number> {
  const stats: Record<string, number> = {}

  // Count groups (unique traces by default)
  let groupCount = data.length
  const traceTypes = new Set(
    data.map((trace) => (trace as { type?: string }).type).filter((t): t is string => Boolean(t))
  )
  if (data.length === 1) {
    if (traceTypes.has('bar')) {
      const barTrace = data[0] as { x?: unknown[]; y?: unknown[] }
      if (Array.isArray(barTrace.x) && barTrace.x.length > 0) {
        groupCount = barTrace.x.length
      } else if (Array.isArray(barTrace.y) && barTrace.y.length > 0) {
        groupCount = barTrace.y.length
      }
    } else if (traceTypes.has('box') || traceTypes.has('violin')) {
      const trace = data[0] as { x?: unknown[] }
      if (Array.isArray(trace.x) && trace.x.length > 0) {
        const uniqueGroups = new Set(trace.x.map((value) => String(value)))
        groupCount = uniqueGroups.size
      }
    }
  }
  stats.group_count = groupCount

  // Count total points and collect all values
  const allPoints: number[] = []
  for (const trace of data) {
    const traceData = trace as { y?: unknown[]; x?: unknown[] }
    const values = (traceData.y ?? traceData.x ?? []).filter(
      (v): v is number => typeof v === 'number'
    )
    allPoints.push(...values)
  }

  stats.n = allPoints.length

  // Compute mean, std
  if (allPoints.length > 0) {
    const { mean, std } = calculateMeanSE(allPoints)
    stats.value_mean = mean
    stats.value_std = std
  }

  return stats
}
*/

// ============================================================================
// PLOT BUILDER HELPERS (PHASE B)
// ============================================================================
// The functions below are plot builders and will be moved to ./plotResult/builders/ in Phase B

/**
 * Build box plot from test result
 */
function buildBoxPlotFromResult(
  result: TestResult,
  opts: { showJitter?: boolean; title?: string } = {}
): PlotSpecWithStats | null {
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  // Try to use plotlyJson if available
  const plotlyJson = result.visualizations?.plotlyJson
  if (plotlyJson) {
    let parsed: { data?: Data[]; layout?: unknown; config?: unknown }
    try {
      parsed =
        typeof plotlyJson === 'string'
          ? JSON.parse(plotlyJson)
          : (plotlyJson as { data?: Data[]; layout?: unknown; config?: unknown })
    } catch {
      return null
    }

    const hasBox = parsed.data?.some((trace) => (trace as { type?: string }).type === 'box')
    if (hasBox && parsed.data) {
      // Modify box traces to add jitter if requested
      let data = parsed.data
      if (opts.showJitter) {
        data = parsed.data.map((trace) => {
          const t = trace as { type?: string; boxpoints?: string | boolean; jitter?: number; pointpos?: number }
          if (t.type === 'box') {
            return {
              ...trace,
              boxpoints: 'all',
              jitter: 0.3,
              pointpos: -1.8,
            }
          }
          return trace
        })
      }

      const stats = {
        ...extractNumericStats(result.statistics),
        ...extractNumericStats(result.modelFit),
        ...extractStatsFromPlotlyData(data),
      }

      const plot = createTestResultPlotSpec({
        id: `plot-${result.id}`,
        type: 'box',
        title: opts.title ?? result.testName,
        statisticsFamilyId,
        resultId: result.id,
        testType: result.testId,
        testFamily,
        plotlyData: data,
        plotlyLayout: parsed.layout ?? {},
        plotlyConfig: (parsed.config ?? {}) as Partial<import('plotly.js').Config>,
        dataPolicy: 'raw',
        samplingConfig: null,
        aggregationConfig: null,
      })

      return { plot, stats }
    }
  }

  const payloadSeries = buildPayloadSeries(result)
  if (payloadSeries) {
    const builder = getPlotBuilder('box')
    const columns = [
      ...(payloadSeries.groupValues
        ? [
            {
              role: 'group' as const,
              columnId: 'group',
              columnName: payloadSeries.groupLabel ?? 'Group',
              values: payloadSeries.groupValues,
              inferredType: 'categorical' as const,
            },
          ]
        : []),
      {
        role: 'y' as const,
        columnId: 'value',
        columnName: payloadSeries.yLabel,
        values: payloadSeries.yValues,
        inferredType: 'numeric' as const,
      },
    ]

    const output = builder({
      source: 'test_result',
      testResult: result,
      columns,
      dataPolicy: 'raw',
      samplingConfig: null,
      aggregationConfig: null,
      options: {
        title: opts.title ?? result.testName,
        showLegend: Boolean(payloadSeries.groupValues),
        showGrid: true,
        colorPalette: DEFAULT_COLORS,
        showJitter: opts.showJitter ?? false,
        jitterAmount: 0.3,
        pointPosition: -1.8,
      },
    })

    const stats = {
      ...extractNumericStats(result.statistics),
      ...extractNumericStats(result.modelFit),
      ...output.stats,
    }

    const plot = createTestResultPlotSpec({
      id: `plot-${result.id}`,
      type: 'box',
      title: opts.title ?? result.testName,
      statisticsFamilyId,
      resultId: result.id,
      testType: result.testId,
      testFamily,
      plotlyData: output.data,
      plotlyLayout: output.layout,
      plotlyConfig: output.config,
      dataPolicy: output.dataPolicy,
      samplingConfig: output.samplingConfig,
      aggregationConfig: output.aggregationConfig,
    })

    return { plot, stats }
  }

  // Fallback: Call builder (may yield placeholder if no data)
  const builder = getPlotBuilder('box')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [],
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      showJitter: opts.showJitter ?? false,
      jitterAmount: 0.3,
      pointPosition: -1.8,
    },
  })

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...output.stats,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}`,
    type: 'box',
    title: opts.title ?? result.testName,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: output.layout,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  return { plot, stats }
}

/**
 * Build violin plot from test result
 */
function buildViolinPlotFromResult(
  result: TestResult,
  opts: { showJitter?: boolean; title?: string } = {}
): PlotSpecWithStats | null {
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  // Try to use plotlyJson if available
  const plotlyJson = result.visualizations?.plotlyJson
  if (plotlyJson) {
    let parsed: { data?: Data[]; layout?: unknown; config?: unknown }
    try {
      parsed =
        typeof plotlyJson === 'string'
          ? JSON.parse(plotlyJson)
          : (plotlyJson as { data?: Data[]; layout?: unknown; config?: unknown })
    } catch {
      return null
    }

    const hasViolin = parsed.data?.some((trace) => (trace as { type?: string }).type === 'violin')
    if (hasViolin && parsed.data) {
      // Modify violin traces to add jitter if requested
      let data = parsed.data
      if (opts.showJitter) {
        data = parsed.data.map((trace) => {
          const t = trace as { type?: string; points?: string | boolean; jitter?: number; pointpos?: number }
          if (t.type === 'violin') {
            return {
              ...trace,
              points: 'all',
              jitter: 0.3,
              pointpos: -1.8, // Offset for visible jitter points
            }
          }
          return trace
        })
      }

      const stats = {
        ...extractNumericStats(result.statistics),
        ...extractNumericStats(result.modelFit),
        ...extractStatsFromPlotlyData(data),
      }

      const plot = createTestResultPlotSpec({
        id: `plot-${result.id}`,
        type: 'violin',
        title: opts.title ?? result.testName,
        statisticsFamilyId,
        resultId: result.id,
        testType: result.testId,
        testFamily,
        plotlyData: data,
        plotlyLayout: parsed.layout ?? {},
        plotlyConfig: (parsed.config ?? {}) as Partial<import('plotly.js').Config>,
        dataPolicy: 'raw',
        samplingConfig: null,
        aggregationConfig: null,
      })

      return { plot, stats }
    }
  }

  const payloadSeries = buildPayloadSeries(result)
  if (payloadSeries) {
    const builder = getPlotBuilder('violin')
    const columns = [
      ...(payloadSeries.groupValues
        ? [
            {
              role: 'group' as const,
              columnId: 'group',
              columnName: payloadSeries.groupLabel ?? 'Group',
              values: payloadSeries.groupValues,
              inferredType: 'categorical' as const,
            },
          ]
        : []),
      {
        role: 'y' as const,
        columnId: 'value',
        columnName: payloadSeries.yLabel,
        values: payloadSeries.yValues,
        inferredType: 'numeric' as const,
      },
    ]

    const output = builder({
      source: 'test_result',
      testResult: result,
      columns,
      dataPolicy: 'raw',
      samplingConfig: null,
      aggregationConfig: null,
      options: {
        title: opts.title ?? result.testName,
        showLegend: Boolean(payloadSeries.groupValues),
        showGrid: true,
        colorPalette: DEFAULT_COLORS,
        showJitter: opts.showJitter ?? false,
        jitterAmount: 0.3,
        pointPosition: -1.8,
      },
    })

    const stats = {
      ...extractNumericStats(result.statistics),
      ...extractNumericStats(result.modelFit),
      ...output.stats,
    }

    const plot = createTestResultPlotSpec({
      id: `plot-${result.id}`,
      type: 'violin',
      title: opts.title ?? result.testName,
      statisticsFamilyId,
      resultId: result.id,
      testType: result.testId,
      testFamily,
      plotlyData: output.data,
      plotlyLayout: output.layout,
      plotlyConfig: output.config,
      dataPolicy: output.dataPolicy,
      samplingConfig: output.samplingConfig,
      aggregationConfig: output.aggregationConfig,
    })

    return { plot, stats }
  }

  // Fallback: Call builder
  const builder = getPlotBuilder('violin')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [],
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      showJitter: opts.showJitter ?? false,
      jitterAmount: 0.3,
      pointPosition: -1.8, // Offset for visible jitter points
    },
  })

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...output.stats,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}`,
    type: 'violin',
    title: opts.title ?? result.testName,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: output.layout,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  return { plot, stats }
}

/**
 * Build histogram from test result
 */
function buildHistogramFromResult(
  result: TestResult,
  opts: { title?: string; bins?: number; showDensityCurve?: boolean } = {}
): PlotSpecWithStats | null {
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const plotlyJson = result.visualizations?.plotlyJson
  if (plotlyJson) {
    let parsed: { data?: Data[]; layout?: unknown; config?: unknown }
    try {
      parsed =
        typeof plotlyJson === 'string'
          ? JSON.parse(plotlyJson)
          : (plotlyJson as { data?: Data[]; layout?: unknown; config?: unknown })
    } catch {
      return null
    }

    const hasHistogram = parsed.data?.some(
      (trace) => (trace as { type?: string }).type === 'histogram'
    )
    if (hasHistogram && parsed.data) {
      const stats = {
        ...extractNumericStats(result.statistics),
        ...extractNumericStats(result.modelFit),
        ...extractStatsFromPlotlyData(parsed.data),
      }

      const plot = createTestResultPlotSpec({
        id: `plot-${result.id}`,
        type: 'histogram',
        title: opts.title ?? result.testName,
        statisticsFamilyId,
        resultId: result.id,
        testType: result.testId,
        testFamily,
        plotlyData: parsed.data,
        plotlyLayout: parsed.layout ?? {},
        plotlyConfig: (parsed.config ?? {}) as Partial<import('plotly.js').Config>,
        dataPolicy: 'raw',
        samplingConfig: null,
        aggregationConfig: null,
      })

      return { plot, stats }
    }
  }

  const payloadSeries = buildPayloadSeries(result)
  if (payloadSeries) {
    const builder = getPlotBuilder('histogram')
    const output = builder({
      source: 'test_result',
      testResult: result,
      columns: [
        {
          role: 'y',
          columnId: 'value',
          columnName: payloadSeries.yLabel,
          values: payloadSeries.yValues,
          inferredType: 'numeric',
        },
      ],
      dataPolicy: 'raw',
      samplingConfig: null,
      aggregationConfig: null,
      options: {
        title: opts.title ?? result.testName,
        showLegend: false,
        showGrid: true,
        colorPalette: DEFAULT_COLORS,
        histogramBins: opts.bins ?? 30,
        showDensityCurve: opts.showDensityCurve,
      },
    })

    const stats = {
      ...extractNumericStats(result.statistics),
      ...extractNumericStats(result.modelFit),
      ...output.stats,
    }

    const plot = createTestResultPlotSpec({
      id: `plot-${result.id}`,
      type: 'histogram',
      title: opts.title ?? result.testName,
      statisticsFamilyId,
      resultId: result.id,
      testType: result.testId,
      testFamily,
      plotlyData: output.data,
      plotlyLayout: output.layout,
      plotlyConfig: output.config,
      dataPolicy: output.dataPolicy,
      samplingConfig: output.samplingConfig,
      aggregationConfig: output.aggregationConfig,
    })

    return { plot, stats }
  }

  // Fallback: Call builder
  const builder = getPlotBuilder('histogram')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [],
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      showLegend: false,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      histogramBins: opts.bins ?? 30,
      showDensityCurve: opts.showDensityCurve,
    },
  })

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...output.stats,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}`,
    type: 'histogram',
    title: opts.title ?? result.testName,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: output.layout,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  return { plot, stats }
}

/**
 * Build column scatter plot from test result
 */
function buildColumnScatterFromResult(
  result: TestResult,
  opts: {
    title?: string
    errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
    showMeanLine?: boolean
    pointJitterX?: number
    pointSize?: number
  } = {}
): PlotSpecWithStats | null {
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const payloadSeries = buildPayloadSeries(result)
  if (!payloadSeries) return null

  const columns: PlotColumn[] = [
    {
      role: 'y',
      columnId: 'value',
      columnName: payloadSeries.yLabel,
      values: payloadSeries.yValues,
      inferredType: 'numeric',
    },
  ]

  if (payloadSeries.groupValues) {
    columns.unshift({
      role: 'group',
      columnId: 'group',
      columnName: payloadSeries.groupLabel ?? 'Group',
      values: payloadSeries.groupValues,
      inferredType: 'categorical',
    })
  }

  const builder = getPlotBuilder('column_scatter')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      showLegend: Boolean(payloadSeries.groupValues),
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType: opts.errorBarType ?? 'se',
      showMeanLine: opts.showMeanLine ?? true,
      pointJitterX: opts.pointJitterX,
      pointSize: opts.pointSize,
    },
  })

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...output.stats,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}`,
    type: 'column_scatter',
    title: opts.title ?? result.testName,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: output.layout,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  return { plot, stats }
}

/**
 * Build box/violin plots for independent t-test from raw group values
 * Includes significance brackets showing p-value between groups
 */
function buildIndependentTTestPlots(
  result: TestResult,
  plotType: 'box' | 'violin',
  opts: { showJitter?: boolean; bracketSettings?: BracketSettings; title?: string } = {}
): PlotSpecWithStats | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null

  const data = payload.data
  const group1Raw = toNumberArray(data.group1 ?? data.data1)
  const group2Raw = toNumberArray(data.group2 ?? data.data2)

  if (group1Raw.length === 0 && group2Raw.length === 0) return null

  const fallbackNames = resolveGroupNames(payload, 2)
  const group1Name =
    typeof data.group1_name === 'string'
      ? data.group1_name
      : typeof data.group_name1 === 'string'
        ? data.group_name1
        : fallbackNames[0] ?? 'Group 1'
  const group2Name =
    typeof data.group2_name === 'string'
      ? data.group2_name
      : typeof data.group_name2 === 'string'
        ? data.group_name2
        : fallbackNames[1] ?? 'Group 2'
  const valueLabel = resolveValueLabel(payload, 'Value')
  const groupLabel = resolveGroupLabel(payload, 'Group')

  const { mean: mean1 } = calculateMeanSE(group1Raw)
  const { mean: mean2 } = calculateMeanSE(group2Raw)
  const group1Quartiles = calculateQuartiles(group1Raw)
  const group2Quartiles = calculateQuartiles(group2Raw)

  // Build arrays for plot builder (same as Mann-Whitney pattern)
  const yValues = [...group1Raw, ...group2Raw]
  const groupValues = [
    ...Array(group1Raw.length).fill(group1Name),
    ...Array(group2Raw.length).fill(group2Name),
  ]

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const builder = getPlotBuilder(plotType)
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'group',
        columnId: 'group',
        columnName: groupLabel,
        values: groupValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'value',
        columnName: valueLabel,
        values: yValues,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      showJitter: opts.showJitter ?? false,
      title: opts.title ?? result.testName,
      showLegend: false,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
  })

  // Apply significance brackets if provided
  let layout = output.layout
  let config = output.config
  let stats = output.stats

  const bracketSettings = opts.bracketSettings
  if (bracketSettings) {
    const resultData = getResultData(result)
    const { pValue } = resolveIndependentTTestPrimaryPValue(resultData)
    const pValueText =
      typeof resultData.p_value_text === 'string' ? resultData.p_value_text : undefined

    if (pValue !== null) {
      const brackets: SignificanceBracket[] = [
        {
          group1: group1Name,
          group2: group2Name,
          pValue,
          pValueText,
          label: getBracketLabel(pValue, bracketSettings) ?? '',
          height: 0,
        },
      ]

      // Calculate yMin/yMax from actual data
      const yMax = Math.max(...yValues)
      const yMin = Math.min(...yValues)

      const categoryOrder = new Map([
        [group1Name, 0],
        [group2Name, 1],
      ])
      const stackedBrackets = stackBrackets(brackets, bracketSettings, categoryOrder)
      const adjustedBrackets = repelBracketLayout(
        stackedBrackets,
        bracketSettings,
        yMin,
        yMax
      )

      const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
      const maxHeight = Math.max(0, ...adjustedBrackets.map((bracket) => bracket.height))

      const bracketPad = yScale * 0.08

      const shapes = createBracketShapes(
        adjustedBrackets,
        bracketSettings,
        yMax,
        yScale,
        categoryOrder,
        { yMin, yMax }
      )

      const labeledBrackets = adjustedBrackets
        .map((bracket) => ({ bracket, label: formatBracketLabel(bracket, bracketSettings) }))
        .filter((entry) => Boolean(entry.label))
      const effectMap: Record<string, BracketEffectMeta> = {}
      const effectShapes: Record<string, string[]> = {}
      labeledBrackets.forEach(({ bracket }, index) => {
        const effectId = bracket.effectId ?? `effect-${index}`
        const significant = isBracketSignificant(bracket.pValue, bracketSettings)
        if (!effectMap[effectId]) {
          effectMap[effectId] = {
            label: bracket.effectLabel ?? bracket.label ?? `Bracket ${index + 1}`,
            group: bracket.effectGroup ?? 'main',
            significant,
          }
        } else if (significant) {
          effectMap[effectId] = {
            ...effectMap[effectId],
            significant: true,
          }
        }
        const shapeName = `sig_bracket_${index}`
        effectShapes[effectId] = [...(effectShapes[effectId] ?? []), shapeName]
      })

      const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}
      const baseYAxis = (layoutBase as { yaxis?: Record<string, unknown> }).yaxis ?? {}
      const rangeMinBase = Math.min(yMin, yMax)
      const rangeMaxBase = Math.max(yMin, yMax)
      const dataSpan = Math.abs(rangeMaxBase - rangeMinBase)
      const dataPad =
        dataSpan > 0 ? dataSpan * 0.05 : Math.max(1, Math.abs(rangeMaxBase) * 0.05)
      const paddedMin = rangeMinBase - dataPad
      const paddedMax = rangeMaxBase + dataPad
      const bracketOffset =
        bracketSettings.offsetY + maxHeight + bracketSettings.heightStep + 0.04
      const bracketY =
        yMax > 0 ? yMax * (1 + bracketOffset) : yMax - yScale * bracketOffset
      const rangeMin = Math.min(paddedMin, bracketY - bracketPad)
      const rangeMax = Math.max(paddedMax, bracketY + bracketPad)

      const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}

      layout = {
        ...layout,
        yaxis: {
          ...baseYAxis,
          range: [rangeMin, rangeMax],
          autorange: false,
        },
        shapes,
        meta: {
          ...currentMeta,
          bracketCatalog: { brackets: adjustedBrackets },
          bracketEffectMap: effectMap,
          bracketEffectShapes: effectShapes,
          bracketVisibility:
            (currentMeta as { bracketVisibility?: Record<string, boolean> }).bracketVisibility ?? {},
          bracketSettings,
        },
      }

      config = {
        ...config,
        displayModeBar: true,
        modeBarButtonsToAdd: ['eraseshape'] as never[],
        edits: {
          shapePosition: true,
          annotationPosition: true,
        },
      }

      // Add bracket stats
      stats = {
        ...stats,
        bracket_p_value: pValue,
        bracket_significant: isBracketSignificant(pValue, bracketSettings) ? 1 : 0,
      }
    }
  }

  stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...stats,
    group1_n: group1Raw.length,
    group1_mean: mean1,
    group1_median: group1Quartiles.median,
    group1_q1: group1Quartiles.q1,
    group1_q3: group1Quartiles.q3,
    group1_min: group1Quartiles.min,
    group1_max: group1Quartiles.max,
    group2_n: group2Raw.length,
    group2_mean: mean2,
    group2_median: group2Quartiles.median,
    group2_q1: group2Quartiles.q1,
    group2_q3: group2Quartiles.q3,
    group2_min: group2Quartiles.min,
    group2_max: group2Quartiles.max,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-${plotType}`,
    type: plotType,
    title: opts.title ?? `${result.testName} - ${plotType === 'box' ? 'Box Plot' : 'Violin Plot'}`,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: layout,
    plotlyConfig: config,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  })

  // Add test-specific stats for Mann-Whitney U
  const testSpecificStats: Record<string, number | string> = {}
  if (result.testId === 'mann_whitney' || result.testId === 'mann_whitney_u') {
    const testData = getResultData(result)
    const uRaw = testData.U_statistic ?? testData.u_statistic
    const uValue = toNumber(uRaw)
    if (typeof uValue === 'number') testSpecificStats.U_statistic = uValue
    else if (typeof uRaw === 'string') testSpecificStats.U_statistic = uRaw
    const zRaw = testData.z_statistic ?? testData.z_score
    const zValue = toNumber(zRaw)
    if (typeof zValue === 'number') testSpecificStats.z_statistic = zValue
    else if (typeof zRaw === 'string') testSpecificStats.z_statistic = zRaw
    const pValue = toNumber(testData.p_value)
    if (typeof pValue === 'number') testSpecificStats.p_value = pValue
    else if (typeof testData.p_value === 'string') testSpecificStats.p_value = testData.p_value
  }

  return { plot, stats: { ...stats, ...testSpecificStats } }
}

/**
 * Build box/violin plots for paired t-test from raw differences
 * Shows distribution of differences (Group1 - Group2)
 * No significance brackets (single distribution, not a comparison)
 */
function buildPairedTTestPlots(
  result: TestResult,
  plotType: 'box' | 'violin',
  opts: { showJitter?: boolean; title?: string } = {}
): PlotSpecWithStats | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null

  const data = payload.data

  // Try to get differences from payload first, otherwise calculate
  let differencesRaw: number[]
  if (data.differences) {
    differencesRaw = toNumberArray(data.differences)
  } else {
    // Fallback: calculate from group1/group2
    differencesRaw = calculateDifferences(data.group1 ?? data.data1, data.group2 ?? data.data2)
  }

  if (differencesRaw.length === 0) return null

  const fallbackNames = resolveGroupNames(payload, 2)
  const group1Name =
    typeof data.group1_name === 'string'
      ? data.group1_name
      : typeof data.group_name1 === 'string'
        ? data.group_name1
        : fallbackNames[0] ?? 'Group 1'
  const group2Name =
    typeof data.group2_name === 'string'
      ? data.group2_name
      : typeof data.group_name2 === 'string'
        ? data.group_name2
        : fallbackNames[1] ?? 'Group 2'
  const diffLabel = `${group1Name} - ${group2Name}`

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const diffQuartiles = calculateQuartiles(differencesRaw)
  const { mean: diffMean } = calculateMeanSE(differencesRaw)

  const builder = getPlotBuilder(plotType)
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'y',
        columnId: 'difference',
        columnName: diffLabel,
        values: differencesRaw,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      showJitter: opts.showJitter ?? false,
      title: opts.title ?? result.testName,
      showLegend: false,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
  })

  const dataWithFixedX = (output.data as Data[]).map((trace) => {
    const t = trace as Data & { type?: string; x?: number[] }
    if (t.type !== 'box' && t.type !== 'violin') return trace
    return {
      ...trace,
      x: differencesRaw.map(() => 0),
    }
  })

  const layoutBase = (output.layout as Partial<Layout>) ?? {}
  const baseXAxis = (layoutBase.xaxis as Partial<Layout['xaxis']>) ?? {}
  const fixedXAxis: Partial<Layout['xaxis']> = {
    ...baseXAxis,
    type: 'linear',
    tickmode: 'array',
    tickvals: [0],
    ticktext: [diffLabel],
    range: [-0.5, 0.5],
    autorange: false,
    tickwidth: typeof baseXAxis.tickwidth === 'number' ? baseXAxis.tickwidth : 4,
    ticklen: typeof baseXAxis.ticklen === 'number' ? baseXAxis.ticklen : 6,
    ticklabelshift:
      typeof baseXAxis.ticklabelshift === 'number' ? baseXAxis.ticklabelshift : 1,
  }

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...output.stats,
    differences_n: differencesRaw.length,
    differences_mean: diffMean,
    differences_median: diffQuartiles.median,
    differences_q1: diffQuartiles.q1,
    differences_q3: diffQuartiles.q3,
    differences_min: diffQuartiles.min,
    differences_max: diffQuartiles.max,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-${plotType}`,
    type: plotType,
    title:
      opts.title ??
      `${result.testName} - ${plotType === 'box' ? 'Box Plot' : 'Violin Plot'} (Differences)`,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: dataWithFixedX,
    plotlyLayout: {
      ...layoutBase,
      xaxis: fixedXAxis,
    },
    plotlyConfig: output.config,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  })

  // Add test-specific stats for Wilcoxon Signed-Rank
  const testSpecificStats: Record<string, number | string> = {}
  if (result.testId === 'wilcoxon' || result.testId === 'wilcoxon_signed_rank') {
    const testData = getResultData(result)
    const wRaw = testData.W_statistic ?? testData.w_statistic
    const wValue = toNumber(wRaw)
    if (typeof wValue === 'number') testSpecificStats.W_statistic = wValue
    else if (typeof wRaw === 'string') testSpecificStats.W_statistic = wRaw
    const zRaw = testData.z_statistic ?? testData.z_score
    const zValue = toNumber(zRaw)
    if (typeof zValue === 'number') testSpecificStats.z_statistic = zValue
    else if (typeof zRaw === 'string') testSpecificStats.z_statistic = zRaw
    const pValue = toNumber(testData.p_value)
    if (typeof pValue === 'number') testSpecificStats.p_value = pValue
    else if (typeof testData.p_value === 'string') testSpecificStats.p_value = testData.p_value
  }

  return { plot, stats: { ...stats, ...testSpecificStats } }
}

/**
 * Build bar plot for independent t-test from raw group values
 * Shows mean +/- SE for two groups with significance bracket
 */
function buildIndependentTTestBarPlot(
  result: TestResult,
  opts: {
    errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
    bracketSettings?: BracketSettings
    title?: string
  } = {}
): PlotSpecWithStats | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null

  const data = payload.data
  const group1Raw = toNumberArray(data.group1 ?? data.data1)
  const group2Raw = toNumberArray(data.group2 ?? data.data2)

  if (group1Raw.length === 0 && group2Raw.length === 0) return null

  const fallbackNames = resolveGroupNames(payload, 2)
  const group1Name =
    typeof data.group1_name === 'string'
      ? data.group1_name
      : typeof data.group_name1 === 'string'
        ? data.group_name1
        : fallbackNames[0] ?? 'Group 1'
  const group2Name =
    typeof data.group2_name === 'string'
      ? data.group2_name
      : typeof data.group_name2 === 'string'
        ? data.group_name2
        : fallbackNames[1] ?? 'Group 2'
  const valueLabel = resolveValueLabel(payload, 'Value')
  const groupLabel = resolveGroupLabel(payload, 'Group')

  // Calculate mean and error for each group
  const { mean: mean1, se: se1, std: std1 } = calculateMeanSE(group1Raw)
  const { mean: mean2, se: se2, std: std2 } = calculateMeanSE(group2Raw)
  const error1 = calculateErrorBar(group1Raw, opts.errorBarType ?? 'se')
  const error2 = calculateErrorBar(group2Raw, opts.errorBarType ?? 'se')

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  // Create aggregated columns for bar plot builder
  const builder = getPlotBuilder('bar')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: 'group',
        columnName: groupLabel,
        values: [group1Name, group2Name],
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'value',
        columnName: valueLabel,
        values: [mean1, mean2],
        inferredType: 'numeric',
      },
      {
        role: 'error',
        columnId: 'error',
        columnName: 'Error',
        values: [error1, error2],
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      errorBarType: opts.errorBarType ?? 'se',
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      bargap: 0.7,  // Independent t-test bar spacing (narrower than default 0.6)
      bracketSettings: opts.bracketSettings,
      splitTraces: true, // one trace per category for independent color/pattern control
    },
  })

  // Apply significance brackets if provided
  let layout = output.layout
  let config = output.config
  let stats = output.stats

  if (opts.bracketSettings) {
    const resultData = getResultData(result)
    const { pValue } = resolveIndependentTTestPrimaryPValue(resultData)
    const pValueText =
      typeof resultData.p_value_text === 'string' ? resultData.p_value_text : undefined

    if (pValue !== null) {
      const brackets: SignificanceBracket[] = [
        {
          group1: group1Name,
          group2: group2Name,
          pValue,
          pValueText,
          label: getBracketLabel(pValue, opts.bracketSettings) ?? '',
          height: 0,
        },
      ]

      // Calculate yMin/yMax from mean +/- error
      const yMax = Math.max(mean1 + error1, mean2 + error2)
      const yMin = Math.min(mean1 - error1, mean2 - error2)

      const categoryOrder = new Map([
        [group1Name, 0],
        [group2Name, 1],
      ])
      const stackedBrackets = stackBrackets(brackets, opts.bracketSettings, categoryOrder)
      const adjustedBrackets = repelBracketLayout(
        stackedBrackets,
        opts.bracketSettings,
        yMin,
        yMax
      )

      const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}

      const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
      const maxHeight = Math.max(0, ...adjustedBrackets.map((bracket) => bracket.height))
      const bracketPad = yScale * 0.08

      const direction = yMin >= 0 ? 1 : yMax <= 0 ? -1 : 1
      const alignOffset = yScale * opts.bracketSettings.offsetY
      const bracketBase = direction > 0 ? yMax - alignOffset : yMax + alignOffset
      const bracketY = direction > 0 ? yMax + yScale * maxHeight : yMax - yScale * maxHeight

      const shapes = createBracketShapes(
        adjustedBrackets,
        opts.bracketSettings,
        bracketBase,
        yScale,
        categoryOrder,
        { yMin, yMax }
      )

      const baseYAxis = (layoutBase as { yaxis?: Record<string, unknown> }).yaxis ?? {}
      const rangeMinBase = Math.min(yMin, yMax)
      const rangeMaxBase = Math.max(yMin, yMax)
      const rangeMin = Math.min(0, rangeMinBase, bracketY - bracketPad)
      const rangeMax = Math.max(0, rangeMaxBase, bracketY + bracketPad)

      const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}

      layout = {
        ...layout,
        yaxis: {
          ...baseYAxis,
          range: [rangeMin, rangeMax],
          autorange: false,
        },
        shapes,
        meta: {
          ...currentMeta,
          bracketCatalog: { brackets: adjustedBrackets },
          bracketSettings: opts.bracketSettings,
        },
      }

      config = {
        ...config,
        displayModeBar: true,
        modeBarButtonsToAdd: ['eraseshape'] as never[],
        edits: {
          shapePosition: true,
          annotationPosition: true,
        },
      }

      // Add bracket stats
      stats = {
        ...stats,
        bracket_p_value: pValue,
        bracket_significant: isBracketSignificant(pValue, opts.bracketSettings) ? 1 : 0,
      }
    }
  }

  // Add group stats
  stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...stats,
    group1_mean: mean1,
    group1_se: se1,
    group1_sd: std1,
    group1_n: group1Raw.length,
    group2_mean: mean2,
    group2_se: se2,
    group2_sd: std2,
    group2_n: group2Raw.length,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-bar`,
    type: 'bar',
    title: opts.title ?? `${result.testName} - Bar Plot`,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: layout,
    plotlyConfig: config,
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
  })

  return { plot, stats }
}

/**
 * Build column scatter for independent t-test (mean-based, two groups)
 * Shows scattered points for each group + mean lines + error bars + significance bracket
 */
function buildIndependentTTestColumnScatter(
  result: TestResult,
  opts: {
    errorBarType?: 'se' | 'sd' | 'ci' | 'none'
    showMeanLine?: boolean
    pointJitterX?: number
    bracketSettings?: BracketSettings
    title?: string
  } = {}
): PlotSpecWithStats | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null

  const data = payload.data
  const group1Raw = toNumberArray(data.group1 ?? data.data1)
  const group2Raw = toNumberArray(data.group2 ?? data.data2)

  if (group1Raw.length === 0 && group2Raw.length === 0) return null

  const fallbackNames = resolveGroupNames(payload, 2)
  const group1Name =
    typeof data.group1_name === 'string'
      ? data.group1_name
      : typeof data.group_name1 === 'string'
        ? data.group_name1
        : fallbackNames[0] ?? 'Group 1'
  const group2Name =
    typeof data.group2_name === 'string'
      ? data.group2_name
      : typeof data.group_name2 === 'string'
        ? data.group_name2
        : fallbackNames[1] ?? 'Group 2'
  const valueLabel = resolveValueLabel(payload, 'Value')
  const groupLabel = resolveGroupLabel(payload, 'Group')

  // Calculate mean and error for each group
  const { mean: mean1, se: se1, std: std1 } = calculateMeanSE(group1Raw)
  const { mean: mean2, se: se2, std: std2 } = calculateMeanSE(group2Raw)
  const error1 = calculateErrorBar(group1Raw, opts.errorBarType ?? 'se')
  const error2 = calculateErrorBar(group2Raw, opts.errorBarType ?? 'se')

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  // Create columns for column scatter builder
  const groupValues: string[] = []
  const yValues: number[] = []
  for (const val of group1Raw) {
    groupValues.push(group1Name)
    yValues.push(val)
  }
  for (const val of group2Raw) {
    groupValues.push(group2Name)
    yValues.push(val)
  }

  const builder = getPlotBuilder('column_scatter')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'group',
        columnId: 'group',
        columnName: groupLabel,
        values: groupValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'value',
        columnName: valueLabel,
        values: yValues,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      errorBarType: opts.errorBarType ?? 'se',
      showMeanLine: opts.showMeanLine ?? true,
      pointJitterX: opts.pointJitterX ?? 0.05,
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
  })

  // Apply significance brackets if provided
  let layout = output.layout
  let config = output.config
  let stats = output.stats ?? {}

  if (opts.bracketSettings) {
    const resultData = getResultData(result)
    const { pValue } = resolveIndependentTTestPrimaryPValue(resultData)
    const pValueText =
      typeof resultData.p_value_text === 'string' ? resultData.p_value_text : undefined

    if (pValue !== null) {
      const brackets: SignificanceBracket[] = [
        {
          group1: group1Name,
          group2: group2Name,
          pValue,
          pValueText,
          label: getBracketLabel(pValue, opts.bracketSettings) ?? '',
          height: 0,
        },
      ]

      // Calculate yMin/yMax from mean +/- error
      const yMax = Math.max(mean1 + error1, mean2 + error2, ...group1Raw, ...group2Raw)
      const yMin = Math.min(mean1 - error1, mean2 - error2, ...group1Raw, ...group2Raw)

      const categoryOrder = new Map([
        [group1Name, 0],
        [group2Name, 1],
      ])
      const stackedBrackets = stackBrackets(brackets, opts.bracketSettings, categoryOrder)
      const adjustedBrackets = repelBracketLayout(
        stackedBrackets,
        opts.bracketSettings,
        yMin,
        yMax
      )

      const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}

      const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
      const maxHeight = Math.max(0, ...adjustedBrackets.map((bracket) => bracket.height))
      const bracketPad = yScale * 0.08

      const direction = yMin >= 0 ? 1 : yMax <= 0 ? -1 : 1
      const alignOffset = yScale * opts.bracketSettings.offsetY
      const bracketBase = direction > 0 ? yMax - alignOffset : yMax + alignOffset
      const bracketY = direction > 0 ? yMax + yScale * maxHeight : yMax - yScale * maxHeight

      const shapes = createBracketShapes(
        adjustedBrackets,
        opts.bracketSettings,
        bracketBase,
        yScale,
        categoryOrder,
        { yMin, yMax }
      )

      const baseYAxis = (layoutBase as { yaxis?: Record<string, unknown> }).yaxis ?? {}
      const rangeMinBase = Math.min(yMin, yMax)
      const rangeMaxBase = Math.max(yMin, yMax)
      const dataSpan = Math.abs(rangeMaxBase - rangeMinBase)
      const dataPad =
        dataSpan > 0 ? dataSpan * 0.05 : Math.max(1, Math.abs(rangeMaxBase) * 0.05)
      const paddedMin = rangeMinBase - dataPad
      const paddedMax = rangeMaxBase + dataPad
      const rangeMin = Math.min(paddedMin, bracketY - bracketPad)
      const rangeMax = Math.max(paddedMax, bracketY + bracketPad)

      const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}

      layout = {
        ...layoutBase,
        shapes,
        yaxis: {
          ...baseYAxis,
          range: [rangeMin, rangeMax],
          autorange: false,
        },
        meta: {
          ...currentMeta,
          bracketCatalog: { brackets: adjustedBrackets },
          bracketVisibility:
            (currentMeta as { bracketVisibility?: Record<string, boolean> }).bracketVisibility ?? {},
          bracketSettings: opts.bracketSettings,
          errorBarType: opts.errorBarType ?? 'se',
          showMeanLine: opts.showMeanLine ?? true,
        },
      }

      config = {
        ...(config ?? {}),
        displayModeBar: true,
        modeBarButtonsToAdd: ['eraseshape'] as never[],
        edits: {
          shapePosition: true,
          annotationPosition: true,
        },
      }
    }
  }

  // Add group stats
  stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...stats,
    group1_mean: mean1,
    group1_se: se1,
    group1_sd: std1,
    group1_n: group1Raw.length,
    group2_mean: mean2,
    group2_se: se2,
    group2_sd: std2,
    group2_n: group2Raw.length,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-column-scatter`,
    type: 'column_scatter',
    title: opts.title ?? `${result.testName} - Column Scatter`,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: layout,
    plotlyConfig: config,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  })

  return { plot, stats }
}

/**
 * Build column scatter for Mann-Whitney U (median-based, two groups)
 * Shows scattered points for each group + median lines + IQR error bars + significance bracket
 */
function buildMannWhitneyColumnScatter(
  result: TestResult,
  opts: {
    errorBarType?: 'iqr' | 'none'
    showMeanLine?: boolean
    pointJitterX?: number
    bracketSettings?: BracketSettings
    title?: string
  } = {}
): PlotSpecWithStats | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null

  const data = payload.data
  const group1Raw = toNumberArray(data.group1 ?? data.data1 ?? data.data_1)
  const group2Raw = toNumberArray(data.group2 ?? data.data2 ?? data.data_2)

  if (group1Raw.length === 0 && group2Raw.length === 0) return null

  const fallbackNames = resolveGroupNames(payload, 2)
  const group1Name =
    typeof data.group1_name === 'string'
      ? data.group1_name
      : typeof data.group_name1 === 'string'
        ? data.group_name1
        : fallbackNames[0] ?? 'Group 1'
  const group2Name =
    typeof data.group2_name === 'string'
      ? data.group2_name
      : typeof data.group_name2 === 'string'
        ? data.group_name2
        : fallbackNames[1] ?? 'Group 2'
  const valueLabel = resolveValueLabel(payload, 'Value')
  const groupLabel = resolveGroupLabel(payload, 'Group')

  // Calculate median and IQR for each group
  const stats1 = calculateQuartiles(group1Raw)
  const stats2 = calculateQuartiles(group2Raw)
  const median1 = stats1.median
  const median2 = stats2.median
  const iqr1 = stats1.iqr
  const iqr2 = stats2.iqr

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'
  const palette = DEFAULT_COLORS

  // Create columns for column scatter builder
  const groupValues: string[] = []
  const yValues: number[] = []
  for (const val of group1Raw) {
    groupValues.push(group1Name)
    yValues.push(val)
  }
  for (const val of group2Raw) {
    groupValues.push(group2Name)
    yValues.push(val)
  }

  const builder = getPlotBuilder('column_scatter')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'group',
        columnId: 'group',
        columnName: groupLabel,
        values: groupValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'value',
        columnName: valueLabel,
        values: yValues,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      errorBarType: 'none',
      showMeanLine: false,
      pointJitterX: opts.pointJitterX ?? 0.05,
      showLegend: true,
      showGrid: true,
      colorPalette: palette,
    },
  })

  const traceData = [...(output.data as Data[])]
  const showMedianLine = opts.showMeanLine ?? true

  if (showMedianLine) {
    traceData.push({
      type: 'scatter',
      mode: 'lines',
      x: [-0.15, 0.15],
      y: [median1, median1],
      name: `Median (${group1Name})`,
      line: {
        color: getColor(0, palette),
        width: 3,
        dash: 'solid',
      },
      showlegend: false,
      hovertemplate: `Median: %{y:.3f}<extra></extra>`,
    })
    traceData.push({
      type: 'scatter',
      mode: 'lines',
      x: [0.85, 1.15],
      y: [median2, median2],
      name: `Median (${group2Name})`,
      line: {
        color: getColor(1, palette),
        width: 3,
        dash: 'solid',
      },
      showlegend: false,
      hovertemplate: `Median: %{y:.3f}<extra></extra>`,
    })
  }

  if ((opts.errorBarType ?? 'iqr') !== 'none') {
    const errorLower1 = median1 - iqr1 / 2
    const errorUpper1 = median1 + iqr1 / 2
    const errorLower2 = median2 - iqr2 / 2
    const errorUpper2 = median2 + iqr2 / 2

    traceData.push({
      type: 'scatter',
      mode: 'lines',
      x: [-0.05, 0.05, null, 0, 0, null, -0.05, 0.05],
      y: [errorLower1, errorLower1, null, errorLower1, errorUpper1, null, errorUpper1, errorUpper1],
      name: `Error (${group1Name})`,
      line: {
        color: '#333',
        width: 1.5,
      },
      showlegend: false,
      hoverinfo: 'skip',
    })
    traceData.push({
      type: 'scatter',
      mode: 'lines',
      x: [0.95, 1.05, null, 1, 1, null, 0.95, 1.05],
      y: [errorLower2, errorLower2, null, errorLower2, errorUpper2, null, errorUpper2, errorUpper2],
      name: `Error (${group2Name})`,
      line: {
        color: '#333',
        width: 1.5,
      },
      showlegend: false,
      hoverinfo: 'skip',
    })
  }

  // Apply significance brackets if provided
  let layout = output.layout
  let config = output.config
  let stats = output.stats ?? {}

  if (opts.bracketSettings) {
    const resultData = getResultData(result)
    const pValue = toNumber(resultData.p_value)
    const pValueText =
      typeof resultData.p_value_text === 'string' ? resultData.p_value_text : undefined

    if (pValue !== null) {
      const brackets: SignificanceBracket[] = [
        {
          group1: group1Name,
          group2: group2Name,
          pValue,
          pValueText,
          label: getBracketLabel(pValue, opts.bracketSettings) ?? '',
          height: 0,
        },
      ]

      // Calculate yMin/yMax from median +/- IQR/2
      const yMax = Math.max(median1 + iqr1 / 2, median2 + iqr2 / 2, ...group1Raw, ...group2Raw)
      const yMin = Math.min(median1 - iqr1 / 2, median2 - iqr2 / 2, ...group1Raw, ...group2Raw)

      const categoryOrder = new Map([
        [group1Name, 0],
        [group2Name, 1],
      ])
      const stackedBrackets = stackBrackets(brackets, opts.bracketSettings, categoryOrder)
      const adjustedBrackets = repelBracketLayout(
        stackedBrackets,
        opts.bracketSettings,
        yMin,
        yMax
      )

      const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}

      const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
      const maxHeight = Math.max(0, ...adjustedBrackets.map((bracket) => bracket.height))
      const bracketPad = yScale * 0.08

      const direction = yMin >= 0 ? 1 : yMax <= 0 ? -1 : 1
      const alignOffset = yScale * opts.bracketSettings.offsetY
      const bracketBase = direction > 0 ? yMax - alignOffset : yMax + alignOffset
      const bracketY = direction > 0 ? yMax + yScale * maxHeight : yMax - yScale * maxHeight

      const shapes = createBracketShapes(
        adjustedBrackets,
        opts.bracketSettings,
        bracketBase,
        yScale,
        categoryOrder,
        { yMin, yMax }
      )

      const baseYAxis = (layoutBase as { yaxis?: Record<string, unknown> }).yaxis ?? {}
      const rangeMinBase = Math.min(yMin, yMax)
      const rangeMaxBase = Math.max(yMin, yMax)
      const dataSpan = Math.abs(rangeMaxBase - rangeMinBase)
      const dataPad =
        dataSpan > 0 ? dataSpan * 0.05 : Math.max(1, Math.abs(rangeMaxBase) * 0.05)
      const paddedMin = rangeMinBase - dataPad
      const paddedMax = rangeMaxBase + dataPad
      const rangeMin = Math.min(paddedMin, bracketY - bracketPad)
      const rangeMax = Math.max(paddedMax, bracketY + bracketPad)

      const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}

      layout = {
        ...layoutBase,
        shapes,
        yaxis: {
          ...baseYAxis,
          range: [rangeMin, rangeMax],
          autorange: false,
        },
        meta: {
          ...currentMeta,
          bracketCatalog: { brackets: adjustedBrackets },
          bracketVisibility:
            (currentMeta as { bracketVisibility?: Record<string, boolean> }).bracketVisibility ?? {},
          bracketSettings: opts.bracketSettings,
          errorBarType: opts.errorBarType ?? 'iqr',
          showMeanLine: showMedianLine,
        },
      }

      config = {
        ...(config ?? {}),
        displayModeBar: true,
        modeBarButtonsToAdd: ['eraseshape'] as never[],
        edits: {
          shapePosition: true,
          annotationPosition: true,
        },
      }
    }
  }

  // Add group stats (median-based)
  stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...stats,
    group1_median: median1,
    group1_q1: stats1.q1,
    group1_q3: stats1.q3,
    group1_iqr: iqr1,
    group1_n: group1Raw.length,
    group2_median: median2,
    group2_q1: stats2.q1,
    group2_q3: stats2.q3,
    group2_iqr: iqr2,
    group2_n: group2Raw.length,
    ...(opts.errorBarType !== 'none' && {
      group1_error: iqr1 / 2,
      group2_error: iqr2 / 2,
    }),
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-column-scatter`,
    type: 'column_scatter',
    title: opts.title ?? `${result.testName} - Column Scatter (Medians)`,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: traceData,
    plotlyLayout: layout,
    plotlyConfig: config,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  })

  return { plot, stats }
}

/**
 * Build bar plot for Mann-Whitney U (median-based, two groups)
 * Shows median bars with IQR error bars + significance bracket
 */
function buildMannWhitneyBarPlot(
  result: TestResult,
  opts: {
    errorBarType?: 'iqr' | 'none'
    bracketSettings?: BracketSettings
    title?: string
  } = {}
): PlotSpecWithStats | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null

  const data = payload.data
  const group1Raw = toNumberArray(data.group1 ?? data.data1 ?? data.data_1)
  const group2Raw = toNumberArray(data.group2 ?? data.data2 ?? data.data_2)

  if (group1Raw.length === 0 && group2Raw.length === 0) return null

  const fallbackNames = resolveGroupNames(payload, 2)
  const group1Name =
    typeof data.group1_name === 'string'
      ? data.group1_name
      : typeof data.group_name1 === 'string'
        ? data.group_name1
        : fallbackNames[0] ?? 'Group 1'
  const group2Name =
    typeof data.group2_name === 'string'
      ? data.group2_name
      : typeof data.group_name2 === 'string'
        ? data.group_name2
        : fallbackNames[1] ?? 'Group 2'
  const valueLabel = resolveValueLabel(payload, 'Value')
  const groupLabel = resolveGroupLabel(payload, 'Group')

  // Calculate median and IQR for each group
  const stats1 = calculateQuartiles(group1Raw)
  const stats2 = calculateQuartiles(group2Raw)
  const median1 = stats1.median
  const median2 = stats2.median
  const iqr1 = stats1.iqr
  const iqr2 = stats2.iqr
  const error1 = opts.errorBarType === 'iqr' ? iqr1 / 2 : 0
  const error2 = opts.errorBarType === 'iqr' ? iqr2 / 2 : 0

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  // Create aggregated columns for bar plot builder
  const builder = getPlotBuilder('bar')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: 'group',
        columnName: groupLabel,
        values: [group1Name, group2Name],
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'value',
        columnName: valueLabel,
        values: [median1, median2],
        inferredType: 'numeric',
      },
      {
        role: 'error',
        columnId: 'error',
        columnName: 'Error',
        values: [error1, error2],
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      errorBarType: opts.errorBarType ?? 'iqr',
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      bargap: 0.7,
      bracketSettings: opts.bracketSettings,
      splitTraces: true,
    },
  })

  // Apply significance brackets if provided
  let layout = output.layout
  let config = output.config
  let stats = output.stats

  if (opts.bracketSettings) {
    const resultData = getResultData(result)
    const pValue = toNumber(resultData.p_value)
    const pValueText =
      typeof resultData.p_value_text === 'string' ? resultData.p_value_text : undefined

    if (pValue !== null) {
      const brackets: SignificanceBracket[] = [
        {
          group1: group1Name,
          group2: group2Name,
          pValue,
          pValueText,
          label: getBracketLabel(pValue, opts.bracketSettings) ?? '',
          height: 0,
        },
      ]

      // Calculate yMin/yMax from median +/- error
      const yMax = Math.max(median1 + error1, median2 + error2)
      const yMin = Math.min(median1 - error1, median2 - error2)

      const categoryOrder = new Map([
        [group1Name, 0],
        [group2Name, 1],
      ])
      const stackedBrackets = stackBrackets(brackets, opts.bracketSettings, categoryOrder)
      const adjustedBrackets = repelBracketLayout(
        stackedBrackets,
        opts.bracketSettings,
        yMin,
        yMax
      )

      const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}

      const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
      const maxHeight = Math.max(0, ...adjustedBrackets.map((bracket) => bracket.height))
      const bracketPad = yScale * 0.08

      const direction = yMin >= 0 ? 1 : yMax <= 0 ? -1 : 1
      const alignOffset = yScale * opts.bracketSettings.offsetY
      const bracketBase = direction > 0 ? yMax - alignOffset : yMax + alignOffset
      const bracketY = direction > 0 ? yMax + yScale * maxHeight : yMax - yScale * maxHeight

      const shapes = createBracketShapes(
        adjustedBrackets,
        opts.bracketSettings,
        bracketBase,
        yScale,
        categoryOrder,
        { yMin, yMax }
      )

      const baseYAxis = (layoutBase as { yaxis?: Record<string, unknown> }).yaxis ?? {}
      const rangeMinBase = Math.min(yMin, yMax)
      const rangeMaxBase = Math.max(yMin, yMax)
      const rangeMin = Math.min(0, rangeMinBase, bracketY - bracketPad)
      const rangeMax = Math.max(0, rangeMaxBase, bracketY + bracketPad)

      const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}

      layout = {
        ...layoutBase,
        shapes,
        yaxis: {
          ...baseYAxis,
          range: [rangeMin, rangeMax],
          autorange: false,
        },
        meta: {
          ...currentMeta,
          bracketCatalog: { brackets: adjustedBrackets },
          bracketVisibility:
            (currentMeta as { bracketVisibility?: Record<string, boolean> }).bracketVisibility ?? {},
          bracketSettings: opts.bracketSettings,
          errorBarType: opts.errorBarType ?? 'iqr',
        },
      }
    }
  }

  // Add group stats (median-based)
  stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...stats,
    group1_median: median1,
    group1_q1: stats1.q1,
    group1_q3: stats1.q3,
    group1_iqr: iqr1,
    group1_n: group1Raw.length,
    group2_median: median2,
    group2_q1: stats2.q1,
    group2_q3: stats2.q3,
    group2_iqr: iqr2,
    group2_n: group2Raw.length,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-bar`,
    type: 'bar',
    title: opts.title ?? `${result.testName} - Bar Plot (Medians)`,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: layout,
    plotlyConfig: config,
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
  })

  return { plot, stats }
}

/**
 * Build bar plot for paired t-test from raw differences
 * Shows single bar with mean difference +/- SE
 * No significance brackets (single bar, not a comparison)
 */
function buildPairedTTestBarPlot(
  result: TestResult,
  opts: { errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'; title?: string } = {}
): PlotSpecWithStats | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null

  const data = payload.data

  // Try to get differences from payload first, otherwise calculate
  let differencesRaw: number[]
  if (data.differences) {
    differencesRaw = toNumberArray(data.differences)
  } else {
    // Fallback: calculate from group1/group2
    differencesRaw = calculateDifferences(data.group1 ?? data.data1, data.group2 ?? data.data2)
  }

  if (differencesRaw.length === 0) return null

  const fallbackNames = resolveGroupNames(payload, 2)
  const group1Name =
    typeof data.group1_name === 'string'
      ? data.group1_name
      : typeof data.group_name1 === 'string'
        ? data.group_name1
        : fallbackNames[0] ?? 'Group 1'
  const group2Name =
    typeof data.group2_name === 'string'
      ? data.group2_name
      : typeof data.group_name2 === 'string'
        ? data.group_name2
        : fallbackNames[1] ?? 'Group 2'
  const diffLabel = `${group1Name} - ${group2Name}`

  // Calculate mean and error for differences
  const { mean: meanDiff, se: seDiff, std: stdDiff } = calculateMeanSE(differencesRaw)
  const error = calculateErrorBar(differencesRaw, opts.errorBarType ?? 'se')

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  // Create aggregated column for single bar
  const builder = getPlotBuilder('bar')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: 'difference',
        columnName: 'Difference',
        values: [diffLabel],
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'value',
        columnName: diffLabel,
        values: [meanDiff],
        inferredType: 'numeric',
      },
      {
        role: 'error',
        columnId: 'error',
        columnName: 'Error',
        values: [error],
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      errorBarType: opts.errorBarType ?? 'se',
      showLegend: false,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
  })

  const barWidth = 0.3
  const barData = (output.data as Data[]).map((trace) => {
    const t = trace as Data & { type?: string; width?: number }
    if (t.type !== 'bar') return trace
    return { ...trace, width: barWidth }
  })

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...output.stats,
    mean_difference: meanDiff,
    se_difference: seDiff,
    std_difference: stdDiff,
    n_pairs: differencesRaw.length,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-bar`,
    type: 'bar',
    title: opts.title ?? `${result.testName} - Bar Plot (Difference)`,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: barData,
    plotlyLayout: output.layout,
    plotlyConfig: output.config,
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
  })

  return { plot, stats }
}

type GroupSummaryStats = {
  mean: number
  median: number
  q1: number
  q3: number
  min: number
  max: number
  n: number
}

function collectGroupStats(
  groups: unknown[],
  groupNames: string[]
): {
  categories: string[]
  groupValues: string[]
  yValues: number[]
  groupStats: Record<string, GroupSummaryStats>
  totalN: number
} {
  const categories: string[] = []
  const groupValues: string[] = []
  const yValues: number[] = []
  const groupStats: Record<string, GroupSummaryStats> = {}
  let totalN = 0

  groups.forEach((group, index) => {
    const groupData = toNumberArray(group)
    if (groupData.length === 0) return

    const groupName = groupNames[index] ?? `Group ${index + 1}`
    categories.push(groupName)
    groupValues.push(...Array(groupData.length).fill(groupName))
    yValues.push(...groupData)
    totalN += groupData.length

    const { mean } = calculateMeanSE(groupData)
    const quartiles = calculateQuartiles(groupData)
    groupStats[`group${index + 1}`] = {
      mean,
      median: quartiles.median,
      q1: quartiles.q1,
      q3: quartiles.q3,
      min: quartiles.min,
      max: quartiles.max,
      n: groupData.length,
    }
  })

  return { categories, groupValues, yValues, groupStats, totalN }
}

const normalizeBracketGroupKey = (value: string): string =>
  canonicalizeBracketGroupKey(value)

const buildBracketGroupAlias = (groupNames: string[]): Map<string, string> => {
  const aliasMap = new Map<string, string>()
  groupNames.forEach((name, index) => {
    aliasMap.set(normalizeBracketGroupKey(name), name)
    aliasMap.set(normalizeBracketGroupKey(`Group ${index + 1}`), name)
    aliasMap.set(normalizeBracketGroupKey(`Group${index + 1}`), name)
  })
  return aliasMap
}

const buildCategoryOrderWithAliases = (groupNames: string[]): Map<string, number> => {
  const categoryOrder = new Map<string, number>()
  groupNames.forEach((name, index) => {
    categoryOrder.set(name, index)
    categoryOrder.set(canonicalizeBracketGroupKey(name), index)
    categoryOrder.set(`Group ${index + 1}`, index)
    categoryOrder.set(`Group${index + 1}`, index)
    categoryOrder.set(`group ${index + 1}`, index)
    categoryOrder.set(`group${index + 1}`, index)
  })
  return categoryOrder
}

const remapBracketsToGroups = (
  brackets: SignificanceBracket[],
  groupNames: string[]
): SignificanceBracket[] => {
  if (brackets.length === 0) return brackets
  const aliasMap = buildBracketGroupAlias(groupNames)
  // Dedupe warnings per (unmatched-name, available-groups) pair within this call
  const warned = new Set<string>()
  return brackets.map((bracket) => {
    const group1Key = normalizeBracketGroupKey(String(bracket.group1))
    const group2Key = normalizeBracketGroupKey(String(bracket.group2))
    const mappedGroup1 = String(aliasMap.get(group1Key) ?? bracket.group1)
    const mappedGroup2 = String(aliasMap.get(group2Key) ?? bracket.group2)
    if (mappedGroup1 === String(bracket.group1) && !groupNames.includes(mappedGroup1)) {
      const warnKey = `g1:${bracket.group1}|${groupNames.join('|')}`
      if (!warned.has(warnKey)) {
        console.warn(`[brackets] unmatched group1 "${bracket.group1}" — available: ${groupNames.join(', ')}`)
        warned.add(warnKey)
      }
    }
    if (mappedGroup2 === String(bracket.group2) && !groupNames.includes(mappedGroup2)) {
      const warnKey = `g2:${bracket.group2}|${groupNames.join('|')}`
      if (!warned.has(warnKey)) {
        console.warn(`[brackets] unmatched group2 "${bracket.group2}" — available: ${groupNames.join(', ')}`)
        warned.add(warnKey)
      }
    }
    const rawEffectLabel =
      bracket.effectLabel && !/group\s*\d+/i.test(bracket.effectLabel)
        ? bracket.effectLabel
        : `${mappedGroup1} vs ${mappedGroup2}`
    // Repair mojibake in display label (effectLabel shown in Brackets sidebar)
    const effectLabel = repairMojibakeForDisplay(rawEffectLabel)
    return {
      ...bracket,
      group1: mappedGroup1,
      group2: mappedGroup2,
      effectLabel,
    }
  })
}

/**
 * Build box/violin plots for One-Way ANOVA from raw group data
 * Shows distribution of each group with Tukey HSD post-hoc brackets
 */
function buildOneWayAnovaPlots(
  result: TestResult,
  plotType: 'box' | 'violin',
  opts: { showJitter?: boolean; bracketSettings?: BracketSettings; title?: string } = {}
): PlotSpecWithStats | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null

  const data = payload.data
  const groups = data.groups as unknown
  if (!Array.isArray(groups) || groups.length < 2) return null

  const groupNames = Array.isArray(data.group_names)
    ? (data.group_names as string[])
    : groups.map((_, idx) => `Group ${idx + 1}`)

  const { categories, groupValues, yValues, groupStats, totalN } = collectGroupStats(
    groups,
    groupNames
  )
  if (yValues.length === 0) return null

  const valueLabel = typeof data.value_column === 'string' ? data.value_column : 'Value'
  const groupLabel = typeof data.group_column === 'string' ? data.group_column : 'Group'

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const builder = getPlotBuilder(plotType)
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'group',
        columnId: 'group',
        columnName: groupLabel,
        values: groupValues,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: 'value',
        columnName: valueLabel,
        values: yValues,
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      showJitter: opts.showJitter ?? false,
      title: opts.title ?? result.testName,
      showLegend: false,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
  })

  // Apply significance brackets if provided
  let layout = output.layout
  let config = output.config
  let stats = output.stats

  if (opts.bracketSettings) {
    const brackets = remapBracketsToGroups(
      extractPostHocBrackets(result, opts.bracketSettings),
      groupNames
    )

    if (brackets.length > 0) {
      const yMax = Math.max(...yValues)
      const yMin = Math.min(...yValues)

      const categoryOrder = buildCategoryOrderWithAliases(groupNames)
      const stackedBrackets = stackBrackets(brackets, opts.bracketSettings, categoryOrder)
      const adjustedBrackets = repelBracketLayout(
        stackedBrackets,
        opts.bracketSettings,
        yMin,
        yMax
      )

      const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
      const maxHeight = Math.max(0, ...adjustedBrackets.map((bracket) => bracket.height))
      const bracketPad = yScale * 0.08

      const shapes = createBracketShapes(
        adjustedBrackets,
        opts.bracketSettings,
        yMax,
        yScale,
        categoryOrder,
        { yMin, yMax }
      )

      const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}
      const baseYAxis = (layoutBase as { yaxis?: Record<string, unknown> }).yaxis ?? {}
      const rangeMinBase = Math.min(yMin, yMax)
      const rangeMaxBase = Math.max(yMin, yMax)
      const dataSpan = Math.abs(rangeMaxBase - rangeMinBase)
      const dataPad =
        dataSpan > 0 ? dataSpan * 0.05 : Math.max(1, Math.abs(rangeMaxBase) * 0.05)
      const paddedMin = rangeMinBase - dataPad
      const paddedMax = rangeMaxBase + dataPad
      const bracketOffset =
        opts.bracketSettings.offsetY + maxHeight + opts.bracketSettings.heightStep + 0.04
      const bracketY =
        yMax > 0 ? yMax * (1 + bracketOffset) : yMax - yScale * bracketOffset
      const rangeMin = Math.min(paddedMin, bracketY - bracketPad)
      const rangeMax = Math.max(paddedMax, bracketY + bracketPad)

      const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}

      layout = {
        ...layout,
        yaxis: {
          ...baseYAxis,
          range: [rangeMin, rangeMax],
          autorange: false,
        },
        shapes,
        meta: {
          ...currentMeta,
          bracketCatalog: { brackets: adjustedBrackets },
          bracketSettings: opts.bracketSettings,
        },
      }

      config = {
        ...config,
        displayModeBar: true,
        modeBarButtonsToAdd: ['eraseshape'] as never[],
        edits: {
          shapePosition: true,
          annotationPosition: true,
        },
      }
    }
  }

  // Add group statistics
  const flatStats: Record<string, number> = {}
  Object.entries(groupStats).forEach(([key, value]) => {
    flatStats[`${key}_n`] = value.n
    flatStats[`${key}_mean`] = value.mean
    flatStats[`${key}_median`] = value.median
    flatStats[`${key}_q1`] = value.q1
    flatStats[`${key}_q3`] = value.q3
    flatStats[`${key}_min`] = value.min
    flatStats[`${key}_max`] = value.max
  })

  const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}
  const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}
  const currentMetaStats =
    currentMeta && typeof currentMeta === 'object' && 'stats' in currentMeta
      ? (currentMeta.stats as Record<string, unknown>)
      : {}
  layout = {
    ...layoutBase,
    meta: {
      ...currentMeta,
      stats: {
        ...currentMetaStats,
        n_traces: categories.length,
        total_points: totalN,
        ...flatStats,
      },
    },
  }

  stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...stats,
    ...flatStats,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-${plotType}`,
    type: plotType,
    title: opts.title ?? `${result.testName} - ${plotType === 'box' ? 'Box' : 'Violin'} Plot`,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: layout,
    plotlyConfig: config,
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  })

  return { plot, stats }
}

/**
 * Build box/violin plots for Kruskal-Wallis from raw group data
 * Shows distribution of each group with Dunn test post-hoc brackets
 * (Reuses One-Way ANOVA implementation since structure is identical)
 */
function buildKruskalWallisPlots(
  result: TestResult,
  plotType: 'box' | 'violin',
  opts: { showJitter?: boolean; bracketSettings?: BracketSettings; title?: string } = {}
): PlotSpecWithStats | null {
  return buildOneWayAnovaPlots(result, plotType, opts)
}

function buildOneWayAnovaBarPlot(
  result: TestResult,
  summaryMode: 'mean' | 'median',
  opts: {
    errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
    bracketSettings?: BracketSettings
    title?: string
  } = {}
): PlotSpecWithStats | null {
  const payload = getPlotPayload(result)
  if (!payload?.data) return null

  const data = payload.data
  const groups = data.groups as unknown
  if (!Array.isArray(groups) || groups.length < 2) return null

  const groupNames = Array.isArray(data.group_names)
    ? (data.group_names as string[])
    : groups.map((_, idx) => `Group ${idx + 1}`)

  const resultData = getResultData(result)
  const statsSource =
    typeof result.statistics === 'object' && result.statistics !== null
      ? (result.statistics as Record<string, unknown>)
      : null
  const pooledMs =
    toNumber((resultData as Record<string, unknown>)?.ms_within) ??
    toNumber((resultData as Record<string, unknown>)?.residual_ms) ??
    toNumber((resultData as Record<string, unknown>)?.ms_residual) ??
    toNumber((resultData as Record<string, unknown>)?.mse) ??
    (statsSource ? toNumber(statsSource.ms_within ?? statsSource.residual_ms ?? statsSource.ms_residual ?? statsSource.mse) : null)

  const { categories, groupStats, totalN } = collectGroupStats(groups, groupNames)
  if (categories.length === 0) return null

  const errorBarType = opts.errorBarType ?? 'se'
  const summaries: number[] = []
  const errors: Array<number | null> = []

  groups.forEach((group, index) => {
    const groupData = toNumberArray(group)
    if (groupData.length === 0) return
    const stats = groupStats[`group${index + 1}`]
    if (!stats) return

    summaries.push(summaryMode === 'median' ? stats.median : stats.mean)
    if (errorBarType === 'se' && pooledMs !== null) {
      const n = stats.n
      errors.push(n > 0 ? Math.sqrt(pooledMs / n) : null)
    } else {
      errors.push(calculateErrorBar(groupData, errorBarType))
    }
  })
  const groupLabel = typeof data.group_column === 'string' ? data.group_column : 'Group'

  const bracketSettings = opts.bracketSettings
  const brackets = bracketSettings
    ? remapBracketsToGroups(extractPostHocBrackets(result, bracketSettings), groupNames)
    : undefined

  let bracketCategoryOrder: Map<string, number> | undefined
  let bracketRange: { yMin: number; yMax: number } | null = null
  let bracketMeta:
    | {
        adjustedBrackets: SignificanceBracket[]
        effectMap: Record<string, BracketEffectMeta>
        effectShapes: Record<string, string[]>
      }
    | null = null
  if (bracketSettings && brackets && brackets.length > 0) {
    const rangeValues: number[] = []
    summaries.forEach((value, index) => {
      const error = errors[index] ?? 0
      rangeValues.push(value - error, value + error)
    })
    const yMin = rangeValues.length > 0 ? Math.min(...rangeValues) : 0
    const yMax = rangeValues.length > 0 ? Math.max(...rangeValues) : 0
    const categoryOrder = buildCategoryOrderWithAliases(groupNames)
    bracketCategoryOrder = categoryOrder
    bracketRange = { yMin, yMax }
    const stackedBrackets = stackBrackets(brackets, bracketSettings, categoryOrder)
    const adjustedBrackets = repelBracketLayout(
      stackedBrackets,
      bracketSettings,
      yMin,
      yMax
    )
    const labeledBrackets = adjustedBrackets
      .map((bracket) => ({ bracket, label: formatBracketLabel(bracket, bracketSettings) }))
      .filter((entry) => Boolean(entry.label))
    const effectMap: Record<string, BracketEffectMeta> = {}
    const effectShapes: Record<string, string[]> = {}
    labeledBrackets.forEach(({ bracket }, index) => {
      const effectId = bracket.effectId ?? `effect-${index}`
      const significant = isBracketSignificant(bracket.pValue, bracketSettings)
      if (!effectMap[effectId]) {
        effectMap[effectId] = {
          label: bracket.effectLabel ?? bracket.label ?? `Bracket ${index + 1}`,
          group: bracket.effectGroup ?? 'main',
          significant,
        }
      } else if (significant) {
        effectMap[effectId] = {
          ...effectMap[effectId],
          significant: true,
        }
      }
      const shapeName = `sig_bracket_${index}`
      effectShapes[effectId] = [...(effectShapes[effectId] ?? []), shapeName]
    })
    bracketMeta = { adjustedBrackets, effectMap, effectShapes }
  }

  const builder = getPlotBuilder('bar')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      {
        role: 'x',
        columnId: groupLabel,
        columnName: groupLabel,
        values: categories,
        inferredType: 'categorical',
      },
      {
        role: 'y',
        columnId: summaryMode,
        columnName: summaryMode === 'median' ? 'Median' : 'Mean',
        values: summaries,
        inferredType: 'numeric',
      },
      ...(errors.some((value) => typeof value === 'number' && Number.isFinite(value))
        ? [
            {
              role: 'error' as const,
              columnId: 'error',
              columnName: 'Error',
              values: errors.map((value) => (typeof value === 'number' ? value : null)),
              inferredType: 'numeric' as const,
            },
          ]
        : []),
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      showLegend: false,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType,
      bracketSettings: opts.bracketSettings,
      brackets,
    },
  })

  const barTraces: Data[] = categories.map((category, index) => {
    const errorValue = errors[index]
    return {
      type: 'bar',
      x: [category],
      y: [summaries[index] ?? 0],
      marker: { color: getColor(index, DEFAULT_COLORS) },
      ...(typeof errorValue === 'number' && Number.isFinite(errorValue)
        ? {
            error_y: {
              type: 'data',
              array: [errorValue],
              visible: true,
              color: '#333',
              thickness: 1.5,
              width: 4,
            },
          }
        : {}),
      name: category,
      showlegend: true,
      legendgroup: category,
    } as Data
  })

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const flatStats: Record<string, number> = {}
  Object.entries(groupStats).forEach(([key, value]) => {
    flatStats[`${key}_n`] = value.n
    flatStats[`${key}_mean`] = value.mean
    flatStats[`${key}_median`] = value.median
    flatStats[`${key}_q1`] = value.q1
    flatStats[`${key}_q3`] = value.q3
    flatStats[`${key}_min`] = value.min
    flatStats[`${key}_max`] = value.max
  })

  const layoutBase = (output.layout as Partial<Layout>) ?? {}
  const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}
  const currentMetaStats =
    currentMeta && typeof currentMeta === 'object' && 'stats' in currentMeta
      ? (currentMeta.stats as Record<string, unknown>)
      : {}
  let layout = layoutBase

  if (bracketMeta && bracketSettings && bracketRange) {
    const { yMin, yMax } = bracketRange
    const categoryOrder = bracketCategoryOrder
    const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
    const maxHeight = Math.max(0, ...bracketMeta.adjustedBrackets.map((bracket) => bracket.height))
    const bracketTop =
      yMax > 0
        ? yScale * (1 + bracketSettings.offsetY + maxHeight + bracketSettings.heightStep + 0.04)
        : yMax + yScale * (bracketSettings.offsetY + maxHeight + bracketSettings.heightStep + 0.04)
    const bracketPad = yScale * 0.08

    const shapes = createBracketShapes(
      bracketMeta.adjustedBrackets,
      bracketSettings,
      yMax,
      yScale,
      categoryOrder,
      { yMin, yMax }
    )

    const baseYAxis = (layoutBase as { yaxis?: Partial<Layout['yaxis']> }).yaxis ?? {}
    const existingRange = Array.isArray(baseYAxis.range) ? baseYAxis.range : null

    const isNegativeOnly = yMax <= 0 && yMin < 0
    const isPositiveOnly = yMin >= 0 && yMax > 0

    const rangeMinBase = Math.min(yMin, 0)
    const rangeMaxBase = Math.max(yMax, 0)

    let rangeMin: number
    let rangeMax: number

    if (isNegativeOnly) {
      rangeMax = 0
      rangeMin = Math.min(rangeMinBase, bracketTop - bracketPad)
    } else if (isPositiveOnly) {
      rangeMin = 0
      rangeMax = Math.max(rangeMaxBase, bracketTop + bracketPad)
    } else {
      rangeMin = typeof existingRange?.[0] === 'number' ? existingRange[0] : rangeMinBase
      rangeMax = typeof existingRange?.[1] === 'number'
        ? Math.max(existingRange[1], bracketTop + bracketPad, rangeMaxBase)
        : Math.max(rangeMaxBase, bracketTop + bracketPad)
    }

    layout = {
      ...layoutBase,
      yaxis: {
        ...baseYAxis,
        range: [rangeMin, rangeMax],
        autorange: false,
      },
      shapes,
    }
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-bar`,
    type: 'bar',
    title: opts.title ?? result.testName,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: barTraces,
    plotlyLayout: {
      ...layout,
      meta: {
        ...currentMeta,
        errorBarType,
        ...(bracketMeta
          ? {
              bracketCatalog: { brackets: bracketMeta.adjustedBrackets },
              bracketEffectMap: bracketMeta.effectMap,
              bracketEffectShapes: bracketMeta.effectShapes,
              bracketVisibility:
                (currentMeta as { bracketVisibility?: Record<string, boolean> }).bracketVisibility ??
                {},
              bracketSettings,
            }
          : {}),
        stats: {
          ...currentMetaStats,
          n_traces: categories.length,
          total_points: totalN,
          ...flatStats,
        },
      },
    },
    plotlyConfig: bracketMeta
      ? {
          ...output.config,
          displayModeBar: true,
          modeBarButtonsToAdd: ['eraseshape'] as never[],
          edits: {
            ...(output.config?.edits ?? {}),
            shapePosition: true,
            annotationPosition: true,
          },
        }
      : output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...output.stats,
    ...flatStats,
  }

  return { plot, stats }
}

function buildKruskalWallisBarPlot(
  result: TestResult,
  opts: {
    errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
    bracketSettings?: BracketSettings
    title?: string
  } = {}
): PlotSpecWithStats | null {
  return buildOneWayAnovaBarPlot(result, 'median', opts)
}

/**
 * Build bar plot from test result
 */
function buildBarPlotFromResult(
  result: TestResult,
  opts: {
    title?: string
    errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
    bracketSettings?: BracketSettings
    overlayPoints?: boolean
    pointJitterX?: number
    pointSize?: number
    splitTraces?: boolean
  } = {}
): PlotSpecWithStats | null {
  const normalizedTestId = normalizeTestId(result.testId)
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  // Prefer plotlyJson if provided (bar traces or cell summaries)
  const plotlyJson = result.visualizations?.plotlyJson
  if (plotlyJson && !opts.overlayPoints) {
    let parsed: { data?: Data[]; layout?: unknown; config?: unknown }
    try {
      parsed =
        typeof plotlyJson === 'string'
          ? JSON.parse(plotlyJson)
          : (plotlyJson as { data?: Data[]; layout?: unknown; config?: unknown })
    } catch {
      return null
    }

    const hasBar = parsed.data?.some((trace) => (trace as { type?: string }).type === 'bar')
    if (hasBar && parsed.data) {
      const stats = {
        ...extractNumericStats(result.statistics),
        ...extractNumericStats(result.modelFit),
        ...extractStatsFromPlotlyData(parsed.data),
      }

      // Extract and render significance brackets if settings provided
      let layout = parsed.layout ?? {}
      const plotlyConfig = (parsed.config ?? {}) as Partial<import('plotly.js').Config>
      if (opts.bracketSettings) {
        const bracketSettings = opts.bracketSettings
        const brackets = extractPostHocBrackets(result, bracketSettings)
        if (brackets.length > 0) {
          const categoryOrder: string[] = []
          const seenCategories = new Set<string>()
          for (const trace of parsed.data) {
            const barTrace = trace as { type?: string; x?: unknown[]; y?: unknown[] }
            if (barTrace.type !== 'bar') continue
            const xValues = Array.isArray(barTrace.x) ? barTrace.x : []
            if (xValues.length === 0 && Array.isArray(barTrace.y)) {
              for (let i = 0; i < barTrace.y.length; i++) {
                const key = String(i)
                if (!seenCategories.has(key)) {
                  seenCategories.add(key)
                  categoryOrder.push(key)
                }
              }
            } else {
              for (const xValue of xValues) {
                const key = String(xValue)
                if (!seenCategories.has(key)) {
                  seenCategories.add(key)
                  categoryOrder.push(key)
                }
              }
            }
          }
          const categoryMap =
            categoryOrder.length > 0
              ? new Map(categoryOrder.map((category, index) => [category, index]))
              : undefined
          const stackedBrackets = categoryMap
            ? stackBrackets(brackets, bracketSettings, categoryMap)
            : brackets

          // Calculate y-range from bar trace data
          let yMax = -Infinity
          let yMin = Infinity
          for (const trace of parsed.data) {
            const barTrace = trace as { y?: unknown[]; error_y?: { array?: number[] } }
            if (!Array.isArray(barTrace.y)) continue
            const errorArray = Array.isArray(barTrace.error_y?.array)
              ? barTrace.error_y?.array
              : undefined
            for (let i = 0; i < barTrace.y.length; i++) {
              const val = barTrace.y[i]
              if (typeof val !== 'number') continue
              const errorVal = errorArray?.[i]
              const effectiveMax = typeof errorVal === 'number' ? val + errorVal : val
              const effectiveMin = typeof errorVal === 'number' ? val - errorVal : val
              yMax = Math.max(yMax, effectiveMax)
              yMin = Math.min(yMin, effectiveMin)
            }
          }
          if (!Number.isFinite(yMax)) yMax = 0
          if (!Number.isFinite(yMin)) yMin = 0
          // For negative-only data, ensure yScale is positive and brackets have headroom above zero
          const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
          // Bracket baseline: use yMax for positioning, but offset upward for negative-only data
          const bracketBaselineY = yMax
          const adjustedBrackets = repelBracketLayout(stackedBrackets, bracketSettings, yMin, yMax)
          const maxHeight = Math.max(0, ...adjustedBrackets.map((bracket) => bracket.height))
          // For negative-only data, position brackets above yMax toward zero (add positive offset)
          // For positive/mixed data, position brackets above yMax (multiply by >1 factor)
          const bracketTop = yMax > 0
            ? yMax * (1 + bracketSettings.offsetY + maxHeight + bracketSettings.heightStep + 0.04)
            : yMax + yScale * (bracketSettings.offsetY + maxHeight + bracketSettings.heightStep + 0.04)
          const bracketPad = yScale * 0.08

          // Generate shapes with embedded labels (labels move with brackets when dragged)
          // Pass data range for stable direction determination (prevents flipping when dragging near zero)
          const shapes = createBracketShapes(adjustedBrackets, bracketSettings, bracketBaselineY, yScale, categoryMap, { yMin, yMax })
          const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}
          const labeledBrackets = adjustedBrackets
            .map((bracket) => ({ bracket, label: formatBracketLabel(bracket, bracketSettings) }))
            .filter((entry) => Boolean(entry.label))
          const effectMap: Record<string, BracketEffectMeta> = {}
          const effectShapes: Record<string, string[]> = {}
          labeledBrackets.forEach(({ bracket }, index) => {
            const effectId = bracket.effectId ?? `effect-${index}`
            const significant = isBracketSignificant(bracket.pValue, bracketSettings)
            if (!effectMap[effectId]) {
              effectMap[effectId] = {
                label: bracket.effectLabel ?? bracket.label ?? `Bracket ${index + 1}`,
                group: bracket.effectGroup ?? 'main',
                significant,
              }
            } else if (significant) {
              effectMap[effectId] = {
                ...effectMap[effectId],
                significant: true,
              }
            }
            const shapeName = `sig_bracket_${index}`
            effectShapes[effectId] = [...(effectShapes[effectId] ?? []), shapeName]
          })
          const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}
          const baseYAxis =
            (layoutBase as { yaxis?: Record<string, unknown> }).yaxis ?? {}
          const xAxisSide =
            (layoutBase as { xaxis?: { side?: string } }).xaxis?.side ?? 'bottom'
          const allowTopPadding = xAxisSide !== 'top'
          const existingRange = Array.isArray(baseYAxis.range) ? baseYAxis.range : null

          // Detect data type for axis locking behavior
          const isNegativeOnly = yMax <= 0 && yMin < 0
          const isPositiveOnly = yMin >= 0 && yMax > 0

          // For negative-only data: lock upper bound at 0, expand downward only
          // For positive-only data: lock lower bound at 0, expand upward only
          // For mixed data: allow expansion in both directions
          let rangeMin: number
          let rangeMax: number

          if (isNegativeOnly) {
            // Negative-only data: lock rangeMax at 0, expand rangeMin downward for brackets
            rangeMax = 0
            rangeMin = allowTopPadding
              ? Math.min(yMin, bracketTop - bracketPad)
              : yMin
          } else if (isPositiveOnly) {
            // Positive-only data: lock rangeMin at 0, expand rangeMax upward for brackets
            rangeMin = 0
            rangeMax = allowTopPadding
              ? Math.max(yMax, bracketTop + bracketPad)
              : yMax
          } else {
            // Mixed data: allow expansion in both directions (original behavior)
            rangeMin = typeof existingRange?.[0] === 'number'
              ? existingRange[0]
              : yMin < 0 ? yMin : 0
            rangeMax = typeof existingRange?.[1] === 'number'
              ? allowTopPadding
                ? Math.max(existingRange[1], bracketTop + bracketPad)
                : existingRange[1]
              : allowTopPadding
                ? Math.max(yMax, bracketTop + bracketPad)
                : yMax
          }

          const existingShapes = (layoutBase as { shapes?: unknown[] }).shapes ?? []
          const nonBracketShapes = existingShapes.filter((shape) => {
            const name = typeof (shape as { name?: unknown }).name === 'string'
              ? String((shape as { name?: unknown }).name)
              : ''
            return !name.startsWith('sig_bracket_')
          })
          layout = {
            ...layoutBase,
            meta: {
              ...currentMeta,
              bracketCatalog: { brackets: adjustedBrackets },
              bracketEffectMap: effectMap,
              bracketEffectShapes: effectShapes,
              bracketVisibility:
                (currentMeta as { bracketVisibility?: Record<string, boolean> }).bracketVisibility ??
                {},
              bracketSettings: opts.bracketSettings,
            },
            yaxis: {
              ...baseYAxis,
              range: [rangeMin, rangeMax],
            },
            shapes: [...nonBracketShapes, ...shapes],
          }
          plotlyConfig.displayModeBar = true
          plotlyConfig.modeBarButtonsToAdd = ['eraseshape']
          plotlyConfig.edits = {
            shapePosition: true,
            annotationPosition: true,
          }
        }
      }

      const plot = createTestResultPlotSpec({
        id: `plot-${result.id}`,
        type: 'bar',
        title: opts.title ?? result.testName,
        statisticsFamilyId,
        resultId: result.id,
        testType: result.testId,
        testFamily,
        plotlyData: parsed.data,
        plotlyLayout: layout,
        plotlyConfig,
        dataPolicy: 'raw',
        samplingConfig: null,
        aggregationConfig: null,
      })

      return { plot, stats }
    }
  }

  if (normalizedTestId === 't_test_one_sample') {
    const payloadSeries = buildPayloadSeries(result)
    if (payloadSeries && payloadSeries.yValues.length > 0) {
      const builder = getPlotBuilder('bar')
      const output = builder({
        source: 'test_result',
        testResult: result,
        columns: [
          {
            role: 'y',
            columnId: 'value',
            columnName: payloadSeries.yLabel,
            values: payloadSeries.yValues,
            inferredType: 'numeric',
          },
        ],
        dataPolicy: 'raw',
        samplingConfig: null,
        aggregationConfig: null,
        options: {
          title: opts.title ?? result.testName,
          showLegend: false,
          showGrid: true,
          colorPalette: DEFAULT_COLORS,
          errorBarType: opts.errorBarType ?? 'se',
          overlayPoints: opts.overlayPoints ?? false,
          pointJitterX: opts.pointJitterX,
          pointSize: opts.pointSize,
        },
      })
      const baseXAxis = (output.layout.xaxis ?? {}) as Partial<Layout['xaxis']>
      const normalizedOneSampleLayout: Partial<Layout> = {
        ...output.layout,
        xaxis: {
          ...baseXAxis,
          linewidth: typeof baseXAxis.linewidth === 'number' ? baseXAxis.linewidth : 4,
          tickfont: {
            ...(typeof baseXAxis.tickfont === 'object' ? baseXAxis.tickfont : {}),
            weight:
              typeof (baseXAxis.tickfont as { weight?: unknown } | undefined)?.weight === 'number'
                ? (baseXAxis.tickfont as { weight?: number }).weight
                : 700,
          },
          tickwidth: typeof baseXAxis.tickwidth === 'number' ? baseXAxis.tickwidth : 4,
          ticklen: typeof baseXAxis.ticklen === 'number' ? baseXAxis.ticklen : 6,
          ticklabelshift:
            typeof baseXAxis.ticklabelshift === 'number' ? baseXAxis.ticklabelshift : 1,
        },
      }

      const stats = {
        ...extractNumericStats(result.statistics),
        ...extractNumericStats(result.modelFit),
        ...output.stats,
      }

      const plot = createTestResultPlotSpec({
        id: `plot-${result.id}`,
        type: 'bar',
        title: opts.title ?? result.testName,
        statisticsFamilyId,
        resultId: result.id,
        testType: result.testId,
        testFamily,
        plotlyData: output.data,
        plotlyLayout: normalizedOneSampleLayout,
        plotlyConfig: output.config,
        dataPolicy: output.dataPolicy,
        samplingConfig: output.samplingConfig,
        aggregationConfig: output.aggregationConfig,
      })

      return { plot, stats }
    }
  }

  const fromSummaries = buildBarFromCellSummaries(result, opts)
  if (fromSummaries) {
    return fromSummaries
  }

  const payload = getPlotPayload(result)
  if (payload?.data && Array.isArray(payload.data.groups)) {
    const rawGroups = payload.data.groups as unknown[][]
    const groupNames = resolveGroupNames(payload, rawGroups.length)
    const cleanedGroups: number[][] = []
    const cleanedNames: string[] = []
    rawGroups.forEach((group, index) => {
      const values = toNumberArray(group)
      if (values.length > 0) {
        cleanedGroups.push(values)
        cleanedNames.push(groupNames[index] ?? `Group ${index + 1}`)
      }
    })

    const payloadBar = buildBarFromGroupData(result, cleanedGroups, cleanedNames, {
      ...opts,
      groupLabel: resolveGroupLabel(payload, 'Group'),
    })
    if (payloadBar) {
      return payloadBar
    }
  }

  // Fallback: Call builder
  // Extract brackets if settings provided
  let brackets: SignificanceBracket[] | undefined
  if (opts.bracketSettings) {
    brackets = extractPostHocBrackets(result, opts.bracketSettings)
  }

  const builder = getPlotBuilder('bar')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [],
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? result.testName,
      showLegend: false,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType: opts.errorBarType ?? 'se',
      bracketSettings: opts.bracketSettings,
      brackets, // Pass extracted brackets to builder
      overlayPoints: opts.overlayPoints,
      pointJitterX: opts.pointJitterX,
      pointSize: opts.pointSize,
    },
  })

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...output.stats,
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}`,
    type: 'bar',
    title: opts.title ?? result.testName,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: output.layout,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  return { plot, stats }
}

/**
 * Build grouped bar plot from test result
 * Reuses existing buildGroupedBarFromCellSummaries logic
 */
function buildGroupedBarFromResult(
  result: TestResult,
  opts: { title?: string; bracketSettings?: BracketSettings; errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none' } = {}
): PlotSpecWithStats | null {
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const resultData = getResultData(result)
  const summarySource = resolveCellSummarySource(resultData)
  const meansType = summarySource?.meansType ?? 'unknown'
  const defaultTitle =
    meansType === 'lsmean' ? 'Predicted Means (LS Means)' : opts.title ?? result.testName

  const grouped =
    buildGroupedBarFromCellSummaries(result, { errorBarType: opts.errorBarType }) ??
    buildGroupedBarFromPayload(result)
  if (!grouped) return null
  const factorNames = getFactorNamesFromResult(resultData)
  const factor1Name = factorNames[0] ?? 'factor1'
  const factor2Name = factorNames[1] ?? 'factor2'

  // Apply significance brackets if settings provided
  let layout = grouped.layout
  let plotlyConfig: Partial<import('plotly.js').Config> = {}
  if (opts.errorBarType) {
    const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}
    const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}
    layout = {
      ...layoutBase,
      meta: {
        ...currentMeta,
        errorBarType:
          (currentMeta as { errorBarType?: string }).errorBarType ?? opts.errorBarType,
        meansType,
      },
    }
  }
  if (opts.bracketSettings) {
    const bracketSettings = opts.bracketSettings
    const isFdrMethod = (value: unknown): boolean => {
      if (typeof value !== 'string') return false
      return /fdr|benjamini/i.test(value)
    }
    const adjustmentMethodRaw =
      (typeof resultData.adjustment_method === 'string' && resultData.adjustment_method) ||
      (typeof (resultData as Record<string, unknown>).posthoc_adjustment === 'string' &&
        (resultData as Record<string, unknown>).posthoc_adjustment) ||
      ''
    const posthocQValue = toNumber(
      resultData.posthoc_q ?? (resultData as Record<string, unknown>).posthocQ
    )
    if (isFdrMethod(adjustmentMethodRaw) && posthocQValue !== null) {
      const currentStar = bracketSettings.thresholds['*']
      if (Number.isFinite(currentStar) && currentStar > 0) {
        const appliedQ = (bracketSettings as { _fdrThresholdQ?: number })._fdrThresholdQ
        if (appliedQ !== posthocQValue) {
          const scale = posthocQValue / currentStar
          const star = Math.min(Math.max(posthocQValue, 0), 1)
          const two = Math.min(Math.max(bracketSettings.thresholds['**'] * scale, 0), star)
          const three = Math.min(Math.max(bracketSettings.thresholds['***'] * scale, 0), two)
          bracketSettings.thresholds = {
            '***': three,
            '**': two,
            '*': star,
          }
          ;(bracketSettings as { _fdrThresholdQ?: number })._fdrThresholdQ = posthocQValue
        }
      }
    }
    const defaultValueLabel: 'p' | 'q' = isFdrMethod(adjustmentMethodRaw) ? 'q' : 'p'
    type BracketComparison = {
      group1: string
      group2: string
      pValue: number
      pValueText?: string
      label: string
      valueLabel?: 'p' | 'q'
      effectId: string
      effectLabel: string
      effectGroup: 'main' | 'simple'
      factor?: string
      withinFactor?: string
      withinLevel?: string
    }

    const rawComparisons: Array<{ record: Record<string, unknown>; factor?: string }> = []
    if (Array.isArray(result.postHoc)) {
      rawComparisons.push(
        ...result.postHoc.map((record) => ({ record: record as Record<string, unknown> }))
      )
    } else if (Array.isArray(resultData.pairwise_comparisons)) {
      rawComparisons.push(
        ...(resultData.pairwise_comparisons as Record<string, unknown>[]).map((record) => ({
          record,
        }))
      )
    }

    if (resultData.post_hoc_main_effects && typeof resultData.post_hoc_main_effects === 'object') {
      Object.entries(resultData.post_hoc_main_effects as Record<string, unknown>).forEach(
        ([factor, entries]) => {
          if (!Array.isArray(entries)) return
          rawComparisons.push(
            ...(entries as Record<string, unknown>[]).map((record) => ({ record, factor }))
          )
        }
      )
    }

    if (Array.isArray(resultData.simple_effects)) {
      rawComparisons.push(
        ...(resultData.simple_effects as Record<string, unknown>[]).map((record) => ({
          record,
        }))
      )
    }

    const parseGroups = (text: string): { group1?: string; group2?: string } => {
      const trimmed = text.trim()
      if (!trimmed) return {}
      const match =
        trimmed.match(/(.+?)\s+vs\.?\s+(.+)/i) ?? trimmed.match(/(.+?)\s+-\s+(.+)/)
      if (!match || !match[1] || !match[2]) return {}
      return { group1: match[1].trim(), group2: match[2].trim() }
    }

    const parseScope = (
      scope: string
    ): { factor?: string; withinFactor?: string; withinLevel?: string } => {
      const scopeMatch = scope.match(/^([^|=]+)\|([^=]+)=(.+)$/)
      if (!scopeMatch) return {}
      return {
        factor: scopeMatch[1]?.trim(),
        withinFactor: scopeMatch[2]?.trim(),
        withinLevel: scopeMatch[3]?.trim(),
      }
    }

    const normalizeFactorKey = (value?: string | null): string | null => {
      if (!value) return null
      return value.trim().toLowerCase()
    }

    const normalizePairKey = (value: string): string =>
      value.trim().toLowerCase().replace(/\s+/g, ' ')

    const buildComparisonKey = (
      group1: string,
      group2: string,
      scopeKey: string
    ): string => {
      const left = normalizePairKey(group1)
      const right = normalizePairKey(group2)
      const pair = left <= right ? `${left}||${right}` : `${right}||${left}`
      return `${scopeKey}::${pair}`
    }

    const resolvePValueText = (record: Record<string, unknown>): string | undefined => {
      const candidates = [
        record.p_adjusted,
        record.pValueAdjusted,
        record.p_adj,
        record.p_value,
        record.pValue,
        record.p,
        record.p_raw,
        record.pRaw,
        record.p_value_formatted,
        record.pValueFormatted,
        record.p_formatted,
      ]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim()
        }
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
          return String(candidate)
        }
      }
      return undefined
    }

    const buildFactorAliases = (
      factorName: string,
      fallbackName?: string,
      labelName?: string,
      ordinal?: number
    ): Set<string> => {
      const aliases = new Set<string>()
      const add = (value?: string | null) => {
        const normalized = normalizeFactorKey(value)
        if (normalized) {
          aliases.add(normalized)
        }
      }
      add(factorName)
      add(fallbackName)
      add(labelName)
      if (ordinal) {
        add(`factor${ordinal}`)
        add(`factor_${ordinal}`)
      }
      return aliases
    }

    const factor1Aliases = buildFactorAliases(
      factor1Name,
      typeof resultData.factor1_name === 'string' ? resultData.factor1_name : undefined,
      typeof resultData.factor1_label === 'string' ? resultData.factor1_label : undefined,
      1
    )
    const factor2Aliases = buildFactorAliases(
      factor2Name,
      typeof resultData.factor2_name === 'string' ? resultData.factor2_name : undefined,
      typeof resultData.factor2_label === 'string' ? resultData.factor2_label : undefined,
      2
    )

    const resolveFactorRole = (value?: string | null): 'factor1' | 'factor2' | null => {
      const normalized = normalizeFactorKey(value)
      if (!normalized) return null
      if (factor1Aliases.has(normalized)) return 'factor1'
      if (factor2Aliases.has(normalized)) return 'factor2'
      return null
    }

    const buildSimpleEffectsFilter = (): Set<string> | null => {
      const simpleEffects = result.parameters?.simple_effects as
        | { factor_a_within_factor_b?: boolean; factor_b_within_factor_a?: boolean }
        | Array<{ factor?: string; within?: string }>
        | undefined

      if (!simpleEffects) return null

      if (Array.isArray(simpleEffects)) {
        const allowed = new Set<string>()
        for (const entry of simpleEffects) {
          const factorRole = resolveFactorRole(entry?.factor ?? null)
          const withinRole = resolveFactorRole(entry?.within ?? null)
          if (factorRole && withinRole) {
            allowed.add(`${factorRole}|${withinRole}`)
          }
        }
        return allowed
      }

      const allowed = new Set<string>()
      if (simpleEffects.factor_a_within_factor_b) {
        allowed.add('factor1|factor2')
      }
      if (simpleEffects.factor_b_within_factor_a) {
        allowed.add('factor2|factor1')
      }
      return allowed
    }

    const allowedSimpleEffects = buildSimpleEffectsFilter()

    const comparisons: BracketComparison[] = []
    const seenComparisons = new Set<string>()
    for (const entry of rawComparisons) {
      const record = entry.record
      const comparisonText =
        (typeof record.comparison === 'string' && record.comparison) ||
        (typeof record.contrast === 'string' && record.contrast) ||
        (typeof record.label === 'string' && record.label) ||
        ''

      const comparisonSegments = comparisonText.split('|').map((part) => part.trim())
      const comparisonPart = comparisonSegments[0] ?? ''
      const scopePart =
        comparisonSegments.length > 1 ? comparisonSegments.slice(1).join('|').trim() : ''

      const parsedGroups = parseGroups(comparisonPart ?? '')
      const group1 =
        (typeof record.group1 === 'string' && record.group1) || parsedGroups.group1 || ''
      const group2 =
        (typeof record.group2 === 'string' && record.group2) || parsedGroups.group2 || ''
      if (!group1 || !group2) continue

      const pValue =
        toNumber(record.p_adjusted ?? record.pValueAdjusted ?? record.p_adj) ??
        toNumber(record.p_value ?? record.pValue ?? record.p)
      if (pValue === null) continue
      const pValueText = resolvePValueText(record)

      const bracketSettingsWithNs = { ...bracketSettings, showNs: true }
      const label = getBracketLabel(pValue, bracketSettingsWithNs)
      const recordMethod = record.method ?? record.adjustment_method ?? adjustmentMethodRaw
      const valueLabel: 'p' | 'q' = isFdrMethod(recordMethod) ? 'q' : defaultValueLabel

      const factorScope =
        (typeof record.factor_scope === 'string' && record.factor_scope) ||
        (typeof record.factorScope === 'string' && record.factorScope) ||
        scopePart ||
        ''

      const scope = factorScope ? parseScope(factorScope) : {}
      const rawWithinFactor =
        (typeof record.within_factor === 'string' && record.within_factor) ||
        (typeof record.withinFactor === 'string' && record.withinFactor) ||
        scope.withinFactor
      const rawWithinLevel =
        (typeof record.within_level === 'string' && record.within_level) ||
        (typeof record.withinLevel === 'string' && record.withinLevel) ||
        scope.withinLevel

      const factor =
        scope.factor ??
        (typeof record.factor === 'string' ? record.factor : undefined) ??
        entry.factor

      const scopeKey = [
        normalizePairKey(scope.factor ?? factor ?? ''),
        normalizePairKey(rawWithinFactor ?? scope.withinFactor ?? ''),
        normalizePairKey(rawWithinLevel ?? scope.withinLevel ?? ''),
      ].join('|')
      const comparisonKey = buildComparisonKey(group1, group2, scopeKey)
      if (seenComparisons.has(comparisonKey)) continue
      seenComparisons.add(comparisonKey)

      const baseLabel = comparisonText || `${group1} vs ${group2}`
      const isSimpleEffect = Boolean(rawWithinFactor && rawWithinLevel)
      if (!isSimpleEffect) continue
      const effectGroup: 'simple' = 'simple'
      const effectLabel = factorScope ? `${baseLabel} | ${factorScope}` : baseLabel

      comparisons.push({
        group1,
        group2,
        pValue,
        pValueText,
        label,
        valueLabel,
        effectId: comparisonKey,
        effectLabel,
        effectGroup,
        factor,
        withinFactor: rawWithinFactor ?? undefined,
        withinLevel: rawWithinLevel ?? undefined,
      })
    }

    if (comparisons.length > 0) {
      const plotData = Array.isArray(grouped.data) ? grouped.data : []
      const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}
      const categoryOrder = new Map<string, number>()
      const groupOrder = new Map<string, number>()

      plotData.forEach((trace, index) => {
        const name = (trace as { name?: unknown }).name
        if (name !== undefined) {
          groupOrder.set(String(name), index)
        }
        const xValues = Array.isArray((trace as { x?: unknown }).x)
          ? ((trace as { x: unknown[] }).x ?? [])
          : []
        for (const xValue of xValues) {
          const key = String(xValue)
          if (!categoryOrder.has(key)) {
            categoryOrder.set(key, categoryOrder.size)
          }
        }
      })

      const traceCount = groupOrder.size || plotData.length || 1
      // Extract gaps from layout (defaults match groupedBarBuilder)
      const bargap = typeof (layoutBase as { bargap?: number }).bargap === 'number'
        ? (layoutBase as { bargap?: number }).bargap ?? 0.6
        : 0.6
      const groupWidth = 1 - bargap
      const bargroupgap = typeof (layoutBase as { bargroupgap?: number }).bargroupgap === 'number'
        ? (layoutBase as { bargroupgap?: number }).bargroupgap ?? 0.15
        : 0.15
      const barWidth =
        traceCount > 0
          ? groupWidth / (traceCount + Math.max(0, traceCount - 1) * bargroupgap)
          : groupWidth
      const barStep = barWidth * (1 + bargroupgap)
      const categoryByIndex = Array.from(categoryOrder.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([key]) => key)

      const resolveCategoryIndex = (value: string): number | null => {
        const trimmed = value.trim()
        if (categoryOrder.has(trimmed)) return categoryOrder.get(trimmed) ?? null
        const numeric = Number(trimmed)
        if (Number.isFinite(numeric)) {
          const numericKey = String(numeric)
          if (categoryOrder.has(numericKey)) return categoryOrder.get(numericKey) ?? null
        }
        return null
      }

      const resolveGroupIndex = (value: string): number | null => {
        const trimmed = value.trim()
        if (groupOrder.has(trimmed)) return groupOrder.get(trimmed) ?? null
        const numeric = Number(trimmed)
        if (Number.isFinite(numeric)) {
          const numericKey = String(numeric)
          if (groupOrder.has(numericKey)) return groupOrder.get(numericKey) ?? null
        }
        return null
      }

      const barShift = (traceIndex: number): number =>
        (traceIndex - (traceCount - 1) / 2) * barStep

      const positioned: SignificanceBracket[] = []
      comparisons.forEach((comparison) => {
        const comparisonFactor = comparison.factor
        const withinFactor = comparison.withinFactor
        const withinLevel = comparison.withinLevel
        const bracketMeta = {
          effectId: comparison.effectId,
          effectLabel: comparison.effectLabel,
          effectGroup: comparison.effectGroup,
        }

        // SHOW ALL SIMPLE EFFECTS - user can delete unwanted brackets from plot
        // Two types of comparisons possible:
        // 1. Factor1 within Factor2=level → horizontal brackets (same color, different x)
        // 2. Factor2 within Factor1=level → vertical brackets (same x, different bars)
        if (withinFactor && withinLevel) {
          const factorRole = resolveFactorRole(comparisonFactor)
          const withinRole = resolveFactorRole(withinFactor)

          if (allowedSimpleEffects && !allowedSimpleEffects.has(`${factorRole}|${withinRole}`)) {
            return
          }

          // Factor1 comparisons within Factor2 levels (horizontal brackets)
          if (factorRole === 'factor1' && withinRole === 'factor2') {
            const traceIndex = resolveGroupIndex(withinLevel)
            const x1 = resolveCategoryIndex(comparison.group1)
            const x2 = resolveCategoryIndex(comparison.group2)
            if (traceIndex === null || x1 === null || x2 === null) return
            const group1 = categoryByIndex[x1]
            const group2 = categoryByIndex[x2]
            if (!group1 || !group2) return
            const shift = barShift(traceIndex)
            positioned.push({
              group1,
              group2,
              group1Shift: shift,
              group2Shift: shift,
              ...bracketMeta,
              pValue: comparison.pValue,
              pValueText: comparison.pValueText,
              valueLabel: comparison.valueLabel,
              label: comparison.label,
              height: 0,
            })
            return
          }

          // Factor2 comparisons within Factor1 levels (vertical brackets)
          if (factorRole === 'factor2' && withinRole === 'factor1') {
            const categoryIndex = resolveCategoryIndex(withinLevel)
            const g1 = resolveGroupIndex(comparison.group1)
            const g2 = resolveGroupIndex(comparison.group2)
            if (categoryIndex === null || g1 === null || g2 === null) return
            const categoryName = categoryByIndex[categoryIndex]
            if (!categoryName) return
            positioned.push({
              group1: categoryName,
              group2: categoryName,
              group1Shift: barShift(g1),
              group2Shift: barShift(g2),
              ...bracketMeta,
              pValue: comparison.pValue,
              pValueText: comparison.pValueText,
              valueLabel: comparison.valueLabel,
              label: comparison.label,
              height: 0,
            })
            return
          }

          return
        }

        // Main effects without simple effects context
        if (resolveFactorRole(comparisonFactor) === 'factor1') {
          const x1 = resolveCategoryIndex(comparison.group1)
          const x2 = resolveCategoryIndex(comparison.group2)
          if (x1 === null || x2 === null) return
          const group1 = categoryByIndex[x1]
          const group2 = categoryByIndex[x2]
          if (!group1 || !group2) return
          positioned.push({
            group1,
            group2,
            ...bracketMeta,
            pValue: comparison.pValue,
            pValueText: comparison.pValueText,
            valueLabel: comparison.valueLabel,
            label: comparison.label,
            height: 0,
          })
          return
        }

        if (resolveFactorRole(comparisonFactor) === 'factor2') {
          const midpointIndex =
            categoryOrder.size > 0 ? Math.floor((categoryOrder.size - 1) / 2) : 0
          const categoryName = categoryByIndex[midpointIndex]
          const g1 = resolveGroupIndex(comparison.group1)
          const g2 = resolveGroupIndex(comparison.group2)
          if (!categoryName || g1 === null || g2 === null) return
          positioned.push({
            group1: categoryName,
            group2: categoryName,
            group1Shift: barShift(g1),
            group2Shift: barShift(g2),
            ...bracketMeta,
            pValue: comparison.pValue,
            pValueText: comparison.pValueText,
            valueLabel: comparison.valueLabel,
            label: comparison.label,
            height: 0,
          })
        }
      })

      if (positioned.length > 0) {
        const stackedBrackets = stackBrackets(positioned, bracketSettings)

        let yMax = -Infinity
        let yMin = Infinity
        for (const trace of plotData) {
          const yValues = Array.isArray((trace as { y?: unknown }).y)
            ? ((trace as { y: number[] }).y ?? [])
            : []
          const errorValues = Array.isArray((trace as { error_y?: { array?: unknown[] } }).error_y?.array)
            ? ((trace as { error_y?: { array?: number[] } }).error_y?.array ?? [])
            : []
          for (let i = 0; i < yValues.length; i++) {
            const yValue = yValues[i]
            if (typeof yValue !== 'number') continue
            const errorValue = errorValues[i]
            const effectiveMax = typeof errorValue === 'number' ? yValue + errorValue : yValue
            const effectiveMin = typeof errorValue === 'number' ? yValue - errorValue : yValue
            yMax = Math.max(yMax, effectiveMax)
            yMin = Math.min(yMin, effectiveMin)
          }
        }

        if (!Number.isFinite(yMax)) yMax = 0
        if (!Number.isFinite(yMin)) yMin = 0
        // For negative-only data, ensure yScale is positive and brackets have headroom above zero
        const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
        // Bracket baseline: use yMax for positioning, but offset upward for negative-only data
        const bracketBaselineY = yMax
        const adjustedBrackets = repelBracketLayout(stackedBrackets, bracketSettings, yMin, yMax)
        const maxHeight = Math.max(0, ...adjustedBrackets.map((bracket) => bracket.height))
        // For negative-only data, position brackets above yMax toward zero (add positive offset)
        // For positive/mixed data, position brackets above yMax (multiply by >1 factor)
        const bracketTop = yMax > 0
          ? yMax * (1 + bracketSettings.offsetY + maxHeight + bracketSettings.heightStep + 0.04)
          : yMax + yScale * (bracketSettings.offsetY + maxHeight + bracketSettings.heightStep + 0.04)
        const bracketPad = yScale * 0.08
        // Generate shapes with embedded labels (labels move with brackets when dragged)
        // Pass data range for stable direction determination (prevents flipping when dragging near zero)
        const shapes = createBracketShapes(adjustedBrackets, bracketSettings, bracketBaselineY, yScale, categoryOrder, { yMin, yMax })

        const layoutBase = typeof layout === 'object' && layout !== null ? layout : {}
        const labeledBrackets = adjustedBrackets
          .map((bracket) => ({ bracket, label: formatBracketLabel(bracket, bracketSettings) }))
          .filter((entry) => Boolean(entry.label))
        const effectMap: Record<string, BracketEffectMeta> = {}
        const effectShapes: Record<string, string[]> = {}
        labeledBrackets.forEach(({ bracket }, index) => {
          const effectId = bracket.effectId ?? `effect-${index}`
          const significant = isBracketSignificant(bracket.pValue, bracketSettings)
          if (!effectMap[effectId]) {
            effectMap[effectId] = {
              label: bracket.effectLabel ?? bracket.label ?? `Bracket ${index + 1}`,
              group: bracket.effectGroup ?? 'main',
              significant,
            }
          } else if (significant) {
            effectMap[effectId] = {
              ...effectMap[effectId],
              significant: true,
            }
          }
          const shapeName = `sig_bracket_${index}`
          effectShapes[effectId] = [...(effectShapes[effectId] ?? []), shapeName]
        })
        const currentMeta = (layoutBase as { meta?: Record<string, unknown> }).meta ?? {}
        const baseYAxis =
          (layoutBase as { yaxis?: Record<string, unknown> }).yaxis ?? {}
        const xAxisSide =
          (layoutBase as { xaxis?: { side?: string } }).xaxis?.side ?? 'bottom'
        const allowTopPadding = xAxisSide !== 'top'
        const existingRange = Array.isArray(baseYAxis.range) ? baseYAxis.range : null

        // Detect data type for axis locking behavior
        const isNegativeOnly = yMax <= 0 && yMin < 0
        const isPositiveOnly = yMin >= 0 && yMax > 0

        // For negative-only data: lock upper bound at 0, expand downward only
        // For positive-only data: lock lower bound at 0, expand upward only
        // For mixed data: allow expansion in both directions
        let rangeMin: number
        let rangeMax: number

        if (isNegativeOnly) {
          // Negative-only data: lock rangeMax at 0, expand rangeMin downward for brackets
          rangeMax = 0
          rangeMin = allowTopPadding
            ? Math.min(yMin, bracketTop - bracketPad)
            : yMin
        } else if (isPositiveOnly) {
          // Positive-only data: lock rangeMin at 0, expand rangeMax upward for brackets
          rangeMin = 0
          rangeMax = allowTopPadding
            ? Math.max(yMax, bracketTop + bracketPad)
            : yMax
        } else {
          // Mixed data: allow expansion in both directions (original behavior)
          rangeMin = typeof existingRange?.[0] === 'number'
            ? existingRange[0]
            : yMin < 0 ? yMin : 0
          rangeMax = typeof existingRange?.[1] === 'number'
            ? allowTopPadding
              ? Math.max(existingRange[1], bracketTop + bracketPad)
              : existingRange[1]
            : allowTopPadding
              ? Math.max(yMax, bracketTop + bracketPad)
              : yMax
        }
        const existingShapes = (layoutBase as { shapes?: unknown[] }).shapes ?? []
        const nonBracketShapes = existingShapes.filter((shape) => {
          const name = typeof (shape as { name?: unknown }).name === 'string'
            ? String((shape as { name?: unknown }).name)
            : ''
          return !name.startsWith('sig_bracket_')
        })
        layout = {
          ...layoutBase,
          meta: {
            ...currentMeta,
            bracketCatalog: { brackets: adjustedBrackets },
            bracketEffectMap: effectMap,
            bracketEffectShapes: effectShapes,
            bracketVisibility:
              (currentMeta as { bracketVisibility?: Record<string, boolean> }).bracketVisibility ??
              {},
            bracketSettings,
          },
          yaxis: {
            ...baseYAxis,
            range: [rangeMin, rangeMax],
          },
          shapes: [...nonBracketShapes, ...shapes],
        }
        plotlyConfig = {
          displayModeBar: true,
          modeBarButtonsToAdd: ['eraseshape'],
          edits: {
            shapePosition: true,
            annotationPosition: true,
          },
        }
      }
    }
  }

  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
    ...grouped.stats,
  }

  // Ensure plot-level stats are available for E2E extraction even if traces
  // are not yet materialized in the canvas.
  if (layout && typeof layout === 'object') {
    const layoutBase = layout as { meta?: Record<string, unknown> }
    const currentMeta = layoutBase.meta ?? {}
    layout = {
      ...layoutBase,
      meta: {
        ...currentMeta,
        stats: {
          ...(currentMeta as { stats?: Record<string, unknown> }).stats,
          ...grouped.stats,
        },
      },
    }
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}`,
    type: 'grouped_bar',
    title: defaultTitle,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: grouped.data,
    plotlyLayout: layout,
    plotlyConfig,
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
  })

  if (plot.plotlyLayout && typeof plot.plotlyLayout === 'object') {
    const layoutBase = plot.plotlyLayout as { title?: string | { text?: string } }
    const nextTitle =
      typeof layoutBase.title === 'object' && layoutBase.title !== null
        ? { ...layoutBase.title, text: defaultTitle }
        : { text: defaultTitle }
    plot.plotlyLayout = {
      ...layoutBase,
      title: nextTitle,
    }
  }

  return { plot, stats }
}

/**
 * Build interaction plot from cell means (factor A on x, factor B as series)
 */
function buildInteractionPlotFromCellMeans(
  result: TestResult,
  cellMeans: CellMean[],
  factorA: string,
  factorB: string,
  opts: { title?: string; errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none' } = {}
): PlotSpecWithStats | null {
  const errorBarType = opts.errorBarType ?? 'se'
  const aLevels = getFactorLevelOrder(cellMeans, factorA)
  const bLevels = getFactorLevelOrder(cellMeans, factorB)
  if (aLevels.length === 0 || bLevels.length === 0) return null

  const xValues: string[] = []
  const groupValues: string[] = []
  const yValues: number[] = []
  const errorValues: number[] = []
  const stats: Record<string, number | string> = {}

  const factorizeKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '_')

  const resultData = getResultData(result)
  const residualFromResult = (resultData as Record<string, unknown> | undefined)?.residual
  const statsSource =
    typeof result.statistics === 'object' && result.statistics !== null
      ? (result.statistics as Record<string, unknown>)
      : null
  const residualMs =
    toNumber((resultData as Record<string, unknown> | undefined)?.residual_ms) ??
    toNumber((resultData as Record<string, unknown> | undefined)?.ms_residual) ??
    (statsSource ? toNumber(statsSource.residual_ms ?? statsSource.ms_residual) : null) ??
    (typeof residualFromResult === 'object' && residualFromResult !== null
      ? toNumber((residualFromResult as { MS?: unknown }).MS)
      : null) ??
    (() => {
      const residualSs =
        toNumber((resultData as Record<string, unknown> | undefined)?.residual_ss) ??
        (statsSource ? toNumber(statsSource.residual_ss) : null)
      const residualDf =
        toNumber((resultData as Record<string, unknown> | undefined)?.residual_df) ??
        (statsSource ? toNumber(statsSource.residual_df) : null)
      if (residualSs === null || residualDf === null || residualDf === 0) return null
      return residualSs / residualDf
    })()
  const residualDf =
    toNumber((resultData as Record<string, unknown> | undefined)?.residual_df) ??
    (statsSource ? toNumber(statsSource.residual_df) : null) ??
    (typeof residualFromResult === 'object' && residualFromResult !== null
      ? toNumber((residualFromResult as { df?: unknown }).df)
      : null)
  const alpha = toNumber((resultData as Record<string, unknown> | undefined)?.alpha) ?? 0.05

  for (const a of aLevels) {
    for (const b of bLevels) {
      const matches = cellMeans.filter(
        (cell) => String(cell.factors?.[factorA]) === a && String(cell.factors?.[factorB]) === b
      )
      if (matches.length === 0) continue

      const totalN = matches.reduce((sum, cell) => sum + (Number(cell.n) || 0), 0)
      const validMeans = matches.map((cell) => Number(cell.mean) || 0)
      const meanSum = validMeans.reduce((sum, value) => sum + value, 0)
      const meanCount = validMeans.length
      const pooledMean = meanCount > 0 ? meanSum / meanCount : 0

      const weight = meanCount > 0 ? 1 / meanCount : 0
      const se =
        residualMs !== null && meanCount > 0
          ? Math.sqrt(
              matches.reduce((sum, cell) => {
                const n = Number(cell.n) || 0
                if (n <= 0) return sum
                return sum + (weight * weight) / n
              }, 0) * residualMs
            )
          : 0

      let error = se
      if (errorBarType === 'sd') error = residualMs !== null ? Math.sqrt(residualMs) : 0
      else if (errorBarType === 'ci') {
        const tCritical = tCriticalFromDf(residualDf ?? 0, alpha)
        error = tCritical * se
      }
      else if (errorBarType === 'iqr') error = 0
      else if (errorBarType === 'none') error = 0

      xValues.push(a)
      groupValues.push(b)
      yValues.push(pooledMean)
      errorValues.push(error)

      const statKey = `${factorizeKey(b)}_${factorizeKey(a)}`
      stats[`${statKey}_mean`] = pooledMean
      stats[`${statKey}_se`] = se
      stats[`${statKey}_n`] = totalN
    }
  }

  // Aggregate plot-level stats for E2E validation
  stats.series_count = bLevels.length
  stats.category_count = aLevels.length
  stats.error_bar_type = errorBarType === 'se' ? 1 : errorBarType === 'sd' ? 2 : 0
  stats.n_traces = bLevels.length
  stats.n_points_per_trace = aLevels.length
  stats.total_points = yValues.length

  const builder = getPlotBuilder('interaction')
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [
      { role: 'x', columnId: factorA, columnName: factorA, values: xValues, inferredType: 'categorical' },
      { role: 'group', columnId: factorB, columnName: factorB, values: groupValues, inferredType: 'categorical' },
      { role: 'y', columnId: 'mean', columnName: 'Mean', values: yValues, inferredType: 'numeric' },
      {
        role: 'error',
        columnId: 'error',
        columnName: 'Error',
        values: errorValues.map((v) => (Number.isFinite(v) ? v : null)),
        inferredType: 'numeric',
      },
    ],
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: opts.title ?? `${factorA} × ${factorB} Interaction`,
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
      errorBarType,
    },
  })

  if (!output) return null

  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-interaction-${factorizeKey(factorA)}-${factorizeKey(factorB)}`,
    type: 'interaction',
    title: opts.title ?? `${factorA} × ${factorB} Interaction`,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: output.layout,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  const combinedStats = { ...output.stats, ...stats }

  // Embed plot stats in layout meta for data-plot-stats extraction
  plot.plotlyLayout = {
    ...(plot.plotlyLayout ?? {}),
    meta: {
      ...((plot.plotlyLayout as { meta?: Record<string, unknown> } | undefined)?.meta ?? {}),
      stats: combinedStats,
      plotType: 'interaction',
    },
  }

  return { plot, stats: combinedStats }
}

function buildInteractionPlotFromResult(
  result: TestResult,
  opts: { title?: string; errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none' } = {}
): PlotSpecWithStats | null {
  const resultData = getResultData(result)
  const summarySource = resolveCellSummarySource(resultData)
  const summaries = summarySource?.summaries
  const meansType = summarySource?.meansType ?? 'unknown'
  if (!Array.isArray(summaries) || summaries.length === 0) return null

  const factorNames = getFactorNamesFromResult(resultData)
  if (factorNames.length < 2) return null

  const factorLabels = {
    factor1: factorNames[0]!,
    factor2: factorNames[1]!,
  }

  const cellMeans: CellMean[] = (summaries as Record<string, unknown>[]).map((cell) => {
    const factors = parseCellFactors(cell, factorLabels) ?? {}
    return {
      factors,
      mean: Number(cell.emmean ?? cell.mean ?? cell.median ?? 0),
      std: Number(cell.std ?? 0),
      n: Number(cell.n ?? cell.count ?? cell.N ?? cell.n_obs ?? cell.sample_size ?? 0),
    }
  })

  const plotSpec = buildInteractionPlotFromCellMeans(
    result,
    cellMeans,
    factorNames[0]!,
    factorNames[1]!,
    opts
  )
  if (plotSpec?.plot?.plotlyLayout && typeof plotSpec.plot.plotlyLayout === 'object') {
    const layoutBase = plotSpec.plot.plotlyLayout as { meta?: Record<string, unknown> }
    plotSpec.plot.plotlyLayout = {
      ...layoutBase,
      meta: {
        ...(layoutBase.meta ?? {}),
        meansType,
      },
    }
  }
  return plotSpec
}

/**
 * Helper: Build facet combinations (Cartesian product)
 * Generates all combinations of factor levels for faceting
 */
function buildFacetCombinations(
  facetLevelLists: Array<{ factor: string; levels: string[] }>
): Array<Array<{ factorName: string; level: string }>> {
  if (facetLevelLists.length === 0) {
    return [[]]
  }

  const [first, ...rest] = facetLevelLists
  if (!first) return [[]]
  const restCombinations = buildFacetCombinations(rest)

  const combinations: Array<Array<{ factorName: string; level: string }>> = []
  for (const level of first.levels) {
    for (const restCombo of restCombinations) {
      combinations.push([{ factorName: first.factor, level }, ...restCombo])
    }
  }

  return combinations
}

/**
 * NEW: Build multifactorial plots using composition approach (SAFE REFACTOR)
 * Reuses validated two-way ANOVA grouped bar logic, arranged in faceted grid
 *
 * - 2 factors: delegates to existing logic (no change)
 * - 3+ factors: creates multiple two-way grouped bars arranged in subplot grid
 */
function buildMultifactorialPlotsV2(
  result: TestResult,
  opts: {
    title?: string
    errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
    bracketSettings?: BracketSettings
  } = {}
): PlotSpecWithStats[] {
  const resultData = getResultData(result)
  const summarySource = resolveCellSummarySource(resultData)
  const summaries = summarySource?.summaries
  const meansType = summarySource?.meansType ?? 'unknown'

  if (!Array.isArray(summaries) || summaries.length === 0) {
    return []
  }

  const factorNames = getFactorNamesFromResult(resultData)

  if (factorNames.length < 2) {
    return []
  }

  const cellMeans: CellMean[] = (summaries as Record<string, unknown>[]).map((cell) => {
    const factors = parseCellFactors(cell) ?? {}
    return {
      factors,
      mean: Number(cell.emmean ?? cell.mean ?? cell.median ?? 0),
      std: Number(cell.std ?? 0),
      se: Number(cell.se ?? cell.sem ?? cell.stderr ?? cell.std_error ?? Number.NaN),
      n: Number(cell.n ?? cell.count ?? cell.N ?? cell.n_obs ?? cell.sample_size ?? 0),
    }
  })

  const factorLevels = getFactorLevelCounts(cellMeans, factorNames)
  const effectiveFactors = factorNames.filter((name) => (factorLevels[name] ?? 0) > 1)
  const resolvedFactors = effectiveFactors.length >= 2 ? effectiveFactors : factorNames
  const defaultBracketSettings = createDefaultBracketSettings()
  const errorBarType = opts.errorBarType ?? 'se'
  const bracketSettings = opts.bracketSettings ?? defaultBracketSettings
  const useEmmeansSe = meansType === 'lsmean'
  const statsFallback = (result.statistics ?? {}) as Record<string, unknown>
  const residualMs =
    toNumber(resultData.residual_ms) ??
    toNumber(resultData.ms_residual) ??
    (typeof resultData.residual === 'object' && resultData.residual !== null
      ? toNumber((resultData.residual as { MS?: unknown }).MS)
      : null) ??
    toNumber(statsFallback.residual_ms) ??
    toNumber(statsFallback.ms_residual) ??
    (typeof statsFallback.residual === 'object' && statsFallback.residual !== null
      ? toNumber((statsFallback.residual as { MS?: unknown }).MS)
      : null)
  const residualSs =
    toNumber(resultData.residual_ss) ?? toNumber(statsFallback.residual_ss)
  const residualDf =
    toNumber(resultData.residual_df) ?? toNumber(statsFallback.residual_df)
  const pooledMs =
    residualMs ??
    (residualSs !== null && residualDf !== null && residualDf > 0
      ? residualSs / residualDf
      : null) ??
    toNumber(resultData.ms_within) ??
    toNumber(resultData.mse) ??
    toNumber(statsFallback.ms_within) ??
    toNumber(statsFallback.mse)

  const normalizeKey = (value: string): string => value.trim().toLowerCase()
  const factorAliasMap = new Map<string, string>()
  factorNames.forEach((name, index) => {
    const normalized = normalizeKey(name)
    factorAliasMap.set(normalized, name)
    factorAliasMap.set(`factor${index + 1}`, name)
    factorAliasMap.set(`factor_${index + 1}`, name)
  })
  const resolveFactorName = (value?: string | null): string | undefined => {
    if (!value) return undefined
    const normalized = normalizeKey(value)
    return factorAliasMap.get(normalized) ?? value.trim()
  }

  const normalizeFactors = (
    factors?: Record<string, string>
  ): Record<string, string> | undefined => {
    if (!factors) return undefined
    const normalized: Record<string, string> = {}
    Object.entries(factors).forEach(([key, value]) => {
      if (value === null || value === undefined) return
      const resolvedKey = resolveFactorName(key) ?? key
      normalized[resolvedKey] = String(value)
    })
    return Object.keys(normalized).length > 0 ? normalized : undefined
  }

  const parseSimpleEffectBrackets = (
    records: Record<string, unknown>[]
  ): SimpleEffectBracket[] => {
    const brackets: SimpleEffectBracket[] = []
    const normalize = (value: string) => value.trim()
    const toNumber = (value: unknown): number | null => {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null
      }
      if (typeof value === 'string') {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }
    const parseGroups = (text: string): { group1?: string; group2?: string } => {
      const match =
        text.match(/(.+?)\s+vs\.?\s+(.+)/i) ?? text.match(/(.+?)\s+-\s+(.+)/)
      if (!match || !match[1] || !match[2]) return {}
      return { group1: match[1].trim(), group2: match[2].trim() }
    }
    const resolvePValueText = (record: Record<string, unknown>): string | undefined => {
      const candidates = [
        record.p_adjusted,
        record.pValueAdjusted,
        record.p_adj,
        record.p_value,
        record.pValue,
        record.p,
        record.p_value_formatted,
        record.pValueFormatted,
        record.p_formatted,
      ]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim()
        }
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
          return String(candidate)
        }
      }
      return undefined
    }

    records.forEach((record) => {
      const comparisonText =
        (typeof record.comparison === 'string' && record.comparison) ||
        (typeof record.contrast === 'string' && record.contrast) ||
        (typeof record.label === 'string' && record.label) ||
        ''
      if (!comparisonText) return

      const comparisonSegments = comparisonText.split('|').map((part) => part.trim())
      const comparisonPart = comparisonSegments[0] ?? ''
      const scopePart =
        comparisonSegments.length > 1 ? comparisonSegments.slice(1).join('|').trim() : ''

      let group1 = typeof record.group1 === 'string' ? record.group1 : undefined
      let group2 = typeof record.group2 === 'string' ? record.group2 : undefined
      if (!group1 || !group2) {
        const parsed = parseGroups(comparisonPart)
        group1 = group1 ?? parsed.group1
        group2 = group2 ?? parsed.group2
      }
      if (!group1 || !group2) return

      const pValue =
        toNumber(record.p_adj ?? record.p_adjusted) ??
        toNumber(record.p_value ?? record.pValue) ??
        toNumber(record.p)
      if (pValue === null) return

      const pValueText = resolvePValueText(record)
      const sig =
        (typeof record.sig_stars === 'string' && record.sig_stars) ||
        (typeof record.sig === 'string' && record.sig) ||
        getBracketLabel(pValue, { ...defaultBracketSettings, showNs: true })

      const factors: Record<string, string> = {}
      const rawFactors = record.factors
      if (rawFactors && typeof rawFactors === 'object' && !Array.isArray(rawFactors)) {
        Object.entries(rawFactors as Record<string, unknown>).forEach(([key, value]) => {
          if (value !== null && value !== undefined) {
            const resolvedKey = resolveFactorName(key) ?? key
            factors[resolvedKey] = String(value)
          }
        })
      }

      const scopeTokens = scopePart.split('|').map((part) => part.trim()).filter(Boolean)
      const comparedFactor = resolveFactorName(scopeTokens[0]) ?? scopeTokens[0]
      scopeTokens.slice(1).forEach((token) => {
        const [key, value] = token.split('=').map((part) => part.trim())
        if (key && value) {
          const resolvedKey = resolveFactorName(key) ?? key
          factors[resolvedKey] = value
        }
      })

      const withinFactorRaw =
        typeof record.within_factor === 'string'
          ? record.within_factor
          : typeof record.withinFactor === 'string'
            ? record.withinFactor
            : undefined
      const withinFactor = resolveFactorName(withinFactorRaw)
      const withinLevel =
        (typeof record.within_level === 'string' && record.within_level) ||
        (typeof record.withinLevel === 'string' && record.withinLevel)
      if (withinFactor && withinLevel) {
        factors[withinFactor] = String(withinLevel)
      }

      brackets.push({
        group1: normalize(group1),
        group2: normalize(group2),
        p_value: pValue,
        p_value_text: pValueText,
        sig,
        factors: Object.keys(factors).length > 0 ? factors : undefined,
        compared_factor: comparedFactor || undefined,
      })
    })

    return brackets
  }

  const rawSimpleEffects = resultData.simple_effects as unknown
  const normalizeBracket = (bracket: SimpleEffectBracket): SimpleEffectBracket => {
    const resolvedFactors = normalizeFactors(bracket.factors)
    const compared = resolveFactorName(bracket.compared_factor ?? null) ?? bracket.compared_factor
    const sig =
      bracket.sig && bracket.sig.trim()
        ? bracket.sig
        : getBracketLabel(bracket.p_value, { ...defaultBracketSettings, showNs: true })
    return {
      ...bracket,
      sig,
      factors: resolvedFactors,
      compared_factor: compared ?? undefined,
    }
  }
  const bracketList = (rawSimpleEffects as { brackets?: unknown } | null | undefined)?.brackets
  const simpleBrackets: SimpleEffectBracket[] = Array.isArray(bracketList)
    ? (bracketList as SimpleEffectBracket[])
        .map(normalizeBracket)
        .filter(
          (entry) => entry.group1 && entry.group2 && Number.isFinite(entry.p_value)
        )
    : Array.isArray(rawSimpleEffects)
      ? parseSimpleEffectBrackets(rawSimpleEffects as Record<string, unknown>[])
      : []

  // Two-way: use existing two-way logic (unchanged, safe)
  if (resolvedFactors.length === 2) {
    const plots: PlotSpecWithStats[] = []
    const factorIndexByName = new Map(resolvedFactors.map((name, index) => [name, index + 1]))
    const getInteractionPlotType = (a: string, b: string): string | null => {
      const aIndex = factorIndexByName.get(a)
      const bIndex = factorIndexByName.get(b)
      if (!aIndex || !bIndex) return null
      const first = Math.min(aIndex, bIndex)
      const second = Math.max(aIndex, bIndex)
      return `interaction_f${first}f${second}`
    }

    const groupedTitle =
      meansType === 'lsmean' ? 'Predicted Means (LS Means)' : opts.title ?? 'Cell Means'
    const grouped = buildGroupedBarFromResult(result, {
      title: groupedTitle,
      bracketSettings,
      errorBarType,
    })
    if (grouped) {
      grouped.plot.id = `plot-${result.id}-mf-primary`
      grouped.plot.title = groupedTitle
      const currentLayout = (grouped.plot.plotlyLayout ?? {}) as { title?: string | { text?: string } }
      grouped.plot.plotlyLayout = {
        ...currentLayout,
        title:
          typeof currentLayout.title === 'object' && currentLayout.title !== null
            ? { ...currentLayout.title, text: groupedTitle }
            : { text: groupedTitle },
      }
      plots.push(grouped)
    }

    // Add interaction plots for two-way
    const pairs: Array<[string, string]> = []
    for (let i = 0; i < resolvedFactors.length; i++) {
      for (let j = i + 1; j < resolvedFactors.length; j++) {
        pairs.push([resolvedFactors[i]!, resolvedFactors[j]!])
      }
    }

    let order = 2
    for (const [a, b] of pairs) {
      const interaction = buildInteractionPlotFromCellMeans(result, cellMeans, a, b, {
        title: `${a} × ${b} Interaction`,
        errorBarType,
      })
      if (interaction) {
        interaction.plot.id = `${interaction.plot.id}-mf-${order}`
        interaction.plot.title = `${a} × ${b} Interaction`
        const plotType = getInteractionPlotType(a, b)
        if (plotType) {
          const currentLayout = (interaction.plot.plotlyLayout ?? {}) as { meta?: Record<string, unknown> }
          interaction.plot.plotlyLayout = {
            ...currentLayout,
            meta: {
              ...(currentLayout.meta ?? {}),
              plotType,
            },
          }
        }
        plots.push(interaction)
        order += 1
      }
    }

    return plots
  }

  // Three-way or more: SINGLE-AXIS FLATTENED approach (matches z8.png)
  const plots: PlotSpecWithStats[] = []
  const factorIndexByName = new Map(resolvedFactors.map((name, index) => [name, index + 1]))
  const getInteractionPlotType = (a: string, b: string): string | null => {
    const aIndex = factorIndexByName.get(a)
    const bIndex = factorIndexByName.get(b)
    if (!aIndex || !bIndex) return null
    const first = Math.min(aIndex, bIndex)
    const second = Math.max(aIndex, bIndex)
    return `interaction_f${first}f${second}`
  }

  // Extract explicit factor role mapping from result parameters (if provided by user)
  const explicitMapping = normalizeFactorMapping(
    (result.parameters as Record<string, unknown> | undefined)?.factor_role_mapping,
    resolvedFactors
  )

  // Determine factor roles (x, series, facets)
  const roles = assignFactorRoles(resolvedFactors, explicitMapping)

  // Get factor level orders
  const xLevels = getFactorLevelOrder(cellMeans, roles.x)
  const seriesLevels = getFactorLevelOrder(cellMeans, roles.series)

  // Build facet combinations for non-x, non-series factors
  const facetFactors = roles.facets
  const facetLevelLists = facetFactors.map((factor) => ({
    factor,
    levels: getFactorLevelOrder(cellMeans, factor),
  }))
  const facetCombinations = buildFacetCombinations(facetLevelLists)

  // STEP 1: Flatten facets into ONE x-axis (facet-major order)
  // Build x-axis categories with facet prefix to keep categories unique:
  // ["FacetA | x1", "FacetA | x2", "FacetB | x1", ...]
  const flattenedXCategories: string[] = []
  const tickValues: string[] = []
  const tickText: string[] = []
  const facetBoundaries: number[] = [] // Indices where facets change (for separators)
  const facetMidpoints: Array<{ facet: Array<{ factorName: string; level: string }>; midpoint: number }> = []
  const spacerKey = '__facet_spacer__'
  const facetStarts: number[] = []

  facetCombinations.forEach((facetLevels, facetIdx) => {
    const facetStart = flattenedXCategories.length
    facetStarts.push(facetStart)
    const facetLabel = facetLevels.map(({ factorName, level }) => `${factorName}=${level}`).join(' | ')

    // Add all x-levels for this facet
    xLevels.forEach((xLevel) => {
      const label = facetLabel ? `${facetLabel} | ${xLevel}` : xLevel
      flattenedXCategories.push(label)
      tickValues.push(label)
      tickText.push(xLevel) // show only the x-level on the tick
    })

    const facetEnd = flattenedXCategories.length

    // Mark boundary (except for first facet)
    if (facetIdx > 0) {
      facetBoundaries.push(facetStart - 0.5) // Between last of prev facet and first of this facet
    }

    // Spacer category to visually separate facets
    const isLastFacet = facetIdx === facetCombinations.length - 1
    if (!isLastFacet) {
      const spacerLabel = `${facetLabel} | ${spacerKey}_${facetIdx}`
      flattenedXCategories.push(spacerLabel)
      tickValues.push(spacerLabel)
      tickText.push('') // hide spacer tick text
    }

    // Calculate midpoint for facet label
    const midpoint = (facetStart + facetEnd - 1) / 2
    facetMidpoints.push({ facet: facetLevels, midpoint })
  })

  // STEP 2: Build traces for each series level across ALL facets on ONE axis
  const allTraces: any[] = []
  const allRangeValues: number[] = []
  const allStats: Record<string, number | string> = {}

  // Precompute bar geometry (mirrors two-way ANOVA logic so brackets move with spacing)
  const bargap = 0.6
  const bargroupgap = 0.15
  const groupWidth = 1 - bargap
  const barWidth =
    seriesLevels.length > 0
      ? groupWidth / (seriesLevels.length + Math.max(0, seriesLevels.length - 1) * bargroupgap)
      : groupWidth
  const barStep = barWidth * (1 + bargroupgap)
  const seriesShiftByLevel = new Map<string, number>()
  seriesLevels.forEach((level, index) => {
    const shift = (index - (seriesLevels.length - 1) / 2) * barStep
    seriesShiftByLevel.set(level, shift)
  })

  seriesLevels.forEach((seriesLevel, seriesIdx) => {
    const means: number[] = []
    const errorBars: number[] = []

    // Iterate through flattened x-categories in facet-major order
    facetCombinations.forEach((facetLevels) => {
      xLevels.forEach((xLevel) => {
        // Find cell mean matching x + series + facets
        const cell = cellMeans.find(
          (c) =>
            String(c.factors[roles.x]) === xLevel &&
            String(c.factors[roles.series]) === seriesLevel &&
            facetLevels.every(
              ({ factorName, level }) => String(c.factors[factorName]) === level
            )
        )

        if (cell) {
          const mean = typeof cell.mean === 'number' ? cell.mean : parseFloat(String(cell.mean))
          const std = typeof cell.std === 'number' ? cell.std : parseFloat(String(cell.std))
          const rawSe =
            typeof cell.se === 'number' && Number.isFinite(cell.se)
              ? cell.se
              : Number.isFinite(std) && cell.n > 0
                ? std / Math.sqrt(cell.n)
                : 0
          const pooledSe =
            errorBarType === 'se' && pooledMs !== null && cell.n > 0
              ? Math.sqrt(pooledMs / cell.n)
              : null
          const se = useEmmeansSe && Number.isFinite(rawSe) ? rawSe : (pooledSe ?? rawSe)

          means.push(mean)

          // Calculate error bar based on selected type (using cell statistics, not raw values)
          let errorBar = 0
          if (errorBarType !== 'none') {
            if (errorBarType === 'se') {
              errorBar = se
            } else if (errorBarType === 'sd') {
              errorBar = std
            } else if (errorBarType === 'ci') {
              // 95% CI: 1.96 * SE
              errorBar = 1.96 * se
            } else if (errorBarType === 'iqr') {
              // For IQR, use Q3-Q1 if available
              const q1 = typeof cell.q1 === 'number' ? cell.q1 : 0
              const q3 = typeof cell.q3 === 'number' ? cell.q3 : 0
              errorBar = (q3 - q1) / 2
            }
          }
          errorBars.push(errorBar)
          allRangeValues.push(mean - errorBar, mean + errorBar)

          // Store stats for E2E validation
          const facetKey = facetLevels
            .map(({ factorName, level }) => `${factorName}_${level}`)
            .join('_')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
          const statKey = `${facetKey}_${seriesLevel}_${xLevel}`.toLowerCase().replace(/[^a-z0-9]+/g, '_')
          allStats[`${statKey}_mean`] = mean
          allStats[`${statKey}_se`] = se
          allStats[`${statKey}_n`] = cell.n
        } else {
          means.push(0)
          errorBars.push(0)
        }
      })

      // Spacer category placeholder (no bar)
      const isLastFacet = facetLevels === facetCombinations[facetCombinations.length - 1]
        ? true
        : false
      if (!isLastFacet) {
        means.push(null as any)
        errorBars.push(0)
      }
    })

    // Create trace for this series across ALL x-categories
    const trace: any = {
      type: 'bar',
      x: flattenedXCategories,
      y: means,
      name: seriesLevel,
      legendgroup: seriesLevel,
      marker: { color: getColor(seriesIdx) },
    }

    // Add error bars if not 'none'
    if (errorBarType !== 'none') {
      trace.error_y = {
        type: 'data',
        array: errorBars,
        visible: true,
        color: 'rgba(0,0,0,0.5)',
      }
    }

    allTraces.push(trace)
  })

  // STEP 3: Add vertical separators at facet boundaries
  // Optional: facet separators (disabled per design feedback)
  const separatorShapes: any[] = []

  // STEP 4: Add facet label annotations above each facet block
  const facetAnnotations = facetMidpoints.map(({ facet, midpoint }) => {
    const facetLabel = facet.map(({ factorName, level }) => `${factorName}=${level}`).join(', ')
    return {
      text: facetLabel,
      x: midpoint,
      y: 0.96,
      xref: 'x',
      yref: 'paper',
      xanchor: 'center',
      yanchor: 'bottom',
      showarrow: false,
      font: { size: 12, weight: 700 },
    }
  })

  // STEP 5: Handle brackets on flattened x-axis
  const allBrackets: SignificanceBracket[] = []
  const allBracketShapes: any[] = []
  const bracketEffectMap: Record<string, BracketEffectMeta> = {}
  const bracketEffectShapes: Record<string, string[]> = {}

  if (bracketSettings.show && simpleBrackets.length > 0) {
    let bracketShapeIndex = 0

    facetCombinations.forEach((facetLevels, facetIdx) => {
      const facetStart = facetStarts[facetIdx] ?? facetIdx * (xLevels.length + 1)
      const xLevelSet = new Set(xLevels)
      const seriesLevelSet = new Set(seriesLevels)
      const categoryOrder = new Map<string, number>()
      flattenedXCategories.forEach((cat, idx) => categoryOrder.set(cat, idx))
      const facetScopeLabel = facetLevels
        .map(({ factorName, level }) => `${factorName}=${level}`)
        .join(', ')

      // Filter brackets to this facet
      const facetBrackets = simpleBrackets.filter((bracket) => {
        if (!bracket.factors) return true // Missing factors = applies to all facets
        return facetLevels.every(
          ({ factorName, level }) =>
            !bracket.factors![factorName] || String(bracket.factors![factorName]) === level
        )
      })

      // Map brackets to flattened x-axis positions
      const positionedBrackets: SignificanceBracket[] = []
      facetBrackets.forEach((bracket) => {
        const group1 = bracket.group1
        const group2 = bracket.group2
        if (!group1 || !group2) return

        const label = bracket.sig ?? getBracketLabel(bracket.p_value, bracketSettings)
        if (!label && !bracketSettings.showNs) return

        const factors = bracket.factors ?? {}
        const comparedFactor = bracket.compared_factor

        const inX = xLevelSet.has(group1) && xLevelSet.has(group2)
        const inSeries = seriesLevelSet.has(group1) && seriesLevelSet.has(group2)

        // Horizontal bracket: compare x-levels within a single series
        if (inX && (!inSeries || comparedFactor === roles.x)) {
          const seriesLevel = factors[roles.series]
          if (!seriesLevel || !seriesShiftByLevel.has(seriesLevel)) return
          const shift = seriesShiftByLevel.get(seriesLevel) ?? 0
          const g1Idx = xLevels.indexOf(group1)
          const g2Idx = xLevels.indexOf(group2)
          if (g1Idx === -1 || g2Idx === -1) return
          const flatGroup1 = facetStart + g1Idx
          const flatGroup2 = facetStart + g2Idx
          positionedBrackets.push({
            group1: flattenedXCategories[flatGroup1] ?? group1,
            group2: flattenedXCategories[flatGroup2] ?? group2,
            group1Shift: shift,
            group2Shift: shift,
            pValue: bracket.p_value,
            pValueText: bracket.p_value_text,
            effectId: `facet${facetIdx}-${group1}-${group2}`,
            effectLabel: facetScopeLabel ? `${group1} vs ${group2} | ${facetScopeLabel}` : `${group1} vs ${group2}`,
            effectGroup: 'simple',
            label,
            height: 0,
          })
          return
        }

        // Vertical bracket: compare series within a single x-level
        if (inSeries && (!inX || comparedFactor === roles.series)) {
          const xLevel = factors[roles.x]
          if (!xLevel || !xLevelSet.has(xLevel)) return
          const xIdx = xLevels.indexOf(xLevel)
          if (xIdx === -1) return
          const flatX = facetStart + xIdx
          const shift1 = seriesShiftByLevel.get(group1)
          const shift2 = seriesShiftByLevel.get(group2)
          if (shift1 === undefined || shift2 === undefined) return
          positionedBrackets.push({
            group1: flattenedXCategories[flatX] ?? xLevel,
            group2: flattenedXCategories[flatX] ?? xLevel,
            group1Shift: shift1,
            group2Shift: shift2,
            pValue: bracket.p_value,
            pValueText: bracket.p_value_text,
            effectId: `facet${facetIdx}-${group1}-${group2}-${xLevel}`,
            effectLabel: facetScopeLabel ? `${group1} vs ${group2} | ${facetScopeLabel}` : `${group1} vs ${group2}`,
            effectGroup: 'simple',
            label,
            height: 0,
          })
        }
      })

      // Stack brackets and create shapes
      if (positionedBrackets.length > 0) {
        const categoryOrder = new Map<string, number>()
        flattenedXCategories.forEach((cat, idx) => categoryOrder.set(cat, idx))

        const stacked = stackBrackets(positionedBrackets, bracketSettings, categoryOrder)
        const rawMax = Math.max(...allRangeValues)
        const rawMin = Math.min(...allRangeValues)
        const yMax = Number.isFinite(rawMax) ? rawMax : 0
        const yMin = Number.isFinite(rawMin) ? rawMin : 0
        const yScale = yMax > 0 ? yMax : Math.max(1, Math.abs(yMin))
        const bracketBaseY = yMax <= 0 && yMin < 0 ? yMin : yMax
        const adjusted = repelBracketLayout(stacked, bracketSettings, yMin, yMax)
        const labeled = adjusted
          .map((bracket) => ({ bracket, label: formatBracketLabel(bracket, bracketSettings) }))
          .filter((entry) => Boolean(entry.label))
        const shapes = createBracketShapes(
          adjusted,
          bracketSettings,
          bracketBaseY,
          yScale,
          categoryOrder,
          { yMin, yMax }
        )

        labeled.forEach(({ bracket, label }, index) => {
          const shape = shapes[index]
          if (!shape) return

          const shapeName = `sig_bracket_${bracketShapeIndex++}`
          const effectId = bracket.effectId ?? shapeName
          const significant = Boolean(getBracketLabel(bracket.pValue, { ...bracketSettings, showNs: false }))

          allBracketShapes.push({
            ...shape,
            name: shapeName,
            label: {
              ...(shape as any).label,
              text: label,
            },
          })

          allBrackets.push({ ...bracket, label, effectId, effectLabel: bracket.effectLabel, effectGroup: 'simple' })

          if (!bracketEffectMap[effectId]) {
            bracketEffectMap[effectId] = {
              label: bracket.effectLabel ?? `${bracket.group1} vs ${bracket.group2}`,
              group: 'simple',
              significant,
            }
          }
          bracketEffectShapes[effectId] = [...(bracketEffectShapes[effectId] ?? []), shapeName]
        })
      }
    })
  }

  // STEP 6: Build final layout (SINGLE PLOT, reuse two-way styling)
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

  // Calculate global y-range
  const [baseMin, baseMax] = calculateBarPlotRange(allRangeValues, 0.1)
  const rangeMin = Number.isFinite(baseMin) ? baseMin : 0
  const rangeMax = Number.isFinite(baseMax) ? baseMax : 0
  const dataMax = Math.max(...allRangeValues)
  const dataMin = Math.min(...allRangeValues)
  const hasDataRange = Number.isFinite(dataMax) && Number.isFinite(dataMin)
  const isNegativeOnly = hasDataRange && dataMax <= 0 && dataMin < 0
  const isPositiveOnly = hasDataRange && dataMin >= 0 && dataMax > 0
  const yScale = dataMax > 0 ? dataMax : Math.max(1, Math.abs(dataMin))
  let yRange: [number, number] = [rangeMin, rangeMax]
  if (allBrackets.length > 0 && hasDataRange) {
    // approximate max bracket height in units of category span
    const maxHeight = Math.max(0, ...allBrackets.map((b) => b.height ?? 0))
    const offset = bracketSettings.offsetY + maxHeight + bracketSettings.heightStep + 0.04
    const bracketPad = yScale * 0.08
    if (isNegativeOnly) {
      const bracketBottom = dataMin - yScale * offset
      yRange = [Math.min(rangeMin, bracketBottom - bracketPad), 0]
    } else if (isPositiveOnly) {
      const bracketTop = dataMax * (1 + offset)
      yRange = [0, Math.max(rangeMax, bracketTop + bracketPad)]
    } else {
      const bracketTop = dataMax * (1 + offset)
      const extra = Math.max(0, (rangeMax - rangeMin) * 0.08)
      yRange = [rangeMin, Math.max(rangeMax, bracketTop + extra)]
    }
  }
  const xAxisSide = rangeMax <= 0 && rangeMin < 0 ? 'top' : 'bottom'

  const plotTitle =
    meansType === 'lsmean' ? 'Predicted Means (LS Means)' : opts.title ?? 'Cell Means'
  // Aggregate plot-level stats for E2E (use only real cells with n>0)
  const realCells = cellMeans.filter((c) => Number.isFinite(c.mean) && c.n > 0)
  const meanValues = realCells.map((c) => Number(c.mean))
  const seValues = realCells
    .map((c) => {
      const rawSe = Number.isFinite(c.se) ? Number(c.se) : Number.NaN
      if (useEmmeansSe && Number.isFinite(rawSe)) return rawSe
      if (errorBarType === 'se' && pooledMs !== null && c.n > 0) {
        return Math.sqrt(pooledMs / c.n)
      }
      if (Number.isFinite(c.std) && c.n > 0) return Number(c.std) / Math.sqrt(c.n)
      return Number.NaN
    })
    .filter((v) => Number.isFinite(v))
  allStats['n_facets'] = facetCombinations.length
  allStats['n_traces_per_facet'] = seriesLevels.length
  allStats['n_points_per_trace'] = xLevels.length
  allStats['total_points'] = facetCombinations.length * seriesLevels.length * xLevels.length
  if (meanValues.length > 0) {
    const meanSum = meanValues.reduce((s, v) => s + v, 0)
    allStats['overall_mean'] = meanSum / meanValues.length
    allStats['min_mean'] = Math.min(...meanValues)
    allStats['max_mean'] = Math.max(...meanValues)
  }
  if (seValues.length > 0) {
    const seSum = seValues.reduce((s, v) => s + v, 0)
    allStats['mean_se'] = seSum / seValues.length
  }

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}-mf-faceted-v2`,
    // Use grouped_bar type to reuse the standard builder/UI and avoid the legacy faceted builder
    type: 'grouped_bar',
    title: plotTitle,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: allTraces,
    plotlyLayout: {
      title: {
        text: plotTitle,
        yref: 'paper',
        y: 1.0,
        yanchor: 'bottom',
        automargin: false,
      },
      showlegend: true,
      barmode: 'group',
      bargap,
      bargroupgap,
      xaxis: {
        title: { text: roles.x, font: { weight: 700 }, standoff: 15 },
        tickfont: { weight: 700, size: 12 },
        side: xAxisSide,
        type: 'category',
        tickmode: 'array',
        tickvals: tickValues,
        ticktext: tickText,
        categoryorder: 'array',
        categoryarray: tickValues,
        ticks: 'outside',
        tickangle: 0,
        ticklen: 6,
        tickwidth: 4,
        tickcolor: '#000',
        linecolor: '#000',
        linewidth: 4,
        automargin: true,
      },
      yaxis: {
        title: { text: meansType === 'lsmean' ? 'Predicted Mean' : 'Mean', font: { weight: 700 }, standoff: 15 },
        tickfont: { weight: 700, size: 12 },
        range: yRange,
        autorange: false,
        ticklen: 6,
        tickwidth: 4,
        ticklabelshift: 1,
        tickcolor: '#000',
        linecolor: '#000',
        linewidth: 4,
        automargin: true,
      },
      shapes: [...separatorShapes, ...allBracketShapes],
      annotations: [...facetAnnotations],
      legend: {
        x: 1.02,
        y: 1,
        orientation: 'v',
      },
      meta: {
        errorBarType,
        plotType: 'grouped_bar',
        bracketCatalog: {
          brackets: allBrackets,
          bargap,
          bargroupgap,
          seriesLevels,
          xLevels,
        },
        bracketEffectMap,
        bracketEffectShapes,
        bracketVisibility: {},
        bracketSettings,
        stats: allStats,
        meansType,
        // Factor role assignment metadata for E2E validation
        factor_role_mapping: explicitMapping ?? null,
        assigned_factor_roles: {
          x: roles.x,
          series: roles.series,
          facets: roles.facets,
        },
      },
    },
    plotlyConfig: {
      responsive: true,
      displaylogo: false,
      displayModeBar: true,
      ...(allBrackets.length > 0
        ? {
            modeBarButtonsToAdd: ['eraseshape'],
            edits: {
              shapePosition: true,
              annotationPosition: true,
            },
          }
        : {}),
    },
    dataPolicy: 'aggregated',
    samplingConfig: null,
    aggregationConfig: null,
  })

  allStats['facet_count'] = facetCombinations.length
  allStats['x_category_count'] = flattenedXCategories.length
  allStats['bracket_count'] = allBrackets.length
  plots.push({ plot, stats: allStats })

  // Add interaction plots (reuse existing logic)
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < resolvedFactors.length; i++) {
    for (let j = i + 1; j < resolvedFactors.length; j++) {
      pairs.push([resolvedFactors[i]!, resolvedFactors[j]!])
    }
  }

  let order = 2
  for (const [a, b] of pairs) {
    const interaction = buildInteractionPlotFromCellMeans(result, cellMeans, a, b, {
      title: `${a} × ${b} Interaction`,
      errorBarType,
    })
    if (interaction) {
      interaction.plot.id = `${interaction.plot.id}-mf-${order}`
      interaction.plot.title = `${a} × ${b} Interaction`
      const plotType = getInteractionPlotType(a, b)
      if (plotType) {
        const currentLayout = (interaction.plot.plotlyLayout ?? {}) as { meta?: Record<string, unknown> }
        interaction.plot.plotlyLayout = {
          ...currentLayout,
          meta: {
            ...(currentLayout.meta ?? {}),
            plotType,
          },
        }
      }
      plots.push(interaction)
      order += 1
    }
  }

  return plots
}

/**
 * Build multifactorial ANOVA plots (faceted grouped bar + interaction plots)
 * - 2 factors: grouped bar + interaction
 * - 3+ factors: faceted grouped bar + all 2-way interaction plots
 * Only simple-effect brackets are shown (no main-effect brackets).
 */
function buildMultifactorialPlots(result: TestResult): PlotSpecWithStats[] {
  // ============================================================================
  // FEATURE FLAG: Test new composition approach (safe rollback if issues)
  // ============================================================================
  const USE_COMPOSITION_APPROACH = true // TODO: Set to false to rollback instantly

  if (USE_COMPOSITION_APPROACH) {
    console.log('[buildMultifactorialPlots] Using V2 composition approach')
    return buildMultifactorialPlotsV2(result)
  }

  console.log('[buildMultifactorialPlots] Using V1 legacy approach (OLD)')

  // ============================================================================
  // OLD LOGIC (fallback) - preserved for instant rollback
  // ============================================================================
  const resultData = getResultData(result)
  const summaries =
    (resultData.cell_summaries as unknown[] | undefined) ??
    (resultData.cell_means as unknown[] | undefined)

  if (!Array.isArray(summaries) || summaries.length === 0) return []

  const factorNames = getFactorNamesFromResult(resultData)
  if (factorNames.length < 2) return []

  const cellMeans: CellMean[] = (summaries as Record<string, unknown>[]).map((cell) => {
    const factors = parseCellFactors(cell) ?? {}
    return {
      factors,
      mean: Number(cell.mean ?? cell.median ?? 0),
      std: Number(cell.std ?? 0),
      n: Number(cell.n ?? cell.count ?? 0),
    }
  })

  const factorLevels = getFactorLevelCounts(cellMeans, factorNames)
  const effectiveFactors = factorNames.filter((name) => (factorLevels[name] ?? 0) > 1)
  const resolvedFactors = effectiveFactors.length >= 2 ? effectiveFactors : factorNames
  const bracketSettings = createDefaultBracketSettings()
  const errorBarType: 'se' = 'se'
  const plots: PlotSpecWithStats[] = []

  // Primary plot
  if (resolvedFactors.length === 2) {
    const grouped = buildGroupedBarFromResult(result, {
      title: 'Cell Means',
      bracketSettings,
      errorBarType,
    })
    if (grouped) {
      grouped.plot.id = `plot-${result.id}-mf-primary`
      grouped.plot.title = 'Cell Means'
      const currentLayout = (grouped.plot.plotlyLayout ?? {}) as { title?: string | { text?: string } }
      grouped.plot.plotlyLayout = {
        ...currentLayout,
        title:
          typeof currentLayout.title === 'object' && currentLayout.title !== null
            ? { ...currentLayout.title, text: 'Cell Means' }
            : { text: 'Cell Means' },
      }
      plots.push(grouped)
    }
  } else {
    // Extract explicit factor role mapping from result parameters
    const explicitMapping = normalizeFactorMapping(
      (result.parameters as Record<string, unknown> | undefined)?.factor_role_mapping,
      resolvedFactors
    )
    const roles = assignFactorRoles(resolvedFactors, explicitMapping)
    const builder = getPlotBuilder('faceted_grouped_bar')
    const output = builder({
      source: 'test_result',
      testResult: result,
      // columns unused by builder, but provided for completeness
      columns: [
        { role: 'x', columnId: roles.x, columnName: roles.x, values: [], inferredType: 'categorical' },
        { role: 'group', columnId: roles.series, columnName: roles.series, values: [], inferredType: 'categorical' },
        { role: 'y', columnId: 'mean', columnName: 'Mean', values: [], inferredType: 'numeric' },
      ],
      dataPolicy: 'aggregated',
      samplingConfig: null,
      aggregationConfig: null,
      options: {
        title: 'Cell Means',
        showLegend: true,
        showGrid: true,
        colorPalette: DEFAULT_COLORS,
        errorBarType,
        bracketSettings,
        // meta for E2E
        meta: { stats: {} },
      },
      // Pass raw result data for faceted builder
      resultData: { ...resultData, factor_names: resolvedFactors },
    } as any)

    const testFamily = mapFamily(result.family)
    const statisticsFamilyId =
      result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'

    const plot = createTestResultPlotSpec({
      id: `plot-${result.id}-mf-faceted`,
      type: 'faceted_grouped_bar',
      title: 'Cell Means',
      statisticsFamilyId,
      resultId: result.id,
      testType: result.testId,
      testFamily,
      plotlyData: output.data,
      plotlyLayout: output.layout,
      plotlyConfig: output.config,
      dataPolicy: output.dataPolicy,
      samplingConfig: output.samplingConfig,
      aggregationConfig: output.aggregationConfig,
    })

    plots.push({ plot, stats: output.stats })
  }

  // Interaction plots for all 2-way factor pairs
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < resolvedFactors.length; i++) {
    for (let j = i + 1; j < resolvedFactors.length; j++) {
      pairs.push([resolvedFactors[i]!, resolvedFactors[j]!])
    }
  }

  let order = 2
  for (const [a, b] of pairs) {
    const interaction = buildInteractionPlotFromCellMeans(result, cellMeans, a, b, {
      title: `${a} × ${b} Interaction`,
      errorBarType,
    })
    if (interaction) {
      interaction.plot.id = `${interaction.plot.id}-mf-${order}`
      interaction.plot.title = `${a} × ${b} Interaction`
      plots.push(interaction)
      order += 1
    }
  }

  return plots
}

// ============================================================================
// MAIN PLOT GENERATION FUNCTION
// ============================================================================

/**
 * Build plot specifications from a test result using the recipe system.
 * Returns an array of plots as defined by the test's AutoPlotRecipe.
 * Falls back to legacy single-plot logic for tests without recipes.
 */
export function buildPlotSpecsFromResult(result: TestResult): PlotSpecWithStats[] {
  // Secondary guard: Skip plot generation for large datasets
  // Defensive programming - prevents any future caller from accidentally generating plots
  // for large datasets that would freeze Plotly
  if (result.isLargeDataset) {
    console.debug('[buildPlotSpecsFromResult] Skipping - large dataset detected')
    return []
  }

  const normalizedTestId = normalizeTestId(result.testId)
  const recipe = getPlotRecipe(normalizedTestId)

  console.log('[buildPlotSpecsFromResult] Recipe lookup', {
    originalTestId: result.testId,
    normalizedTestId,
    recipeFound: Boolean(recipe),
    recipePlots: recipe?.plots.length,
  })

  // Recipe-based multi-plot generation
  if (recipe) {
    // Custom builder overrides default recipe loop (used for multifactorial ANOVA)
    if (recipe.customBuilder) {
      const specs = recipe.customBuilder(result)
      return specs
    }

    const plots: Array<PlotSpecWithStats & { order: number }> = []

    for (const [index, plotConfig] of recipe.plots.entries()) {
      let plotSpec: PlotSpecWithStats | null = null

      console.log('[buildPlotSpecsFromResult] Building plot', {
        index,
        plotType: plotConfig.type,
        options: plotConfig.options,
      })

      // Route to appropriate helper based on plot type
      switch (plotConfig.type) {
        case 'box': {
          // Use specialized t-test builders with bracket support
          if (normalizedTestId === 't_test_two_sample' || normalizedTestId === 'mann_whitney_u') {
            const bracketSettings = plotConfig.options?.bracketSettings ?? createDefaultBracketSettings()
            plotSpec = buildIndependentTTestPlots(result, 'box', {
              title: plotConfig.options?.title as string | undefined,
              showJitter: plotConfig.options?.showJitter,
              bracketSettings,
            })
            if (!plotSpec) {
              plotSpec = buildBoxPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                showJitter: plotConfig.options?.showJitter,
              })
            }
          } else if (normalizedTestId === 't_test_paired' || normalizedTestId === 'wilcoxon_signed_rank') {
            plotSpec = buildPairedTTestPlots(result, 'box', {
              title: plotConfig.options?.title as string | undefined,
              showJitter: plotConfig.options?.showJitter,
            })
            if (!plotSpec) {
              plotSpec = buildBoxPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                showJitter: plotConfig.options?.showJitter,
              })
            }
          } else if (normalizedTestId === 'anova_one_way') {
            const bracketSettings = plotConfig.options?.bracketSettings ?? createDefaultBracketSettings()
            plotSpec = buildOneWayAnovaPlots(result, 'box', {
              title: plotConfig.options?.title as string | undefined,
              showJitter: plotConfig.options?.showJitter,
              bracketSettings,
            })
            if (!plotSpec) {
              plotSpec = buildBoxPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                showJitter: plotConfig.options?.showJitter,
              })
            }
          } else if (normalizedTestId === 'kruskal_wallis') {
            const bracketSettings = plotConfig.options?.bracketSettings ?? createDefaultBracketSettings()
            plotSpec = buildKruskalWallisPlots(result, 'box', {
              title: plotConfig.options?.title as string | undefined,
              showJitter: plotConfig.options?.showJitter,
              bracketSettings,
            })
            if (!plotSpec) {
              plotSpec = buildBoxPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                showJitter: plotConfig.options?.showJitter,
              })
            }
          } else {
            plotSpec = buildBoxPlotFromResult(result, {
              title: plotConfig.options?.title as string | undefined,
              showJitter: plotConfig.options?.showJitter,
            })
          }
          break
        }
        case 'violin': {
          // Use specialized t-test builders with bracket support
          if (normalizedTestId === 't_test_two_sample' || normalizedTestId === 'mann_whitney_u') {
            const bracketSettings = plotConfig.options?.bracketSettings ?? createDefaultBracketSettings()
            plotSpec = buildIndependentTTestPlots(result, 'violin', {
              title: plotConfig.options?.title as string | undefined,
              showJitter: plotConfig.options?.showJitter,
              bracketSettings,
            })
            if (!plotSpec) {
              plotSpec = buildViolinPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                showJitter: plotConfig.options?.showJitter,
              })
            }
          } else if (normalizedTestId === 't_test_paired' || normalizedTestId === 'wilcoxon_signed_rank') {
            plotSpec = buildPairedTTestPlots(result, 'violin', {
              title: plotConfig.options?.title as string | undefined,
              showJitter: plotConfig.options?.showJitter,
            })
            if (!plotSpec) {
              plotSpec = buildViolinPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                showJitter: plotConfig.options?.showJitter,
              })
            }
          } else if (normalizedTestId === 'anova_one_way') {
            const bracketSettings = plotConfig.options?.bracketSettings ?? createDefaultBracketSettings()
            plotSpec = buildOneWayAnovaPlots(result, 'violin', {
              title: plotConfig.options?.title as string | undefined,
              showJitter: plotConfig.options?.showJitter,
              bracketSettings,
            })
            if (!plotSpec) {
              plotSpec = buildViolinPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                showJitter: plotConfig.options?.showJitter,
              })
            }
          } else if (normalizedTestId === 'kruskal_wallis') {
            const bracketSettings = plotConfig.options?.bracketSettings ?? createDefaultBracketSettings()
            plotSpec = buildKruskalWallisPlots(result, 'violin', {
              title: plotConfig.options?.title as string | undefined,
              showJitter: plotConfig.options?.showJitter,
              bracketSettings,
            })
            if (!plotSpec) {
              plotSpec = buildViolinPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                showJitter: plotConfig.options?.showJitter,
              })
            }
          } else {
            plotSpec = buildViolinPlotFromResult(result, {
              title: plotConfig.options?.title as string | undefined,
              showJitter: plotConfig.options?.showJitter,
            })
          }
          break
        }
        case 'histogram':
          plotSpec = buildHistogramFromResult(result, {
            title: plotConfig.options?.title as string | undefined,
            bins: plotConfig.options?.histogramBins,
            showDensityCurve: plotConfig.options?.showDensityCurve as boolean | undefined,
          })
          break
        case 'column_scatter':
          // Use specialized two-group scatter builders with bracket support
          if (normalizedTestId === 't_test_two_sample') {
            plotSpec = buildIndependentTTestColumnScatter(result, {
              title: plotConfig.options?.title as string | undefined,
              errorBarType: plotConfig.options?.errorBarType as 'se' | 'sd' | 'ci' | 'none' | undefined,
              showMeanLine: plotConfig.options?.showMeanLine as boolean | undefined,
              pointJitterX: plotConfig.options?.pointJitterX as number | undefined,
              bracketSettings: plotConfig.options?.bracketSettings ?? createDefaultBracketSettings(),
            })
            if (!plotSpec) {
              plotSpec = buildColumnScatterFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                errorBarType: plotConfig.options?.errorBarType as
                  | 'se'
                  | 'sd'
                  | 'ci'
                  | 'iqr'
                  | 'none'
                  | undefined,
                showMeanLine: plotConfig.options?.showMeanLine as boolean | undefined,
                pointJitterX: plotConfig.options?.pointJitterX as number | undefined,
                pointSize: plotConfig.options?.pointSize as number | undefined,
              })
            }
          } else if (normalizedTestId === 'mann_whitney_u') {
            plotSpec = buildMannWhitneyColumnScatter(result, {
              title: plotConfig.options?.title as string | undefined,
              errorBarType: plotConfig.options?.errorBarType as 'iqr' | 'none' | undefined,
              showMeanLine: plotConfig.options?.showMeanLine as boolean | undefined,
              pointJitterX: plotConfig.options?.pointJitterX as number | undefined,
              bracketSettings: plotConfig.options?.bracketSettings ?? createDefaultBracketSettings(),
            })
            if (!plotSpec) {
              plotSpec = buildColumnScatterFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                errorBarType: plotConfig.options?.errorBarType as
                  | 'se'
                  | 'sd'
                  | 'ci'
                  | 'iqr'
                  | 'none'
                  | undefined,
                showMeanLine: plotConfig.options?.showMeanLine as boolean | undefined,
                pointJitterX: plotConfig.options?.pointJitterX as number | undefined,
                pointSize: plotConfig.options?.pointSize as number | undefined,
              })
            }
          } else {
            plotSpec = buildColumnScatterFromResult(result, {
              title: plotConfig.options?.title as string | undefined,
              errorBarType: plotConfig.options?.errorBarType as
                | 'se'
                | 'sd'
                | 'ci'
                | 'iqr'
                | 'none'
                | undefined,
              showMeanLine: plotConfig.options?.showMeanLine as boolean | undefined,
              pointJitterX: plotConfig.options?.pointJitterX as number | undefined,
              pointSize: plotConfig.options?.pointSize as number | undefined,
            })
          }
          break
        case 'bar':
          // Use specialized t-test bar builders with bracket support
          if (normalizedTestId === 't_test_two_sample') {
            plotSpec = buildIndependentTTestBarPlot(result, {
              title: plotConfig.options?.title as string | undefined,
              errorBarType: plotConfig.options?.errorBarType as
                | 'se'
                | 'sd'
                | 'ci'
                | 'iqr'
                | 'none'
                | undefined,
              bracketSettings: plotConfig.options?.bracketSettings ?? createDefaultBracketSettings(),
            })
            if (!plotSpec) {
              plotSpec = buildBarPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                errorBarType: plotConfig.options?.errorBarType,
                bracketSettings: plotConfig.options?.bracketSettings,
              })
            }
          } else if (normalizedTestId === 'anova_one_way') {
            plotSpec = buildOneWayAnovaBarPlot(result, 'mean', {
              title: plotConfig.options?.title as string | undefined,
              errorBarType: plotConfig.options?.errorBarType as
                | 'se'
                | 'sd'
                | 'ci'
                | 'iqr'
                | 'none'
                | undefined,
              bracketSettings: plotConfig.options?.bracketSettings ?? createDefaultBracketSettings(),
            })
            if (!plotSpec) {
              plotSpec = buildBarPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                errorBarType: plotConfig.options?.errorBarType,
                bracketSettings: plotConfig.options?.bracketSettings,
              })
            }
          } else if (normalizedTestId === 'kruskal_wallis') {
            plotSpec = buildKruskalWallisBarPlot(result, {
              title: plotConfig.options?.title as string | undefined,
              errorBarType: plotConfig.options?.errorBarType as
                | 'se'
                | 'sd'
                | 'ci'
                | 'iqr'
                | 'none'
                | undefined,
              bracketSettings: plotConfig.options?.bracketSettings ?? createDefaultBracketSettings(),
            })
            if (!plotSpec) {
              plotSpec = buildBarPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                errorBarType: plotConfig.options?.errorBarType,
                bracketSettings: plotConfig.options?.bracketSettings,
              })
            }
          } else if (normalizedTestId === 'mann_whitney_u') {
            plotSpec = buildMannWhitneyBarPlot(result, {
              title: plotConfig.options?.title as string | undefined,
              errorBarType: plotConfig.options?.errorBarType as 'iqr' | 'none' | undefined,
              bracketSettings: plotConfig.options?.bracketSettings ?? createDefaultBracketSettings(),
            })
            if (!plotSpec) {
              plotSpec = buildBarPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                errorBarType: plotConfig.options?.errorBarType,
                bracketSettings: plotConfig.options?.bracketSettings,
              })
            }
          } else if (normalizedTestId === 't_test_paired') {
            plotSpec = buildPairedTTestBarPlot(result, {
              title: plotConfig.options?.title as string | undefined,
              errorBarType: plotConfig.options?.errorBarType as
                | 'se'
                | 'sd'
                | 'ci'
                | 'iqr'
                | 'none'
                | undefined,
            })
            if (!plotSpec) {
              plotSpec = buildBarPlotFromResult(result, {
                title: plotConfig.options?.title as string | undefined,
                errorBarType: plotConfig.options?.errorBarType,
                bracketSettings: plotConfig.options?.bracketSettings,
              })
            }
          } else if (normalizedTestId === 'wilcoxon_signed_rank') {
            // Split bars into separate traces so Colors/Patterns can be edited per category
            plotSpec = buildBarPlotFromResult(result, {
              title: plotConfig.options?.title as string | undefined,
              errorBarType: plotConfig.options?.errorBarType,
              bracketSettings: plotConfig.options?.bracketSettings,
              splitTraces: true,
            })
          } else {
            plotSpec = buildBarPlotFromResult(result, {
              title: plotConfig.options?.title as string | undefined,
              errorBarType: plotConfig.options?.errorBarType,
              bracketSettings: plotConfig.options?.bracketSettings,
              overlayPoints: plotConfig.options?.overlayPoints as boolean | undefined,
              pointJitterX: plotConfig.options?.pointJitterX as number | undefined,
              pointSize: plotConfig.options?.pointSize as number | undefined,
            })
          }
          break
        case 'grouped_bar':
          plotSpec = buildGroupedBarFromResult(result, {
            title: plotConfig.options?.title as string | undefined,
            bracketSettings: plotConfig.options?.bracketSettings,
            errorBarType: plotConfig.options?.errorBarType as 'se' | 'sd' | 'ci' | undefined,
          })
          break
        case 'interaction':
          plotSpec = buildInteractionPlotFromResult(result, {
            title: plotConfig.options?.title as string | undefined,
            errorBarType: plotConfig.options?.errorBarType as 'se' | 'sd' | 'ci' | 'iqr' | 'none' | undefined,
          })
          break
        case 'faceted_grouped_bar':
          plotSpec = buildGroupedBarFromResult(result, {
            title: plotConfig.options?.title as string | undefined,
            bracketSettings: plotConfig.options?.bracketSettings,
            errorBarType: plotConfig.options?.errorBarType as 'se' | 'sd' | 'ci' | undefined,
          })
          break
        default:
          // Unsupported plot type in recipe - skip
          console.warn('[buildPlotSpecsFromResult] Unsupported plot type', plotConfig.type)
          continue
      }

      console.log('[buildPlotSpecsFromResult] Plot build result', {
        plotType: plotConfig.type,
        success: Boolean(plotSpec),
        plotId: plotSpec?.plot.id,
      })

      if (plotSpec) {
        const baseId = plotSpec.plot.id || `plot-${result.id}`
        const order = plotConfig.order ?? index + 1
        const uniqueId = `${baseId}-${plotConfig.type}-${order}`

        // Override title if specified in recipe
        if (plotConfig.title) {
          plotSpec.plot.title = plotConfig.title
          const currentLayout = (plotSpec.plot.plotlyLayout ?? {}) as {
            title?: string | { text?: string }
          }
          const title =
            typeof currentLayout.title === 'object' && currentLayout.title !== null
              ? { ...currentLayout.title, text: plotConfig.title }
              : { text: plotConfig.title }
          plotSpec.plot.plotlyLayout = {
            ...currentLayout,
            title,
          }
        }
        plotSpec.plot.id = uniqueId
        plots.push({ ...plotSpec, order })
      }
    }

    // Sort by order and strip order property
    return plots.sort((a, b) => a.order - b.order).map(({ order, ...rest }) => rest)
  }

  // Legacy single-plot fallback (for tests without recipes)
  const primary = getPrimaryPlot(normalizedTestId)
  const plotType = primary?.id ?? 'scatter'
  const testFamily = mapFamily(result.family)
  const statisticsFamilyId =
    result.statisticsFamilyId ?? useAppStore.getState().activeFamilyId ?? 'statistics-1'
  const stats = {
    ...extractNumericStats(result.statistics),
    ...extractNumericStats(result.modelFit),
  }

  const plotlyJson = result.visualizations?.plotlyJson
  if (plotlyJson) {
    let plotlyObj: { data?: unknown[]; layout?: unknown; config?: unknown }
    try {
      plotlyObj =
        typeof plotlyJson === 'string'
          ? JSON.parse(plotlyJson)
          : (plotlyJson as { data?: unknown[]; layout?: unknown; config?: unknown })
    } catch {
      return []
    }

    const firstTrace = plotlyObj.data?.[0] as { type?: string; mode?: string } | undefined
    const plotlyType = mapPlotlyType(firstTrace?.type, firstTrace?.mode)
    let resolvedType = primary?.id ?? plotlyType
    const title =
      (plotlyObj.layout as { title?: { text?: string } })?.title?.text ?? result.testName

    let data = plotlyObj.data ?? []
    let layout = plotlyObj.layout ?? {}

    if (primary?.id === 'bar') {
      const converted = tryConvertBoxToBar(plotlyObj.data as Array<Record<string, unknown>>)
      if (converted) {
        data = converted.data
        layout = {
          ...layout,
          xaxis: { title: 'Group' },
        }
        resolvedType = 'bar'
      } else if (plotlyType !== 'bar') {
        resolvedType = plotlyType
      }
    }

    const plot = createTestResultPlotSpec({
      id: `plot-${result.id}`,
      type: resolvedType,
      title,
      statisticsFamilyId,
      resultId: result.id,
      testType: result.testId,
      testFamily,
      plotlyData: data,
      plotlyLayout: layout,
      plotlyConfig: ((plotlyObj as { config?: unknown }).config ?? {}) as Partial<import('plotly.js').Config>,
      dataPolicy: 'raw',
      samplingConfig: null,
      aggregationConfig: null,
    })

    return [{ plot, stats }]
  }

  if (!primary) return []

  const builder = getPlotBuilder(plotType)
  const output = builder({
    source: 'test_result',
    testResult: result,
    columns: [],
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
    options: {
      title: result.testName,
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
  })

  const plot = createTestResultPlotSpec({
    id: `plot-${result.id}`,
    type: plotType,
    title: result.testName,
    statisticsFamilyId,
    resultId: result.id,
    testType: result.testId,
    testFamily,
    plotlyData: output.data,
    plotlyLayout: output.layout,
    plotlyConfig: output.config,
    dataPolicy: output.dataPolicy,
    samplingConfig: output.samplingConfig,
    aggregationConfig: output.aggregationConfig,
  })

  return [{ plot, stats: { ...stats, ...output.stats } }]
}

/**
 * Legacy wrapper for backward compatibility.
 * Returns first plot from buildPlotSpecsFromResult or null.
 * @deprecated Use buildPlotSpecsFromResult instead
 */
export function buildPlotSpecFromResult(result: TestResult): PlotSpecWithStats | null {
  const plots = buildPlotSpecsFromResult(result)
  return plots[0] ?? null
}

/**
 * Rebuild a single test-result plot with updated options (e.g., error bars).
 *
 * For multifactorial ANOVA (3+ factors), routes to buildMultifactorialPlotsV2
 * and returns the primary plot.
 *
 * Design split: `lmmStyleOverrides` is only accepted here (the rebuild path).
 * Initial plot generation goes through `buildPlotSpecsFromResult` / `customBuilder`,
 * where no user overrides exist yet — see LMM_PLOT_RECIPES for the rationale comment.
 */
export function rebuildTestResultPlot(
  result: TestResult,
  plotType: PlotType,
  opts: {
    title?: string
    errorBarType?: 'se' | 'sd' | 'ci' | 'iqr' | 'none'
    bracketSettings?: BracketSettings
    showMeanLine?: boolean
    overlayPoints?: boolean
    pointJitterX?: number
    pointSize?: number
    lmmMode?: 'trajectory' | 'contrast' | 'line_unavailable' | null
    facetKey?: string | null
    testType?: string | null
    lmmStyleOverrides?: Record<string, import('./plotResult/lmm/resolveTraceRoles').LmmTraceRoleOverride>
  } = {}
): PlotSpecWithStats | null {
  const normalizedTestId = normalizeTestId(result.testId)
  const forceSeForAnovaBar =
    (normalizedTestId === 'anova_one_way' ||
      normalizedTestId === 'anova_two_way' ||
      normalizedTestId === 'multifactorial_anova') &&
    (plotType === 'bar' || plotType === 'grouped_bar')
  const normalizedErrorBarType = forceSeForAnovaBar ? 'se' : opts.errorBarType

  // LMM ANOVA: always rebuild through buildLmmPlots to preserve normalized semantics.
  // Generic grouped_bar / line builders know nothing about LMM's estimated_means or
  // continuous_effects structure, so routing through them would produce wrong output.
  if (normalizedTestId === 'lmm_anova' && (plotType === 'grouped_bar' || plotType === 'line')) {
    const allSpecs = buildLmmPlots(result, opts.lmmStyleOverrides)
    const match = allSpecs.find(
      s =>
        s.plot.type === plotType &&
        (opts.lmmMode == null || s.plot.lmmMode === opts.lmmMode) &&
        (opts.facetKey == null || s.plot.facetKey === opts.facetKey) &&
        (opts.testType == null ||
          (s.plot.testType != null &&
            normalizeTestId(s.plot.testType) === normalizeTestId(opts.testType)))
    )
    return match ?? null
  }

  // Detect multifactorial ANOVA (3+ factors)
  if (plotType === 'grouped_bar' && normalizedTestId === 'multifactorial_anova') {
    const resultData = getResultData(result)
    const factorNames = getFactorNamesFromResult(resultData)

    // If 3+ factors, use buildMultifactorialPlotsV2
    if (factorNames.length >= 3) {
      const plots = buildMultifactorialPlotsV2(result, opts)
      // Return the primary plot (first in array)
      return plots.length > 0 ? plots[0]! : null
    }
  }

  switch (plotType) {
    case 'bar':
      if (normalizedTestId === 't_test_two_sample') {
        return buildIndependentTTestBarPlot(result, {
          title: opts.title ?? result.testName,
          errorBarType: normalizedErrorBarType,
          bracketSettings: opts.bracketSettings,
        })
      }
      if (normalizedTestId === 'mann_whitney_u') {
        return buildMannWhitneyBarPlot(result, {
          title: opts.title ?? result.testName,
          errorBarType: normalizedErrorBarType as 'iqr' | 'none' | undefined,
          bracketSettings: opts.bracketSettings,
        })
      }
      if (normalizedTestId === 't_test_paired') {
        return buildPairedTTestBarPlot(result, {
          title: opts.title ?? result.testName,
          errorBarType: normalizedErrorBarType,
        })
      }
      if (normalizedTestId === 'anova_one_way') {
        return buildOneWayAnovaBarPlot(result, 'mean', {
          title: opts.title ?? result.testName,
          errorBarType: normalizedErrorBarType,
          bracketSettings: opts.bracketSettings,
        })
      }
      if (normalizedTestId === 'kruskal_wallis') {
        return buildKruskalWallisBarPlot(result, {
          title: opts.title ?? result.testName,
          errorBarType: normalizedErrorBarType,
          bracketSettings: opts.bracketSettings,
        })
      }
      return buildBarPlotFromResult(result, {
        title: opts.title ?? result.testName,
        errorBarType: normalizedErrorBarType,
        bracketSettings: opts.bracketSettings,
        overlayPoints: opts.overlayPoints,
        pointJitterX: opts.pointJitterX,
        pointSize: opts.pointSize,
      })
    case 'grouped_bar':
      return buildGroupedBarFromResult(result, {
        title: opts.title ?? result.testName,
        errorBarType: normalizedErrorBarType,
        bracketSettings: opts.bracketSettings,
      })
    case 'column_scatter':
      if (normalizedTestId === 't_test_two_sample') {
        return buildIndependentTTestColumnScatter(result, {
          title: opts.title ?? result.testName,
          errorBarType: normalizedErrorBarType as 'se' | 'sd' | 'ci' | 'none' | undefined,
          showMeanLine: opts.showMeanLine,
          pointJitterX: opts.pointJitterX,
          bracketSettings: opts.bracketSettings,
        })
      }
      if (normalizedTestId === 'mann_whitney_u') {
        return buildMannWhitneyColumnScatter(result, {
          title: opts.title ?? result.testName,
          errorBarType: normalizedErrorBarType as 'iqr' | 'none' | undefined,
          showMeanLine: opts.showMeanLine,
          pointJitterX: opts.pointJitterX,
          bracketSettings: opts.bracketSettings,
        })
      }
      return buildColumnScatterFromResult(result, {
        title: opts.title ?? result.testName,
        errorBarType: normalizedErrorBarType,
        showMeanLine: opts.showMeanLine,
        pointJitterX: opts.pointJitterX,
        pointSize: opts.pointSize,
      })
    default:
      return null
  }
}
