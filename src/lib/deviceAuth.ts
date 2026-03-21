export type DeviceAuthMode = 'guest' | 'pairing' | 'linked' | 'invalid'

export type DeviceEntitlementTier = 'free' | 'pro' | 'enterprise' | string

export interface DeviceLinkStartResult {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type DesktopAuthPollStatus =
  | 'pending'
  | 'rate_limited'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'consumed'

export interface DeviceLinkPollResult {
  status: DesktopAuthPollStatus
  sessionToken?: string
  retryAfterSecs?: number
}

export interface DeviceSessionValidationResult {
  valid: boolean
  reason?: string
  deviceId?: string
  tier?: DeviceEntitlementTier
  expiresAt?: string | null
  email?: string | null
}

export interface DeviceSessionRefreshResult extends DeviceSessionValidationResult {
  sessionToken?: string
}

export interface DeviceSessionRevokeResult {
  success: boolean
  alreadyRevoked: boolean
}

export interface StoredDeviceAuthSession {
  sessionToken: string
  linkedEmail: string | null
  tier: DeviceEntitlementTier | null
  deviceId: string | null
  expiresAt: string | null
  lastValidatedAt: string | null
}

export interface PairingSnapshot {
  deviceCode: string
  userCode: string
  verificationUri: string
  pollIntervalSeconds: number
  expiresAt: string
}
