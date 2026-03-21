import type { ColumnMetadata } from '@/store/data-store'

type ResolveColumnRenameParams = {
  colIndex: number
  requestedName: string
  columns: ColumnMetadata[]
  allocateAutoName?: () => string | null
}

type ResolveColumnRenameResult = {
  nextName: string
  reservedAutoName: string | null
}

function isNameTaken(
  candidate: string,
  columns: ColumnMetadata[],
  excludeIndex: number
): boolean {
  const normalized = candidate.trim().toLowerCase()
  if (!normalized) return false
  return columns.some((column, idx) => {
    if (idx === excludeIndex) return false
    return column.name.trim().toLowerCase() === normalized
  })
}

function findNextAvailableColumnName(
  startNumber: number,
  columns: ColumnMetadata[],
  excludeIndex: number
): string {
  let nextNumber = Math.max(1, startNumber)
  while (isNameTaken(`Column ${nextNumber}`, columns, excludeIndex)) {
    nextNumber += 1
  }
  return `Column ${nextNumber}`
}

export function resolveColumnRenameTarget({
  colIndex,
  requestedName,
  columns,
  allocateAutoName,
}: ResolveColumnRenameParams): ResolveColumnRenameResult {
  const trimmed = requestedName.trim()
  if (trimmed.length > 0) {
    return { nextName: trimmed, reservedAutoName: null }
  }

  const preferredName = `Column ${colIndex + 1}`
  if (!isNameTaken(preferredName, columns, colIndex)) {
    return { nextName: preferredName, reservedAutoName: null }
  }

  const allocated = allocateAutoName?.()?.trim() ?? ''
  if (allocated.length > 0 && !isNameTaken(allocated, columns, colIndex)) {
    return { nextName: allocated, reservedAutoName: allocated }
  }

  return {
    nextName: findNextAvailableColumnName(colIndex + 1, columns, colIndex),
    reservedAutoName: allocated.length > 0 ? allocated : null,
  }
}
