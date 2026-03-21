/**
 * Generate correlation plots (Pearson, Spearman, Kendall)
 *
 * Plot 1: Scatter plot with regression line (Pearson only)
 * Plot 2: Correlation matrix heatmap (Pearson, Spearman, Kendall)
 */

import type { TestResult } from '@/store/results-store'
import type { Group3PlotOutput } from '../types'
import {
  buildPearsonCorrelationHeatmap,
  buildSpearmanCorrelationHeatmap,
  buildKendallCorrelationHeatmap,
  scatterBuilder,
  type PlotBuilderInput,
} from '@/utils/plotBuilders'
import { DEFAULT_COLORS } from '@/utils/plotBuilders/common'

/**
 * Generate scatter plot for correlation (used by Pearson only)
 */
export function generateCorrelationScatter(
  result: TestResult,
  xColumn: { columnId: string; columnName: string; values: unknown[] },
  yColumn: { columnId: string; columnName: string; values: unknown[] },
  titlePrefix: string = 'Correlation',
): Group3PlotOutput | null {
  // Build scatter plot using existing scatterBuilder
  const input: PlotBuilderInput = {
    source: 'test_result',
    columns: [
      {
        columnId: xColumn.columnId,
        columnName: xColumn.columnName,
        role: 'x',
        inferredType: 'numeric',
        values: xColumn.values,
      },
      {
        columnId: yColumn.columnId,
        columnName: yColumn.columnName,
        role: 'y',
        inferredType: 'numeric',
        values: yColumn.values,
      },
    ],
    testResult: result,
    options: {
      title: `${titlePrefix}: ${xColumn.columnName} vs ${yColumn.columnName}`,
      showLegend: true,
      showGrid: true,
      colorPalette: DEFAULT_COLORS,
    },
    dataPolicy: 'raw',
    samplingConfig: null,
    aggregationConfig: null,
  }

  const builderOutput = scatterBuilder(input)

  return {
    plotlyData: builderOutput.data,
    plotlyLayout: {
      ...(builderOutput.layout as object),
      meta: {
        ...(builderOutput.layout.meta ?? {}),
        stats: builderOutput.stats,
      },
    },
    plotlyConfig: builderOutput.config,
  }
}

/**
 * Generate Pearson correlation heatmap
 */
export function generatePearsonCorrelationHeatmap(result: TestResult): Group3PlotOutput | null {
  const builderOutput = buildPearsonCorrelationHeatmap(result)

  return {
    plotlyData: builderOutput.data,
    plotlyLayout: {
      ...(builderOutput.layout as object),
      meta: {
        ...(builderOutput.layout.meta ?? {}),
        stats: builderOutput.stats,
      },
    },
    plotlyConfig: builderOutput.config,
  }
}

/**
 * Generate Spearman correlation heatmap
 */
export function generateSpearmanCorrelationHeatmap(result: TestResult): Group3PlotOutput | null {
  const builderOutput = buildSpearmanCorrelationHeatmap(result)

  return {
    plotlyData: builderOutput.data,
    plotlyLayout: {
      ...(builderOutput.layout as object),
      meta: {
        ...(builderOutput.layout.meta ?? {}),
        stats: builderOutput.stats,
      },
    },
    plotlyConfig: builderOutput.config,
  }
}

/**
 * Generate Kendall correlation heatmap
 */
export function generateKendallCorrelationHeatmap(result: TestResult): Group3PlotOutput | null {
  const builderOutput = buildKendallCorrelationHeatmap(result)

  return {
    plotlyData: builderOutput.data,
    plotlyLayout: {
      ...(builderOutput.layout as object),
      meta: {
        ...(builderOutput.layout.meta ?? {}),
        stats: builderOutput.stats,
      },
    },
    plotlyConfig: builderOutput.config,
  }
}
