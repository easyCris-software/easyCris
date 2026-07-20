/**
 * getTransformLabel
 *
 * Single source of truth for human-readable transform type labels.
 * Used by TransformWarningDialog and AppShell's applyPendingTransform so the
 * two sites cannot independently drift (e.g. warning says "Filter (Permanent)"
 * while the success toast says "Filter").
 */

const TRANSFORM_LABEL_MAP: Record<string, string> = {
  pivot_wider: 'Pivot Wider',
  pivot_longer: 'Pivot Longer',
  // "Filter (Permanent)" explicitly distinguishes the destructive row-removal
  // transform from the non-destructive view filter that only hides rows.
  filter: 'Filter (Permanent)',
  group_aggregate: 'Group & Aggregate',
}

/**
 * Returns the canonical display label for a transform type.
 * Falls back to the raw type string if the type is not recognised.
 */
export function getTransformLabel(type: string): string {
  return TRANSFORM_LABEL_MAP[type] ?? type
}
