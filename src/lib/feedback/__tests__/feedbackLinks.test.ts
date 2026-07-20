import { describe, it, expect } from 'vitest'
import {
  FEEDBACK_EMAIL,
  GITHUB_REPO_URL,
  GITHUB_BUG_URL,
  GITHUB_FEATURE_URL,
  buildBugEmailUrl,
  buildFeatureEmailUrl,
} from '../feedbackLinks'

describe('feedbackLinks constants', () => {
  it('FEEDBACK_EMAIL is hello@easycris.com', () => {
    expect(FEEDBACK_EMAIL).toBe('hello@easycris.com')
  })

  it('GITHUB_REPO_URL points to the repo root', () => {
    expect(GITHUB_REPO_URL).toBe('https://github.com/easyCris-software/easyCris')
  })

  it('GITHUB_BUG_URL includes bug label and template', () => {
    expect(GITHUB_BUG_URL).toContain('labels=bug')
    expect(GITHUB_BUG_URL).toContain('template=bug_report.md')
  })

  it('GITHUB_FEATURE_URL includes enhancement label and template', () => {
    expect(GITHUB_FEATURE_URL).toContain('labels=enhancement')
    expect(GITHUB_FEATURE_URL).toContain('template=feature_request.md')
  })
})

describe('buildBugEmailUrl', () => {
  it('returns a mailto: URL', () => {
    const url = buildBugEmailUrl('1.0.0', 'Mozilla/5.0')
    expect(url.startsWith('mailto:')).toBe(true)
  })

  it('addresses hello@easycris.com', () => {
    const url = buildBugEmailUrl('1.0.0', 'Mozilla/5.0')
    expect(url).toContain('hello@easycris.com')
  })

  it('subject contains Bug Report', () => {
    const url = buildBugEmailUrl('1.0.0', 'Mozilla/5.0')
    const decoded = decodeURIComponent(url)
    expect(decoded).toMatch(/subject=.*Bug Report/i)
  })

  it('body contains app version', () => {
    const url = buildBugEmailUrl('2.3.1', 'Mozilla/5.0')
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('2.3.1')
  })

  it('body contains user agent', () => {
    const url = buildBugEmailUrl('1.0.0', 'TestAgent/42')
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('TestAgent/42')
  })

  it('body contains describe / steps / expected template prompts', () => {
    const url = buildBugEmailUrl('1.0.0', 'ua')
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('Describe the bug')
    expect(decoded).toContain('Steps to reproduce')
    expect(decoded).toContain('Expected behavior')
  })
})

describe('buildFeatureEmailUrl', () => {
  it('returns a mailto: URL', () => {
    const url = buildFeatureEmailUrl('1.0.0')
    expect(url.startsWith('mailto:')).toBe(true)
  })

  it('addresses hello@easycris.com', () => {
    const url = buildFeatureEmailUrl('1.0.0')
    expect(url).toContain('hello@easycris.com')
  })

  it('subject contains Feature Request', () => {
    const url = buildFeatureEmailUrl('1.0.0')
    const decoded = decodeURIComponent(url)
    expect(decoded).toMatch(/subject=.*Feature Request/i)
  })

  it('body contains app version', () => {
    const url = buildFeatureEmailUrl('0.9.5')
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('0.9.5')
  })

  it('body contains feature template prompts', () => {
    const url = buildFeatureEmailUrl('1.0.0')
    const decoded = decodeURIComponent(url)
    expect(decoded).toContain('Describe your idea')
    expect(decoded).toContain('How would this help')
  })
})
