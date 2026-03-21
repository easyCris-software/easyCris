import { describe, expect, it } from 'vitest'
import { buildPerformTestWarningKey } from '@/components/layout/performTestWarning'

describe('buildPerformTestWarningKey', () => {
  it('uses project scope when projectId exists', () => {
    const key = buildPerformTestWarningKey({
      projectId: 'project-123',
      familyId: 'statistics-2',
      datasetId: 'dataset-abc',
      sessionId: 'session-1',
    })
    expect(key).toBe('project:project-123:family:statistics-2')
  })

  it('falls back to dataset scope when projectId is unavailable', () => {
    const key = buildPerformTestWarningKey({
      projectId: null,
      familyId: 'statistics-1',
      datasetId: 'dataset-xyz',
      sessionId: 'session-1',
    })
    expect(key).toBe('dataset:dataset-xyz:family:statistics-1')
  })

  it('falls back to session scope when projectId and datasetId are unavailable', () => {
    const key = buildPerformTestWarningKey({
      projectId: undefined,
      familyId: 'statistics-1',
      datasetId: null,
      sessionId: 'session-42',
    })
    expect(key).toBe('session:session-42:family:statistics-1')
  })
})

