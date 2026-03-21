import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/app-store'

describe('app operation lock', () => {
  beforeEach(() => {
    useAppStore.getState().reset()
  })

  it('acquires once and rejects concurrent acquire attempts', () => {
    const token = useAppStore.getState().acquireAppOperationLock({
      owner: 'rnaseq',
      operation: 'rnaseq_batch',
      stage: 'Running model 1 of 3',
      progress: 10,
    })
    const secondToken = useAppStore.getState().acquireAppOperationLock({
      owner: 'statistics',
      operation: 'stats_run',
    })

    expect(token).toBeTruthy()
    expect(secondToken).toBeNull()
    expect(useAppStore.getState().appOperationLock.active).toBe(true)
  })

  it('releases only when token matches active lock', () => {
    const token = useAppStore.getState().acquireAppOperationLock({
      owner: 'rnaseq',
      operation: 'rnaseq_batch',
    })
    expect(token).toBeTruthy()

    const wrongRelease = useAppStore.getState().releaseAppOperationLock('wrong-token')
    expect(wrongRelease).toBe(false)
    expect(useAppStore.getState().appOperationLock.active).toBe(true)

    const correctRelease = useAppStore.getState().releaseAppOperationLock(token as string)
    expect(correctRelease).toBe(true)
    expect(useAppStore.getState().appOperationLock.active).toBe(false)
  })
})

