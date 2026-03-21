import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const helperModulePath = '../../../../e2e/utils/device-approval-helper.mjs'

const originalEnv = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  TEST_USER_EMAIL: process.env.TEST_USER_EMAIL,
  TEST_USER_PASSWORD: process.env.TEST_USER_PASSWORD,
  VITE_EASYCRIS_WEB_URL: process.env.VITE_EASYCRIS_WEB_URL,
}

async function loadHelper() {
  return import(helperModulePath)
}

function hashCode(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('deviceApprovalHelper', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    delete process.env.TEST_USER_EMAIL
    delete process.env.TEST_USER_PASSWORD
    delete process.env.VITE_EASYCRIS_WEB_URL
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key as keyof typeof originalEnv]
      } else {
        process.env[key as keyof typeof originalEnv] = value
      }
    }
  })

  it('fails loudly when required env is missing', async () => {
    const { approveDeviceLinkByUserCode } = await loadHelper()

    await expect(approveDeviceLinkByUserCode('ABCD-EFGH')).rejects.toThrow(
      /NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|TEST_USER_EMAIL/
    )
  })

  it('approves a pending request via the exact approval RPC contract', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    process.env.TEST_USER_EMAIL = 'device-link@example.com'

    const fetchMock = vi.fn()

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            users: [
              {
                id: 'user-123',
                email: 'device-link@example.com',
              },
            ],
            total: 1,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 'request-456',
            },
          ]),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              device_id: 'device-789',
            },
          ]),
          { status: 200 }
        )
      )

    vi.stubGlobal('fetch', fetchMock)

    const { approveDeviceLinkByUserCode } = await loadHelper()
    const result = await approveDeviceLinkByUserCode('ABCD-EFGH')

    expect(result.userId).toBe('user-123')
    expect(result.requestId).toBe('request-456')
    expect(result.deviceId).toBe('device-789')
    expect(result.sessionToken).toMatch(/^[0-9a-f]{64}$/)

    expect(fetchMock).toHaveBeenCalledTimes(3)

    const firstCall = fetchMock.mock.calls[0]
    expect(firstCall).toBeDefined()
    const [listUsersUrl, listUsersInit] = firstCall as [RequestInfo | URL, RequestInit | undefined]
    expect(String(listUsersUrl)).toContain('/auth/v1/admin/users')
    expect(listUsersInit?.headers).toMatchObject({
      apikey: 'service-role-key',
      Authorization: 'Bearer service-role-key',
    })

    const secondCall = fetchMock.mock.calls[1]
    expect(secondCall).toBeDefined()
    const [lookupUrl] = secondCall as [RequestInfo | URL, RequestInit | undefined]
    const hashedCode = hashCode('ABCDEFGH')
    expect(String(lookupUrl)).toContain('/rest/v1/desktop_auth_requests')
    expect(String(lookupUrl)).toContain(`user_code_hash=eq.${hashedCode}`)
    expect(String(lookupUrl)).toContain('status=eq.pending')

    const thirdCall = fetchMock.mock.calls[2]
    expect(thirdCall).toBeDefined()
    const [, rpcInit] = thirdCall as [RequestInfo | URL, RequestInit | undefined]
    expect(rpcInit?.method).toBe('POST')
    expect(rpcInit?.headers).toMatchObject({
      apikey: 'service-role-key',
      Authorization: 'Bearer service-role-key',
    })

    const rpcBody = JSON.parse(String(rpcInit?.body))
    expect(rpcBody).toMatchObject({
      p_auth_request_id: 'request-456',
      p_user_id: 'user-123',
      p_display_name: null,
      p_pickup_secret: result.sessionToken,
      p_max_approve_attempts: 5,
    })
    expect(rpcBody.p_session_token_hash).toBe(hashCode(result.sessionToken))
  })

  it('deletes approved desktop device state during e2e cleanup', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    process.env.TEST_USER_EMAIL = 'device-link@example.com'

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([{ id: 'device-789' }]), { status: 200 })
    )

    vi.stubGlobal('fetch', fetchMock)

    const { revokeApprovedDeviceLink } = await loadHelper()
    const result = await revokeApprovedDeviceLink({
      deviceId: 'device-789',
      userId: 'user-123',
    })

    expect(result).toEqual({
      success: true,
      alreadyRevoked: false,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [revokeUrl, revokeInit] = fetchMock.mock.calls[0] as [
      RequestInfo | URL,
      RequestInit | undefined,
    ]

    expect(String(revokeUrl)).toContain('/rest/v1/devices')
    expect(String(revokeUrl)).toContain('id=eq.device-789')
    expect(String(revokeUrl)).toContain('user_id=eq.user-123')
    expect(revokeInit?.method).toBe('DELETE')
    expect(revokeInit?.headers).toMatchObject({
      apikey: 'service-role-key',
      Authorization: 'Bearer service-role-key',
      Prefer: 'return=representation',
    })
    expect(revokeInit?.body).toBeUndefined()
  })
})
