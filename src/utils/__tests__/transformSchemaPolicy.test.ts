import { describe, expect, it } from 'vitest'
import { evaluateTransformSchemaDecision } from '@/utils/transformSchemaPolicy'

describe('transformSchemaPolicy', () => {
  it('blocks in-place transforms when schema is partial', () => {
    const decision = evaluateTransformSchemaDecision(
      'in-place',
      {
        contextLabel: 'in-place transform',
        availableColumns: 5,
        missingColumns: 95,
        totalColumns: 100,
      },
      true
    )

    expect(decision.allow).toBe(false)
    expect(decision.errorMessage).toContain('blocked')
    expect(decision.errorMessage).toContain('95')
  })

  it('allows new-family transforms with a warning when schema is partial', () => {
    const decision = evaluateTransformSchemaDecision(
      'new-family',
      {
        contextLabel: 'transform',
        availableColumns: 5,
        missingColumns: 95,
        totalColumns: 100,
      },
      true
    )

    expect(decision.allow).toBe(true)
    expect(decision.warningMessage).toContain('partial schema')
    expect(decision.warningMessage).toContain('95')
  })
})
