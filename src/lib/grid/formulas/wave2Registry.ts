/**
 * Wave 2 Promotion Registry
 *
 * Single source of truth for the Wave 2 scalar-promotion manifest.
 * All 27 functions confirmed registered in formualizer-eval 0.4.3.
 * (GAMMALN is NOT in this manifest — only a comment reference in formualizer-eval;
 *  it falls back to fast-formula-parser sync evaluation, catalog entry: backendRequired: false.)
 *
 * Wave 2 covers:
 *   - Statistical distributions (NORM.*, T.DIST/INV, CHISQ.*, F.*, BINOM.DIST,
 *     POISSON.DIST, EXPON.DIST, GAMMA.DIST, WEIBULL.DIST, BETA.DIST,
 *     NEGBINOM.DIST, HYPGEOM.DIST)
 *   - Inference helpers (COVARIANCE.P/S, CONFIDENCE.NORM/T, STANDARDIZE)
 *   - Descriptive (AVEDEV, GEOMEAN, HARMEAN)
 *   - Math (PRODUCT)
 *
 * All entries: status = 'promoted', backendRequired = true.
 *
 * Test dataset (same as Wave 1):
 *   row 0: col-a=10, col-b=1,  col-c='foo'
 *   row 1: col-a=20, col-b=2,  col-c='bar'
 *   row 2: col-a=30, col-b=3,  col-c='baz'
 *   A=col-a, B=col-b, C=col-c
 */

export interface Wave2Entry {
  fn: string
  routingFormula: string
  note: string
  status: 'promoted'
  backendRequired: true
}

export const WAVE2_MANIFEST: readonly Wave2Entry[] = [
  // ── Statistical distributions ─────────────────────────────────────────────
  {
    fn: 'NORM.DIST',
    routingFormula: '=NORM.DIST(0, 0, 1, TRUE)',
    note: 'Normal CDF/PDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'NORM.INV',
    routingFormula: '=NORM.INV(0.5, 0, 1)',
    note: 'Normal quantile function — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'NORM.S.DIST',
    routingFormula: '=NORM.S.DIST(0, TRUE)',
    note: 'Standard normal CDF/PDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'NORM.S.INV',
    routingFormula: '=NORM.S.INV(0.5)',
    note: 'Standard normal quantile function — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'T.DIST',
    routingFormula: '=T.DIST(0, 5, TRUE)',
    note: "Student's t CDF/PDF — always returns a single scalar",
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'T.INV',
    routingFormula: '=T.INV(0.5, 5)',
    note: "Student's t quantile function — always returns a single scalar",
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'CHISQ.DIST',
    routingFormula: '=CHISQ.DIST(0, 2, TRUE)',
    note: 'Chi-squared CDF/PDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'CHISQ.INV',
    routingFormula: '=CHISQ.INV(0.5, 2)',
    note: 'Chi-squared quantile function — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'F.DIST',
    routingFormula: '=F.DIST(1, 5, 5, TRUE)',
    note: 'F-distribution CDF/PDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'F.INV',
    routingFormula: '=F.INV(0.5, 5, 5)',
    note: 'F-distribution quantile function — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'BINOM.DIST',
    routingFormula: '=BINOM.DIST(3, 5, 0.5, TRUE)',
    note: 'Binomial CDF/PMF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'POISSON.DIST',
    routingFormula: '=POISSON.DIST(2, 2, FALSE)',
    note: 'Poisson PMF/CDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'EXPON.DIST',
    routingFormula: '=EXPON.DIST(1, 1, FALSE)',
    note: 'Exponential PDF/CDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'GAMMA.DIST',
    routingFormula: '=GAMMA.DIST(1, 1, 1, FALSE)',
    note: 'Gamma PDF/CDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'WEIBULL.DIST',
    routingFormula: '=WEIBULL.DIST(1, 1, 1, FALSE)',
    note: 'Weibull PDF/CDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'BETA.DIST',
    routingFormula: '=BETA.DIST(0.5, 2, 2, TRUE)',
    note: 'Beta CDF/PDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'NEGBINOM.DIST',
    routingFormula: '=NEGBINOM.DIST(0, 1, 0.5, FALSE)',
    note: 'Negative binomial PMF/CDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'HYPGEOM.DIST',
    routingFormula: '=HYPGEOM.DIST(1, 2, 2, 4, FALSE)',
    note: 'Hypergeometric PMF/CDF — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  // ── Inference helpers ────────────────────────────────────────────────────
  {
    fn: 'COVARIANCE.P',
    routingFormula: '=COVARIANCE.P(A1:A3, B1:B3)',
    note: 'Population covariance — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'COVARIANCE.S',
    routingFormula: '=COVARIANCE.S(A1:A3, B1:B3)',
    note: 'Sample covariance — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'CONFIDENCE.NORM',
    routingFormula: '=CONFIDENCE.NORM(0.05, 1, 100)',
    note: 'Normal confidence interval margin — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'CONFIDENCE.T',
    routingFormula: '=CONFIDENCE.T(0.05, 1, 100)',
    note: "Student's t confidence interval margin — always returns a single scalar",
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'STANDARDIZE',
    routingFormula: '=STANDARDIZE(10, 20, 10)',
    note: 'Z-score normalization — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  // ── Descriptive stats ────────────────────────────────────────────────────
  {
    fn: 'AVEDEV',
    routingFormula: '=AVEDEV(A1:A3)',
    note: 'Average absolute deviation — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'GEOMEAN',
    routingFormula: '=GEOMEAN(A1:A3)',
    note: 'Geometric mean — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  {
    fn: 'HARMEAN',
    routingFormula: '=HARMEAN(A1:A3)',
    note: 'Harmonic mean — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
  // ── Math ─────────────────────────────────────────────────────────────────
  {
    fn: 'PRODUCT',
    routingFormula: '=PRODUCT(A1:A3)',
    note: 'Product of all values — always returns a single scalar',
    status: 'promoted',
    backendRequired: true,
  },
]

// ---------------------------------------------------------------------------
// Derived views — used directly by test file
// ---------------------------------------------------------------------------

/** All promoted entries (all Wave 2 entries are promoted). */
export const WAVE2_PROMOTED = WAVE2_MANIFEST.filter((e) => e.status === 'promoted')

/** All Wave 2 entries route to backend. */
export const WAVE2_BACKEND_PROMOTED = WAVE2_PROMOTED.filter((e) => e.backendRequired)

/** Set of all function names in the manifest. */
export const WAVE2_FN_SET = new Set<string>(WAVE2_MANIFEST.map((e) => e.fn))
