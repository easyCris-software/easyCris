/**
 * Wave 3 Promotion Registry
 *
 * Single source of truth for the Wave 3 scalar-promotion manifest.
 * Both functions confirmed implemented in formualizer-eval 0.4.3 (lambda.rs).
 *
 * Wave 3 covers:
 *   - LET    (lambda.rs:110) — variable binding, always returns a single scalar
 *   - LAMBDA (lambda.rs:256) — anonymous function, invoked via LET binding returns a single scalar
 *                             (self-invoke syntax =LAMBDA(…)(arg) unsupported by formualizer parser)
 *
 * FFP 1.0.19 has zero LET/LAMBDA implementation — backend routing is mandatory.
 * MAP/BYROW/BYCOL/MAKEARRAY/SCAN/REDUCE (spill-returning higher-order combinators)
 * remain spill-deferred and are NOT in this manifest.
 *
 * All entries: status = 'promoted', backendRequired = true.
 */

export interface Wave3Entry {
  fn: string
  routingFormula: string
  note: string
  status: 'promoted'
  backendRequired: true
}

export const WAVE3_MANIFEST: readonly Wave3Entry[] = [
  {
    fn: 'LET',
    routingFormula: '=LET(x,5,x*2)',
    note: 'Variable binding — always returns a single scalar; FFP 1.0.19 has no LET support',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'LAMBDA',
    // Immediate self-invocation =LAMBDA(x,x*2)(5) is NOT supported by the formualizer-eval
    // parser (unexpected token at the trailing '('). Use LET binding instead — the standard
    // Excel form and the shape formualizer-eval actually handles.
    routingFormula: '=LET(f,LAMBDA(x,x*2),f(5))',
    note: 'Anonymous function via LET binding — scalar result; FFP 1.0.19 has no LAMBDA support; self-invoke syntax unsupported by formualizer parser',
    status: 'promoted',
    backendRequired: true,
  },
]

// ---------------------------------------------------------------------------
// Derived views — used directly by test file
// ---------------------------------------------------------------------------

/** All promoted entries (all Wave 3 entries are promoted). */
export const WAVE3_PROMOTED = WAVE3_MANIFEST.filter((e) => e.status === 'promoted')

/** All Wave 3 entries route to backend. */
export const WAVE3_BACKEND_PROMOTED = WAVE3_PROMOTED.filter((e) => e.backendRequired)

/** Set of all function names in the manifest. */
export const WAVE3_FN_SET = new Set<string>(WAVE3_MANIFEST.map((e) => e.fn))
