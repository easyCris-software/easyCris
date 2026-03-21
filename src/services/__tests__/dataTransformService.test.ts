import { describe, expect, it } from 'vitest'
import { DataTransformService } from '@/services/dataTransformService'

describe('DataTransformService contracts', () => {
  it('uses row-index alignment when only partial id columns exist', () => {
    const rows = [
      { group: 'A', value: 10, subject: 'S1' },
      { group: 'B', value: 20, subject: '' },
      { group: 'A', value: 30, subject: 'S2' },
      { group: 'B', value: 40, subject: '' },
    ]

    const result = DataTransformService.pivotWider(rows, {
      namesFrom: 'group',
      valuesFrom: ['value'],
      useRowIndex: true,
    })

    expect(result).toEqual([
      { A: 10, B: 20 },
      { A: 30, B: 40 },
    ])
  })

  it('throws when filter references a missing column', () => {
    const rows = [{ colA: 'x' }]
    expect(() =>
      DataTransformService.filter(rows, {
        groups: [{ op: 'AND', conditions: [{ columnId: 'missing', operator: 'eq', value: 'x' }] }],
      })
    ).toThrow(/Missing filter column/)
  })

  it('allows filtering empty datasets without throwing missing-column errors', () => {
    const rows: Record<string, any>[] = []
    const result = DataTransformService.filter(rows, {
      groups: [{ op: 'AND', conditions: [{ columnId: 'colA', operator: 'eq', value: 'x' }] }],
    })
    expect(result).toEqual([])
  })

  it('throws when filter uses an invalid operator', () => {
    const rows = [{ colA: 'x' }]
    expect(() =>
      DataTransformService.filter(rows, {
        groups: [{ op: 'AND', conditions: [{ columnId: 'colA', operator: 'wat' as any, value: 'x' }] }],
      })
    ).toThrow(/Invalid filter operator/)
  })

  it('treats configured missing markers as empty in filter isEmpty', () => {
    const rows = [
      { colA: 'NA' },
      { colA: '' },
      { colA: null },
      { colA: '-' },
      { colA: 'real' },
    ]
    const result = DataTransformService.filter(rows, {
      groups: [{ op: 'AND', conditions: [{ columnId: 'colA', operator: 'isEmpty', value: '' }] }],
    })
    expect(result).toHaveLength(4)
  })

  it('throws on invalid regex patterns', () => {
    const rows = [{ colA: 'abc' }]
    expect(() =>
      DataTransformService.filter(rows, {
        groups: [{ op: 'AND', conditions: [{ columnId: 'colA', operator: 'regex', value: '[' }] }],
      })
    ).toThrow(/Invalid regex pattern/)
  })

  it('applies multiple AND conditions within a single group', () => {
    const rows = [
      { grp: 'A', score: 10 },
      { grp: 'A', score: 4 },
      { grp: 'B', score: 12 },
      { grp: 'B', score: 3 },
    ]

    const result = DataTransformService.filter(rows, {
      groups: [
        {
          op: 'AND',
          conditions: [
            { columnId: 'grp', operator: 'eq', value: 'A' },
            { columnId: 'score', operator: 'gte', value: 8 },
          ],
        },
      ],
      groupOperator: 'AND',
    })

    expect(result).toEqual([{ grp: 'A', score: 10 }])
  })

  it('applies AND correctly across multiple groups', () => {
    const rows = [
      { group: 'A', score: 10, status: 'active' },
      { group: 'A', score: 6, status: 'active' },
      { group: 'B', score: 12, status: 'inactive' },
      { group: 'B', score: 11, status: 'active' },
      { group: 'C', score: 20, status: 'active' },
    ]

    const result = DataTransformService.filter(rows, {
      groups: [
        {
          op: 'OR',
          conditions: [
            { columnId: 'group', operator: 'eq', value: 'A' },
            { columnId: 'group', operator: 'eq', value: 'B' },
          ],
        },
        {
          op: 'AND',
          conditions: [
            { columnId: 'score', operator: 'gte', value: 10 },
            { columnId: 'status', operator: 'eq', value: 'active' },
          ],
        },
      ],
      groupOperator: 'AND',
    })

    expect(result).toEqual([
      { group: 'A', score: 10, status: 'active' },
      { group: 'B', score: 11, status: 'active' },
    ])
  })

  it('throws when numeric aggregation is requested on non-numeric data', () => {
    const rows = [
      { grp: 'A', txt: 'alpha' },
      { grp: 'A', txt: 'beta' },
    ]
    expect(() =>
      DataTransformService.groupAggregate(rows, {
        groupByColumns: ['grp'],
        aggregations: { txt: 'avg' },
      })
    ).toThrow(/Numeric aggregation requires numeric values/)
  })

  it('throws when an unknown aggregation function is provided', () => {
    const rows = [
      { grp: 'A', val: 1, other: 10 },
      { grp: 'A', val: 2, other: 20 },
    ]
    expect(() =>
      DataTransformService.groupAggregate(rows, {
        groupByColumns: ['grp'],
        aggregations: {
          val: 'sum',
          other: 'totally_invalid' as any,
        },
      })
    ).toThrow(/Invalid aggregation function/)
  })

  it('count aggregation counts non-null values', () => {
    const rows = [
      { grp: 'A', val: 1 },
      { grp: 'A', val: null },
      { grp: 'A', val: 3 },
    ]
    const result = DataTransformService.groupAggregate(rows, {
      groupByColumns: ['grp'],
      aggregations: { val: 'count' },
    })
    expect(result).toEqual([{ grp: 'A', val: 2 }])
  })
})
