import type { RemoteSessionMode } from '@/services/remoteSessionService'

const DEFAULT_REMOTE_ICE_CONFIG_URL =
  'https://remote.easycris.com/v1/remote/ice-config'
const configuredRemoteIceConfigUrl = () =>
  import.meta.env.VITE_REMOTE_ICE_CONFIG_URL ?? DEFAULT_REMOTE_ICE_CONFIG_URL
const DEFAULT_ICE_CONFIG_TIMEOUT_MS = 5000
const DEFAULT_ICE_CONFIG_ATTEMPTS = 2
const DEFAULT_RETRY_BACKOFF_MS = 200

export const remoteIceConfigErrorMessage =
  'Could not fetch remote connection settings. Check your internet connection and try again.'

export type RemoteIceConfigRequest =
  | { role: 'host'; invite_id: string; host_secret: string }
  | {
      role: 'guest'
      invite_id: string
      guest_token: string
      guest_device_id?: string
    }

export interface RemoteIcePolicyOptions {
  mode: RemoteSessionMode
  forceRelay?: boolean
  request?: RemoteIceConfigRequest
  endpointUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  attempts?: number
}

interface RemoteIceConfigResponse {
  iceServers: RTCIceServer[]
}

const wait = (ms: number) =>
  new Promise(resolve => window.setTimeout(resolve, ms))

const isRemoteIceConfigResponse = (
  value: unknown
): value is RemoteIceConfigResponse => {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as RemoteIceConfigResponse).iceServers)
  )
}

export const fetchRemoteIceServers = async (
  options: RemoteIcePolicyOptions
): Promise<RTCIceServer[]> => {
  if (options.mode === 'lan') return []
  if (!options.request) {
    throw new Error(remoteIceConfigErrorMessage)
  }

  const endpointUrl = options.endpointUrl ?? configuredRemoteIceConfigUrl()
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_ICE_CONFIG_TIMEOUT_MS
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ICE_CONFIG_ATTEMPTS)

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetchImpl(endpointUrl, {
        body: JSON.stringify(options.request),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`Remote ICE config failed with HTTP ${response.status}`)
      }
      const payload: unknown = await response.json()
      if (!isRemoteIceConfigResponse(payload)) {
        throw new Error('Remote ICE config response is invalid')
      }
      return payload.iceServers
    } catch (error) {
      if (attempt === attempts) {
        throw new Error(remoteIceConfigErrorMessage, { cause: error })
      }
      await wait(DEFAULT_RETRY_BACKOFF_MS)
    } finally {
      window.clearTimeout(timeout)
    }
  }

  throw new Error(remoteIceConfigErrorMessage)
}

export const getRemotePeerConnectionConfig = async (
  options: RemoteIcePolicyOptions
): Promise<RTCConfiguration> => {
  const iceServers = await fetchRemoteIceServers(options)
  const config: RTCConfiguration = { iceServers }
  if (options.forceRelay) {
    config.iceTransportPolicy = 'relay'
  }
  return config
}
