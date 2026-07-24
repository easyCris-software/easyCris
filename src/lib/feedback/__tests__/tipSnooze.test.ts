import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isSnoozed, snooze, clearSnooze, SNOOZE_DURATION_MS } from '../tipSnooze'

const TIP_ID = 'rate-us'

describe('tipSnooze', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('isSnoozed returns false when no snooze key exists', () => {
    expect(isSnoozed(TIP_ID)).toBe(false)
  })

  it('isSnoozed returns true when snoozed until the future', () => {
    const futureTs = Date.now() + 1_000_000
    localStorage.setItem(`easycris-tip-snooze-${TIP_ID}-until`, String(futureTs))
    expect(isSnoozed(TIP_ID)).toBe(true)
  })

  it('isSnoozed returns false when snooze timestamp has expired', () => {
    const pastTs = Date.now() - 1
    localStorage.setItem(`easycris-tip-snooze-${TIP_ID}-until`, String(pastTs))
    expect(isSnoozed(TIP_ID)).toBe(false)
  })

  it('snooze sets a key that makes isSnoozed return true', () => {
    snooze(TIP_ID)
    expect(isSnoozed(TIP_ID)).toBe(true)
  })

  it('snooze stores a timestamp 14 days in the future', () => {
    vi.useFakeTimers()
    const now = new Date('2026-01-01').getTime()
    vi.setSystemTime(now)

    snooze(TIP_ID)

    const stored = parseInt(localStorage.getItem(`easycris-tip-snooze-${TIP_ID}-until`) ?? '0', 10)
    expect(stored).toBe(now + SNOOZE_DURATION_MS)
  })

  it('clearSnooze removes the key so isSnoozed returns false', () => {
    snooze(TIP_ID)
    expect(isSnoozed(TIP_ID)).toBe(true)
    clearSnooze(TIP_ID)
    expect(isSnoozed(TIP_ID)).toBe(false)
  })

  it('SNOOZE_DURATION_MS is 14 days', () => {
    expect(SNOOZE_DURATION_MS).toBe(14 * 24 * 60 * 60 * 1000)
  })
})
