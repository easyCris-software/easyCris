export function hasLocalClipboardColumns(
  rowRecord: Record<string, unknown> | undefined,
  selectedColumnIds: string[]
): rowRecord is Record<string, unknown> {
  return (
    rowRecord != null &&
    selectedColumnIds.every((columnId) =>
      Object.prototype.hasOwnProperty.call(rowRecord, columnId)
    )
  )
}
