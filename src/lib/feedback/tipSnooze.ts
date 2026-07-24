/**
 * Snooze helpers for BottomLeftTip.
 *
 * Snooze state is stored in localStorage so it persists across sessions.
 * Each tip has its own key so tips can be snoozed independently.
 */

export const SNOOZE_DURATION_MS = 14 * 24 * 60 * 60 * 1000 // 14 days

function snoozeKey(tipId: string): string {
  return `easycris-tip-snooze-${tipId}-until`
}

/** Returns true if the tip is currently within its snooze window. */
export function isSnoozed(tipId: string): boolean {
  const stored = localStorage.getItem(snoozeKey(tipId))
  if (!stored) return false
  return Date.now() < parseInt(stored, 10)
}

/** Snoozes the tip for 14 days from now. */
export function snooze(tipId: string): void {
  localStorage.setItem(snoozeKey(tipId), String(Date.now() + SNOOZE_DURATION_MS))
}

/** Clears any existing snooze for the tip. */
export function clearSnooze(tipId: string): void {
  localStorage.removeItem(snoozeKey(tipId))
}
