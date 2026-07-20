import { describe, expect, it } from 'vitest'
import { shouldShowBlockingAppBusyOverlay } from '../appBusyOverlayGate'

describe('shouldShowBlockingAppBusyOverlay', () => {
  it('shows for blocking operation locks', () => {
    expect(shouldShowBlockingAppBusyOverlay({ active: false, owner: 'paste' })).toBe(false)
    expect(shouldShowBlockingAppBusyOverlay({ active: true, owner: 'rnaseq' })).toBe(true)
    expect(shouldShowBlockingAppBusyOverlay({ active: true, owner: 'paste' })).toBe(true)
    expect(shouldShowBlockingAppBusyOverlay({ active: true, owner: 'grid' })).toBe(true)
    expect(shouldShowBlockingAppBusyOverlay({ active: true, owner: 'statistics' })).toBe(false)
    expect(shouldShowBlockingAppBusyOverlay({ active: true, owner: null })).toBe(false)
  })
})
