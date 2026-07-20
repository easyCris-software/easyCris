/**
 * Fill Handle Utilities - Phase 7
 *
 * Logic for determining how to fill cells when dragging the fill handle.
 * Supports:
 * - Simple copy (default)
 * - Numeric series (linear progression)
 * - Formula shifting (handled by FormulaService)
 */

export type FillMode = 'copy' | 'series'

/**
 * Detect if values form a numeric series (linear progression)
 * Returns the step size if series detected, null otherwise
 */
function detectNumericSeries(values: unknown[]): number | null {
  if (values.length < 2) return null

  // Filter to numeric values
  const numbers = values
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((n) => !isNaN(n))

  if (numbers.length < 2) return null

  // Check if all steps are consistent
  const firstStep = numbers[1]! - numbers[0]!
  const tolerance = 1e-10

  for (let i = 2; i < numbers.length; i++) {
    const step = numbers[i]! - numbers[i - 1]!
    if (Math.abs(step - firstStep) > tolerance) {
      return null // Not a consistent series
    }
  }

  return firstStep
}

/**
 * Decide fill mode based on source values
 * For now: simple copy or numeric series detection
 */
export function decideFillMode(sourceValues: unknown[]): FillMode {
  // Try numeric series detection
  const step = detectNumericSeries(sourceValues)
  if (step !== null) {
    return 'series'
  }

  // Default: simple copy
  return 'copy'
}

/**
 * Compute filled value for a target cell
 * @param mode - Fill mode (copy or series)
 * @param sourceValues - Values from the source block (in fill direction)
 * @param targetIndex - Index of the target cell (0-based, relative to end of source)
 * @returns The value to fill
 */
export function computeFilledValue(
  mode: FillMode,
  sourceValues: unknown[],
  targetIndex: number
): unknown {
  if (sourceValues.length === 0) {
    return null
  }

  if (mode === 'copy') {
    // Cycle through source values
    return sourceValues[targetIndex % sourceValues.length]
  }

  if (mode === 'series') {
    // Compute next value in series
    const step = detectNumericSeries(sourceValues)
    if (step === null) {
      // Fallback to copy if series detection fails
      return sourceValues[targetIndex % sourceValues.length]
    }

    const lastValue = sourceValues[sourceValues.length - 1]
    const lastNumber = typeof lastValue === 'number' ? lastValue : Number(lastValue)

    if (isNaN(lastNumber)) {
      return sourceValues[targetIndex % sourceValues.length]
    }

    // Continue series: lastValue + step * (targetIndex + 1)
    // targetIndex is 0-based from end of source, so first target cell is targetIndex=0
    return lastNumber + step * (targetIndex + 1)
  }

  return null
}
