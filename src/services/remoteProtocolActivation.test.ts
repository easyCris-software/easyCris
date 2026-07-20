import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockListen, mockInvoke } = vi.hoisted(() => ({
  mockListen: vi.fn().mockResolvedValue(() => undefined),
  mockInvoke: vi.fn().mockResolvedValue(null),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

describe('initializeRemoteProtocolActivation', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useRealTimers()
    mockListen.mockClear()
    mockListen.mockResolvedValue(() => undefined)
    mockInvoke.mockClear()
    mockInvoke.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('loads a cold-launch pending invite from Rust after the Tauri bridge becomes ready', async () => {
    mockInvoke.mockImplementation(command => {
      if (command === 'take_pending_remote_join_url') return Promise.resolve(null)
      if (command === 'current_remote_join_url') {
        return Promise.resolve(
          'easycris-remote://join?host=127.0.0.1:7743&session=session-1&token=secret-token'
        )
      }
      return Promise.resolve(null)
    })
    const { initializeRemoteProtocolActivation } = await import('./remoteProtocolActivation')
    const { useRemoteJoinUrlStore } = await import('@/store/remote-join-url-store')
    useRemoteJoinUrlStore.setState({ dialogOpen: false, pendingUrl: null })

    initializeRemoteProtocolActivation()

    await vi.waitFor(() =>
      expect(useRemoteJoinUrlStore.getState()).toMatchObject({
        dialogOpen: true,
        pendingUrl:
          'easycris-remote://join?host=127.0.0.1:7743&session=session-1&token=secret-token',
      })
    )
    expect(mockInvoke).toHaveBeenCalledWith('take_pending_remote_join_url')
    expect(mockInvoke).toHaveBeenCalledWith('current_remote_join_url')
  })

  it('opens an invite from the DOM protocol activation event', async () => {
    const { initializeRemoteProtocolActivation } = await import('./remoteProtocolActivation')
    const { useRemoteJoinUrlStore } = await import('@/store/remote-join-url-store')
    useRemoteJoinUrlStore.setState({ dialogOpen: false, pendingUrl: null })

    initializeRemoteProtocolActivation()
    window.dispatchEvent(
      new CustomEvent('easycris-remote-join-link', {
        detail:
          'easycris-remote://join?host=127.0.0.1:7743&session=dom-session&token=dom-token',
      })
    )

    expect(useRemoteJoinUrlStore.getState()).toMatchObject({
      dialogOpen: true,
      pendingUrl:
        'easycris-remote://join?host=127.0.0.1:7743&session=dom-session&token=dom-token',
    })
  })

  it('stops after one empty read on normal launches without a protocol URL', async () => {
    vi.useFakeTimers()
    mockInvoke.mockResolvedValue(null)
    const { initializeRemoteProtocolActivation } = await import('./remoteProtocolActivation')
    const { useRemoteJoinUrlStore } = await import('@/store/remote-join-url-store')
    useRemoteJoinUrlStore.setState({ dialogOpen: false, pendingUrl: null })

    initializeRemoteProtocolActivation()

    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2))
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      'take_pending_remote_join_url',
      'current_remote_join_url',
    ])

    await vi.advanceTimersByTimeAsync(1000)

    expect(mockInvoke).toHaveBeenCalledTimes(2)
    expect(useRemoteJoinUrlStore.getState()).toMatchObject({
      dialogOpen: false,
      pendingUrl: null,
    })
  })

  it('warns on retryable bridge failures and errors after retry exhaustion', async () => {
    vi.useFakeTimers()
    const bridgeError = new Error('bridge unavailable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockInvoke.mockRejectedValue(bridgeError)
    const { initializeRemoteProtocolActivation } = await import('./remoteProtocolActivation')

    initializeRemoteProtocolActivation()

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Remote invite link was not ready yet; retrying:',
        bridgeError
      )
    )

    for (let attempt = 1; attempt < 20; attempt += 1) {
      await vi.advanceTimersByTimeAsync(250)
    }

    expect(error).toHaveBeenCalledWith(
      'Failed to read pending remote invite link:',
      bridgeError
    )
    expect(warn).toHaveBeenCalledTimes(1)
    const { useRemoteJoinUrlStore } = await import('@/store/remote-join-url-store')
    expect(useRemoteJoinUrlStore.getState()).toMatchObject({
      dialogOpen: false,
      pendingUrl: null,
    })
  })

  it('logs listener registration failures', async () => {
    const listenError = new Error('listen unavailable')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockListen.mockRejectedValueOnce(listenError)
    const { initializeRemoteProtocolActivation } = await import('./remoteProtocolActivation')

    initializeRemoteProtocolActivation()

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        'Failed to listen for remote invite links:',
        listenError
      )
    )
    expect(error).toHaveBeenCalledTimes(1)
  })
})
