export interface PasteSelectionRange {
  width: number
  height: number
}

export function expandClipboardForSelection(
  parsedData: string[][],
  selectionRange: PasteSelectionRange | null | undefined
): string[][] {
  if (!selectionRange || parsedData.length === 0) {
    return parsedData
  }

  const sourceHeight = parsedData.length
  const sourceWidth = parsedData.reduce((max, row) => Math.max(max, row.length), 0)
  const targetWidth = selectionRange.width
  const targetHeight = selectionRange.height

  if (
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    targetWidth <= 0 ||
    targetHeight <= 0 ||
    targetWidth < sourceWidth ||
    targetHeight < sourceHeight ||
    targetWidth % sourceWidth !== 0 ||
    targetHeight % sourceHeight !== 0
  ) {
    return parsedData
  }

  if (targetWidth === sourceWidth && targetHeight === sourceHeight) {
    return parsedData
  }

  return Array.from({ length: targetHeight }, (_, rowIndex) =>
    Array.from({ length: targetWidth }, (_, colIndex) =>
      parsedData[rowIndex % sourceHeight]?.[colIndex % sourceWidth] ?? ''
    )
  )
}
