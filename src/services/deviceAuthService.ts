import type {
  DeviceLinkPollResult,
  DeviceLinkStartResult,
  DeviceSessionRefreshResult,
  DeviceSessionRevokeResult,
  DeviceSessionValidationResult,
} from '@/lib/deviceAuth'
import { invoke } from '@tauri-apps/api/core'

type StartLinkingParams = {
  clientVersion: string
  deviceFingerprint: string
}

const DEFAULT_WEB_BASE_URL = 'https://easycris.com'

export function getEasyCrisWebBaseUrl(): string {
  const configured = import.meta.env.VITE_EASYCRIS_WEB_URL?.trim()
  const baseUrl = configured && configured.length > 0 ? configured : DEFAULT_WEB_BASE_URL
  return baseUrl.replace(/\/+$/, '')
}

export function getDeviceManagementUrl(): string {
  return `${getEasyCrisWebBaseUrl()}/account/devices`
}

type InvokeArgs = Record<string, string>

async function callNativeCommand<T>(
  command: string,
  args: InvokeArgs
): Promise<T> {
  return await invoke<T>(command, args)
}

export async function startLinking(
  params: StartLinkingParams
): Promise<DeviceLinkStartResult> {
  return await callNativeCommand<DeviceLinkStartResult>('desktop_auth_start', {
    clientVersion: params.clientVersion,
    deviceFingerprint: params.deviceFingerprint,
  })
}

export async function pollLinking(params: {
  deviceCode: string
}): Promise<DeviceLinkPollResult> {
  return await callNativeCommand<DeviceLinkPollResult>('desktop_auth_poll', {
    deviceCode: params.deviceCode,
  })
}

export async function validateDeviceSession(
  sessionToken: string
): Promise<DeviceSessionValidationResult> {
  return await callNativeCommand<DeviceSessionValidationResult>(
    'desktop_auth_validate_session',
    { sessionToken }
  )
}

export async function refreshDeviceSession(
  sessionToken: string
): Promise<DeviceSessionRefreshResult> {
  return await callNativeCommand<DeviceSessionRefreshResult>(
    'desktop_auth_refresh_session',
    { sessionToken }
  )
}

export async function revokeCurrentDeviceSession(
  sessionToken: string
): Promise<DeviceSessionRevokeResult> {
  return await callNativeCommand<DeviceSessionRevokeResult>(
    'desktop_auth_revoke_session',
    { sessionToken }
  )
}
