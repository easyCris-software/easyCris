import type { BracketEffectMeta } from './types'

/**
 * Returns updated bracketVisibility after toggling a master comparison effectId.
 * The master record itself is updated, and all child entries (those with
 * parentId === masterEffectId) are set to the same visibility.
 */
export function cascadeMasterToggle(
  masterEffectId: string,
  visible: boolean,
  effectMap: Record<string, BracketEffectMeta>,
  currentVisibility: Record<string, boolean>,
): Record<string, boolean> {
  const next: Record<string, boolean> = { ...currentVisibility, [masterEffectId]: visible }
  for (const [id, meta] of Object.entries(effectMap)) {
    if (meta.parentId === masterEffectId) {
      next[id] = visible
    }
  }
  return next
}

/**
 * Returns the checked state for a master comparison toggle based on its children's
 * recorded visibility. Defaults to true (visible) when no visibility record exists.
 *
 * Returns:
 *   true          — all children are visible (or no children)
 *   false         — all children are hidden
 *   'indeterminate' — mixed: some visible, some hidden
 */
export function getMasterToggleState(
  masterEffectId: string,
  effectMap: Record<string, BracketEffectMeta>,
  currentVisibility: Record<string, boolean>,
): boolean | 'indeterminate' {
  const childIds = Object.entries(effectMap)
    .filter(([, meta]) => meta.parentId === masterEffectId)
    .map(([id]) => id)

  if (childIds.length === 0) {
    return currentVisibility[masterEffectId] ?? true
  }

  const visibleCount = childIds.filter(id => currentVisibility[id] !== false).length

  if (visibleCount === 0) return false
  if (visibleCount === childIds.length) return true
  return 'indeterminate'
}
