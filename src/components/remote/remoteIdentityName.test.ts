import { describe, expect, it } from 'vitest'
import { remoteIdentityName } from '@/components/remote/remoteIdentityName'

describe('remoteIdentityName', () => {
  it('uses meaningful account display names before device ids', () => {
    expect(
      remoteIdentityName({
        deviceId: 'device-id',
        displayName: 'user@example.com',
        fallback: 'fallback',
      })
    ).toBe('user@example.com')
  })

  it('uses device ids for generic guest labels', () => {
    expect(
      remoteIdentityName({
        deviceId: 'guest-device-id',
        displayName: 'Guest',
        fallback: 'fallback',
      })
    ).toBe('guest-device-id')
  })

  it('uses device ids for generated device labels', () => {
    expect(
      remoteIdentityName({
        deviceId: 'host-device-id',
        displayName: 'Device 123456',
        fallback: 'fallback',
      })
    ).toBe('host-device-id')
  })
})
