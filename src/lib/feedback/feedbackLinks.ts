/**
 * Centralised feedback link builders for the Help & Support dialog.
 *
 * All GitHub URLs and mailto: templates live here so ActionToolbar
 * never constructs strings inline.
 */

export const FEEDBACK_EMAIL = 'hello@easycris.com'

export const GITHUB_REPO_URL = 'https://github.com/easyCris-software/easyCris'

export const GITHUB_BUG_URL =
  'https://github.com/easyCris-software/easyCris/issues/new?labels=bug&template=bug_report.md'

export const GITHUB_FEATURE_URL =
  'https://github.com/easyCris-software/easyCris/issues/new?labels=enhancement&template=feature_request.md'

export const GITHUB_DISCUSSIONS_URL = 'https://github.com/easyCris-software/easyCris/discussions'

/**
 * Builds a pre-filled mailto: URI for bug reports.
 * Includes app version and user agent so support has context immediately.
 */
export function buildBugEmailUrl(version: string, userAgent: string): string {
  const subject = encodeURIComponent('Bug Report — easyCris')
  const body = encodeURIComponent(
    [
      `App version: ${version}`,
      `Platform: ${userAgent}`,
      '',
      'Describe the bug:',
      '',
      'Steps to reproduce:',
      '1. ',
      '',
      'Expected behavior:',
      '',
      'Actual behavior:',
    ].join('\n')
  )
  return `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`
}

/**
 * Builds a pre-filled mailto: URI for feature requests.
 */
export function buildFeatureEmailUrl(version: string): string {
  const subject = encodeURIComponent('Feature Request — easyCris')
  const body = encodeURIComponent(
    [
      `App version: ${version}`,
      '',
      'Describe your idea:',
      '',
      'How would this help you or others?',
      '',
      'Any alternatives you have considered?',
    ].join('\n')
  )
  return `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`
}
