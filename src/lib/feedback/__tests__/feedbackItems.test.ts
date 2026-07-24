import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFeedbackItems } from '../feedbackItems'
import { FEEDBACK_EMAIL, GITHUB_BUG_URL, GITHUB_DISCUSSIONS_URL, GITHUB_FEATURE_URL, GITHUB_REPO_URL } from '../feedbackLinks'

/**
 * Tests for the feedback item builder.
 *
 * These tests guard the handler→label mapping so a swap
 * (e.g. "Star on GitHub" calling email instead of GitHub) is
 * caught immediately without needing a mounted UI test.
 */
describe('buildFeedbackItems', () => {
  const openEmailFn = vi.fn()
  const openUrlFn = vi.fn()
  const closeFn = vi.fn()

  const items = buildFeedbackItems({
    version: '1.2.3',
    openEmailFn,
    openUrlFn,
    closeFn,
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ---------------------------------------------------------------------------
  // report-bug
  // ---------------------------------------------------------------------------

  it('report-bug: primary action sends bug email (not GitHub)', () => {
    const bug = items.find((i) => i.id === 'report-bug')!
    bug.primaryAction()
    expect(openEmailFn).toHaveBeenCalledOnce()
    const [url] = openEmailFn.mock.calls[0] as [string]
    expect(url).toContain('mailto:')
    expect(url).toContain(FEEDBACK_EMAIL)
    expect(url.toLowerCase()).toContain('bug')
    expect(openUrlFn).not.toHaveBeenCalled()
  })

  it('report-bug: secondary action opens GitHub bug URL (not email)', () => {
    const bug = items.find((i) => i.id === 'report-bug')!
    bug.secondaryAction()
    expect(openUrlFn).toHaveBeenCalledWith(GITHUB_BUG_URL)
    expect(openEmailFn).not.toHaveBeenCalled()
  })

  it('report-bug: primary label is Report via Email', () => {
    const bug = items.find((i) => i.id === 'report-bug')!
    expect(bug.primaryLabel).toBe('Report via Email')
  })

  it('report-bug: secondary label is Report via GitHub', () => {
    const bug = items.find((i) => i.id === 'report-bug')!
    expect(bug.secondaryLabel).toBe('Report via GitHub')
  })

  // ---------------------------------------------------------------------------
  // request-feature
  // ---------------------------------------------------------------------------

  it('request-feature: primary action sends feature email', () => {
    const feat = items.find((i) => i.id === 'request-feature')!
    feat.primaryAction()
    expect(openEmailFn).toHaveBeenCalledOnce()
    const [url] = openEmailFn.mock.calls[0] as [string]
    expect(url).toContain('mailto:')
    expect(url.toLowerCase()).toContain('feature')
    expect(openUrlFn).not.toHaveBeenCalled()
  })

  it('request-feature: secondary action opens GitHub feature URL', () => {
    const feat = items.find((i) => i.id === 'request-feature')!
    feat.secondaryAction()
    expect(openUrlFn).toHaveBeenCalledWith(GITHUB_FEATURE_URL)
    expect(openEmailFn).not.toHaveBeenCalled()
  })

  it('request-feature: primary label is Request via Email', () => {
    const feat = items.find((i) => i.id === 'request-feature')!
    expect(feat.primaryLabel).toBe('Request via Email')
  })

  it('request-feature: secondary label is Request via GitHub', () => {
    const feat = items.find((i) => i.id === 'request-feature')!
    expect(feat.secondaryLabel).toBe('Request via GitHub')
  })

  // ---------------------------------------------------------------------------
  // love-easycris — the swap regression test
  // ---------------------------------------------------------------------------

  it('love-easycris: primary action (Star on GitHub) opens GITHUB_REPO_URL, not email', () => {
    const love = items.find((i) => i.id === 'love-easycris')!
    love.primaryAction()
    expect(openUrlFn).toHaveBeenCalledWith(GITHUB_REPO_URL)
    expect(openEmailFn).not.toHaveBeenCalled()
  })

  it('love-easycris: secondary action (Join Discussions) opens GitHub discussions URL', () => {
    const love = items.find((i) => i.id === 'love-easycris')!
    love.secondaryAction()
    expect(openUrlFn).toHaveBeenCalledWith(GITHUB_DISCUSSIONS_URL)
    expect(openEmailFn).not.toHaveBeenCalled()
  })

  it('love-easycris: primary label is Star on GitHub', () => {
    const love = items.find((i) => i.id === 'love-easycris')!
    expect(love.primaryLabel).toMatch(/star/i)
    expect(love.primaryLabel).toMatch(/github/i)
  })

  it('love-easycris: secondary label is Join Discussions', () => {
    const love = items.find((i) => i.id === 'love-easycris')!
    expect(love.secondaryLabel).toBe('Join Discussions')
  })

  // ---------------------------------------------------------------------------
  // Dialog-close behavior (documented intentional asymmetry)
  // GitHub actions close the dialog; email actions keep it open so the user
  // can fall back to GitHub if the mail client fails.
  // ---------------------------------------------------------------------------

  it('GitHub actions call closeFn', () => {
    const bug = items.find((i) => i.id === 'report-bug')!
    bug.secondaryAction()
    expect(closeFn).toHaveBeenCalled()
  })

  it('email actions do NOT call closeFn (dialog stays open as fallback)', () => {
    const bug = items.find((i) => i.id === 'report-bug')!
    bug.primaryAction()
    expect(closeFn).not.toHaveBeenCalled()
  })

  it('love-easycris Star on GitHub calls closeFn', () => {
    const love = items.find((i) => i.id === 'love-easycris')!
    love.primaryAction()
    expect(closeFn).toHaveBeenCalled()
  })

  it('love-easycris Join Discussions calls closeFn', () => {
    const love = items.find((i) => i.id === 'love-easycris')!
    love.secondaryAction()
    expect(closeFn).toHaveBeenCalled()
  })
})
