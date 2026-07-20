export type DoseResponseInterpolationModel = '3PL' | '4PL'
export type DoseResponseInterpolationMode = 'forward' | 'inverse'

export interface DoseResponseFitParameters {
  bottom: number
  top: number
  ic50: number
  hill: number
}

export interface DoseResponseInterpolationContext {
  model: DoseResponseInterpolationModel
  parameters: DoseResponseFitParameters
  observedDoseRange?: [number, number] | null
}

export type DoseResponseInterpolationStatus =
  | 'ok'
  | 'invalid_input'
  | 'out_of_range'
  | 'no_solution'

export interface DoseResponseInterpolationResult {
  status: DoseResponseInterpolationStatus
  value: number | null
  extrapolated: boolean
  message: string
}

export interface DoseResponseInterpolationOptions {
  allowExtrapolation?: boolean
}

export function normalizeDoseResponseInterpolationModel(
  value?: string
): DoseResponseInterpolationModel | null {
  if (!value) return null
  const upper = value.toUpperCase()
  if (upper.startsWith('3PL') || upper.includes('DOSE_RESPONSE_3PL')) return '3PL'
  if (upper.startsWith('4PL') || upper.includes('DOSE_RESPONSE_4PL')) return '4PL'
  return null
}

export function evaluateDoseResponseValue(
  parameters: DoseResponseFitParameters,
  concentration: number
): number | null {
  if (!Number.isFinite(concentration) || concentration <= 0) return null
  if (!Number.isFinite(parameters.ic50) || parameters.ic50 <= 0) return null

  const ratio = concentration / parameters.ic50
  const denominator = 1 + Math.pow(ratio, -parameters.hill)
  if (!Number.isFinite(denominator) || denominator === 0) return null

  const predicted =
    parameters.bottom + (parameters.top - parameters.bottom) / denominator
  return Number.isFinite(predicted) ? predicted : null
}

export function invertDoseResponseValue(
  parameters: DoseResponseFitParameters,
  response: number
): number | null {
  if (!Number.isFinite(response)) return null
  if (!Number.isFinite(parameters.ic50) || parameters.ic50 <= 0) return null
  if (!Number.isFinite(parameters.hill) || parameters.hill === 0) return null

  const delta = parameters.top - parameters.bottom
  if (!Number.isFinite(delta) || delta === 0) return null

  const denominator = response - parameters.bottom
  if (!Number.isFinite(denominator) || denominator === 0) return null

  const base = delta / denominator - 1
  if (!Number.isFinite(base) || base <= 0) return null

  const exponent = -1 / parameters.hill
  const concentration = parameters.ic50 * Math.pow(base, exponent)
  if (!Number.isFinite(concentration) || concentration <= 0) return null

  return concentration
}

export function interpolateDoseResponse(
  context: DoseResponseInterpolationContext,
  mode: DoseResponseInterpolationMode,
  inputValue: number,
  options?: DoseResponseInterpolationOptions
): DoseResponseInterpolationResult {
  const allowExtrapolation = options?.allowExtrapolation === true
  const { parameters, observedDoseRange } = context

  if (!Number.isFinite(inputValue)) {
    return {
      status: 'invalid_input',
      value: null,
      extrapolated: false,
      message: 'Enter a valid numeric value.',
    }
  }

  const isDoseOutsideObserved = (dose: number) => {
    if (!observedDoseRange) return false
    const [minDose, maxDose] = observedDoseRange
    if (!Number.isFinite(minDose) || !Number.isFinite(maxDose)) return false
    return dose < minDose || dose > maxDose
  }

  if (mode === 'forward') {
    if (inputValue <= 0) {
      return {
        status: 'invalid_input',
        value: null,
        extrapolated: false,
        message: 'Concentration must be greater than 0.',
      }
    }

    const predicted = evaluateDoseResponseValue(parameters, inputValue)
    if (predicted === null) {
      return {
        status: 'no_solution',
        value: null,
        extrapolated: false,
        message: 'Unable to evaluate prediction for this concentration.',
      }
    }

    const extrapolated = isDoseOutsideObserved(inputValue)
    if (extrapolated && !allowExtrapolation) {
      return {
        status: 'out_of_range',
        value: null,
        extrapolated: true,
        message: 'Input is outside observed dose range. Enable extrapolation to continue.',
      }
    }

    return {
      status: 'ok',
      value: predicted,
      extrapolated,
      message: extrapolated
        ? 'Extrapolated prediction outside observed dose range.'
        : 'Prediction computed from fitted curve.',
    }
  }

  const responseMin = Math.min(parameters.bottom, parameters.top)
  const responseMax = Math.max(parameters.bottom, parameters.top)
  if (inputValue <= responseMin || inputValue >= responseMax) {
    return {
      status: 'out_of_range',
      value: null,
      extrapolated: false,
      message: `Response must be between ${responseMin.toPrecision(4)} and ${responseMax.toPrecision(4)} (exclusive).`,
    }
  }

  const estimatedDose = invertDoseResponseValue(parameters, inputValue)
  if (estimatedDose === null) {
    return {
      status: 'no_solution',
      value: null,
      extrapolated: false,
      message: 'Unable to solve concentration for this response value.',
    }
  }

  const extrapolated = isDoseOutsideObserved(estimatedDose)
  if (extrapolated && !allowExtrapolation) {
    return {
      status: 'out_of_range',
      value: null,
      extrapolated: true,
      message: 'Estimated concentration falls outside observed dose range. Enable extrapolation to continue.',
    }
  }

  return {
    status: 'ok',
    value: estimatedDose,
    extrapolated,
    message: extrapolated
      ? 'Estimated concentration is extrapolated outside observed dose range.'
      : 'Estimated concentration computed from fitted curve.',
  }
}
