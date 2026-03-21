import type { ColumnMetadata } from '@/store/data-store'

export type PivotColumnConfig = {
  namesFrom: string
  valuesFrom: string[]
}

const isBlankValue = (value: unknown): boolean => value === null || value === undefined || value === ''

const collectRowKeys = (rows: Record<string, any>[]): string[] => {
  const seen = new Set<string>()
  const keys: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row ?? {})) {
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }
  return keys
}

export const computePivotIdColumns = (
  rows: Record<string, any>[],
  config: PivotColumnConfig
): string[] => {
  if (rows.length === 0) return []

  const excluded = new Set([config.namesFrom, ...config.valuesFrom])
  const candidates = collectRowKeys(rows).filter((key) => !excluded.has(key))
  if (candidates.length === 0) return []

  const totalRows = rows.length
  const nonEmptyCounts = new Map<string, number>()
  const distinctValues = new Map<string, Set<string>>()

  for (const candidate of candidates) {
    nonEmptyCounts.set(candidate, 0)
    distinctValues.set(candidate, new Set<string>())
  }

  for (const row of rows) {
    for (const candidate of candidates) {
      const value = row[candidate]
      if (isBlankValue(value)) continue
      nonEmptyCounts.set(candidate, (nonEmptyCounts.get(candidate) ?? 0) + 1)
      distinctValues.get(candidate)?.add(String(value))
    }
  }

  return candidates.filter((candidate) => {
    const nonEmpty = nonEmptyCounts.get(candidate) ?? 0
    const distinct = distinctValues.get(candidate)?.size ?? 0
    return nonEmpty === totalRows && distinct > 1
  })
}

export const normalizeDisplayName = (name: string): string => {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}

export const makeUniqueDisplayName = (
  desiredName: string,
  occupiedNormalizedNames: Set<string>
): string => {
  const base = desiredName.trim() || 'Column'
  const baseNormalized = normalizeDisplayName(base)
  if (!occupiedNormalizedNames.has(baseNormalized)) {
    occupiedNormalizedNames.add(baseNormalized)
    return base
  }

  let index = 2
  while (index < 10000) {
    const candidate = `${base} (${index})`
    const candidateNormalized = normalizeDisplayName(candidate)
    if (!occupiedNormalizedNames.has(candidateNormalized)) {
      occupiedNormalizedNames.add(candidateNormalized)
      return candidate
    }
    index += 1
  }

  const fallback = `${base} (${Date.now()})`
  occupiedNormalizedNames.add(normalizeDisplayName(fallback))
  return fallback
}

export type MetadataDedupeResult = {
  metadata: ColumnMetadata[]
  renamedEntries: Array<{ id: string; from: string; to: string }>
}

export type ColumnAvailabilityAssessment = {
  availableColumnIds: Set<string>
  missingColumnIds: string[]
  criticalMissingColumnIds: string[]
  ignorableMissingColumnIds: string[]
}

const isLikelySyntheticPaddingColumn = (
  column: ColumnMetadata,
  index: number,
  defaultColumnWidth: number
): boolean => {
  const expectedName = `Column ${index + 1}`
  const actualName = (column.name ?? '').trim()
  const width = column.width ?? defaultColumnWidth
  return (
    actualName === expectedName &&
    (column.type ?? 'text') === 'text' &&
    width === defaultColumnWidth
  )
}

export const assessTransformColumnAvailability = (
  columns: ColumnMetadata[],
  availableColumnIdsInput: Iterable<string>,
  options: { defaultColumnWidth?: number; ignorableColumnIds?: Set<string> } = {}
): ColumnAvailabilityAssessment => {
  const defaultColumnWidth = options.defaultColumnWidth ?? 88
  const ignorableColumnIds = options.ignorableColumnIds ?? new Set<string>()
  const availableColumnIds = new Set<string>(availableColumnIdsInput)
  const missingColumnIds: string[] = []
  const criticalMissingColumnIds: string[] = []
  const ignorableMissingColumnIds: string[] = []

  columns.forEach((column, index) => {
    if (availableColumnIds.has(column.id)) return
    missingColumnIds.push(column.id)
    if (
      ignorableColumnIds.has(column.id) ||
      isLikelySyntheticPaddingColumn(column, index, defaultColumnWidth)
    ) {
      ignorableMissingColumnIds.push(column.id)
    } else {
      criticalMissingColumnIds.push(column.id)
    }
  })

  return {
    availableColumnIds,
    missingColumnIds,
    criticalMissingColumnIds,
    ignorableMissingColumnIds,
  }
}

export const dedupeMetadataDisplayNames = (
  metadata: ColumnMetadata[],
  options: {
    lockedColumnIds?: Set<string>
    reservedNames?: string[]
  } = {}
): MetadataDedupeResult => {
  const lockedColumnIds = options.lockedColumnIds ?? new Set<string>()
  const reservedNames = options.reservedNames ?? []
  const occupied = new Set<string>()

  for (const reservedName of reservedNames) {
    const normalized = normalizeDisplayName(reservedName)
    if (normalized.length > 0) {
      occupied.add(normalized)
    }
  }

  const nextMetadata = metadata.map((column) => ({ ...column }))
  const renamedEntries: Array<{ id: string; from: string; to: string }> = []

  for (const column of nextMetadata) {
    if (!lockedColumnIds.has(column.id)) continue
    const normalized = normalizeDisplayName(column.name ?? '')
    if (normalized.length > 0) {
      occupied.add(normalized)
    }
  }

  for (let index = 0; index < nextMetadata.length; index += 1) {
    const column = nextMetadata[index]
    if (!column) continue
    if (lockedColumnIds.has(column.id)) continue

    const originalName = column.name ?? `Column ${index + 1}`
    const uniqueName = makeUniqueDisplayName(originalName, occupied)
    if (uniqueName !== originalName) {
      renamedEntries.push({
        id: column.id,
        from: originalName,
        to: uniqueName,
      })
      column.name = uniqueName
    } else {
      column.name = uniqueName
    }
  }

  return {
    metadata: nextMetadata,
    renamedEntries,
  }
}
