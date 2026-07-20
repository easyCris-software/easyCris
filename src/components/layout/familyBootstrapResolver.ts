type DatasetRef = {
  id: string
  familyId?: string | null
  dataRowCount?: number | null
  rowCount?: number | null
}

export type FamilyBootstrapDecision =
  | { action: 'none' }
  | { action: 'create-new' }
  | { action: 'adopt-existing'; datasetId: string; hasData: boolean }

export interface AdoptExistingBootstrapParams<TDataset extends DatasetRef = DatasetRef> {
  familyId: string
  decision: Extract<FamilyBootstrapDecision, { action: 'adopt-existing' }>
  datasetsById: ReadonlyMap<string, TDataset>
  currentDatasetId: string | null
  setActiveFamilyDataset: (familyId: string, datasetId: string, hasData: boolean) => void
  setCurrentDataset: (dataset: TDataset | null) => void
}

interface DecideFamilyBootstrapParams {
  familyDatasetId: string | null | undefined
  e2eEnabled: boolean
  currentDataset: DatasetRef | null
  fallbackDataset: DatasetRef | null
  rnaseqDatasetIds: ReadonlySet<string>
}

function isAdoptableCandidate(
  candidate: DatasetRef | null,
  rnaseqDatasetIds: ReadonlySet<string>
): candidate is DatasetRef {
  if (!candidate) return false
  if (rnaseqDatasetIds.has(candidate.id)) return false
  return candidate.familyId == null
}

function resolveHasData(candidate: DatasetRef): boolean {
  if (candidate.dataRowCount != null) {
    return candidate.dataRowCount > 0
  }
  // Fallback for legacy datasets that don't persist dataRowCount.
  return (candidate.rowCount ?? 0) > 0
}

/**
 * Startup family bootstrap policy for Statistics mode.
 *
 * Key invariant:
 * - If the active family has no datasetId, we should either adopt an unowned
 *   non-RNA-seq dataset or create a new one. We should not return "none"
 *   (except E2E mode where bootstrapping is intentionally suppressed).
 */
export function decideFamilyBootstrap(
  params: DecideFamilyBootstrapParams
): FamilyBootstrapDecision {
  const { familyDatasetId, e2eEnabled, currentDataset, fallbackDataset, rnaseqDatasetIds } = params

  if (familyDatasetId) return { action: 'none' }
  if (e2eEnabled) return { action: 'none' }

  if (isAdoptableCandidate(currentDataset, rnaseqDatasetIds)) {
    return {
      action: 'adopt-existing',
      datasetId: currentDataset.id,
      hasData: resolveHasData(currentDataset),
    }
  }
  if (isAdoptableCandidate(fallbackDataset, rnaseqDatasetIds)) {
    return {
      action: 'adopt-existing',
      datasetId: fallbackDataset.id,
      hasData: resolveHasData(fallbackDataset),
    }
  }

  return { action: 'create-new' }
}

/**
 * Applies the adopt-existing branch side effects used by AppShell.
 * Extracted for direct unit testing of the family binding wiring.
 */
export function applyAdoptExistingBootstrap<TDataset extends DatasetRef>(
  params: AdoptExistingBootstrapParams<TDataset>
): void {
  const {
    familyId,
    decision,
    datasetsById,
    currentDatasetId,
    setActiveFamilyDataset,
    setCurrentDataset,
  } = params

  const adoptedDataset = datasetsById.get(decision.datasetId) ?? null
  if (!adoptedDataset) {
    console.warn(
      `[family-bootstrap] Skipping adopt-existing: dataset '${decision.datasetId}' is not available in datasetsById`
    )
    return
  }

  setActiveFamilyDataset(familyId, decision.datasetId, decision.hasData)
  if (currentDatasetId !== adoptedDataset.id) {
    setCurrentDataset(adoptedDataset)
  }
}
