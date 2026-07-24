/**
 * Heatmap Builder (Legacy)
 *
 * Legacy-only plot type. New heatmaps should not be created in Phase 1.
 */

import type { PlotBuilderFn, PlotBuilderOutput } from './types'
import { createPlaceholderOutputFromInput } from './placeholder'

export const heatmapBuilder: PlotBuilderFn = (input): PlotBuilderOutput => {
  return createPlaceholderOutputFromInput(
    'heatmap',
    input,
    input.options.title,
    'Heatmap builder is legacy-only'
  )
}

export default heatmapBuilder
