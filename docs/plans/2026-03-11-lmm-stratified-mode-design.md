# Stratified LMM Mode Design

**Goal:** Add a generic stratified mixed-model mode that runs the existing single-fit `lmm_anova` engine once per user-selected subgroup combination and stacks the per-stratum outputs into one report/export.

## Scope

- Keep the current pooled `lmm_anova` mode as the default.
- Add a separate stratified mode driven by user-selected categorical factors.
- Do not hardcode `Strain`, `Sex`, `Treatment`, `Day`, `Value`, or `ID`.
- Reuse the existing single-fit `lmm_anova()` engine for each stratum.
- Use `lmm_anova_test.R` as the statistical oracle for the new stratified mode only.

## Input Model

The stratified mode should extend the current LMM configuration with:

- `stratified`: boolean
- `stratifyBy`: array of categorical predictor column ids

The within-stratum model continues to use the existing LMM configuration:

- dependent variable
- subject/group column
- model predictors
- predictor typing
- interaction depth
- df method
- random effects configuration
- simple effects settings
- post-hoc settings

The model formula is not hardcoded. It is still derived from the selected predictors and random-effects settings inside `lmm_anova()`.

## Backend Architecture

Add a new orchestration entry point alongside the current single-fit engine:

- `lmm_anova()` remains the single-fit worker
- `lmm_anova_stratified()` handles:
  - validating `stratify_by`
  - splitting rows by subgroup combination
  - invoking `lmm_anova()` for each subgroup
  - attaching subgroup labels to each subgroup result
  - returning a stacked, combined result payload

The per-stratum results should preserve the current LMM payload shape as much as possible while adding subgroup context.

## Result Shape

Top-level stratified result:

- `success`
- `test_type = "lmm_anova_stratified"`
- `stratified = true`
- `stratify_by`
- `strata_results[]`
- `warnings[]`
- stacked export/report rows derived from all subgroup results

Each item in `strata_results[]` should include:

- `stratum`
  - object keyed by selected stratification factor name
- `stratum_label`
- the usual per-fit LMM fields from `lmm_anova()`

Flattened report/export rows should include subgroup columns before inferential columns:

- `Section`
- one column per selected stratification factor
- `Effect`
- `Within Factor`
- `Within Level`
- `Comparison`
- inferential fields

## Safety Policy

Stratified mode increases the probability of small or singular fits. Before shipping, it must:

- warn clearly on singular and near-zero random-effects fits
- preserve finite-df fallback behavior
- allow per-stratum success/fallback rather than failing the whole batch on one bad stratum
- enforce minimum subgroup size / subject count rules before fitting

## Validation Strategy

- Current pooled mode keeps using the current pooled validation harness.
- New stratified mode should validate against the logic in `lmm_anova_test.R`.
- Validation should focus on:
  - subgroup split logic
  - subgroup labeling
  - omnibus/simple-effect row structure
  - warning/fallback behavior on unstable strata

## UI/Product Direction

- Add a simple mode toggle:
  - pooled model
  - stratified subgroup models
- In stratified mode, users pick subgroup factors generically from categorical predictors.
- Export/report should stack subgroup results on one sheet instead of creating one sheet per subgroup.
