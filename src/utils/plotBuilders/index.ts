/**
 * Plot Builders - Factory & Registry
 */

import type { PlotType } from '@/config/plotRegistry'
import type { PlotBuilderFn } from './types'
import { createPlaceholderOutputFromInput } from './placeholder'
import { barPlotBuilder } from './barPlotBuilder'
import { scatterBuilder } from './scatterBuilder'
import { histogramBuilder } from './histogramBuilder'
import { qqPlotBuilder } from './qqPlotBuilder'
import { boxPlotBuilder } from './boxPlotBuilder'
import { violinPlotBuilder } from './violinPlotBuilder'
import { groupedBarBuilder } from './groupedBarBuilder'
import { stackedBarBuilder } from './stackedBarBuilder'
import { linePlotBuilder } from './linePlotBuilder'
import { interactionPlotBuilder } from './interactionPlotBuilder'
import { facetedGroupedBarBuilder } from './facetedGroupedBarBuilder'
import { residualBuilder } from './residualBuilder'
import { pieChartBuilder } from './pieChartBuilder'
import { survivalBuilder } from './survivalBuilder'
import { doseResponseBuilder } from './doseResponseBuilder'
import { forestPlotBuilder } from './forestPlotBuilder'
import { synergyMatrixBuilder } from './synergyMatrixBuilder'
import { synergyContourBuilder } from './synergyContourPlaceholder'
import { synergyHeatmapBuilder } from './synergyHeatmapBuilder'
import { mosaicBuilder } from './mosaicBuilder'
import { heatmapBuilder } from './heatmapBuilder'
import { columnScatterBuilder } from './columnScatterBuilder'

// Group 2 dose-response curve builders
export { buildDoseResponseCurveFromResult } from './doseResponseCurveBuilder'
export { buildDoseResponseCompareFromResult } from './doseResponseCompareBuilder'

// Group 2 synergy plot builders
export { buildSynergyContourFromResult, buildSynergyContourPlotsFromAll } from './synergyContourBuilder'
export { buildSynergyHeatmapFromResult, buildSynergyHeatmapPlotsFromAll } from './synergyHeatmapBuilder'
export { buildLoeweIsobologramFromResult } from './loeweIsobologramBuilder'

// Group 3 regression/correlation plot builders
export { buildPearsonCorrelationHeatmap, buildSpearmanCorrelationHeatmap, buildKendallCorrelationHeatmap } from './correlationHeatmapBuilder'
export { buildROCCurveFromResult } from './rocCurveBuilder'

// Matrix heatmap helper (shared between synergy and correlation)
export { buildMatrixHeatmap } from './matrixHeatmapHelper'

export * from './types'
export * from './common'
export * from './factorRoleAssignment'
export * from './filterSimpleEffectBrackets'
export * from './barPlotBuilder'
export * from './scatterBuilder'
export * from './histogramBuilder'
export * from './qqPlotBuilder'
export * from './boxPlotBuilder'
export * from './violinPlotBuilder'
export * from './columnScatterBuilder'
export * from './groupedBarBuilder'
export * from './stackedBarBuilder'
export * from './linePlotBuilder'
export * from './interactionPlotBuilder'
export * from './facetedGroupedBarBuilder'
export * from './residualBuilder'
export * from './pieChartBuilder'
export * from './survivalBuilder'
export * from './doseResponseBuilder'
export * from './forestPlotBuilder'
export * from './synergyMatrixBuilder'
export * from './synergyHeatmapBuilder'
export * from './mosaicBuilder'
export * from './heatmapBuilder'

function createPlaceholderBuilder(plotType: PlotType): PlotBuilderFn {
  return (input) => createPlaceholderOutputFromInput(plotType, input, input.options.title)
}

const scatterGlBuilder: PlotBuilderFn = (input) => {
  const output = scatterBuilder(input)
  return {
    ...output,
    data: output.data.map((trace) =>
      typeof trace === 'object' ? { ...trace, type: 'scattergl' } : trace
    ),
  }
}

const BUILDERS: Partial<Record<PlotType, PlotBuilderFn>> = {
  bar: barPlotBuilder,
  faceted_grouped_bar: facetedGroupedBarBuilder,
  grouped_bar: groupedBarBuilder,
  stacked_bar: stackedBarBuilder,
  box: boxPlotBuilder,
  violin: violinPlotBuilder,
  column_scatter: columnScatterBuilder,
  scatter: scatterBuilder,
  scattergl: scatterGlBuilder,
  line: linePlotBuilder,
  histogram: histogramBuilder,
  pie: pieChartBuilder,
  qq: qqPlotBuilder,
  residual: residualBuilder,
  survival: survivalBuilder,
  doseresponse: doseResponseBuilder,
  forest: forestPlotBuilder,
  interaction: interactionPlotBuilder,
  synergy_matrix: synergyMatrixBuilder,
  synergy_contour: synergyContourBuilder,
  synergy_heatmap: synergyHeatmapBuilder,
  mosaic: mosaicBuilder,
  heatmap: heatmapBuilder,
}

export function getPlotBuilder(plotType: PlotType): PlotBuilderFn {
  return BUILDERS[plotType] ?? createPlaceholderBuilder(plotType)
}

export function hasPlotBuilder(plotType: PlotType): boolean {
  return plotType in BUILDERS
}

export function getImplementedPlotTypes(): PlotType[] {
  return Object.keys(BUILDERS) as PlotType[]
}
