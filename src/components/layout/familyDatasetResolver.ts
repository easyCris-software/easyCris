/**
 * Pure helper for resolving which dataset the active family should display.
 *
 * Invariant: a family with no/invalid datasetId MUST NOT borrow an unrelated
 * (fallback) dataset. Returning null signals "no dataset for this family" so
 * the UI shows an empty grid rather than data belonging to a different family.
 */

/**
 * Returns the dataset for `family`, or null if:
 *   - family is undefined / has no datasetId
 *   - the datasetId does not exist in datasetsById (orphaned / not yet loaded)
 *
 * Callers should pass only their own datasetsById Map; this function has no
 * concept of "fallback" — choosing a substitute is the caller's responsibility
 * (and the correct policy is to show nothing, not to borrow an unrelated dataset).
 */
export function resolveFamilyDataset<T extends { id: string; familyId?: string | null }>(
  family: { id: string; datasetId?: string } | undefined,
  datasetsById: ReadonlyMap<string, T>,
): T | null {
  if (!family?.datasetId) return null
  const dataset = datasetsById.get(family.datasetId)
  if (!dataset) return null
  // Accept explicit ownership match, and also accept temporarily unowned datasets
  // (familyId unset) during the brief bind window after dataset creation/import.
  if (dataset.familyId == null || dataset.familyId === family.id) return dataset
  return null
}
