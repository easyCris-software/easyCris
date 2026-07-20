import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const helperModulePath = '../../../../e2e/utils/device-approval-helper.mjs'

const originalEnv = {
  EASYCRIS_WEB_URL: process.env.EASYCRIS_WEB_URL,
  PW_TEST_SUPPORT_SECRET: process.env.PW_TEST_SUPPORT_SECRET,
  TEST_USER_EMAIL: process.env.TEST_USER_EMAIL,
  TEST_USER_PASSWORD: process.env.TEST_USER_PASSWORD,
}

async function loadHelper() {
  return import(helperModulePath)
}

describe('deviceApprovalHelper', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete process.env.EASYCRIS_WEB_URL
    delete process.env.PW_TEST_SUPPORT_SECRET
    delete process.env.TEST_USER_EMAIL
    delete process.env.TEST_USER_PASSWORD
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

  it('fails loudly when required approval env is missing', async () => {
    const { approveDeviceLinkByUserCode } = await loadHelper()

    await expect(approveDeviceLinkByUserCode('ABCD-EFGH')).rejects.toThrow(
      /EASYCRIS_WEB_URL|PW_TEST_SUPPORT_SECRET|TEST_USER_EMAIL|TEST_USER_PASSWORD/
    )
  })

  it('approves through the protected Auth.js/Postgres test boundary', async () => {
    process.env.EASYCRIS_WEB_URL = 'http://127.0.0.1:3100'
    process.env.PW_TEST_SUPPORT_SECRET = 'test-support-secret'
    process.env.TEST_USER_EMAIL = 'device-link@example.com'
    process.env.TEST_USER_PASSWORD = 'Password-123!'

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          requestId: 'request-456',
          userId: 'user-123',
          deviceId: 'device-789',
          sessionToken: 'a'.repeat(64),
        }),
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const { approveDeviceLinkByUserCode } = await loadHelper()
    const result = await approveDeviceLinkByUserCode('ABCD-EFGH')

    expect(result).toEqual({
      requestId: 'request-456',
      userId: 'user-123',
      deviceId: 'device-789',
      sessionToken: 'a'.repeat(64),
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [approvalUrl, approvalInit] = fetchMock.mock.calls[0] as [
      RequestInfo | URL,
      RequestInit | undefined,
    ]
    expect(String(approvalUrl)).toBe(
      'http://127.0.0.1:3100/api/test-support/auth/authjs-postgres/desktop-auth/approve-by-user-code'
    )
    expect(approvalInit?.method).toBe('POST')
    expect(approvalInit?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-playwright-test-support-secret': 'test-support-secret',
    })
    expect(JSON.parse(String(approvalInit?.body))).toEqual({
      userCode: 'ABCD-EFGH',
      user: {
        email: 'device-link@example.com',
        password: 'Password-123!',
      },
      displayName: null,
    })
  })

  it('revokes through the production session endpoint', async () => {
    process.env.EASYCRIS_WEB_URL = 'http://127.0.0.1:3100'

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, already_revoked: false }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { revokeApprovedDeviceLink } = await loadHelper()
    const result = await revokeApprovedDeviceLink({
      deviceId: 'device-789',
      userId: 'user-123',
      sessionToken: 'b'.repeat(64),
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
    expect(String(revokeUrl)).toBe('http://127.0.0.1:3100/api/device-session/revoke')
    expect(revokeInit?.method).toBe('POST')
    expect(revokeInit?.headers).toMatchObject({
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(revokeInit?.body))).toEqual({
      session_token: 'b'.repeat(64),
    })
  })
})
