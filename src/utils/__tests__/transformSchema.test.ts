import { describe, expect, it } from 'vitest'
import type { ColumnMetadata } from '@/store/data-store'
import {
  assessTransformColumnAvailability,
  computePivotIdColumns,
  dedupeMetadataDisplayNames,
  makeUniqueDisplayName,
  normalizeDisplayName,
} from '@/utils/transformSchema'

describe('transformSchema utilities', () => {
  describe('computePivotIdColumns', () => {
    it('treats fully populated, varying columns as id columns', () => {
      const rows = [
        { group: 'A', value: 10, subject: 'S1' },
        { group: 'B', value: 20, subject: 'S2' },
      ]
      const ids = computePivotIdColumns(rows, { namesFrom: 'group', valuesFrom: ['value'] })
      expect(ids).toEqual(['subject'])
    })

    it('does not treat partially populated columns as id columns', () => {
      const rows = [
        { group: 'A', value: 10, subject: 'S1' },
        { group: 'B', value: 20, subject: '' },
        { group: 'A', value: 30, subject: '' },
      ]
      const ids = computePivotIdColumns(rows, { namesFrom: 'group', valuesFrom: ['value'] })
      expect(ids).toEqual([])
    })
  })

  describe('display-name deduplication', () => {
    it('normalizes names for collision checks', () => {
      expect(normalizeDisplayName('  Alpha   Beta ')).toBe('alpha beta')
    })

    it('creates deterministic numeric suffixes', () => {
      const occupied = new Set<string>(['value'])
      const next = makeUniqueDisplayName('Value', occupied)
      expect(next).toBe('Value (2)')
    })

    it('keeps locked names and renames generated collisions', () => {
      const metadata: ColumnMetadata[] = [
        { id: 'col-0', name: 'Subject', type: 'text', width: 88 },
        { id: 'col-1', name: 'value', type: 'text', width: 88 },
      ]
      const result = dedupeMetadataDisplayNames(metadata, {
        lockedColumnIds: new Set(['col-0']),
        reservedNames: ['Value'],
      })
      expect(result.metadata[0]?.name).toBe('Subject')
      expect(result.metadata[1]?.name).toBe('value (2)')
      expect(result.renamedEntries).toEqual([
        { id: 'col-1', from: 'value', to: 'value (2)' },
      ])
    })
  })

  describe('column availability assessment', () => {
    it('treats default trailing grid columns as ignorable when absent in storage', () => {
      const columns: ColumnMetadata[] = [
        { id: 'col-0', name: 'Subject', type: 'text', width: 88 },
        { id: 'col-1', name: 'Score', type: 'numeric', width: 88 },
        { id: 'col-2', name: 'Column 3', type: 'text', width: 88 },
        { id: 'col-3', name: 'Column 4', type: 'text', width: 88 },
      ]

      const assessment = assessTransformColumnAvailability(columns, ['col-0', 'col-1'])
      expect(assessment.criticalMissingColumnIds).toEqual([])
      expect(assessment.ignorableMissingColumnIds).toEqual(['col-2', 'col-3'])
    })

    it('flags missing custom columns as critical', () => {
      const columns: ColumnMetadata[] = [
        { id: 'col-0', name: 'Subject', type: 'text', width: 88 },
        { id: 'col-1', name: 'Custom Empty', type: 'text', width: 88 },
        { id: 'col-2', name: 'Column 3', type: 'text', width: 88 },
      ]

      const assessment = assessTransformColumnAvailability(columns, ['col-0'])
      expect(assessment.criticalMissingColumnIds).toEqual(['col-1'])
      expect(assessment.ignorableMissingColumnIds).toEqual(['col-2'])
    })

    it('treats configured no-data columns as ignorable even if custom named', () => {
      const columns: ColumnMetadata[] = [
        { id: 'col-0', name: 'Subject', type: 'text', width: 88 },
        { id: 'col-1', name: 'Custom Empty', type: 'numeric', width: 120 },
      ]

      const assessment = assessTransformColumnAvailability(columns, ['col-0'], {
        ignorableColumnIds: new Set(['col-1']),
      })
      expect(assessment.criticalMissingColumnIds).toEqual([])
      expect(assessment.ignorableMissingColumnIds).toEqual(['col-1'])
    })
  })
})
