/**
 * Unit tests for updateActiveFamilyData edge cases:
 *   - null familyId captured = no binding (explicit "no family" signal)
 *   - non-existent dataset = no orphan family binding
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/app-store'
import { useDataStore } from '@/store/data-store'
import type { Dataset } from '@/store/data-store'

vi.mock('@/services/cacheService', () => ({
  default: {
    createEmptyDuckDB: vi.fn().mockResolvedValue(undefined),
    setActiveProjectId: vi.fn().mockResolvedValue('project-1'),
  },
}))

// Minimal Dataset stub
function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'ds-1',
    name: 'Test Dataset',
    columns: [],
    rowCount: 0,
    dataRowCount: 0,
    familyId: undefined,
    ...overrides,
  } as unknown as Dataset
}

describe('updateActiveFamilyData', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
    // Wipe datasets — data-store has no reset(), clear via setState
    useDataStore.setState({ datasets: [] })
  })

  describe('null familyId = explicit no-binding signal', () => {
    it('does NOT bind the dataset when captured familyId is null', () => {
      // Arrange: family exists and is active
      const { families } = useAppStore.getState()
      const familyId = families[0]!.id
      expect(useAppStore.getState().activeFamilyId).toBe(familyId)

      // Dataset exists in data store
      useDataStore.getState().addDataset(makeDataset({ id: 'ds-1' }))

      // Act: call with explicit null familyId
      useAppStore.getState().updateActiveFamilyData('ds-1', null)

      // Assert: family datasetId must NOT have been updated
      const updatedFamily = useAppStore.getState().families.find(f => f.id === familyId)
      expect(updatedFamily?.datasetId).toBeUndefined()
    })

    it('does bind the dataset when familyId is undefined (legacy caller)', () => {
      // Arrange: family exists and is active, dataset exists
      const { families } = useAppStore.getState()
      const familyId = families[0]!.id
      useDataStore.getState().addDataset(makeDataset({ id: 'ds-1' }))

      // Act: call without familyId (legacy single-arg form)
      useAppStore.getState().updateActiveFamilyData('ds-1', undefined)

      // Assert: family datasetId updated via activeFamilyId fallback
      const updatedFamily = useAppStore.getState().families.find(f => f.id === familyId)
      expect(updatedFamily?.datasetId).toBe('ds-1')
    })
  })

  describe('two-family roundtrip: independent bindings do not cross-contaminate', () => {
    it('maintains separate dataset pointers for two distinct families after sequential paste bindings', async () => {
      // Scenario: user pastes data into ds-1 while family-1 is active, then pastes
      // into ds-2 while family-2 is active. Both family→dataset bindings must be
      // independently preserved — switching active family must not overwrite the other.

      // Arrange: create a second family
      const fam2 = await useAppStore.getState().createFamily('Family 2')
      expect(fam2).not.toBeNull()
      if (!fam2) throw new Error('Expected createFamily to return a second family')
      const { families } = useAppStore.getState()
      const fam1Id = families[0]!.id  // initial 'statistics-1'
      const fam2Id = fam2.id

      // Both datasets exist
      useDataStore.getState().addDataset(makeDataset({ id: 'ds-1' }))
      useDataStore.getState().addDataset(makeDataset({ id: 'ds-2' }))

      // Act: bind ds-1 to fam1 (simulates paste completed while fam1 was active)
      useAppStore.getState().updateActiveFamilyData('ds-1', fam1Id)
      // Act: bind ds-2 to fam2 (simulates paste completed while fam2 was active)
      useAppStore.getState().updateActiveFamilyData('ds-2', fam2Id)

      // Assert: both bindings co-exist correctly
      const result = useAppStore.getState().families
      expect(result.find(f => f.id === fam1Id)?.datasetId).toBe('ds-1')
      expect(result.find(f => f.id === fam2Id)?.datasetId).toBe('ds-2')
    })

    it('second binding does not corrupt first when activeFamilyId changes between calls', async () => {
      // Regression for the null/undefined fallback race: if capture is wrong,
      // the second updateActiveFamilyData call (which falls back to activeFamilyId)
      // could overwrite the first binding.

      const fam2 = await useAppStore.getState().createFamily('Family 2')
      expect(fam2).not.toBeNull()
      if (!fam2) throw new Error('Expected createFamily to return a second family')
      const { families } = useAppStore.getState()
      const fam1Id = families[0]!.id
      const fam2Id = fam2.id

      useDataStore.getState().addDataset(makeDataset({ id: 'ds-1' }))
      useDataStore.getState().addDataset(makeDataset({ id: 'ds-2' }))

      // Bind fam1 → ds-1 (explicit capture, as paste handler does)
      useAppStore.getState().updateActiveFamilyData('ds-1', fam1Id)

      // Simulate mid-session active-family switch (user navigated to fam2)
      useAppStore.setState({ activeFamilyId: fam2Id })

      // Bind fam2 → ds-2 using the current activeFamilyId fallback (legacy single-arg)
      useAppStore.getState().updateActiveFamilyData('ds-2')

      // fam1 must still point at ds-1 — fam2 binding must not have clobbered it
      const result = useAppStore.getState().families
      expect(result.find(f => f.id === fam1Id)?.datasetId).toBe('ds-1')
      expect(result.find(f => f.id === fam2Id)?.datasetId).toBe('ds-2')
    })
  })

  describe('removed family = no orphan dataset binding', () => {
    it('does NOT write familyId onto dataset when captured family has been deleted before paste completes', () => {
      // Regression for stale-family race: paste captures familyId at start, family is
      // deleted while clipboard.read / dialog is awaited, then paste completes and calls
      // updateActiveFamilyData with the now-removed familyId. Without a guard this writes
      // a dangling familyId onto the dataset, permanently locking it to a ghost family.

      // Arrange: family exists and dataset exists
      const { families } = useAppStore.getState()
      const capturedFamilyId = families[0]!.id
      useDataStore.getState().addDataset(makeDataset({ id: 'ds-1' }))

      // Simulate: family is removed mid-flight (user deleted it while paste was awaiting)
      useAppStore.setState({ families: [], activeFamilyId: null })

      // Act: paste handler calls back with the captured (now-removed) familyId
      useAppStore.getState().updateActiveFamilyData('ds-1', capturedFamilyId)

      // Assert: dataset must NOT have had a familyId written onto it
      const dataset = useDataStore.getState().datasets.find(d => d.id === 'ds-1')
      expect(dataset?.familyId).toBeUndefined()
    })
  })

  describe('non-existent dataset = no orphan family binding', () => {
    it('does NOT update family when the dataset does not exist in the data store', () => {
      // Arrange: family exists, but dataset is NOT in data store (e.g. deleted)
      const { families } = useAppStore.getState()
      const familyId = families[0]!.id
      // Do NOT add 'ghost-ds' to useDataStore

      // Act
      useAppStore.getState().updateActiveFamilyData('ghost-ds', familyId)

      // Assert: family datasetId must remain untouched
      const updatedFamily = useAppStore.getState().families.find(f => f.id === familyId)
      expect(updatedFamily?.datasetId).toBeUndefined()
    })
  })
})
