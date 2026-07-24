/**
 * Unit tests for resolveFamilyDataset — the pure function that determines
 * which dataset to show for the active family.
 *
 * Key invariant: a family with no/invalid datasetId must NEVER borrow an
 * unrelated (fallback) dataset. It must resolve to null (empty grid) so the
 * user sees "No dataset loaded" for that family rather than data that belongs
 * to a different family.
 */
import { describe, it, expect } from 'vitest'
import { resolveFamilyDataset } from '../familyDatasetResolver'

type SlimDataset = { id: string }
type OwnedSlimDataset = { id: string; familyId: string }

function makeMap(...ids: string[]): Map<string, SlimDataset> {
  return new Map(ids.map(id => [id, { id }]))
}

function makeOwnedMap(...pairs: Array<{ id: string; familyId: string }>): Map<string, OwnedSlimDataset> {
  return new Map(pairs.map(p => [p.id, p]))
}

describe('resolveFamilyDataset', () => {
  describe('family has no datasetId', () => {
    it('returns null when family.datasetId is undefined', () => {
      const result = resolveFamilyDataset(
        { id: 'fam-a', datasetId: undefined },
        makeMap('ds-a', 'ds-b'),
      )
      expect(result).toBeNull()
    })

    it('returns null when family is undefined', () => {
      const result = resolveFamilyDataset(undefined, makeMap('ds-a'))
      expect(result).toBeNull()
    })
  })

  describe('family has a valid datasetId present in the map', () => {
    it('returns the matching dataset', () => {
      const result = resolveFamilyDataset(
        { id: 'fam-target', datasetId: 'ds-target' },
        makeOwnedMap(
          { id: 'ds-a', familyId: 'fam-a' },
          { id: 'ds-target', familyId: 'fam-target' },
          { id: 'ds-b', familyId: 'fam-b' },
        ),
      )
      expect(result).toEqual({ id: 'ds-target', familyId: 'fam-target' })
    })

    it('returns the dataset when owner is not yet written (familyId undefined)', () => {
      // During atomic bind windows, family.datasetId may be set before dataset.familyId
      // is persisted. Resolver should still return the referenced dataset.
      const datasetMap = new Map([
        ['ds-pending', { id: 'ds-pending', familyId: undefined as unknown as string }],
      ])
      const result = resolveFamilyDataset(
        { id: 'fam-target', datasetId: 'ds-pending' },
        datasetMap,
      )
      expect(result).toEqual({ id: 'ds-pending', familyId: undefined })
    })
  })

  describe('family has a datasetId that does NOT exist in the map (orphaned/missing)', () => {
    it('returns null — must not fall back to an unrelated dataset', () => {
      // This is the regression: before the fix, AppShell would call
      // setCurrentDataset(fallbackDataset) here, showing ds-a for a family
      // that was never associated with ds-a. The fix: return null so the
      // grid shows "No dataset loaded" rather than borrowing data.
      const result = resolveFamilyDataset(
        { id: 'fam-a', datasetId: 'ghost-ds' },
        makeMap('ds-a', 'ds-b'), // 'ghost-ds' is not here
      )
      expect(result).toBeNull()
    })

    it('returns null even when a fallback candidate exists in the map', () => {
      // Explicit regression for the "auto-fall to fallbackDataset" path.
      // The function receives no knowledge of fallbackDataset — it must not
      // invent a substitute; only the caller knows what "no dataset" should show.
      const result = resolveFamilyDataset(
        { id: 'fam-a', datasetId: 'missing-ds' },
        makeMap('fallback-ds'),
      )
      expect(result).toBeNull()
    })
  })

  describe('family has datasetId but dataset belongs to another family', () => {
    it('returns null — must not resolve cross-family dataset aliases', () => {
      const result = resolveFamilyDataset(
        { id: 'fam-a', datasetId: 'ds-shared' },
        makeOwnedMap(
          { id: 'ds-shared', familyId: 'fam-b' },
        ),
      )
      expect(result).toBeNull()
    })
  })
})
