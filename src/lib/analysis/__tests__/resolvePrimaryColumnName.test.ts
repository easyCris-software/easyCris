/**
 * resolvePrimaryColumnName — precedence tests (TDD Red Phase)
 *
 * Required order (highest to lowest priority):
 *   1. payloadMetadata.variable_name
 *   2. payloadData.value_name
 *   3. payloadData.dependent_name
 *   4. payloadData.value_column
 *   5. selectedColumnName (selectedColumns[0].columnName)
 *   6. 'response' (hardcoded fallback)
 *
 * Critical rule: explicit payload metadata must win over selectedColumns[0]
 * so that LMM's dependent_name is always used when present, regardless of
 * column selection order.
 */

import { describe, it, expect } from 'vitest'
import { resolvePrimaryColumnName } from '@/lib/analysis/resolvePrimaryColumnName'

describe('resolvePrimaryColumnName — precedence', () => {
  it('prefers payloadMetadata.variable_name over everything', () => {
    expect(
      resolvePrimaryColumnName(
        { variable_name: 'From metadata' },
        { value_name: 'From value_name', dependent_name: 'From payload', value_column: 'Also payload' },
        'From column'
      )
    ).toBe('From metadata')
  })

  it('prefers value_name over dependent_name and selectedColumnName when metadata absent', () => {
    expect(
      resolvePrimaryColumnName(
        {},
        { value_name: 'Preferred value_name', dependent_name: 'Temperature (°C)', value_column: 'temp' },
        'value'
      )
    ).toBe('Preferred value_name')
  })

  it('prefers dependent_name over selectedColumnName when value_name absent', () => {
    expect(
      resolvePrimaryColumnName(
        {},
        { dependent_name: 'Temperature (°C)', value_column: 'temp' },
        'value' // selectedColumns[0] — must NOT win here
      )
    ).toBe('Temperature (°C)')
  })

  it('prefers value_column over selectedColumnName when dependent_name absent', () => {
    expect(
      resolvePrimaryColumnName(
        {},
        { value_column: 'Body Weight (g)' },
        'value' // selectedColumns[0] — must NOT win here
      )
    ).toBe('Body Weight (g)')
  })

  it('falls back to selectedColumnName when no payload metadata present', () => {
    expect(
      resolvePrimaryColumnName(
        {},
        {},
        'latency'
      )
    ).toBe('latency')
  })

  it('falls back to response when all sources absent', () => {
    expect(
      resolvePrimaryColumnName({}, {}, undefined)
    ).toBe('response')
  })

  it('skips empty string dependent_name and tries next candidate', () => {
    expect(
      resolvePrimaryColumnName(
        {},
        { dependent_name: '', value_column: 'Tail Flick Latency' },
        'value'
      )
    ).toBe('Tail Flick Latency')
  })

  it('skips empty string value_name and tries dependent_name next', () => {
    expect(
      resolvePrimaryColumnName(
        {},
        { value_name: '', dependent_name: 'Dependent Label', value_column: 'Value Col' },
        'value'
      )
    ).toBe('Dependent Label')
  })

  it('skips whitespace-only dependent_name and tries next candidate', () => {
    expect(
      resolvePrimaryColumnName(
        {},
        { dependent_name: '   ', value_column: 'Center Time (s)' },
        'value'
      )
    ).toBe('Center Time (s)')
  })

  it('skips whitespace-only value_name and tries dependent_name next', () => {
    expect(
      resolvePrimaryColumnName(
        {},
        { value_name: '   ', dependent_name: 'Center Time (s)', value_column: 'Center Time' },
        'value'
      )
    ).toBe('Center Time (s)')
  })
})
