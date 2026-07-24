import { afterEach, describe, expect, it } from 'vitest'
import {
  areFormulaBarAutocompletePlacementsEqual,
  isAutocompleteDropdownEventTarget,
  type FormulaBarAutocompletePlacement,
} from '../formulaAutocompletePlacement'

describe('formulaAutocompletePlacement', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('detects event targets inside formula autocomplete dropdown', () => {
    const dropdown = document.createElement('div')
    dropdown.className = 'formula-autocomplete-dropdown'
    const child = document.createElement('div')
    dropdown.appendChild(child)
    document.body.appendChild(dropdown)

    expect(isAutocompleteDropdownEventTarget(child)).toBe(true)
    expect(isAutocompleteDropdownEventTarget(dropdown)).toBe(true)
  })

  it('ignores event targets outside formula autocomplete dropdown', () => {
    const outside = document.createElement('div')
    document.body.appendChild(outside)

    expect(isAutocompleteDropdownEventTarget(outside)).toBe(false)
    expect(isAutocompleteDropdownEventTarget(window)).toBe(false)
    expect(isAutocompleteDropdownEventTarget(null)).toBe(false)
  })

  it('compares placement values by geometry fields', () => {
    const base: FormulaBarAutocompletePlacement = {
      top: 100,
      left: 20,
      width: 480,
      maxHeight: 160,
    }
    const same: FormulaBarAutocompletePlacement = {
      top: 100,
      left: 20,
      width: 480,
      maxHeight: 160,
    }
    const changed: FormulaBarAutocompletePlacement = {
      top: 101,
      left: 20,
      width: 480,
      maxHeight: 160,
    }

    expect(areFormulaBarAutocompletePlacementsEqual(base, same)).toBe(true)
    expect(areFormulaBarAutocompletePlacementsEqual(base, changed)).toBe(false)
    expect(areFormulaBarAutocompletePlacementsEqual(base, null)).toBe(false)
    expect(areFormulaBarAutocompletePlacementsEqual(null, null)).toBe(true)
  })
})
