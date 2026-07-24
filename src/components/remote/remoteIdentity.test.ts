import { describe, expect, it } from 'vitest'
import { buildRemoteIdentity } from './remoteIdentity'

describe('buildRemoteIdentity', () => {
  it('labels unlinked users as devices instead of session guests', () => {
    const identity = buildRemoteIdentity({
      linkedEmail: null,
      deviceId: 'device-id',
      deviceFingerprint: 'abcdef1234567890',
    })

    expect(identity.display_name).toBe('Device 123456')
    expect(identity.device_id).toBe('device-id')
    expect(identity.is_guest).toBe(true)
  })

  it('uses the linked email as the remote display name', () => {
    const identity = buildRemoteIdentity({
      linkedEmail: 'user@example.com',
      deviceId: 'device-id',
      deviceFingerprint: 'abcdef1234567890',
    })

    expect(identity.display_name).toBe('user@example.com')
    expect(identity.is_guest).toBe(false)
  })
})
