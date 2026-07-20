import { describe, expect, it } from 'vitest'

import { getValidationDirForTest as getFixtureValidationDir } from '../../../e2e/utils/fixtures.mjs'
import { getValidationDirForTest as getBaselineValidationDir } from '../../../e2e/utils/r-validation.mjs'

describe('validation path aliases', () => {
  it('maps lmm_anova to the linear_mixed_models validation directory', () => {
    expect(getFixtureValidationDir('lmm_anova')).toBe('linear_mixed_models')
    expect(getBaselineValidationDir('lmm_anova')).toBe('linear_mixed_models')
  })

  it('leaves tests without aliases unchanged', () => {
    expect(getFixtureValidationDir('anova_two_way')).toBe('anova_two_way')
    expect(getBaselineValidationDir('anova_two_way')).toBe('anova_two_way')
  })
})
