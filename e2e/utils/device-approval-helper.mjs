import { createHash, randomBytes } from 'node:crypto'

const DEFAULT_SUPABASE_PAGE_SIZE = 200
const DEFAULT_MAX_APPROVE_ATTEMPTS = 5

/**
 * Deterministic desktop device-link approval helper for Tauri E2E.
 *
 * This proves the backend approval contract used by desktop polling.
 * It intentionally does not replace browser/UI coverage that belongs in easycris_web.
 */

function requireEnv(name, description) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing ${name} for ${description}.`)
  }
  return value
}

export function getDeviceApprovalConfig() {
  return {
    supabaseUrl: requireEnv(
      'NEXT_PUBLIC_SUPABASE_URL',
      'desktop device-link approval helper'
    ).replace(/\/+$/, ''),
    serviceRoleKey: requireEnv(
      'SUPABASE_SERVICE_ROLE_KEY',
      'desktop device-link approval helper'
    ),
    testUserEmail: requireEnv(
      'TEST_USER_EMAIL',
      'desktop device-link approval helper'
    ).toLowerCase(),
    testUserPassword: process.env.TEST_USER_PASSWORD?.trim() || null,
  }
}

function createAuthHeaders(serviceRoleKey, extraHeaders = {}) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  }
}

async function fetchJson(url, init, errorContext) {
  const response = await fetch(url, init)
  const text = await response.text()
  const data = text ? JSON.parse(text) : null

  if (!response.ok) {
    const message =
      typeof data?.error === 'string'
        ? data.error
        : typeof data?.message === 'string'
          ? data.message
          : `${response.status} ${response.statusText}`.trim()

    const error = new Error(`${errorContext}: ${message}`)
    error.name = data?.code ?? error.name
    error.code = data?.code
    error.details = data?.details
    error.hint = data?.hint
    throw error
  }

  return data
}

function normalizeUserCode(userCode) {
  return userCode.replace(/-/g, '').trim().toUpperCase()
}

function hashCode(value) {
  return createHash('sha256').update(value).digest('hex')
}

function generateSessionToken() {
  return randomBytes(32).toString('hex')
}

function buildSupabaseUrl(baseUrl, pathname, query = undefined) {
  const url = new URL(pathname, `${baseUrl}/`)
  if (query) {
    for (const [key, value] of query.entries()) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

async function listUsersPage(config, page) {
  const query = new URLSearchParams({
    page: String(page),
    per_page: String(DEFAULT_SUPABASE_PAGE_SIZE),
  })

  return await fetchJson(
    buildSupabaseUrl(config.supabaseUrl, '/auth/v1/admin/users', query),
    {
      method: 'GET',
      headers: createAuthHeaders(config.serviceRoleKey),
    },
    'Failed to list auth users'
  )
}

async function findAuthUserByEmail(config, email) {
  const normalized = email.trim().toLowerCase()
  let page = 1

  while (true) {
    const data = await listUsersPage(config, page)
    const users = Array.isArray(data?.users) ? data.users : []
    const match = users.find((user) => String(user?.email ?? '').toLowerCase() === normalized)

    if (match) {
      return match
    }

    if (
      users.length < DEFAULT_SUPABASE_PAGE_SIZE ||
      (data?.total ?? Number.POSITIVE_INFINITY) <= page * DEFAULT_SUPABASE_PAGE_SIZE
    ) {
      return null
    }

    page += 1
  }
}

async function ensureApprovalUser(config) {
  const existing = await findAuthUserByEmail(config, config.testUserEmail)
  if (existing?.id) {
    return existing.id
  }

  if (!config.testUserPassword) {
    throw new Error(
      `Approval test user ${config.testUserEmail} was not found and TEST_USER_PASSWORD is unavailable for provisioning.`
    )
  }

  const created = await fetchJson(
    buildSupabaseUrl(config.supabaseUrl, '/auth/v1/admin/users'),
    {
      method: 'POST',
      headers: createAuthHeaders(config.serviceRoleKey),
      body: JSON.stringify({
        email: config.testUserEmail,
        password: config.testUserPassword,
        email_confirm: true,
        user_metadata: {
          email: config.testUserEmail,
          email_verified: true,
        },
      }),
    },
    `Failed to create approval test user ${config.testUserEmail}`
  )

  const userId = created?.user?.id
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error(`Provisioned approval test user ${config.testUserEmail} did not return a user id.`)
  }

  return userId
}

async function findPendingAuthRequest(config, userCode) {
  const query = new URLSearchParams({
    select: 'id',
    user_code_hash: `eq.${hashCode(normalizeUserCode(userCode))}`,
    status: 'eq.pending',
    order: 'created_at.desc',
    limit: '1',
  })

  const rows = await fetchJson(
    buildSupabaseUrl(config.supabaseUrl, '/rest/v1/desktop_auth_requests', query),
    {
      method: 'GET',
      headers: createAuthHeaders(config.serviceRoleKey),
    },
    `Failed to resolve pending desktop auth request for ${userCode}`
  )

  return Array.isArray(rows) ? rows[0] ?? null : null
}

export async function approveDeviceLinkByUserCode(userCode, options = {}) {
  const config = getDeviceApprovalConfig()
  const userId = await ensureApprovalUser(config)
  const pendingRequest = await findPendingAuthRequest(config, userCode)

  if (!pendingRequest?.id) {
    throw new Error(`No pending desktop auth request found for ${userCode}.`)
  }

  const sessionToken = generateSessionToken()
  const sessionTokenHash = hashCode(sessionToken)
  const rpcArgs = {
    p_auth_request_id: pendingRequest.id,
    p_user_id: userId,
    p_session_token_hash: sessionTokenHash,
    p_display_name: options.displayName ?? null,
    p_pickup_secret: sessionToken,
    p_max_approve_attempts: DEFAULT_MAX_APPROVE_ATTEMPTS,
  }

  const rpcUrl = buildSupabaseUrl(config.supabaseUrl, '/rest/v1/rpc/easycris_approve_auth_request')
  let approvedRows

  try {
    approvedRows = await fetchJson(
      rpcUrl,
      {
        method: 'POST',
        headers: createAuthHeaders(config.serviceRoleKey),
        body: JSON.stringify(rpcArgs),
      },
      `Failed to approve desktop auth request ${pendingRequest.id}`
    )
  } catch (error) {
    const shouldRetryWithoutAttemptLimit =
      error?.code === 'PGRST202' &&
      String(error?.hint ?? '').includes('easycris_approve_auth_request')

    if (!shouldRetryWithoutAttemptLimit) {
      throw error
    }

    const { p_max_approve_attempts, ...legacyRpcArgs } = rpcArgs
    approvedRows = await fetchJson(
      rpcUrl,
      {
        method: 'POST',
        headers: createAuthHeaders(config.serviceRoleKey),
        body: JSON.stringify(legacyRpcArgs),
      },
      `Failed to approve desktop auth request ${pendingRequest.id}`
    )
  }

  const approvedRow = Array.isArray(approvedRows) ? approvedRows[0] ?? null : null
  if (!approvedRow?.device_id) {
    throw new Error(`Approval RPC did not return a device id for ${pendingRequest.id}.`)
  }

  return {
    requestId: pendingRequest.id,
    userId,
    deviceId: approvedRow.device_id,
    sessionToken,
  }
}

export async function revokeApprovedDeviceLink({ deviceId, userId = null } = {}) {
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
    throw new Error('deviceId is required to revoke an approved desktop link.')
  }

  const config = getDeviceApprovalConfig()
  const query = new URLSearchParams({
    id: `eq.${deviceId.trim()}`,
    select: 'id',
  })

  if (typeof userId === 'string' && userId.trim().length > 0) {
    query.set('user_id', `eq.${userId.trim()}`)
  }

  const rows = await fetchJson(
    buildSupabaseUrl(config.supabaseUrl, '/rest/v1/devices', query),
    {
      method: 'DELETE',
      headers: createAuthHeaders(config.serviceRoleKey, {
        Prefer: 'return=representation',
      }),
    },
    `Failed to delete approved desktop device ${deviceId}`
  )

  const updatedRows = Array.isArray(rows) ? rows : []
  return {
    success: updatedRows.length === 1,
    alreadyRevoked: updatedRows.length === 0,
  }
}
