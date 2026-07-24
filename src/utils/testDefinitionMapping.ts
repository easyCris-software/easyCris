import type { TestDefinition } from '@/config/testRegistry'
import type { StatisticalTest as StoreStatisticalTest } from '@/store/analysis-store'

const mapParamType = (
  registryType: 'number' | 'boolean' | 'select' | 'columns' | 'string'
): 'numeric' | 'categorical' | 'boolean' | 'column' | 'columns' => {
  switch (registryType) {
    case 'number':
      return 'numeric'
    case 'select':
    case 'string':
      return 'categorical'
    case 'boolean':
      return 'boolean'
    case 'columns':
      return 'columns'
    default:
      return 'categorical'
  }
}

export const toStoreTestDefinition = (testDef: TestDefinition): StoreStatisticalTest => {
  const parameters = testDef.parameters.map(p => ({
    name: p.name,
    type: mapParamType(p.type),
    value: p.default,
    required: p.required !== false,
    defaultValue: p.default,
    options: p.options,
    min: p.min,
    max: p.max,
    description: p.label,
  }))

  const requiredColumnTypes = testDef.requiredDataFields
    .filter(f => f.required !== false)
    .map(f => f.type === 'any' ? 'numeric' : f.type)

  return {
    id: testDef.id,
    family: testDef.family as StoreStatisticalTest['family'],
    name: testDef.displayName,
    description: testDef.description || '',
    parameters,
    requiredColumns: testDef.requiredDataFields.filter(f => f.required !== false).length,
    requiredColumnTypes,
  }
}
