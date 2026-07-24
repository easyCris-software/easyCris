/**
 * Formula Catalog — single source of truth for formula function classification.
 *
 * Every entry drives:
 *   - Autocomplete visibility (autocompleteVisible)
 *   - Spill/array guard (SPILL_DEFERRED_SET)
 *   - Product denylist (DENIED_SET)
 *   - Backend scalar routing (BACKEND_SCALAR_ROUTING_SET)
 *
 * Classification rules:
 *   scalar        — always returns a single value; allowed for evaluation
 *   spill-deferred — can return 2D array; blocked until spill engine is implemented
 *   denied        — product decision; hard error with migration message at runtime
 *
 * Phase 0: all functions carried at their current effective classification.
 * No scalar enablement happens here — that is Wave 1 (Phase 2).
 */

export type FormulaCategory =
  | 'math'
  | 'statistical'
  | 'logical'
  | 'text'
  | 'date'
  | 'reference'
  | 'information'
  | 'financial'
  | 'engineering'
  | 'lambda'

export type FormulaCatalogEntry = {
  name: string
  /**
   * scalar            — always returns a single value; allowed for evaluation
   * spill-deferred    — can return 2D array; blocked until spill engine is implemented
   * denied            — product decision; hard error with migration message at runtime
   * semantics-deferred — function exists in backend but has known semantic gaps
   *                      (e.g. ISFORMULA always returns FALSE in current Formualizer);
   *                      blocked with a "not yet available" message until the gap is closed
   */
  classification: 'scalar' | 'spill-deferred' | 'denied' | 'semantics-deferred'
  /** true → must be routed to Formualizer backend; false → fast-formula-parser handles it */
  backendRequired: boolean
  /** false for spill-deferred, denied, semantics-deferred, or scalar functions intentionally hidden (SWITCH) */
  autocompleteVisible: boolean
  /** hint shown in autocomplete dropdown */
  signature: string
  category: FormulaCategory
  /**
   * Which promotion wave added this entry to the scalar set.
   * Enables reverse-parity tests between catalog and waveNRegistry.ts.
   * null = predates the wave system (already scalar before Wave 1).
   */
  promotionWave: 'wave1' | 'wave2' | 'wave3' | null
}

// ---------------------------------------------------------------------------
// Helper to build an entry concisely
// ---------------------------------------------------------------------------
type E = FormulaCatalogEntry
const scalar = (
  name: string, category: FormulaCategory, signature: string,
  backendRequired = false, autocompleteVisible = true,
  promotionWave: E['promotionWave'] = null
): E => ({ name, classification: 'scalar', backendRequired, autocompleteVisible, signature, category, promotionWave })
const spill = (name: string, category: FormulaCategory, signature: string): E =>
  ({ name, classification: 'spill-deferred', backendRequired: false, autocompleteVisible: false, signature, category, promotionWave: null })
const denied = (name: string, category: FormulaCategory, signature: string): E =>
  ({ name, classification: 'denied', backendRequired: false, autocompleteVisible: false, signature, category, promotionWave: null })
const semanticsDeferred = (name: string, category: FormulaCategory, signature: string): E =>
  ({ name, classification: 'semantics-deferred', backendRequired: false, autocompleteVisible: false, signature, category, promotionWave: null })

// ---------------------------------------------------------------------------
// FORMULA_CATALOG
// ---------------------------------------------------------------------------
// Sections:
//   1. Denied functions (product decision — VLOOKUP, XLOOKUP)
//   2. Spill-deferred functions (can return arrays; blocked until spill engine)
//      2a. Currently in BACKEND_ARRAY_FUNCTIONS (existing guard)
//      2b. Guard-gap closures (were missing; now explicitly blocked)
//      2c. Wave 1 candidates — promoted to scalar (Phase 2, Wave 1)
//      2d. Wave 3 candidates (LET, LAMBDA — parser/routing research needed)
//   3. Scalar backend functions (backendRequired: true; routed to Formualizer)
//   3a. Wave 2 — distribution / descriptive / math (Phase 2, Wave 2)
//   4. Scalar sync-only (backendRequired: false)
//      4a. SWITCH — scalar but autocompleteVisible: false (explicit UX override)
// ---------------------------------------------------------------------------

export const FORMULA_CATALOG: readonly FormulaCatalogEntry[] = [
  // -------------------------------------------------------------------------
  // 1. Denied
  // -------------------------------------------------------------------------
  denied('VLOOKUP', 'reference', 'VLOOKUP(search_key, range, index, [is_sorted])'),
  denied('XLOOKUP', 'reference', 'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])'),

  // -------------------------------------------------------------------------
  // 2a. Spill-deferred — existing BACKEND_ARRAY_FUNCTIONS
  // -------------------------------------------------------------------------
  // CHOOSE: was in legacy BACKEND_ARRAY_FUNCTIONS before Phase 0 (not a regression).
  // Kept spill-deferred: with an array index argument it can return an array.
  // Decision record item 4: stays deferred until shape-safe scalar contract is proven.
  spill('CHOOSE',     'reference',   'CHOOSE(index_num, value1, [value2], ...)'),
  spill('CHOOSECOLS', 'reference',   'CHOOSECOLS(array, col_num1, [col_num2], ...)'),
  spill('CHOOSEROWS', 'reference',   'CHOOSEROWS(array, row_num1, [row_num2], ...)'),
  spill('DROP',       'reference',   'DROP(array, rows, [columns])'),
  spill('FILTER',     'reference',   'FILTER(array, include, [if_empty])'),
  spill('HSTACK',     'reference',   'HSTACK(array1, [array2], ...)'),
  // ISFORMULA: semantics-deferred — Formualizer currently always returns FALSE
  // (provenance not tracked). Blocked with "not yet available" until the gap is closed.
  // Not a spill function — classified separately so the error message is distinct.
  semanticsDeferred('ISFORMULA', 'information', 'ISFORMULA(reference)'),
  spill('LINEST',     'statistical', 'LINEST(known_ys, [known_xs], [const], [stats])'),
  spill('LOGEST',     'statistical', 'LOGEST(known_ys, [known_xs], [const], [stats])'),
  spill('MODE.MULT',  'statistical', 'MODE.MULT(number1, [number2], ...)'),
  spill('SEQUENCE',   'math',        'SEQUENCE(rows, [columns], [start], [step])'),
  spill('TAKE',       'reference',   'TAKE(array, rows, [columns])'),
  spill('TREND',      'statistical', 'TREND(known_ys, [known_xs], [new_xs], [const])'),
  spill('UNIQUE',     'reference',   'UNIQUE(array, [by_col], [exactly_once])'),
  spill('VSTACK',     'reference',   'VSTACK(array1, [array2], ...)'),

  // -------------------------------------------------------------------------
  // 2b. Spill-deferred — guard-gap closures
  //     These were missing from the legacy BACKEND_ARRAY_FUNCTIONS set;
  //     Phase 0 intentionally closes the gap so they return the spill policy
  //     error rather than falling through to the sync parser.
  // -------------------------------------------------------------------------
  spill('FREQUENCY',  'statistical', 'FREQUENCY(data_array, bins_array)'),
  spill('GROWTH',     'statistical', 'GROWTH(known_ys, [known_xs], [new_xs], [const])'),
  spill('RANDARRAY',  'math',        'RANDARRAY([rows], [columns], [min], [max], [whole_number])'),
  spill('SORT',       'reference',   'SORT(array, [sort_index], [sort_order], [by_col])'),
  spill('SORTBY',     'reference',   'SORTBY(array, by_array1, [sort_order1], ...)'),
  spill('TEXTSPLIT',  'text',        'TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with])'),
  spill('TRANSPOSE',  'reference',   'TRANSPOSE(array)'),

  // -------------------------------------------------------------------------
  // 2c. Wave 1 — promoted to scalar (Phase 2)
  //     All confirmed scalar-returning; routed to Formualizer backend.
  // -------------------------------------------------------------------------
  scalar('ARRAYTOTEXT',     'text',        'ARRAYTOTEXT(array, [format])',                                                                       true, true, 'wave1'),
  scalar('FORECAST.LINEAR', 'statistical', 'FORECAST.LINEAR(x, known_ys, known_xs)',                                                             true, true, 'wave1'),
  scalar('MAXIFS',          'statistical', 'MAXIFS(max_range, criteria_range1, criteria1, ...)',                                                  true, true, 'wave1'),
  scalar('MINIFS',          'statistical', 'MINIFS(min_range, criteria_range1, criteria1, ...)',                                                  true, true, 'wave1'),
  scalar('TEXTAFTER',       'text',        'TEXTAFTER(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])',               true, true, 'wave1'),
  scalar('TEXTBEFORE',      'text',        'TEXTBEFORE(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])',              true, true, 'wave1'),
  scalar('T.TEST',          'statistical', 'T.TEST(array1, array2, tails, type)',                                                                 true, true, 'wave1'),
  scalar('VALUETOTEXT',     'text',        'VALUETOTEXT(value, [format])',                                                                        true, true, 'wave1'),
  scalar('XMATCH',          'reference',   'XMATCH(lookup_value, lookup_array, [match_mode], [search_mode])',                                    true, true, 'wave1'),

  // -------------------------------------------------------------------------
  // 2d. Spill-deferred — MAP and higher-order combinators
  //     MAP/BYROW/BYCOL/MAKEARRAY all return arrays — keep deferred until
  //     the spill engine is in place. LAMBDA used with MAP is also blocked
  //     by the MAP guard.
  // -------------------------------------------------------------------------
  spill('MAP',       'lambda', 'MAP(array1, lambda_or_array, ...)'),
  spill('BYROW',     'lambda', 'BYROW(array, lambda)'),
  spill('BYCOL',     'lambda', 'BYCOL(array, lambda)'),
  spill('MAKEARRAY', 'lambda', 'MAKEARRAY(rows, columns, lambda)'),
  spill('SCAN',      'lambda', 'SCAN(initial_value, array, lambda)'),
  spill('REDUCE',    'lambda', 'REDUCE(initial_value, array, lambda)'),

  // -------------------------------------------------------------------------
  // 3. Scalar backend functions (routed to Formualizer for evaluation)
  //    Ordered by existing BACKEND_FUNCTION_POLICY to ease diff review.
  // -------------------------------------------------------------------------
  // Statistical aggregates
  scalar('MEDIAN',          'statistical', 'MEDIAN(number1, [number2], ...)',            true),
  scalar('LARGE',           'statistical', 'LARGE(array, k)',                            true),
  scalar('SMALL',           'statistical', 'SMALL(array, k)',                            true),
  scalar('STDEV.P',         'statistical', 'STDEV.P(number1, [number2], ...)',           true),
  scalar('STDEV.S',         'statistical', 'STDEV.S(number1, [number2], ...)',           true),
  scalar('VAR.P',           'statistical', 'VAR.P(number1, [number2], ...)',             true),
  scalar('VAR.S',           'statistical', 'VAR.S(number1, [number2], ...)',             true),
  scalar('MODE.SNGL',       'statistical', 'MODE.SNGL(number1, [number2], ...)',         true),
  scalar('RANK.AVG',        'statistical', 'RANK.AVG(number, ref, [order])',             true),
  scalar('RANK.EQ',         'statistical', 'RANK.EQ(number, ref, [order])',              true),
  scalar('PERCENTILE.EXC',  'statistical', 'PERCENTILE.EXC(array, k)',                  true),
  scalar('PERCENTILE.INC',  'statistical', 'PERCENTILE.INC(array, k)',                  true),
  scalar('QUARTILE.EXC',    'statistical', 'QUARTILE.EXC(array, quart)',                 true),
  scalar('QUARTILE.INC',    'statistical', 'QUARTILE.INC(array, quart)',                 true),
  scalar('COUNTA',          'statistical', 'COUNTA(value1, [value2], ...)',              true),
  scalar('COUNTBLANK',      'statistical', 'COUNTBLANK(range)',                          true),
  scalar('COUNTIFS',        'statistical', 'COUNTIFS(criteria_range1, criteria1, ...)',  true),
  scalar('SUMIFS',          'math',        'SUMIFS(sum_range, criteria_range1, criteria1, ...)', true),
  scalar('AVERAGEIFS',      'statistical', 'AVERAGEIFS(average_range, criteria_range1, criteria1, ...)', true),
  // Text (backend)
  scalar('LEN',             'text',        'LEN(text)',                                  true),
  scalar('UPPER',           'text',        'UPPER(text)',                                true),
  scalar('VALUE',           'text',        'VALUE(text)',                                true),
  scalar('SUBSTITUTE',      'text',        'SUBSTITUTE(text, old_text, new_text, [instance_num])', true),
  scalar('TEXTJOIN',        'text',        'TEXTJOIN(delimiter, ignore_empty, text1, [text2], ...)', true),
  // Reference (backend)
  scalar('MATCH',           'reference',   'MATCH(lookup_value, lookup_array, [match_type])', true),
  scalar('OFFSET',          'reference',   'OFFSET(reference, rows, cols, [height], [width])', true),
  // Financial (backend) — existing
  scalar('ACCRINT',         'financial',   'ACCRINT(issue, first_interest, settlement, rate, par, frequency, [basis], [calc_method])', true),
  scalar('ACCRINTM',        'financial',   'ACCRINTM(issue, settlement, rate, par, [basis])', true),
  scalar('CONVERT',         'engineering', 'CONVERT(number, from_unit, to_unit)',        true),
  scalar('CUMIPMT',         'financial',   'CUMIPMT(rate, nper, pv, start_period, end_period, type)', true),
  scalar('CUMPRINC',        'financial',   'CUMPRINC(rate, nper, pv, start_period, end_period, type)', true),
  scalar('DB',              'financial',   'DB(cost, salvage, life, period, [month])',   true),
  scalar('DDB',             'financial',   'DDB(cost, salvage, life, period, [factor])', true),
  scalar('DOLLARDE',        'financial',   'DOLLARDE(fractional_dollar, fraction)',      true),
  scalar('DOLLARFR',        'financial',   'DOLLARFR(decimal_dollar, fraction)',         true),
  scalar('EFFECT',          'financial',   'EFFECT(nominal_rate, npery)',                true),
  scalar('ERF.PRECISE',     'engineering', 'ERF.PRECISE(x)',                            true),
  scalar('FV',              'financial',   'FV(rate, nper, pmt, [pv], [type])',          true),
  scalar('IPMT',            'financial',   'IPMT(rate, per, nper, pv, [fv], [type])',    true),
  scalar('IRR',             'financial',   'IRR(values, [guess])',                       true),
  scalar('MIRR',            'financial',   'MIRR(values, finance_rate, reinvest_rate)',  true),
  scalar('NOMINAL',         'financial',   'NOMINAL(effect_rate, npery)',                true),
  scalar('NPER',            'financial',   'NPER(rate, pmt, pv, [fv], [type])',          true),
  scalar('NPV',             'financial',   'NPV(rate, value1, [value2], ...)',           true),
  scalar('PEARSON',         'statistical', 'PEARSON(array1, array2)',                    true),
  scalar('PERCENTRANK.EXC', 'statistical', 'PERCENTRANK.EXC(array, x, [significance])', true),
  scalar('PERCENTRANK.INC', 'statistical', 'PERCENTRANK.INC(array, x, [significance])', true),
  scalar('PERMUT',          'statistical', 'PERMUT(number, number_chosen)',              true),
  scalar('PMT',             'financial',   'PMT(rate, nper, pv, [fv], [type])',          true),
  scalar('PPMT',            'financial',   'PPMT(rate, per, nper, pv, [fv], [type])',    true),
  scalar('PRICE',           'financial',   'PRICE(settlement, maturity, rate, yld, redemption, frequency, [basis])', true),
  scalar('PV',              'financial',   'PV(rate, nper, pmt, [fv], [type])',          true),
  scalar('RATE',            'financial',   'RATE(nper, pmt, pv, [fv], [type], [guess])', true),
  scalar('RSQ',             'statistical', 'RSQ(known_ys, known_xs)',                    true),
  scalar('SKEW',            'statistical', 'SKEW(number1, [number2], ...)',              true),
  scalar('SLN',             'financial',   'SLN(cost, salvage, life)',                   true),
  scalar('SLOPE',           'statistical', 'SLOPE(known_ys, known_xs)',                  true),
  scalar('STEYX',           'statistical', 'STEYX(known_ys, known_xs)',                  true),
  scalar('SYD',             'financial',   'SYD(cost, salvage, life, per)',              true),
  scalar('TRIMMEAN',        'statistical', 'TRIMMEAN(array, percent)',                   true),
  scalar('XIRR',            'financial',   'XIRR(values, dates, [guess])',               true),
  scalar('XNPV',            'financial',   'XNPV(rate, values, dates)',                  true),
  scalar('YIELD',           'financial',   'YIELD(settlement, maturity, rate, pr, redemption, frequency, [basis])', true),
  scalar('Z.TEST',          'statistical', 'Z.TEST(array, x, [sigma])',                  true),

  // -------------------------------------------------------------------------
  // Wave 2 — distribution / descriptive / math (confirmed in formualizer-eval 0.4.3)
  //   All scalar-returning, backend-required. Promoted in Phase 2, Wave 2.
  // -------------------------------------------------------------------------
  scalar('AVEDEV',          'statistical', 'AVEDEV(number1, [number2], ...)',                                                  true,  true, 'wave2'),
  scalar('BETA.DIST',       'statistical', 'BETA.DIST(x, alpha, beta, cumulative, [A], [B])',                                  true,  true, 'wave2'),
  scalar('BINOM.DIST',      'statistical', 'BINOM.DIST(number_s, trials, probability_s, cumulative)',                          true,  true, 'wave2'),
  scalar('CHISQ.DIST',      'statistical', 'CHISQ.DIST(x, deg_freedom, cumulative)',                                          true,  true, 'wave2'),
  scalar('CHISQ.INV',       'statistical', 'CHISQ.INV(probability, deg_freedom)',                                              true,  true, 'wave2'),
  scalar('CONFIDENCE.NORM', 'statistical', 'CONFIDENCE.NORM(alpha, standard_dev, size)',                                       true,  true, 'wave2'),
  scalar('CONFIDENCE.T',    'statistical', 'CONFIDENCE.T(alpha, standard_dev, size)',                                          true,  true, 'wave2'),
  scalar('COVARIANCE.P',    'statistical', 'COVARIANCE.P(array1, array2)',                                                     true,  true, 'wave2'),
  scalar('COVARIANCE.S',    'statistical', 'COVARIANCE.S(array1, array2)',                                                     true,  true, 'wave2'),
  scalar('EXPON.DIST',      'statistical', 'EXPON.DIST(x, lambda, cumulative)',                                                true,  true, 'wave2'),
  scalar('F.DIST',          'statistical', 'F.DIST(x, deg_freedom1, deg_freedom2, cumulative)',                                true,  true, 'wave2'),
  scalar('F.INV',           'statistical', 'F.INV(probability, deg_freedom1, deg_freedom2)',                                   true,  true, 'wave2'),
  scalar('GAMMA.DIST',      'statistical', 'GAMMA.DIST(x, alpha, beta, cumulative)',                                           true,  true, 'wave2'),
  // GAMMALN: not registered in formualizer-eval 0.4.3 (only a comment mention in combinatorics.rs).
  // Fast-formula-parser handles it synchronously. backendRequired: false.
  scalar('GAMMALN',         'math',        'GAMMALN(x)',                                                                       false, true, 'wave2'),
  scalar('GEOMEAN',         'statistical', 'GEOMEAN(number1, [number2], ...)',                                                  true,  true, 'wave2'),
  scalar('HARMEAN',         'statistical', 'HARMEAN(number1, [number2], ...)',                                                  true,  true, 'wave2'),
  scalar('HYPGEOM.DIST',    'statistical', 'HYPGEOM.DIST(sample_s, number_sample, population_s, number_population, cumulative)', true, true, 'wave2'),
  scalar('NEGBINOM.DIST',   'statistical', 'NEGBINOM.DIST(number_f, number_s, probability_s, cumulative)',                     true,  true, 'wave2'),
  scalar('NORM.DIST',       'statistical', 'NORM.DIST(x, mean, standard_dev, cumulative)',                                     true,  true, 'wave2'),
  scalar('NORM.INV',        'statistical', 'NORM.INV(probability, mean, standard_dev)',                                        true,  true, 'wave2'),
  scalar('NORM.S.DIST',     'statistical', 'NORM.S.DIST(z, cumulative)',                                                       true,  true, 'wave2'),
  scalar('NORM.S.INV',      'statistical', 'NORM.S.INV(probability)',                                                          true,  true, 'wave2'),
  scalar('POISSON.DIST',    'statistical', 'POISSON.DIST(x, mean, cumulative)',                                                true,  true, 'wave2'),
  scalar('PRODUCT',         'math',        'PRODUCT(number1, [number2], ...)',                                                  true,  true, 'wave2'),
  scalar('STANDARDIZE',     'statistical', 'STANDARDIZE(x, mean, standard_dev)',                                               true,  true, 'wave2'),
  scalar('T.DIST',          'statistical', 'T.DIST(x, deg_freedom, cumulative)',                                               true,  true, 'wave2'),
  scalar('T.INV',           'statistical', 'T.INV(probability, deg_freedom)',                                                   true,  true, 'wave2'),
  scalar('WEIBULL.DIST',    'statistical', 'WEIBULL.DIST(x, alpha, beta, cumulative)',                                         true,  true, 'wave2'),

  // -------------------------------------------------------------------------
  // Wave 3 — LET + LAMBDA (Phase 4)
  //   Confirmed in formualizer-eval 0.4.3 (lambda.rs: LET at line 110, LAMBDA at 256).
  //   fast-formula-parser 1.0.19 has NO LET/LAMBDA — must route via backend.
  //   MAP and other higher-order combinators that return arrays remain spill-deferred.
  // -------------------------------------------------------------------------
  scalar('LAMBDA', 'lambda', 'LAMBDA([parameter1, ...], calculation)', true, true, 'wave3'),
  scalar('LET',    'lambda', 'LET(name1, name_value1, ..., calculation)', true, true, 'wave3'),

  // -------------------------------------------------------------------------
  // 4a. Scalar sync-only — SWITCH (hidden from autocomplete by UX decision)
  //     Supported by fast-formula-parser but omitted from autocomplete to avoid
  //     confusion; users are guided to IF/IFS instead.
  // -------------------------------------------------------------------------
  scalar('SWITCH', 'logical', 'SWITCH(expression, value1, result1, [value2, result2], ..., [default])',
    false, false),
]

// ---------------------------------------------------------------------------
// Derived sets — single derivation point, no manual list duplication
// ---------------------------------------------------------------------------

/** Functions blocked until the spill engine is implemented. Replaces BACKEND_ARRAY_FUNCTIONS. */
export const SPILL_DEFERRED_SET = new Set<string>(
  FORMULA_CATALOG.filter((f) => f.classification === 'spill-deferred').map((f) => f.name)
)

/** Functions hard-denied by product decision. Never evaluated. */
export const DENIED_SET = new Set<string>(
  FORMULA_CATALOG.filter((f) => f.classification === 'denied').map((f) => f.name)
)

/**
 * Functions with known semantic gaps in the current backend.
 * Blocked with a "not yet available" message — distinct from spill (array result risk)
 * and deny (product decision). Re-enabled once the gap is closed.
 */
export const SEMANTICS_DEFERRED_SET = new Set<string>(
  FORMULA_CATALOG.filter((f) => f.classification === 'semantics-deferred').map((f) => f.name)
)

/**
 * Functions that must be routed to the Formualizer backend for scalar results.
 * Guards against future catalog mistakes: derivation requires BOTH backendRequired
 * AND classification === 'scalar' so a mis-classified spill/denied entry cannot
 * silently enter the routing path.
 */
export const BACKEND_SCALAR_ROUTING_SET = new Set<string>(
  FORMULA_CATALOG
    .filter((f) => f.backendRequired && f.classification === 'scalar')
    .map((f) => f.name)
)

/**
 * Functions visible in autocomplete, derived from catalog.
 * Used in Wave 1+ to replace manual ALLOWED_FUNCTIONS category filtering.
 * In Phase 0 this is not wired into formulaService autocomplete —
 * ALLOWED_FUNCTIONS is kept as-is until Wave 1.
 */
export const AUTOCOMPLETE_FUNCTIONS = FORMULA_CATALOG.filter((f) => f.autocompleteVisible)

/**
 * Functions promoted in Wave 1 (as recorded by promotionWave field).
 * Used for reverse-parity tests between catalog and wave1Registry.ts.
 */
export const WAVE1_CATALOG_SET = new Set<string>(
  FORMULA_CATALOG.filter((f) => f.promotionWave === 'wave1').map((f) => f.name)
)

/**
 * Functions promoted in Wave 2 (as recorded by promotionWave field).
 * Used for reverse-parity tests between catalog and wave2Registry.ts.
 */
export const WAVE2_CATALOG_SET = new Set<string>(
  FORMULA_CATALOG.filter((f) => f.promotionWave === 'wave2').map((f) => f.name)
)

/**
 * Functions promoted in Wave 3 (as recorded by promotionWave field).
 * Used for reverse-parity tests between catalog and wave3Registry.ts.
 */
export const WAVE3_CATALOG_SET = new Set<string>(
  FORMULA_CATALOG.filter((f) => f.promotionWave === 'wave3').map((f) => f.name)
)
