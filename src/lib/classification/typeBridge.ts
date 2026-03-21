import { ColumnDataType as UiColumnDataType } from '@/services/columnDataService'
import { ColumnDataType as CoreColumnDataType } from '@/lib/modules/core/types'

function normalizeTypeToken(dataType: string): string {
  return dataType.trim().toLowerCase()
}

function warnUnknownToken(direction: 'ui->core' | 'core->ui' | 'persisted->ui', token: string): void {
  if (!import.meta.env.DEV) return
  // Keep runtime behavior non-breaking, but surface miswired tokens during development.
  // eslint-disable-next-line no-console
  console.warn(`[typeBridge] Unknown type token (${direction}): "${token}"`)
}

export function mapUiTypeToCore(dataType: UiColumnDataType | CoreColumnDataType | string): CoreColumnDataType {
  const rawToken = String(dataType)
  switch (normalizeTypeToken(rawToken)) {
    case 'numeric':
      return CoreColumnDataType.Numeric
    case 'categorical':
      return CoreColumnDataType.Categorical
    case 'binary':
      return CoreColumnDataType.Binary
    case 'ordinal':
      return CoreColumnDataType.Ordinal
    case 'empty':
      return CoreColumnDataType.Empty
    case 'mixed':
    default:
      if (normalizeTypeToken(rawToken) !== 'mixed') {
        warnUnknownToken('ui->core', rawToken)
      }
      return CoreColumnDataType.Mixed
  }
}

export function mapCoreTypeToUi(dataType: CoreColumnDataType | UiColumnDataType | string): UiColumnDataType {
  const rawToken = String(dataType)
  switch (normalizeTypeToken(rawToken)) {
    case 'numeric':
      return UiColumnDataType.Numeric
    case 'categorical':
      return UiColumnDataType.Categorical
    case 'binary':
      return UiColumnDataType.Binary
    case 'ordinal':
      return UiColumnDataType.Ordinal
    case 'empty':
      return UiColumnDataType.Empty
    case 'mixed':
    default:
      if (normalizeTypeToken(rawToken) !== 'mixed') {
        warnUnknownToken('core->ui', rawToken)
      }
      return UiColumnDataType.Mixed
  }
}

export function mapPersistedOverrideToUi(
  overrideType: string | null | undefined
): UiColumnDataType | null | undefined {
  if (overrideType == null) {
    return overrideType
  }

  switch (normalizeTypeToken(overrideType)) {
    case 'numeric':
      return UiColumnDataType.Numeric
    case 'categorical':
      return UiColumnDataType.Categorical
    case 'binary':
      return UiColumnDataType.Binary
    case 'ordinal':
      return UiColumnDataType.Ordinal
    case 'mixed':
      return UiColumnDataType.Mixed
    case 'empty':
      return UiColumnDataType.Empty
    default:
      warnUnknownToken('persisted->ui', overrideType)
      return undefined
  }
}
