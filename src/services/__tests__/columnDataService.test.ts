import { describe, expect, it } from 'vitest'
import {
  applyColumnTypeOverride,
  classifyColumn,
  classifyColumnFromStats,
  ColumnDataType,
  isMissingValue,
} from '@/services/columnDataService'

describe('columnDataService', () => {
  const toRowData = (columnId: string, values: Array<string | null | undefined>) =>
    new Map(values.map((value, index) => [index, { [columnId]: value }]))

  it('treats missing indicators as case-insensitive', () => {
    expect(isMissingValue('NA')).toBe(true)
    expect(isMissingValue('NaN')).toBe(true)
    expect(isMissingValue('MISSING')).toBe(true)
    expect(isMissingValue('  #N/A  ')).toBe(true)
    expect(isMissingValue('value')).toBe(false)
  })

  it('classifies mostly numeric columns with one missing marker as numeric', () => {
    const classification = classifyColumn(
      'col_y',
      'y',
      toRowData('col_y', ['2.3', '4.1', '5.8', 'NA', '7.2', '8.5', '10.1', '11.8', '13.2', '14.9', '16.3'])
    )

    expect(classification.dataType).toBe(ColumnDataType.Numeric)
    expect(classification.numericValues).toBe(10)
    expect(classification.missingValues).toBe(1)
  })

  it('uses backend distinctCountCaseFolded instead of capped distinctValues sample', () => {
    const classification = classifyColumnFromStats('col_group', 'group', {
      columnId: 'col_group',
      totalRows: 500,
      nonNullCount: 500,
      distinctCount: 500,
      distinctCountCaseFolded: 250,
      distinctValues: Array.from({ length: 50 }, (_, i) => `label_${i}`),
      numericCount: 0,
      integerCount: 0,
      minValue: null,
      maxValue: null,
    })

    expect(classification.uniqueValueCount).toBe(250)
    expect(classification.uniqueValues.length).toBe(50)
  })

  it('requires integerCount evidence for ordinal stats-path classification', () => {
    const nonOrdinal = classifyColumnFromStats('col_likert', 'likert', {
      columnId: 'col_likert',
      totalRows: 100,
      nonNullCount: 100,
      distinctCount: 5,
      distinctCountCaseFolded: 5,
      distinctValues: ['1', '2', '3', '4', '5'],
      numericCount: 100,
      integerCount: 98,
      minValue: 1,
      maxValue: 5,
    })

    const ordinal = classifyColumnFromStats('col_likert', 'likert', {
      columnId: 'col_likert',
      totalRows: 100,
      nonNullCount: 100,
      distinctCount: 5,
      distinctCountCaseFolded: 5,
      distinctValues: ['1', '2', '3', '4', '5'],
      numericCount: 100,
      integerCount: 100,
      minValue: 1,
      maxValue: 5,
    })

    expect(nonOrdinal.dataType).not.toBe(ColumnDataType.Ordinal)
    expect(ordinal.dataType).toBe(ColumnDataType.Ordinal)
  })

  it('applies override without destroying detected type metadata', () => {
    const detected = classifyColumn(
      'col_mix',
      'mix',
      toRowData('col_mix', ['1', '2', 'A', '3'])
    )
    expect(detected.dataType).toBe(ColumnDataType.Mixed)

    const overridden = applyColumnTypeOverride(detected, ColumnDataType.Numeric)
    expect(overridden.detectedType).toBe(ColumnDataType.Mixed)
    expect(overridden.overrideType).toBe(ColumnDataType.Numeric)
    expect(overridden.effectiveType).toBe(ColumnDataType.Numeric)
    expect(overridden.dataType).toBe(ColumnDataType.Numeric)
  })
})
