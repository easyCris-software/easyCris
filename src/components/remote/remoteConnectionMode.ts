import type { RemoteSessionMode } from '@/services/remoteSessionService'

export const remoteConnectionModeLabels = {
  lan: 'Same Wi-Fi',
  cloud: 'Different network',
} as const satisfies Record<RemoteSessionMode, string>

export const remoteConnectionModeLabel = (mode: RemoteSessionMode) =>
  remoteConnectionModeLabels[mode]
