/**
 * Wave 1 Promotion Registry
 *
 * Single source of truth for the Wave 1 scalar-promotion manifest.
 * Drives parity between:
 *   - formulaCapability.wave1.test.ts  (routing/wiring Vitest TDD gate)
 *   - formula_backend.rs wave1 tests   (Rust backend value assertions)
 *
 * Status legend:
 *   spill-deferred → function still blocked; spill-block test is GREEN (confirms guard works)
 *   promoted       → classification changed to scalar; routing/wiring tests are GREEN
 *
 * To promote a function from Wave 1:
 *   1. In formulaCatalog.ts:
 *        - Change classification from 'spill-deferred' to 'scalar'
 *        - Set backendRequired: true  (route to Formualizer)
 *            OR backendRequired: false (fast-formula-parser handles it)
 *   2. Update status → 'promoted' in this file.
 *   3. If backendRequired: false, set syncExpected to the expected result value.
 *   4. Run `vitest run formulaCapability.wave1` — routing test must turn GREEN.
 *   5. Run `cargo test test_wave1_<fn>` — Rust value test must pass (backend-required only).
 *   6. spillDeferred PARITY_REV auto-fails until SPILL_CASES entry is removed — remove it.
 */

export interface Wave1Entry {
  /** Function name (UPPER_CASE, matches formulaCatalog entry) */
  fn: string
  /**
   * Minimal syntactically-valid formula for the routing test.
   * Must reference at most A1:A3 / B1:B3 using the 3-row test dataset.
   */
  routingFormula: string
  /** Why this function is a Wave 1 candidate */
  note: string
  /** Current promotion status */
  status: 'spill-deferred' | 'promoted'
  /**
   * When promoted:
   *   true  → evaluate() must enqueue a backend request and return CALC_PENDING_SENTINEL
   *   false → evaluate() must return syncExpected synchronously (no backend routing)
   */
  backendRequired: boolean
  /**
   * Expected value from a synchronous evaluation (only relevant when
   * status === 'promoted' && backendRequired === false).
   */
  syncExpected?: unknown
}

// ---------------------------------------------------------------------------
// Wave 1 manifest
// ---------------------------------------------------------------------------
// Test dataset available in routing tests (and Rust tests):
//   row 0: col-a=10, col-b=1,  col-c='foo'
//   row 1: col-a=20, col-b=2,  col-c='bar'
//   row 2: col-a=30, col-b=3,  col-c='baz'
//   (A=col-a, B=col-b, C=col-c in Excel letter mapping)
// ---------------------------------------------------------------------------
export const WAVE1_MANIFEST: readonly Wave1Entry[] = [
  // ── Backend-required scalars ───────────────────────────────────────────
  // NOTE: ISFORMULA is NOT in this manifest. It has been reclassified to
  // 'semantics-deferred' (Formualizer currently always returns FALSE).
  // It will be re-added here once the provenance-tracking gap is closed.
  {
    fn: 'MAXIFS',
    routingFormula: '=MAXIFS(A1:A3,B1:B3,">1")',
    note: 'Scalar aggregate with criteria — always returns a single value',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'MINIFS',
    routingFormula: '=MINIFS(A1:A3,B1:B3,">1")',
    note: 'Scalar aggregate with criteria — always returns a single value',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'XMATCH',
    routingFormula: '=XMATCH(20,A1:A3)',
    note: 'Lookup returning position scalar (1-based) — no spill risk',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'FORECAST.LINEAR',
    routingFormula: '=FORECAST.LINEAR(4,A1:A3,B1:B3)',
    note: 'Regression scalar — maps x-value to linear trend line',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'T.TEST',
    routingFormula: '=T.TEST(A1:A3,B1:B3,2,1)',
    note: 'Paired t-test returning p-value scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'TEXTAFTER',
    routingFormula: '=TEXTAFTER("hello-world","-")',
    note: 'Text scalar — returns substring after first delimiter occurrence',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'TEXTBEFORE',
    routingFormula: '=TEXTBEFORE("hello-world","-")',
    note: 'Text scalar — returns substring before first delimiter occurrence',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'VALUETOTEXT',
    routingFormula: '=VALUETOTEXT(42)',
    note: 'Converts any value to its text representation — always scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'ARRAYTOTEXT',
    routingFormula: '=ARRAYTOTEXT(A1:A2)',
    note: 'In single-cell context returns concatenated scalar string',
    status: 'promoted',
    backendRequired: true,
  },
]

// ---------------------------------------------------------------------------
// Derived views — used directly by test file
// ---------------------------------------------------------------------------

/** All entries not yet promoted (spill guard still active). */
export const WAVE1_PENDING = WAVE1_MANIFEST.filter((e) => e.status === 'spill-deferred')

/** All promoted entries (routing/wiring tests are active). */
export const WAVE1_PROMOTED = WAVE1_MANIFEST.filter((e) => e.status === 'promoted')

/** Promoted entries that route to the backend (CALC_PENDING_SENTINEL expected). */
export const WAVE1_BACKEND_PROMOTED = WAVE1_PROMOTED.filter((e) => e.backendRequired)

/** Promoted entries evaluated synchronously (syncExpected value). */
export const WAVE1_SYNC_PROMOTED = WAVE1_PROMOTED.filter((e) => !e.backendRequired)

/** Set of all function names in the manifest. */
export const WAVE1_FN_SET = new Set<string>(WAVE1_MANIFEST.map((e) => e.fn))
