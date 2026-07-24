import type { DeviceAuthMode } from '@/lib/deviceAuth'

export function shouldShowWelcomeScreen(input: {
  isFirstLaunch: boolean
  linkDialogOpen: boolean
}): boolean {
  return input.isFirstLaunch && !input.linkDialogOpen
}

export function shouldAutoCompleteFirstLaunchAfterLink(input: {
  isFirstLaunch: boolean
  deviceAuthMode: DeviceAuthMode
}): boolean {
  return input.isFirstLaunch && input.deviceAuthMode === 'linked'
}
