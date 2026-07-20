/**
 * LMM Plot Normalizer — Contract Tests (TDD Red Phase)
 *
 * These tests define the required behavior of the LMM plot normalization
 * layer before any production code is written. All tests must fail first.
 */

import { describe, expect, it } from 'vitest'
import { normalizeTestId } from '@/services/plotResult/common/normalize'
import { normalizeLmmForPlots } from '@/services/plotResult/lmm/normalize'

// ---------------------------------------------------------------------------
// Section 1: Test ID aliasing
// ---------------------------------------------------------------------------

describe('normalizeTestId — LMM aliases', () => {
  it('maps lmm_anova_stratified to lmm_anova', () => {
    expect(normalizeTestId('lmm_anova_stratified')).toBe('lmm_anova')
  })

  it('passes lmm_anova through unchanged', () => {
    expect(normalizeTestId('lmm_anova')).toBe('lmm_anova')
  })
})

// ---------------------------------------------------------------------------
// Section 2: Pooled (non-stratified) LMM result
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — pooled result', () => {
  const pooledResult = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [
      { source: 'treatment', f_value: 12.3, p_value: 0.001, num_df: 1, den_df: 18.7, significant: true },
    ],
    estimated_means: [
      { factors: { treatment: 'VEH' }, emmean: 5.2, se: 0.3, ci_lower: 4.6, ci_upper: 5.8, n: 10 },
      { factors: { treatment: 'THC' }, emmean: 7.1, se: 0.28, ci_lower: 6.5, ci_upper: 7.7, n: 10 },
    ],
    pairwise_comparisons: [
      { group1: 'VEH', group2: 'THC', estimate: -1.9, se: 0.4, p_adjusted: 0.002, significant: true, factor: 'treatment' },
    ],
    continuous_effects: null,
  }

  it('produces summary rows from estimated_means', () => {
    const { summaryRows } = normalizeLmmForPlots(pooledResult, {})
    expect(summaryRows.length).toBe(2)
  })

  it('produces no facet dimensions for non-stratified result', () => {
    const { facetDims } = normalizeLmmForPlots(pooledResult, {})
    expect(facetDims).toEqual([])
  })

  it('produces no line rows when continuous_effects is absent', () => {
    const { contrastRows } = normalizeLmmForPlots(pooledResult, {})
    expect(contrastRows.length).toBe(0)
  })

  it('does not require a trait key anywhere in the result', () => {
    expect(() => normalizeLmmForPlots(pooledResult, {})).not.toThrow()
    const { summaryRows } = normalizeLmmForPlots(pooledResult, {})
    summaryRows.forEach(row => {
      expect(Object.keys(row.facetValues)).not.toContain('trait')
    })
  })

  it('uses outcomeLabel from metadata when provided', () => {
    const meta = { dependentName: 'Temperature (°C)' }
    const { outcomeLabel } = normalizeLmmForPlots(pooledResult, meta)
    expect(outcomeLabel).toBe('Temperature (°C)')
  })

  it('falls back to "Value" when no metadata provided', () => {
    const { outcomeLabel } = normalizeLmmForPlots(pooledResult, {})
    expect(outcomeLabel).toBe('Value')
  })
})

// ---------------------------------------------------------------------------
// Section 3: Stratified LMM result — dynamic facets
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — stratified result', () => {
  const makeStratum = (strain: string, sex: string, success = true) => ({
    stratum: { strain, sex },
    success,
    fixed_effects: [
      { source: 'treatment', f_value: 8.1, p_value: 0.01, num_df: 1, den_df: 15.2, significant: true },
    ],
    estimated_means: [
      { factors: { treatment: 'VEH' }, emmean: 4.5, se: 0.2, ci_lower: 4.1, ci_upper: 4.9, n: 8 },
      { factors: { treatment: 'THC' }, emmean: 6.3, se: 0.25, ci_lower: 5.8, ci_upper: 6.8, n: 8 },
    ],
    pairwise_comparisons: [],
    continuous_effects: null,
  })

  const stratifiedResult = {
    success: true,
    test_type: 'lmm_anova_stratified',
    stratified: true,
    stratify_by: ['strain', 'sex'],
    strata_results: [
      makeStratum('B6', 'F'),
      makeStratum('B6', 'M'),
      makeStratum('D2', 'F'),
      makeStratum('D2', 'M', false), // failed stratum
    ],
  }

  it('derives facet dimensions from stratify_by', () => {
    const { facetDims } = normalizeLmmForPlots(stratifiedResult, {})
    expect(facetDims).toEqual(['strain', 'sex'])
  })

  it('excludes failed strata from summary rows', () => {
    const { summaryRows } = normalizeLmmForPlots(stratifiedResult, {})
    const d2mRows = summaryRows.filter(
      r => r.facetValues['strain'] === 'D2' && r.facetValues['sex'] === 'M'
    )
    expect(d2mRows.length).toBe(0)
  })

  it('includes rows from all successful strata', () => {
    const { summaryRows } = normalizeLmmForPlots(stratifiedResult, {})
    // 3 successful strata × 2 estimated_means each = 6
    expect(summaryRows.length).toBe(6)
  })

  it('carries stratum keys as facetValues on each row', () => {
    const { summaryRows } = normalizeLmmForPlots(stratifiedResult, {})
    const b6fRow = summaryRows.find(
      r => r.facetValues['strain'] === 'B6' && r.facetValues['sex'] === 'F'
    )
    expect(b6fRow).toBeDefined()
    expect(b6fRow?.facetValues['strain']).toBe('B6')
    expect(b6fRow?.facetValues['sex']).toBe('F')
  })

  it('works with arbitrary facet names (not hardcoded strain/sex)', () => {
    const arbitraryResult = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['cohort', 'site'],
      strata_results: [
        {
          stratum: { cohort: 'C1', site: 'London' },
          success: true,
          estimated_means: [
            { factors: { treatment: 'VEH' }, emmean: 3.0, se: 0.1, ci_lower: 2.8, ci_upper: 3.2, n: 5 },
          ],
          fixed_effects: [],
          pairwise_comparisons: [],
          continuous_effects: null,
        },
      ],
    }
    const { facetDims, summaryRows } = normalizeLmmForPlots(arbitraryResult, {})
    expect(facetDims).toEqual(['cohort', 'site'])
    expect(summaryRows[0]!.facetValues['cohort']).toBe('C1')
    expect(summaryRows[0]!.facetValues['site']).toBe('London')
  })
})

// ---------------------------------------------------------------------------
// Section 4: Line rows from continuous_effects
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — line rows from continuous_effects', () => {
  const resultWithContinuousEffects = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [
      { source: 'treatment', f_value: 5.1, p_value: 0.03, num_df: 1, den_df: 20, significant: true },
      { source: 'treatment:day_num', f_value: 4.2, p_value: 0.04, num_df: 1, den_df: 95, significant: true },
    ],
    estimated_means: [],
    pairwise_comparisons: [],
    continuous_effects: [
      { effect: 'treatment', time_factor: 'day_num', time_value: '0', label: 'THC vs VEH|treatment|day_num=0', estimate: 0.1, se: 0.05, p_raw: 0.08, p: 0.09 },
      { effect: 'treatment', time_factor: 'day_num', time_value: '7', label: 'THC vs VEH|treatment|day_num=7', estimate: 1.8, se: 0.12, p_raw: 0.001, p: 0.002 },
      { effect: 'treatment', time_factor: 'day_num', time_value: '14', label: 'THC vs VEH|treatment|day_num=14', estimate: 2.3, se: 0.15, p_raw: 0.0002, p: 0.0004 },
    ],
  }

  it('produces one line row per continuous_effects entry', () => {
    const { contrastRows } = normalizeLmmForPlots(resultWithContinuousEffects, {})
    expect(contrastRows.length).toBe(3)
  })

  it('each line row has timeValue, estimate, se, and pValue', () => {
    const { contrastRows } = normalizeLmmForPlots(resultWithContinuousEffects, {})
    const day7 = contrastRows.find(r => r.timeValue === 7)
    expect(day7).toBeDefined()
    expect(day7?.estimate).toBeCloseTo(1.8)
    expect(day7?.se).toBeCloseTo(0.12)
    expect(day7?.pValue).toBeCloseTo(0.002)
  })

  it('detects interaction term via backend " x " label in fixed_effects source', () => {
    // Backend writes source via _internal_term_label() which replaces ":" with " x "
    // Real runtime labels: "treatment x day_num", never "treatment:day_num"
    const withXLabel = {
      ...resultWithContinuousEffects,
      fixed_effects: [
        { source: 'treatment', f_value: 5.1, p_value: 0.03, num_df: 1, den_df: 20, significant: true },
        { source: 'treatment x day_num', f_value: 4.2, p_value: 0.04, num_df: 1, den_df: 95, significant: true },
      ],
    }
    const { interactionSignificant } = normalizeLmmForPlots(withXLabel, {})
    expect(interactionSignificant).toBe(true)
  })

  it('also detects interaction via colon as defensive fallback', () => {
    // Asymptotic path or future backend changes may still emit ":"
    const { interactionSignificant } = normalizeLmmForPlots(resultWithContinuousEffects, {})
    expect(interactionSignificant).toBe(true)
  })

  it('interactionSignificant is false when no interaction term exists', () => {
    const noInteraction = { ...resultWithContinuousEffects, fixed_effects: [
      { source: 'treatment', f_value: 5.1, p_value: 0.03, num_df: 1, den_df: 20, significant: true },
    ]}
    const { interactionSignificant } = normalizeLmmForPlots(noInteraction, {})
    expect(interactionSignificant).toBe(false)
  })

  it('interactionSignificant is false when " x " term is not significant', () => {
    const nsInteraction = { ...resultWithContinuousEffects, fixed_effects: [
      { source: 'treatment x day_num', f_value: 1.2, p_value: 0.28, num_df: 1, den_df: 95, significant: false },
    ]}
    const { interactionSignificant } = normalizeLmmForPlots(nsInteraction, {})
    expect(interactionSignificant).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Section 4b: Trajectory rows from backend per_group_means_over_time
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — trajectory rows strict-source', () => {
  it('extracts trajectoryRows only from per_group_means_over_time', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [
        { factors: { treatment: 'VEH' }, emmean: 10.2, se: 0.3, ci_lower: 9.6, ci_upper: 10.8, n: 8 },
      ],
      per_group_means_over_time: [
        {
          group_factor: 'Treatment',
          group_value: 'VEH',
          time_factor: 'Day_num',
          time_value: '0',
          mean: 10.2,
          se: 0.3,
          ci_lower: 9.6,
          ci_upper: 10.8,
          n: 8,
        },
      ],
    }

    const { trajectoryRows } = normalizeLmmForPlots(result, {})
    expect(trajectoryRows).toHaveLength(1)
    expect(trajectoryRows[0]!.groupFactor).toBe('Treatment')
    expect(trajectoryRows[0]!.groupValue).toBe('VEH')
    expect(trajectoryRows[0]!.timeFactor).toBe('Day_num')
    expect(trajectoryRows[0]!.timeValue).toBe(0)
  })

  it('falls back to estimated_means heuristic when PGMOT absent and 2-factor shape resolves (new hybrid policy)', () => {
    // Treatment=categorical-like, Day_num=numeric-like → heuristic resolves Day_num as x-axis
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [
        { factors: { Treatment: 'VEH', Day_num: '0' }, emmean: 10.2, se: 0.3, ci_lower: 9.6, ci_upper: 10.8, n: 8 },
        { factors: { Treatment: 'THC', Day_num: '0' }, emmean: 12.1, se: 0.4, ci_lower: 11.3, ci_upper: 12.9, n: 8 },
      ],
    }

    const { trajectoryRows } = normalizeLmmForPlots(result, {})
    // Heuristic resolves: 2 rows expected, source=estimated_means
    expect(trajectoryRows).toHaveLength(2)
    expect(trajectoryRows.every(r => r.source === 'estimated_means')).toBe(true)
    expect(trajectoryRows[0]!.groupFactor).toBe('Treatment')
  })

  it('sets trajectory pValue to null when no matching simple-effect exists', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [{ source: 'treatment x Day_num', significant: true }],
      estimated_means: [],
      per_group_means_over_time: [
        {
          group_factor: 'Treatment',
          group_value: 'VEH',
          time_factor: 'Day_num',
          time_value: 0,
          mean: 10.2,
          se: 0.3,
          ci_lower: 9.6,
          ci_upper: 10.8,
          n: 8,
        },
      ],
      // no continuous_effects for this timepoint/group
      continuous_effects: [],
    }
    const { trajectoryRows } = normalizeLmmForPlots(result, {})
    expect(trajectoryRows).toHaveLength(1)
    expect(trajectoryRows[0]!.pValue).toBeNull()
  })

  it('suppresses trajectory pValue mapping when more than two groups are present', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [{ source: 'treatment x Day_num', significant: true }],
      estimated_means: [],
      per_group_means_over_time: [
        { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Day_num', time_value: 0, mean: 10.2, se: 0.3, ci_lower: 9.6, ci_upper: 10.8, n: 8 },
        { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Day_num', time_value: 0, mean: 12.1, se: 0.2, ci_lower: 11.7, ci_upper: 12.5, n: 8 },
        { group_factor: 'Treatment', group_value: 'CBD', time_factor: 'Day_num', time_value: 0, mean: 11.4, se: 0.2, ci_lower: 11.0, ci_upper: 11.8, n: 8 },
      ],
      continuous_effects: [
        { label: 'VEH vs THC|treatment|Day_num=0', time_value: 0, p: 0.03 },
      ],
    }
    const { trajectoryRows } = normalizeLmmForPlots(result, {})
    expect(trajectoryRows).toHaveLength(3)
    expect(trajectoryRows.every(r => r.pValue === null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Section 5: Stratum-key fallback when stratify_by is missing/partial
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — stratum key fallback', () => {
  it('derives facet dims from stratum keys when stratify_by is absent', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      // stratify_by intentionally omitted
      strata_results: [
        {
          stratum: { strain: 'B6', sex: 'F' },
          success: true,
          estimated_means: [
            { factors: { treatment: 'VEH' }, emmean: 4.0, se: 0.2, ci_lower: 3.6, ci_upper: 4.4, n: 5 },
          ],
          fixed_effects: [],
          pairwise_comparisons: [],
          continuous_effects: null,
        },
      ],
    }
    const { facetDims, summaryRows } = normalizeLmmForPlots(result, {})
    expect(facetDims).toContain('strain')
    expect(facetDims).toContain('sex')
    expect(summaryRows[0]!.facetValues['strain']).toBe('B6')
    expect(summaryRows[0]!.facetValues['sex']).toBe('F')
  })

  it('does not include keys from failed strata in facet dims', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['strain'],
      strata_results: [
        {
          stratum: { strain: 'B6', phantom_key: 'dirty' }, // failed — phantom_key must not appear
          success: false,
          estimated_means: [],
          fixed_effects: [],
          pairwise_comparisons: [],
          continuous_effects: null,
        },
        {
          stratum: { strain: 'D2' },
          success: true,
          estimated_means: [
            { factors: { treatment: 'VEH' }, emmean: 4.0, se: 0.2, ci_lower: 3.6, ci_upper: 4.4, n: 5 },
          ],
          fixed_effects: [],
          pairwise_comparisons: [],
          continuous_effects: null,
        },
      ],
    }
    const { facetDims } = normalizeLmmForPlots(result, {})
    expect(facetDims).not.toContain('phantom_key')
    expect(facetDims).toContain('strain')
  })

  it('merges stratify_by dims with any extra stratum keys', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['strain'],
      strata_results: [
        {
          stratum: { strain: 'B6', sex: 'F' }, // sex not in stratify_by
          success: true,
          estimated_means: [
            { factors: { treatment: 'VEH' }, emmean: 4.0, se: 0.2, ci_lower: 3.6, ci_upper: 4.4, n: 5 },
          ],
          fixed_effects: [],
          pairwise_comparisons: [],
          continuous_effects: null,
        },
      ],
    }
    const { facetDims } = normalizeLmmForPlots(result, {})
    expect(facetDims).toContain('strain')
    expect(facetDims).toContain('sex')
  })
})

// ---------------------------------------------------------------------------
// Section 6: Invalid numeric values — drop row, not coerce to 0
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — invalid numeric handling', () => {
  it('drops line rows where timeValue is not a valid number', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: [
        { effect: 'treatment', time_factor: 'day_num', time_value: null, label: 'bad', estimate: 1.0, se: 0.1, p_raw: 0.05, p: 0.05 },
        { effect: 'treatment', time_factor: 'day_num', time_value: '7', label: 'good', estimate: 1.8, se: 0.12, p_raw: 0.001, p: 0.002 },
      ],
    }
    const { contrastRows } = normalizeLmmForPlots(result, {})
    expect(contrastRows.length).toBe(1)
    expect(contrastRows[0]!.timeValue).toBe(7)
  })

  it('drops line rows where estimate is not a valid number', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: [
        { effect: 'treatment', time_factor: 'day_num', time_value: '7', label: 'bad', estimate: null, se: 0.1, p_raw: 0.05, p: 0.05 },
        { effect: 'treatment', time_factor: 'day_num', time_value: '14', label: 'good', estimate: 2.3, se: 0.15, p_raw: 0.001, p: 0.001 },
      ],
    }
    const { contrastRows } = normalizeLmmForPlots(result, {})
    expect(contrastRows.length).toBe(1)
    expect(contrastRows[0]!.timeValue).toBe(14)
  })

  it('treats empty string as invalid — does not coerce to 0', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [
        { factors: { treatment: 'VEH' }, emmean: '', se: 0.2, ci_lower: 3.6, ci_upper: 4.4, n: 5 },
        { factors: { treatment: 'THC' }, emmean: 7.1, se: 0.3, ci_lower: 6.5, ci_upper: 7.7, n: 5 },
      ],
      pairwise_comparisons: [],
      continuous_effects: null,
    }
    const { summaryRows } = normalizeLmmForPlots(result, {})
    expect(summaryRows.length).toBe(1)
    expect(summaryRows[0]!.y).toBeCloseTo(7.1)
  })

  it('drops line rows where timeValue is empty string — does not coerce to 0', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: [
        { effect: 'treatment', time_factor: 'day_num', time_value: '', label: 'bad', estimate: 1.0, se: 0.1, p_raw: 0.05, p: 0.05 },
        { effect: 'treatment', time_factor: 'day_num', time_value: '7', label: 'good', estimate: 1.8, se: 0.12, p_raw: 0.001, p: 0.002 },
      ],
    }
    const { contrastRows } = normalizeLmmForPlots(result, {})
    expect(contrastRows.length).toBe(1)
    expect(contrastRows[0]!.timeValue).toBe(7)
  })

  it('drops summary rows where y (emmean) is not a valid number', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [
        { factors: { treatment: 'VEH' }, emmean: null, se: 0.2, ci_lower: null, ci_upper: null, n: 5 },
        { factors: { treatment: 'THC' }, emmean: 7.1, se: 0.3, ci_lower: 6.5, ci_upper: 7.7, n: 5 },
      ],
      pairwise_comparisons: [],
      continuous_effects: null,
    }
    const { summaryRows } = normalizeLmmForPlots(result, {})
    expect(summaryRows.length).toBe(1)
    expect(summaryRows[0]!.y).toBeCloseTo(7.1)
  })
})

// ---------------------------------------------------------------------------
// Section 7: Graceful degradation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Section 7: Pairwise rows extraction
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — pairwise rows (section 7)', () => {
  const pooledWithPairwise = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [
      { source: 'treatment', f_value: 12.3, p_value: 0.001, num_df: 1, den_df: 18.7, significant: true },
    ],
    estimated_means: [
      { factors: { treatment: 'VEH' }, emmean: 5.2, se: 0.3, ci_lower: 4.6, ci_upper: 5.8, n: 10 },
      { factors: { treatment: 'THC' }, emmean: 7.1, se: 0.28, ci_lower: 6.5, ci_upper: 7.7, n: 10 },
    ],
    pairwise_comparisons: [
      { group1: 'VEH', group2: 'THC', estimate: -1.9, se: 0.4, p_adjusted: 0.002, significant: true, factor: 'treatment' },
    ],
    continuous_effects: null,
  }

  it('normalized result includes pairwiseRows field', () => {
    const result = normalizeLmmForPlots(pooledWithPairwise, {})
    expect(result).toHaveProperty('pairwiseRows')
  })

  it('extracts one pairwise row from pooled pairwise_comparisons', () => {
    const { pairwiseRows } = normalizeLmmForPlots(pooledWithPairwise, {})
    expect(pairwiseRows).toHaveLength(1)
  })

  it('pairwise row has correct group1, group2, significant', () => {
    const { pairwiseRows } = normalizeLmmForPlots(pooledWithPairwise, {})
    const row = pairwiseRows[0]!
    expect(row.group1).toBe('VEH')
    expect(row.group2).toBe('THC')
    expect(row.significant).toBe(true)
  })

  it('pairwise row pAdjusted is a finite number (not a formatted string)', () => {
    const { pairwiseRows } = normalizeLmmForPlots(pooledWithPairwise, {})
    const row = pairwiseRows[0]!
    expect(typeof row.pAdjusted).toBe('number')
    expect(isFinite(row.pAdjusted)).toBe(true)
    expect(row.pAdjusted).toBeCloseTo(0.002)
  })

  it('stratified result extracts pairwise rows from each successful stratum', () => {
    const stratifiedWithPairwise = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['sex'],
      strata_results: [
        {
          success: true,
          stratum: { sex: 'M' },
          fixed_effects: [],
          estimated_means: [
            { factors: { treatment: 'VEH' }, emmean: 26.0, se: 0.6, ci_lower: 24.8, ci_upper: 27.2, n: 5 },
          ],
          pairwise_comparisons: [
            { group1: 'VEH', group2: 'THC', estimate: -3.0, se: 0.5, p_adjusted: 0.009, significant: true, factor: 'treatment' },
          ],
          continuous_effects: null,
        },
        {
          success: false, // failed — its pairwise_comparisons must NOT be included
          stratum: { sex: 'F' },
          fixed_effects: [],
          estimated_means: [],
          pairwise_comparisons: [
            { group1: 'VEH', group2: 'THC', estimate: -99, se: 0.5, p_adjusted: 0.001, significant: true, factor: 'treatment' },
          ],
          continuous_effects: null,
        },
      ],
    }
    const { pairwiseRows } = normalizeLmmForPlots(stratifiedWithPairwise, {})
    // Only the successful stratum contributes; failed stratum is skipped
    expect(pairwiseRows).toHaveLength(1)
    expect(pairwiseRows[0]!.group1).toBe('VEH')
  })

  it('returns empty pairwiseRows when pairwise_comparisons is absent', () => {
    const result = {
      ...pooledWithPairwise,
      pairwise_comparisons: undefined,
    }
    const { pairwiseRows } = normalizeLmmForPlots(result as any, {})
    expect(pairwiseRows).toHaveLength(0)
  })
})

describe('normalizeLmmForPlots — graceful degradation (section 8)', () => {
  it('returns empty contrastRows and a note when continuous_effects absent', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [
        { factors: { treatment: 'VEH' }, emmean: 3.0, se: 0.1, ci_lower: 2.8, ci_upper: 3.2, n: 5 },
      ],
      pairwise_comparisons: [],
      continuous_effects: null,
    }
    const { contrastRows, notes } = normalizeLmmForPlots(result, {})
    expect(contrastRows.length).toBe(0)
    expect(notes.some(n => n.includes('continuous_effects'))).toBe(true)
  })

  it('falls back to cell_summaries when estimated_means is empty', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [],
      cell_summaries: [
        { factors: { treatment: 'VEH' }, mean: 3.0, se: 0.1, ci_lower: 2.8, ci_upper: 3.2, n: 5 },
      ],
      pairwise_comparisons: [],
      continuous_effects: null,
    }
    const { summaryRows } = normalizeLmmForPlots(result, {})
    expect(summaryRows.length).toBe(1)
  })

  it('does not throw when both estimated_means and cell_summaries are empty', () => {
    const result = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [],
      pairwise_comparisons: [],
      continuous_effects: null,
    }
    expect(() => normalizeLmmForPlots(result, {})).not.toThrow()
    const { summaryRows } = normalizeLmmForPlots(result, {})
    expect(summaryRows.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Task 3: Pairwise factor_scope p-value injection
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — simple-effect pValue injection (Task 3)', () => {
  const FIXTURE = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [{ source: 'Treatment x Condition', significant: true }],
    estimated_means: [
      { factors: { Treatment: 'VEH', Condition: 'A' }, emmean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
      { factors: { Treatment: 'VEH', Condition: 'B' }, emmean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
      { factors: { Treatment: 'THC', Condition: 'A' }, emmean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
      { factors: { Treatment: 'THC', Condition: 'B' }, emmean: 14.0, se: 0.3, ci_lower: 13.4, ci_upper: 14.6, n: 8 },
    ],
    simple_effects: [{ factor: 'Treatment', within: 'Condition' }],
    pairwise_comparisons: [
      { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true, factor_scope: 'Treatment|Condition=A' },
      { group1: 'VEH', group2: 'THC', p_adjusted: 0.20, significant: false, factor_scope: 'Treatment|Condition=B' },
    ],
    continuous_effects: null,
  }

  it('injects pValue onto trajectory rows with matching within_level', () => {
    const { trajectoryRows } = normalizeLmmForPlots(FIXTURE as any, {})
    const withP = trajectoryRows.filter(r => r.pValue !== null)
    expect(withP.length).toBeGreaterThan(0)
  })

  it('assigns p=0.04 to rows at Condition=A, p=0.20 at Condition=B', () => {
    const { trajectoryRows } = normalizeLmmForPlots(FIXTURE as any, {})
    const condARows = trajectoryRows.filter(r => r.timeValueRaw === 'A')
    const condBRows = trajectoryRows.filter(r => r.timeValueRaw === 'B')
    for (const r of condARows) expect(r.pValue).toBeCloseTo(0.04)
    for (const r of condBRows) expect(r.pValue).toBeCloseTo(0.20)
  })

  it('keeps pValue=null when no matching pairwise row for that within_level', () => {
    const PARTIAL = {
      ...FIXTURE,
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true, factor_scope: 'Treatment|Condition=A' },
      ],
    }
    const { trajectoryRows } = normalizeLmmForPlots(PARTIAL as any, {})
    const condBRows = trajectoryRows.filter(r => r.timeValueRaw === 'B')
    for (const r of condBRows) expect(r.pValue).toBeNull()
  })

  it('ignores pairwise rows without factor_scope (marginal rows)', () => {
    const WITH_MARGINAL = {
      ...FIXTURE,
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true, factor_scope: 'Treatment|Condition=A' },
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.001, significant: true, factor: 'Treatment' },
      ],
    }
    const { trajectoryRows } = normalizeLmmForPlots(WITH_MARGINAL as any, {})
    const condBRows = trajectoryRows.filter(r => r.timeValueRaw === 'B')
    // marginal row (no factor_scope) must not be matched → condB rows stay null
    for (const r of condBRows) expect(r.pValue).toBeNull()
  })

  it('matching is case-insensitive on withinFactor name', () => {
    const LOWER_SCOPE = {
      ...FIXTURE,
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.03, significant: true, factor_scope: 'Treatment|condition=A' },
      ],
    }
    const { trajectoryRows } = normalizeLmmForPlots(LOWER_SCOPE as any, {})
    const condARows = trajectoryRows.filter(r => r.timeValueRaw === 'A')
    for (const r of condARows) expect(r.pValue).toBeCloseTo(0.03)
  })

  it('suppresses pValue injection when scope has more than 2 active group levels', () => {
    const THREE_GROUP = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [
        { factors: { Treatment: 'VEH', Condition: 'A' }, emmean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
        { factors: { Treatment: 'THC', Condition: 'A' }, emmean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
        { factors: { Treatment: 'CBD', Condition: 'A' }, emmean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
      ],
      simple_effects: [{ factor: 'Treatment', within: 'Condition' }],
      pairwise_comparisons: [
        { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true, factor_scope: 'Treatment|Condition=A' },
        { group1: 'VEH', group2: 'CBD', p_adjusted: 0.02, significant: true, factor_scope: 'Treatment|Condition=A' },
      ],
      continuous_effects: null,
    }
    const { trajectoryRows } = normalizeLmmForPlots(THREE_GROUP as any, {})
    // 3 groups → ambiguous which pair to show → suppress all pValues
    for (const r of trajectoryRows) expect(r.pValue).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Task 2: Hybrid trajectory extraction
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — hybrid trajectory: PGMOT first (Task 2)', () => {
  const WITH_PGMOT = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [],
    estimated_means: [
      { factors: { Treatment: 'VEH', Day: '0' }, emmean: 99.0, se: 0.3, ci_lower: 98.4, ci_upper: 99.6, n: 8 },
    ],
    per_group_means_over_time: [
      { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Day', time_value: 0, mean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
      { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Day', time_value: 7, mean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
      { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Day', time_value: 0, mean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
      { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Day', time_value: 7, mean: 14.0, se: 0.3, ci_lower: 13.4, ci_upper: 14.6, n: 8 },
    ],
    pairwise_comparisons: [],
    continuous_effects: null,
  }

  it('uses PGMOT when present — ignores estimated_means for trajectory', () => {
    const { trajectoryRows } = normalizeLmmForPlots(WITH_PGMOT as any, {})
    // PGMOT means are 10-14 range; estimated_means mean is 99
    expect(trajectoryRows.every(r => r.mean !== 99.0)).toBe(true)
    expect(trajectoryRows.length).toBe(4)
  })

  it('PGMOT rows have source=pgmot', () => {
    const { trajectoryRows } = normalizeLmmForPlots(WITH_PGMOT as any, {})
    expect(trajectoryRows.every(r => r.source === 'pgmot')).toBe(true)
  })
})

describe('normalizeLmmForPlots — hybrid trajectory: estimated_means fallback (Task 2)', () => {
  const NO_PGMOT_WITH_SIMPLE_EFFECTS = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [{ source: 'Treatment x Condition', significant: true }],
    estimated_means: [
      { factors: { Treatment: 'VEH', Condition: 'A' }, emmean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
      { factors: { Treatment: 'VEH', Condition: 'B' }, emmean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
      { factors: { Treatment: 'THC', Condition: 'A' }, emmean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
      { factors: { Treatment: 'THC', Condition: 'B' }, emmean: 14.0, se: 0.3, ci_lower: 13.4, ci_upper: 14.6, n: 8 },
    ],
    simple_effects: [{ factor: 'Treatment', within: 'Condition' }],
    pairwise_comparisons: [],
    continuous_effects: null,
  }

  it('falls back to estimated_means when PGMOT absent and simple_effects declares roles', () => {
    const { trajectoryRows } = normalizeLmmForPlots(NO_PGMOT_WITH_SIMPLE_EFFECTS as any, {})
    expect(trajectoryRows.length).toBe(4)
    expect(trajectoryRows.every(r => r.source === 'estimated_means')).toBe(true)
  })

  it('groupFactor and groupValue come from simple_effects[].factor', () => {
    const { trajectoryRows } = normalizeLmmForPlots(NO_PGMOT_WITH_SIMPLE_EFFECTS as any, {})
    expect(trajectoryRows[0]!.groupFactor).toBe('Treatment')
    expect(['VEH', 'THC']).toContain(trajectoryRows[0]!.groupValue)
  })

  it('timeFactor comes from simple_effects[].within', () => {
    const { trajectoryRows } = normalizeLmmForPlots(NO_PGMOT_WITH_SIMPLE_EFFECTS as any, {})
    expect(trajectoryRows[0]!.timeFactor).toBe('Condition')
  })

  it('timeValueRaw holds the within-factor string level', () => {
    const { trajectoryRows } = normalizeLmmForPlots(NO_PGMOT_WITH_SIMPLE_EFFECTS as any, {})
    const rawVals = trajectoryRows.map(r => r.timeValueRaw)
    expect(rawVals).toContain('A')
    expect(rawVals).toContain('B')
  })

  it('heuristic fallback: 2-factor (one numeric-like, one categorical-like), no simple_effects', () => {
    const HEURISTIC = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [
        { factors: { Treatment: 'VEH', Day: '0' }, emmean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
        { factors: { Treatment: 'VEH', Day: '7' }, emmean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
        { factors: { Treatment: 'THC', Day: '0' }, emmean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
        { factors: { Treatment: 'THC', Day: '7' }, emmean: 14.0, se: 0.3, ci_lower: 13.4, ci_upper: 14.6, n: 8 },
      ],
      pairwise_comparisons: [],
      continuous_effects: null,
    }
    const { trajectoryRows } = normalizeLmmForPlots(HEURISTIC as any, {})
    expect(trajectoryRows.length).toBeGreaterThan(0)
    // Day is numeric-like → x-axis; Treatment is categorical-like → group
    const timeRaws = [...new Set(trajectoryRows.map(r => r.timeValueRaw))]
    expect(timeRaws).toContain('0')
    expect(timeRaws).toContain('7')
    expect(trajectoryRows[0]!.groupFactor).toBe('Treatment')
  })

  it('returns empty trajectoryRows and note when axis roles unresolvable (>2 factors, no simple_effects)', () => {
    const UNRESOLVABLE = {
      success: true,
      test_type: 'lmm_anova',
      stratified: false,
      fixed_effects: [],
      estimated_means: [
        { factors: { A: 'x', B: 'y', C: 'z' }, emmean: 5.0, se: 0.1, ci_lower: 4.8, ci_upper: 5.2, n: 10 },
      ],
      pairwise_comparisons: [],
    }
    const { trajectoryRows, notes } = normalizeLmmForPlots(UNRESOLVABLE as any, {})
    expect(trajectoryRows).toHaveLength(0)
    expect(notes.some(n => n.toLowerCase().includes('line unavailable'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Task 1: Normalizer interface contracts
// ---------------------------------------------------------------------------

const BASE_POOLED = {
  success: true,
  test_type: 'lmm_anova',
  stratified: false,
  fixed_effects: [{ source: 'Treatment x Condition', significant: true }],
  estimated_means: [
    { factors: { Treatment: 'VEH', Condition: 'A' }, emmean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
    { factors: { Treatment: 'VEH', Condition: 'B' }, emmean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
    { factors: { Treatment: 'THC', Condition: 'A' }, emmean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
    { factors: { Treatment: 'THC', Condition: 'B' }, emmean: 14.0, se: 0.3, ci_lower: 13.4, ci_upper: 14.6, n: 8 },
  ],
  pairwise_comparisons: [],
  continuous_effects: null,
}

describe('normalizeLmmForPlots — simpleEffectsConfig field (Task 1)', () => {
  it('is null when result has no simple_effects', () => {
    const { simpleEffectsConfig } = normalizeLmmForPlots(BASE_POOLED, {})
    expect(simpleEffectsConfig).toBeNull()
  })

  it('is null when simple_effects is an empty array', () => {
    const result = { ...BASE_POOLED, simple_effects: [] }
    const { simpleEffectsConfig } = normalizeLmmForPlots(result as any, {})
    expect(simpleEffectsConfig).toBeNull()
  })

  it('returns array of {factor, within} when simple_effects present', () => {
    const result = { ...BASE_POOLED, simple_effects: [{ factor: 'Treatment', within: 'Condition' }] }
    const { simpleEffectsConfig } = normalizeLmmForPlots(result as any, {})
    expect(simpleEffectsConfig).toEqual([{ factor: 'Treatment', within: 'Condition' }])
  })

  it('filters out entries with missing factor or within', () => {
    const result = {
      ...BASE_POOLED,
      simple_effects: [
        { factor: 'Treatment', within: 'Condition' },
        { factor: '', within: 'Condition' },
        { factor: 'Treatment', within: '' },
      ],
    }
    const { simpleEffectsConfig } = normalizeLmmForPlots(result as any, {})
    expect(simpleEffectsConfig).toEqual([{ factor: 'Treatment', within: 'Condition' }])
  })
})

describe('normalizeLmmForPlots — simpleEffectsRequested flag (Task 1)', () => {
  it('is false when simple_effects absent', () => {
    const { simpleEffectsRequested } = normalizeLmmForPlots(BASE_POOLED, {})
    expect(simpleEffectsRequested).toBe(false)
  })

  it('is false when simple_effects is empty array', () => {
    const result = { ...BASE_POOLED, simple_effects: [] }
    const { simpleEffectsRequested } = normalizeLmmForPlots(result as any, {})
    expect(simpleEffectsRequested).toBe(false)
  })

  it('is true when simple_effects has at least one valid entry', () => {
    const result = { ...BASE_POOLED, simple_effects: [{ factor: 'Treatment', within: 'Condition' }] }
    const { simpleEffectsRequested } = normalizeLmmForPlots(result as any, {})
    expect(simpleEffectsRequested).toBe(true)
  })

  it('is true for stratified result where any successful stratum has simple_effects', () => {
    const stratResult = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['Sex'],
      strata_results: [
        {
          success: true,
          stratum: { Sex: 'M' },
          fixed_effects: [],
          estimated_means: [],
          simple_effects: [{ factor: 'Treatment', within: 'Condition' }],
          pairwise_comparisons: [],
        },
      ],
    }
    const { simpleEffectsRequested } = normalizeLmmForPlots(stratResult as any, {})
    expect(simpleEffectsRequested).toBe(true)
  })
})

describe('normalizeLmmForPlots — trajectory row timeValueRaw + source fields (Task 1)', () => {
  const WITH_PGMOT = {
    ...BASE_POOLED,
    per_group_means_over_time: [
      { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Day', time_value: 0, mean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
      { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Day', time_value: 7, mean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
    ],
  }

  it('trajectory rows have timeValueRaw as string', () => {
    const { trajectoryRows } = normalizeLmmForPlots(WITH_PGMOT as any, {})
    expect(trajectoryRows.length).toBeGreaterThan(0)
    for (const row of trajectoryRows) {
      expect(typeof row.timeValueRaw).toBe('string')
    }
  })

  it('trajectory rows have source field', () => {
    const { trajectoryRows } = normalizeLmmForPlots(WITH_PGMOT as any, {})
    expect(trajectoryRows.length).toBeGreaterThan(0)
    for (const row of trajectoryRows) {
      expect(row.source === 'pgmot' || row.source === 'estimated_means').toBe(true)
    }
  })

  it('PGMOT rows have source=pgmot', () => {
    const { trajectoryRows } = normalizeLmmForPlots(WITH_PGMOT as any, {})
    expect(trajectoryRows.every(r => r.source === 'pgmot')).toBe(true)
  })

  it('timeValueRaw matches string version of time_value for PGMOT rows', () => {
    const { trajectoryRows } = normalizeLmmForPlots(WITH_PGMOT as any, {})
    const timeRaws = trajectoryRows.map(r => r.timeValueRaw)
    expect(timeRaws).toContain('0')
    expect(timeRaws).toContain('7')
  })
})

// ---------------------------------------------------------------------------
// Bug fix: pValue map must match groupFactor — not just withinFactor
// (Reviewer A1 / Reviewer B2)
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — pValue map scoped to groupFactor (bug fix)', () => {
  // Two simple-effect scopes share the same within ("Day") but have different factors.
  // Only the scope whose factor matches the active groupFactor should be used.
  const MULTI_FACTOR_FIXTURE = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [],
    estimated_means: [
      { factors: { Drug: 'VEH', Day: 'A' }, emmean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
      { factors: { Drug: 'THC', Day: 'A' }, emmean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
    ],
    simple_effects: [{ factor: 'Drug', within: 'Day' }],
    pairwise_comparisons: [
      // Wrong-factor scope FIRST — Diet|Day shares the same "Day" within but different factor.
      // Without groupFactor gating, first-occurrence-wins would pick this p=0.99 (incorrect).
      { group1: 'VEH', group2: 'THC', p_adjusted: 0.99, significant: false, factor_scope: 'Diet|Day=A' },
      // Correct scope — Drug|Day: should win regardless of order (p=0.04)
      { group1: 'VEH', group2: 'THC', p_adjusted: 0.04, significant: true, factor_scope: 'Drug|Day=A' },
    ],
    continuous_effects: null,
  }

  it('uses p-value from the matching groupFactor scope, not a same-within scope from a different factor', () => {
    const { trajectoryRows } = normalizeLmmForPlots(MULTI_FACTOR_FIXTURE as any, {})
    const dayARows = trajectoryRows.filter(r => r.timeValueRaw === 'A')
    expect(dayARows.length).toBeGreaterThan(0)
    for (const r of dayARows) expect(r.pValue).toBeCloseTo(0.04)
  })

  it('does not pick up p=0.99 from the wrong-factor scope', () => {
    const { trajectoryRows } = normalizeLmmForPlots(MULTI_FACTOR_FIXTURE as any, {})
    const dayARows = trajectoryRows.filter(r => r.timeValueRaw === 'A')
    for (const r of dayARows) expect(r.pValue).not.toBeCloseTo(0.99)
  })
})

// ---------------------------------------------------------------------------
// Bug fix: categorical estimated_means x-levels must get distinct timeValue
// (Reviewer B1 — all levels previously collapsed to timeValue=0)
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — categorical estimated_means timeValue ordering (bug fix)', () => {
  const CAT_FIXTURE = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [],
    estimated_means: [
      { factors: { Treatment: 'VEH', Condition: 'Pre' }, emmean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
      { factors: { Treatment: 'THC', Condition: 'Pre' }, emmean: 11.0, se: 0.3, ci_lower: 10.4, ci_upper: 11.6, n: 8 },
      { factors: { Treatment: 'VEH', Condition: 'Post' }, emmean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
      { factors: { Treatment: 'THC', Condition: 'Post' }, emmean: 13.0, se: 0.3, ci_lower: 12.4, ci_upper: 13.6, n: 8 },
    ],
    simple_effects: [{ factor: 'Treatment', within: 'Condition' }],
    pairwise_comparisons: [],
    continuous_effects: null,
  }

  it('Pre and Post rows have distinct timeValue (not both 0)', () => {
    const { trajectoryRows } = normalizeLmmForPlots(CAT_FIXTURE as any, {})
    const preRows = trajectoryRows.filter(r => r.timeValueRaw === 'Pre')
    const postRows = trajectoryRows.filter(r => r.timeValueRaw === 'Post')
    expect(preRows.length).toBeGreaterThan(0)
    expect(postRows.length).toBeGreaterThan(0)
    const preTV = preRows[0]!.timeValue
    const postTV = postRows[0]!.timeValue
    expect(preTV).not.toBe(postTV)
  })

  it('all rows for the same within-level share the same timeValue', () => {
    const { trajectoryRows } = normalizeLmmForPlots(CAT_FIXTURE as any, {})
    const preRows = trajectoryRows.filter(r => r.timeValueRaw === 'Pre')
    const tvSet = new Set(preRows.map(r => r.timeValue))
    expect(tvSet.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Bug fix (H2): PGMOT pValues must come from pairwise_comparisons.factor_scope
// — not from continuous_effects label parsing
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — PGMOT pValue sourced from factor_scope (bug fix H2)', () => {
  // Fixture: PGMOT rows present + simple_effects declared.
  // pairwise_comparisons has factor_scope with p=0.03 for Day=7.
  // continuous_effects has a DIFFERENT p=0.99 for time_value=7.
  // Without fix: pValue would be 0.99 (from continuous_effects).
  // With fix: pValue should be 0.03 (from pairwise_comparisons).
  const PGMOT_WITH_SE = {
    success: true,
    test_type: 'lmm_anova',
    stratified: false,
    fixed_effects: [],
    per_group_means_over_time: [
      { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Day', time_value: 7, mean: 10.0, se: 0.3, ci_lower: 9.4, ci_upper: 10.6, n: 8 },
      { group_factor: 'Treatment', group_value: 'THC', time_factor: 'Day', time_value: 7, mean: 12.0, se: 0.3, ci_lower: 11.4, ci_upper: 12.6, n: 8 },
    ],
    simple_effects: [{ factor: 'Treatment', within: 'Day' }],
    pairwise_comparisons: [
      { group1: 'VEH', group2: 'THC', p_adjusted: 0.03, significant: true, factor_scope: 'Treatment|Day=7' },
    ],
    // continuous_effects has a different p — must NOT be used for PGMOT stars
    continuous_effects: [
      { time_value: 7, estimate: -0.5, se: 0.1, p: 0.99, label: 'VEH vs THC|treatment|Day=7' },
    ],
  }

  it('PGMOT rows get pValue from pairwise_comparisons factor_scope, not continuous_effects', () => {
    const { trajectoryRows } = normalizeLmmForPlots(PGMOT_WITH_SE as any, {})
    expect(trajectoryRows).toHaveLength(2)
    expect(trajectoryRows.every(r => r.source === 'pgmot')).toBe(true)
    for (const r of trajectoryRows) expect(r.pValue).toBeCloseTo(0.03)
  })

  it('PGMOT pValue is null when no simple_effects configured (even if continuous_effects present)', () => {
    const NO_SE = { ...PGMOT_WITH_SE, simple_effects: [] }
    const { trajectoryRows } = normalizeLmmForPlots(NO_SE as any, {})
    expect(trajectoryRows.every(r => r.pValue === null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// trajectory_roles.reference_level threading in estimated-means path
// RED: fails until topLevelTrajectoryRoles carries reference_level and
//      normalizeLmmForPlots uses it as baseline when pairwise_comparisons absent.
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — trajectory_roles.reference_level in estimated-means groupRole', () => {
  // Pooled result with estimated_means (no PGMOT, no pairwise_comparisons)
  // so extractBaselineGroupValue returns null and trajectory_roles.reference_level
  // must be used instead.
  const EM_WITH_TR_REFERENCE: Record<string, unknown> = {
    success: true,
    test_type: 'lmm_anova',
    trajectory_roles: {
      treatment_factor: 'arm',
      time_factor: 'week',
      reference_level: 'VEH',
    },
    estimated_means: [
      { factors: { arm: 'VEH', week: '0' }, emmean: 10, se: 0.5, ci_lower: 9, ci_upper: 11 },
      { factors: { arm: 'VEH', week: '1' }, emmean: 11, se: 0.5, ci_lower: 10, ci_upper: 12 },
      { factors: { arm: 'THC', week: '0' }, emmean: 12, se: 0.5, ci_lower: 11, ci_upper: 13 },
      { factors: { arm: 'THC', week: '1' }, emmean: 13, se: 0.5, ci_lower: 12, ci_upper: 14 },
    ],
    pairwise_comparisons: [],  // empty → extractBaselineGroupValue returns null
  }

  it('VEH rows get groupRole=baseline when trajectory_roles.reference_level=VEH', () => {
    const { trajectoryRows } = normalizeLmmForPlots(EM_WITH_TR_REFERENCE as any, {})
    const vehRows = trajectoryRows.filter(r => r.groupValue === 'VEH')
    expect(vehRows.length).toBeGreaterThan(0)
    expect(vehRows.every(r => r.groupRole === 'baseline')).toBe(true)
  })

  it('THC rows get groupRole=contrast when trajectory_roles.reference_level=VEH', () => {
    const { trajectoryRows } = normalizeLmmForPlots(EM_WITH_TR_REFERENCE as any, {})
    const thcRows = trajectoryRows.filter(r => r.groupValue === 'THC')
    expect(thcRows.length).toBeGreaterThan(0)
    expect(thcRows.every(r => r.groupRole === 'contrast')).toBe(true)
  })

  it('groupRole is null for all rows when no reference_level and no pairwise_comparisons', () => {
    const NO_REFERENCE = {
      ...EM_WITH_TR_REFERENCE,
      trajectory_roles: { treatment_factor: 'arm', time_factor: 'week' },  // no reference_level
    }
    const { trajectoryRows } = normalizeLmmForPlots(NO_REFERENCE as any, {})
    expect(trajectoryRows.every(r => r.groupRole === null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PGMOT always wins — trajectory_roles is for estimated_means fallback only
// Regression lock against the March 25 breakage where a pgmotMatchesTR gate
// caused PGMOT rows to be discarded and estimated_means to be used instead,
// producing trait names on the x-axis instead of numeric Day values.
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — PGMOT always used when present (no TR gate)', () => {
  // Shared fixture: PGMOT rows use 'day_num' as time_factor, but trajectory_roles
  // specifies time_factor='Day'. The gate-based code would reject these rows.
  // Correct behavior: PGMOT rows are always used; TR only affects estimated_means fallback.
  const PGMOT_WITH_TR_MISMATCH = {
    success: true,
    test_type: 'lmm_anova_stratified',
    stratified: true,
    stratify_by: ['sex'],
    trajectory_roles: {
      treatment_factor: 'Treatment',
      time_factor: 'Day',            // differs from PGMOT time_factor 'day_num'
    },
    strata_results: [
      {
        success: true,
        stratum: { sex: 'M' },
        fixed_effects: [],
        per_group_means_over_time: [
          { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'day_num', time_value: 0, mean: 10, se: 0.5, ci_lower: 9, ci_upper: 11, n: 5 },
          { group_factor: 'Treatment', group_value: 'THC', time_factor: 'day_num', time_value: 0, mean: 12, se: 0.5, ci_lower: 11, ci_upper: 13, n: 5 },
        ],
        estimated_means: [
          { factors: { Treatment: 'VEH', Day: '0' }, emmean: 10, se: 0.5, ci_lower: 9, ci_upper: 11, n: 5 },
          { factors: { Treatment: 'THC', Day: '0' }, emmean: 12, se: 0.5, ci_lower: 11, ci_upper: 13, n: 5 },
          { factors: { Treatment: 'VEH', Day: '1' }, emmean: 11, se: 0.5, ci_lower: 10, ci_upper: 12, n: 5 },
          { factors: { Treatment: 'THC', Day: '1' }, emmean: 13, se: 0.5, ci_lower: 12, ci_upper: 14, n: 5 },
        ],
      },
    ],
  }

  it('uses PGMOT even when PGMOT time_factor differs from trajectory_roles.time_factor', () => {
    // Regression lock: the old gate used to reject these rows and fall back to estimated_means,
    // causing trait names to appear on the x-axis. PGMOT must always win when present.
    const { trajectoryRows } = normalizeLmmForPlots(PGMOT_WITH_TR_MISMATCH as any, {})
    expect(trajectoryRows.length).toBeGreaterThan(0)
    expect(trajectoryRows.every(r => r.source === 'pgmot')).toBe(true)
    expect(trajectoryRows.every(r => r.timeFactor === 'day_num')).toBe(true)
  })

  it('uses PGMOT even when PGMOT group_factor differs from trajectory_roles.treatment_factor', () => {
    const PGMOT_GROUP_MISMATCH = {
      ...PGMOT_WITH_TR_MISMATCH,
      trajectory_roles: { treatment_factor: 'Treatment', time_factor: 'day_num' },
      strata_results: [
        {
          success: true,
          stratum: { sex: 'M' },
          fixed_effects: [],
          per_group_means_over_time: [
            // group_factor='Arm' differs from TR treatment_factor='Treatment'
            { group_factor: 'Arm', group_value: 'VEH', time_factor: 'day_num', time_value: 0, mean: 10, se: 0.5, ci_lower: 9, ci_upper: 11, n: 5 },
            { group_factor: 'Arm', group_value: 'THC', time_factor: 'day_num', time_value: 0, mean: 12, se: 0.5, ci_lower: 11, ci_upper: 13, n: 5 },
          ],
          estimated_means: [
            { factors: { Treatment: 'VEH', day_num: '0' }, emmean: 10, se: 0.5, ci_lower: 9, ci_upper: 11, n: 5 },
            { factors: { Treatment: 'THC', day_num: '0' }, emmean: 12, se: 0.5, ci_lower: 11, ci_upper: 13, n: 5 },
          ],
        },
      ],
    }
    const { trajectoryRows } = normalizeLmmForPlots(PGMOT_GROUP_MISMATCH as any, {})
    expect(trajectoryRows.length).toBeGreaterThan(0)
    // Backend owns group_factor — PGMOT rows tell us it's 'Arm', and that is trusted
    expect(trajectoryRows.every(r => r.source === 'pgmot')).toBe(true)
    expect(trajectoryRows.every(r => r.groupFactor === 'Arm')).toBe(true)
  })

  it('uses PGMOT even when some rows have a different time_factor (heterogeneous batch)', () => {
    const MIXED_PGMOT = {
      ...PGMOT_WITH_TR_MISMATCH,
      strata_results: [{
        ...PGMOT_WITH_TR_MISMATCH.strata_results[0],
        per_group_means_over_time: [
          { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'Day',     time_value: 0, mean: 10, se: 0.5, ci_lower: 9, ci_upper: 11, n: 5 },
          { group_factor: 'Treatment', group_value: 'VEH', time_factor: 'day_num', time_value: 1, mean: 11, se: 0.5, ci_lower: 10, ci_upper: 12, n: 5 },
        ],
      }],
    }
    const { trajectoryRows } = normalizeLmmForPlots(MIXED_PGMOT as any, {})
    expect(trajectoryRows.every(r => r.source === 'pgmot')).toBe(true)
  })

  it('uses PGMOT even when PGMOT rows have an empty group_factor', () => {
    const EMPTY_GROUP = {
      ...PGMOT_WITH_TR_MISMATCH,
      strata_results: [{
        ...PGMOT_WITH_TR_MISMATCH.strata_results[0],
        per_group_means_over_time: [
          { group_factor: '', group_value: 'VEH', time_factor: 'day_num', time_value: 0, mean: 10, se: 0.5, ci_lower: 9, ci_upper: 11, n: 5 },
          { group_factor: '', group_value: 'THC', time_factor: 'day_num', time_value: 0, mean: 12, se: 0.5, ci_lower: 11, ci_upper: 13, n: 5 },
        ],
      }],
    }
    const { trajectoryRows } = normalizeLmmForPlots(EMPTY_GROUP as any, {})
    expect(trajectoryRows.every(r => r.source === 'pgmot')).toBe(true)
  })

  it('PGMOT rows still used when trajectory_roles is absent (no regression on no-TR path)', () => {
    const NO_TR = { ...PGMOT_WITH_TR_MISMATCH, trajectory_roles: undefined }
    const { trajectoryRows } = normalizeLmmForPlots(NO_TR as any, {})
    expect(trajectoryRows.length).toBeGreaterThan(0)
    expect(trajectoryRows.every(r => r.source === 'pgmot')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// compound_panels_warnings surfaced into notes
// ---------------------------------------------------------------------------

describe('normalizeLmmForPlots — compound_panels_warnings surfaced into notes', () => {
  it('appends compound_panels_warnings to notes so users see why compound was skipped', () => {
    const COMPOUND_WARN_RAW = {
      success: true,
      test_type: 'lmm_anova_stratified',
      stratified: true,
      stratify_by: ['sex', 'strain'],
      trajectory_roles: { treatment_factor: 'Treatment', time_factor: 'Day' },
      compound_panels: [],
      compound_panels_warnings: [
        "trajectory_roles.treatment_factor 'NonExistent' is not a model predictor — compound panel skipped.",
      ],
      strata_results: [{
        success: true,
        stratum: { sex: 'M', strain: 'B6' },
        fixed_effects: [],
        estimated_means: [
          { factors: { Treatment: 'VEH', Day: '0' }, emmean: 10, se: 0.5, ci_lower: 9, ci_upper: 11, n: 5 },
          { factors: { Treatment: 'THC', Day: '0' }, emmean: 12, se: 0.5, ci_lower: 11, ci_upper: 13, n: 5 },
        ],
      }],
    }
    const { notes } = normalizeLmmForPlots(COMPOUND_WARN_RAW as any, {})
    expect(notes.some(n => n.includes("trajectory_roles.treatment_factor"))).toBe(true)
  })
})
