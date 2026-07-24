import { describe, it, expect } from 'vitest'
import { getLmmSiblingViews, getActiveViewLabel } from '../lmmViewToggle'

type P = {
  id: string
  type: string
  sourceType: string
  resultId?: string | null
  testType?: string | null
  facetKey?: string | null
  lmmMode?: 'trajectory' | 'contrast' | 'line_unavailable' | null
}

const tLine: P = {
  id: 'line-traj-1',
  type: 'line',
  sourceType: 'test_result',
  resultId: 'r1',
  testType: 'lmm_anova',
  facetKey: 'sex=M',
  lmmMode: 'trajectory',
}

const cLine: P = {
  id: 'line-contrast-1',
  type: 'line',
  sourceType: 'test_result',
  resultId: 'r1',
  testType: 'lmm_anova',
  facetKey: 'sex=M',
  lmmMode: 'contrast',
}

describe('getLmmSiblingViews', () => {
  it('returns null when active plot is missing', () => {
    expect(getLmmSiblingViews(undefined, [tLine, cLine])).toBeNull()
  })

  it('returns null for non-LMM test type', () => {
    const nonLmm: P = { ...tLine, testType: 'chi_square_gof' }
    expect(getLmmSiblingViews(nonLmm, [nonLmm, cLine])).toBeNull()
  })

  it('returns null when only one line mode exists', () => {
    expect(getLmmSiblingViews(tLine, [tLine])).toBeNull()
  })

  it('returns siblings when trajectory and contrast lines share resultId+facetKey', () => {
    const result = getLmmSiblingViews(tLine, [tLine, cLine])
    expect(result).not.toBeNull()
    expect(result!.trajectoryPlotId).toBe('line-traj-1')
    expect(result!.contrastPlotId).toBe('line-contrast-1')
  })

  it('works for lmm_anova_stratified test type as well', () => {
    const sTraj: P = { ...tLine, id: 's-t', testType: 'lmm_anova_stratified' }
    const sContrast: P = { ...cLine, id: 's-c', testType: 'lmm_anova_stratified' }
    const result = getLmmSiblingViews(sTraj, [sTraj, sContrast])
    expect(result).not.toBeNull()
    expect(result!.trajectoryPlotId).toBe('s-t')
    expect(result!.contrastPlotId).toBe('s-c')
  })

  it('pairs siblings when testType differs only by lmm_anova / lmm_anova_stratified alias (normalized)', () => {
    // Active plot stored as lmm_anova; sibling stored as lmm_anova_stratified (migration alias).
    // After normalization both become lmm_anova → should pair.
    const rawA: P = { ...tLine, id: 'a', testType: 'lmm_anova' }
    const rawB: P = { ...cLine, id: 'b', testType: 'lmm_anova_stratified' }
    const result = getLmmSiblingViews(rawA, [rawA, rawB])
    expect(result).not.toBeNull()
    expect(result!.trajectoryPlotId).toBe('a')
    expect(result!.contrastPlotId).toBe('b')
  })

  it('pairs siblings when active=lmm_anova_stratified and sibling=lmm_anova (reverse alias)', () => {
    // Inverse of the above — active is stratified, sibling is base alias.
    const rawA: P = { ...tLine, id: 'c', testType: 'lmm_anova_stratified' }
    const rawB: P = { ...cLine, id: 'd', testType: 'lmm_anova' }
    const result = getLmmSiblingViews(rawA, [rawA, rawB])
    expect(result).not.toBeNull()
    expect(result!.trajectoryPlotId).toBe('c')
    expect(result!.contrastPlotId).toBe('d')
  })

  it('does not cross-pair different facets', () => {
    const otherFacetContrast: P = { ...cLine, id: 'line-contrast-f', facetKey: 'sex=F' }
    expect(getLmmSiblingViews(tLine, [tLine, otherFacetContrast])).toBeNull()
  })

  it('treats undefined facetKey as null (pooled matching)', () => {
    const pooledTraj: P = { ...tLine, id: 'pt', facetKey: undefined, lmmMode: 'trajectory' }
    const pooledContrast: P = { ...cLine, id: 'pc', facetKey: null, lmmMode: 'contrast' }
    const result = getLmmSiblingViews(pooledTraj, [pooledTraj, pooledContrast])
    expect(result).not.toBeNull()
    expect(result!.trajectoryPlotId).toBe('pt')
    expect(result!.contrastPlotId).toBe('pc')
  })
})

describe('getActiveViewLabel', () => {
  it('returns Trajectory for trajectory mode', () => {
    expect(getActiveViewLabel('trajectory')).toBe('Trajectory')
  })

  it('returns Contrast for contrast mode', () => {
    expect(getActiveViewLabel('contrast')).toBe('Contrast')
  })

  it('returns null for non-line modes', () => {
    expect(getActiveViewLabel('line_unavailable')).toBeNull()
    expect(getActiveViewLabel(null)).toBeNull()
    expect(getActiveViewLabel(undefined)).toBeNull()
  })
})
