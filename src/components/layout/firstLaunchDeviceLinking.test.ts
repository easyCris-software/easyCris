import { describe, expect, it } from 'vitest'

import {
  shouldAutoCompleteFirstLaunchAfterLink,
  shouldShowWelcomeScreen,
} from './firstLaunchDeviceLinking'

describe('firstLaunchDeviceLinking', () => {
  it('hides the welcome screen while the link dialog is open', () => {
    expect(shouldShowWelcomeScreen({ isFirstLaunch: true, linkDialogOpen: false })).toBe(true)
    expect(shouldShowWelcomeScreen({ isFirstLaunch: true, linkDialogOpen: true })).toBe(false)
    expect(shouldShowWelcomeScreen({ isFirstLaunch: false, linkDialogOpen: false })).toBe(false)
  })

  it('only auto-completes first launch after a successful link', () => {
    expect(
      shouldAutoCompleteFirstLaunchAfterLink({ isFirstLaunch: true, deviceAuthMode: 'linked' })
    ).toBe(true)
    expect(
      shouldAutoCompleteFirstLaunchAfterLink({ isFirstLaunch: true, deviceAuthMode: 'guest' })
    ).toBe(false)
    expect(
      shouldAutoCompleteFirstLaunchAfterLink({ isFirstLaunch: true, deviceAuthMode: 'pairing' })
    ).toBe(false)
    expect(
      shouldAutoCompleteFirstLaunchAfterLink({ isFirstLaunch: false, deviceAuthMode: 'linked' })
    ).toBe(false)
  })
})
