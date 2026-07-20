import { describe, expect, it } from 'vitest'
import { useRemoteJoinUrlStore } from './remote-join-url-store'

describe('useRemoteJoinUrlStore', () => {
  it('stores a clicked remote invite until the join view clears it', () => {
    useRemoteJoinUrlStore.setState({ pendingUrl: null })

    const url = 'easycris-remote://join?host=127.0.0.1:49152'
    useRemoteJoinUrlStore.getState().setPendingUrl(url)

    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBe(url)

    useRemoteJoinUrlStore.getState().clearPendingUrl(url)
    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBeNull()
  })

  it('does not clear a newer pending invite with a stale clear request', () => {
    useRemoteJoinUrlStore.setState({ pendingUrl: null })

    useRemoteJoinUrlStore.getState().setPendingUrl('easycris-remote://one')
    useRemoteJoinUrlStore.getState().setPendingUrl('easycris-remote://two')
    useRemoteJoinUrlStore.getState().clearPendingUrl('easycris-remote://one')

    expect(useRemoteJoinUrlStore.getState().pendingUrl).toBe(
      'easycris-remote://two'
    )
  })

  it('opens the invite dialog for a new pending invite', () => {
    useRemoteJoinUrlStore.setState({ dialogOpen: false, pendingUrl: null })

    useRemoteJoinUrlStore.getState().setPendingUrl('easycris-remote://one')

    expect(useRemoteJoinUrlStore.getState()).toMatchObject({
      dialogOpen: true,
      pendingUrl: 'easycris-remote://one',
    })
  })

  it('can hide the invite dialog without clearing the pending invite', () => {
    useRemoteJoinUrlStore.setState({ dialogOpen: false, pendingUrl: null })

    useRemoteJoinUrlStore.getState().setPendingUrl('easycris-remote://one')
    useRemoteJoinUrlStore.getState().hideDialog()

    expect(useRemoteJoinUrlStore.getState()).toMatchObject({
      dialogOpen: false,
      pendingUrl: 'easycris-remote://one',
    })
  })
})
