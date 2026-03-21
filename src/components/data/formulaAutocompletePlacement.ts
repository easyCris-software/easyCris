export const FORMULA_AUTOCOMPLETE_DROPDOWN_SELECTOR = '.formula-autocomplete-dropdown'

export type FormulaBarAutocompletePlacement = {
  top: number
  left: number
  width: number
  maxHeight: number
}

export function isAutocompleteDropdownEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest(FORMULA_AUTOCOMPLETE_DROPDOWN_SELECTOR) !== null
}

export function areFormulaBarAutocompletePlacementsEqual(
  left: FormulaBarAutocompletePlacement | null,
  right: FormulaBarAutocompletePlacement | null
): boolean {
  if (left === right) return true
  if (!left || !right) return false

  return (
    left.top === right.top &&
    left.left === right.left &&
    left.width === right.width &&
    left.maxHeight === right.maxHeight
  )
}
