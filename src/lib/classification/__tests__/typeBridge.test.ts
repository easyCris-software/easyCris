import { describe, expect, it } from 'vitest'
import { mapCoreTypeToUi, mapPersistedOverrideToUi, mapUiTypeToCore } from '@/lib/classification/typeBridge'
import { ColumnDataType as CoreType } from '@/lib/modules/core/types'
import { ColumnDataType as UiType } from '@/services/columnDataService'

describe('typeBridge', () => {
  it('maps lowercase and PascalCase tokens to core types', () => {
    expect(mapUiTypeToCore('numeric')).toBe(CoreType.Numeric)
    expect(mapUiTypeToCore('Numeric')).toBe(CoreType.Numeric)
    expect(mapUiTypeToCore(UiType.Binary)).toBe(CoreType.Binary)
    expect(mapUiTypeToCore(CoreType.Ordinal)).toBe(CoreType.Ordinal)
  })

  it('maps lowercase and PascalCase tokens to ui types', () => {
    expect(mapCoreTypeToUi('categorical')).toBe(UiType.Categorical)
    expect(mapCoreTypeToUi('Categorical')).toBe(UiType.Categorical)
    expect(mapCoreTypeToUi(CoreType.Mixed)).toBe(UiType.Mixed)
    expect(mapCoreTypeToUi(UiType.Empty)).toBe(UiType.Empty)
  })

  it('maps persisted override values case-insensitively', () => {
    expect(mapPersistedOverrideToUi('numeric')).toBe(UiType.Numeric)
    expect(mapPersistedOverrideToUi('Numeric')).toBe(UiType.Numeric)
    expect(mapPersistedOverrideToUi('BINARY')).toBe(UiType.Binary)
    expect(mapPersistedOverrideToUi(null)).toBeNull()
    expect(mapPersistedOverrideToUi(undefined)).toBeUndefined()
  })
})

