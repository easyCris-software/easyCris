/**
 * Synergy Contour Placeholder Builder
 *
 * This is a placeholder for the BUILDERS registry.
 * Actual synergy contour plots are auto-generated from test results
 * via customBuilder in plotResultService.ts
 */

import type { PlotBuilderFn } from './types'
import { createPlaceholderOutputFromInput } from './placeholder'

export const synergyContourBuilder: PlotBuilderFn = (input) => {
  return createPlaceholderOutputFromInput(
    'synergy_contour',
    input,
    'Synergy Contour plots are auto-generated from test results (Bliss/HSA/Loewe/ZIP)'
  )
}
