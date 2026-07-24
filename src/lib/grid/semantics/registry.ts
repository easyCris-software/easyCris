import type { GridValueSemantics } from './types'
import type { ColumnMetadata } from '@/store/data-store'
import { numericSemantics } from './numeric'
import { categoricalSemantics } from './categorical'
import { textSemantics } from './text'
import { datetimeSemantics } from './datetime'

const REGISTRY: Record<ColumnMetadata['type'], GridValueSemantics> = {
  numeric: numericSemantics,
  categorical: categoricalSemantics,
  text: textSemantics,
  datetime: datetimeSemantics,
}

/**
 * Returns the GridValueSemantics for the given column type.
 * Falls back to textSemantics for undefined or unrecognised types.
 */
export function getSemanticsForType(
  type: ColumnMetadata['type'] | undefined | null
): GridValueSemantics {
  if (!type) return textSemantics
  return REGISTRY[type] ?? textSemantics
}
