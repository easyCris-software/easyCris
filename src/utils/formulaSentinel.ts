export const FORMULA_PENDING_SENTINEL = '__CALCULATING__'

export function isPendingCalculation(value: unknown): boolean {
  return value === FORMULA_PENDING_SENTINEL
}
