import { describe, expect, it } from 'vitest'

import {
  buildRowId,
  createGridViewModel,
  type OverlayCellStatus,
} from '@/lib/grid/gridViewModel'

describe('gridViewModel', () => {
  it('defines row identity scope explicitly without delimiter collisions', () => {
    const rowId = buildRowId({
      projectId: 'p:1',
      familyId: 'f:1',
      datasetId: 'dataset-1',
      modelRow: 42,
    })

    expect(rowId).toBe(JSON.stringify(['p:1', 'f:1', 'dataset-1', 42]))
  })

  it('returns overlay values ahead of base row values', () => {
    const model = createGridViewModel()
    const rowId = buildRowId({
      projectId: 'project-1',
      familyId: 'statistics-1',
      datasetId: 'dataset-1',
      modelRow: 42,
    })

    model.writeBaseRow(rowId, { a: 'backend', b: 'backend-b' })
    model.writeOverlayPatch(rowId, {
      a: {
        value: 'local',
        mutationId: 'mutation-1',
        revision: 1,
        status: 'pending',
      },
    })

    expect(model.readCell(rowId, 'a')).toBe('local')
    expect(model.readCell(rowId, 'b')).toBe('backend-b')
  })

  it('retains overlay values until matching acknowledgement arrives', () => {
    const model = createGridViewModel()
    const rowId = buildRowId({
      projectId: 'project-1',
      familyId: 'statistics-1',
      datasetId: 'dataset-1',
      modelRow: 7,
    })

    model.writeBaseRow(rowId, { a: 'backend' })
    model.writeOverlayPatch(rowId, {
      a: {
        value: 'local',
        mutationId: 'mutation-1',
        revision: 1,
        status: 'pending',
      },
    })

    model.acknowledgeOverlay(rowId, {
      columnId: 'a',
      mutationId: 'mutation-2',
      revision: 1,
      status: 'persisted',
      value: 'local',
    })
    expect(model.readCell(rowId, 'a')).toBe('local')

    model.acknowledgeOverlay(rowId, {
      columnId: 'a',
      mutationId: 'mutation-1',
      revision: 2,
      status: 'persisted',
      value: 'local',
    })
    expect(model.readCell(rowId, 'a')).toBe('local')

    model.writeBaseRow(rowId, { a: 'local' })
    model.acknowledgeOverlay(rowId, {
      columnId: 'a',
      mutationId: 'mutation-1',
      revision: 1,
      status: 'confirmed',
      value: 'local',
    })
    model.clearConfirmedOverlay(rowId)

    expect(model.readCell(rowId, 'a')).toBe('local')
    expect(model.getOverlayRow(rowId)).toBeNull()
  })

  it('does not clear a confirmed overlay when the acknowledged value does not match', () => {
    const model = createGridViewModel()
    const rowId = buildRowId({
      projectId: 'project-1',
      familyId: 'statistics-1',
      datasetId: 'dataset-1',
      modelRow: 11,
    })

    model.writeBaseRow(rowId, { a: 'stale-backend' })
    model.writeOverlayPatch(rowId, {
      a: {
        value: 'local',
        mutationId: 'mutation-1',
        revision: 1,
        status: 'pending',
      },
    })

    model.acknowledgeOverlay(rowId, {
      columnId: 'a',
      mutationId: 'mutation-1',
      revision: 1,
      status: 'confirmed',
      value: 'other-value',
    })
    model.clearConfirmedOverlay(rowId)

    expect(model.readCell(rowId, 'a')).toBe('local')
    expect(model.getOverlayRow(rowId)?.a?.status).toBe('pending')
  })

  it('treats null and empty string as equivalent when clearing confirmed cleared cells', () => {
    const model = createGridViewModel()
    const rowId = buildRowId({
      projectId: 'project-1',
      familyId: 'statistics-1',
      datasetId: 'dataset-1',
      modelRow: 12,
    })

    model.writeBaseRow(rowId, { a: null })
    model.writeOverlayPatch(rowId, {
      a: {
        value: '',
        mutationId: 'mutation-1',
        revision: 1,
        status: 'pending',
      },
    })

    model.acknowledgeOverlay(rowId, {
      columnId: 'a',
      mutationId: 'mutation-1',
      revision: 1,
      status: 'confirmed',
      value: null,
    })
    model.clearConfirmedOverlay(rowId)

    expect(model.getOverlayRow(rowId)).toBeNull()
  })

  it('merges backend reloads without overwriting overlay values', () => {
    const model = createGridViewModel()
    const rowId = buildRowId({
      projectId: 'project-1',
      familyId: 'statistics-1',
      datasetId: 'dataset-1',
      modelRow: 10,
    })

    model.writeBaseRow(rowId, { a: 'backend-a', b: 'backend-b' })
    model.writeOverlayPatch(rowId, {
      a: {
        value: 'local-a',
        mutationId: 'mutation-1',
        revision: 1,
        status: 'pending',
      },
    })
    model.writeBaseRow(rowId, { a: 'stale-backend-a', b: 'fresh-backend-b', c: 'fresh-backend-c' })

    expect(model.readMergedRow(rowId)).toEqual({
      a: 'local-a',
      b: 'fresh-backend-b',
      c: 'fresh-backend-c',
    })
  })

  it('absorbs legacy staged row patches into overlay rows', () => {
    const model = createGridViewModel()
    const rowId = buildRowId({
      projectId: 'project-1',
      familyId: 'statistics-1',
      datasetId: 'dataset-1',
      modelRow: 4,
    })
    const status: OverlayCellStatus = 'persisted'

    model.ingestLegacyRowPatch(rowId, {
      patch: { a: 'legacy-a', b: 'legacy-b' },
      mutationId: 'legacy-1',
      revision: 3,
      status,
    })

    expect(model.readMergedRow(rowId)).toEqual({
      a: 'legacy-a',
      b: 'legacy-b',
    })
    expect(model.getOverlayRow(rowId)).toEqual({
      a: {
        value: 'legacy-a',
        mutationId: 'legacy-1',
        revision: 3,
        status: 'persisted',
      },
      b: {
        value: 'legacy-b',
        mutationId: 'legacy-1',
        revision: 3,
        status: 'persisted',
      },
    })
  })
})
