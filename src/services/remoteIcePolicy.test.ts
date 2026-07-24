import { describe, expect, it, vi } from 'vitest'
import {
  fetchRemoteIceServers,
  getRemotePeerConnectionConfig,
  remoteIceConfigErrorMessage,
} from './remoteIcePolicy'

describe('remoteIcePolicy', () => {
  it('uses no ICE servers for LAN mode without calling fetch', async () => {
    const fetchImpl = vi.fn()

    await expect(
      fetchRemoteIceServers({ mode: 'lan', fetchImpl })
    ).resolves.toEqual([])
    await expect(
      getRemotePeerConnectionConfig({ mode: 'lan', fetchImpl })
    ).resolves.toEqual({ iceServers: [] })

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('builds a forced relay peer connection config for cloud debug runs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            credential: 'credential',
            urls: 'turn:turn.easycris.com:3478',
            username: 'username',
          },
        ],
      }),
    })

    await expect(
      getRemotePeerConnectionConfig({
        mode: 'cloud',
        forceRelay: true,
        request: {
          role: 'host',
          invite_id: 'rmt_test',
          host_secret: 'host-secret',
        },
        fetchImpl,
      })
    ).resolves.toEqual({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
          credential: 'credential',
          urls: 'turn:turn.easycris.com:3478',
          username: 'username',
        },
      ],
      iceTransportPolicy: 'relay',
    })
  })

  it('posts the participant proof as JSON for cloud ICE config', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ iceServers: [] }),
    })

    await fetchRemoteIceServers({
      mode: 'cloud',
      endpointUrl: 'https://remote.easycris.com/v1/remote/ice-config',
      request: {
        role: 'guest',
        invite_id: 'rmt_test',
        guest_token: 'guest-token',
        guest_device_id: 'guest-device',
      },
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://remote.easycris.com/v1/remote/ice-config',
      expect.objectContaining({
        body: JSON.stringify({
          role: 'guest',
          invite_id: 'rmt_test',
          guest_token: 'guest-token',
          guest_device_id: 'guest-device',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    )
  })

  it('retries cloud ICE config and then reports the user-facing setup error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    })

    await expect(
      fetchRemoteIceServers({
        mode: 'cloud',
        attempts: 2,
        timeoutMs: 10,
        request: {
          role: 'host',
          invite_id: 'rmt_test',
          host_secret: 'host-secret',
        },
        fetchImpl,
      })
    ).rejects.toThrow(remoteIceConfigErrorMessage)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries cloud ICE config when fetch throws', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ iceServers: [] }),
      })

    await expect(
      fetchRemoteIceServers({
        mode: 'cloud',
        attempts: 2,
        timeoutMs: 10,
        request: {
          role: 'guest',
          invite_id: 'rmt_test',
          guest_token: 'guest-token',
        },
        fetchImpl,
      })
    ).resolves.toEqual([])

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
