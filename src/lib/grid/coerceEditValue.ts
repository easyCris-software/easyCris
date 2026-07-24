import { getSemanticsForType } from './semantics'
import type { ColumnMetadata } from '@/store/data-store'

/**
 * Applies type-based coercion to a value before it is committed as a cell edit.
 *
 * Dispatches through getSemanticsForType(columnType).parse() for all string
 * values that are not formula expressions. Non-string values pass through
 * unchanged (already typed or null). Formula strings always pass through so
 * the formula pipeline handles them.
 *
 * Per-type behavior (string inputs only):
 *   numeric   — empty/whitespace → null, numeric string → number, else raw
 *   categorical — empty/whitespace → null, else trimmed string
 *   text      — empty/whitespace → null, else trimmed string
 *   datetime  — safe ISO/date-only → UTC timestamp, ambiguous/invalid → raw
 *   undefined/null — falls back to textSemantics (empty → null, else trimmed)
 *
 * Note: sentinel strings ('na', '-', etc.) are stored as-is for all types.
 * isMissing() handles their classification at display/sort time.
 *
 * @param value      Raw value from clipboard, cell editor, formula bar, or fill
 * @param columnType Declared type of the target column
 * @param isFormula  Predicate from formulaService; defaults to always-false
 */
export function coerceEditValue(
  value: unknown,
  columnType: ColumnMetadata['type'] | undefined | null,
  isFormula: (s: string) => boolean = () => false
): unknown {
  if (typeof value !== 'string') return value
  // Check trimmed value so that leading-space formula literals like "  =SUM(A1)"
  // are caught here rather than being silently trimmed by parse() into a bare
  // "=SUM(A1)" which editExecutor would evaluate as a formula.
  // The original (untrimmed) value is returned so the leading space survives as
  // an intentional escape — consistent with how Excel treats "  =..." as text.
  if (isFormula(value.trim())) return value
  return getSemanticsForType(columnType).parse(value)
}
