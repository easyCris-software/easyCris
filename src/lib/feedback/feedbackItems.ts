/**
 * Pure builder for Help & Support feedback items.
 *
 * Extracted from ActionToolbar so the handler→label mapping
 * is testable without mounting the full component.
 *
 * Dialog-close asymmetry (intentional):
 * - GitHub actions close the dialog (user is navigating away).
 * - Email actions keep the dialog open so the user can fall back
 *   to the GitHub option if no mail client is configured.
 */

import {
  buildBugEmailUrl,
  buildFeatureEmailUrl,
  GITHUB_BUG_URL,
  GITHUB_DISCUSSIONS_URL,
  GITHUB_FEATURE_URL,
  GITHUB_REPO_URL,
} from './feedbackLinks'

export interface FeedbackItem {
  id: string
  title: string
  description: string
  primaryLabel: string
  primaryAction: () => void
  secondaryLabel: string
  secondaryAction: () => void
}

interface BuildOptions {
  /** Installed app version string (shown in email body). */
  version: string
  /** Called for mailto: URLs (email channel). */
  openEmailFn: (url: string) => void
  /** Called for https: URLs (GitHub channel). */
  openUrlFn: (url: string) => void
  /** Called when the Help dialog should close after an action. */
  closeFn: () => void
}

export function buildFeedbackItems({
  version,
  openEmailFn,
  openUrlFn,
  closeFn,
}: BuildOptions): FeedbackItem[] {
  return [
    {
      id: 'report-bug',
      title: 'Report Bug',
      description: 'Something not working?',
      primaryLabel: 'Report via Email',
      primaryAction: () => {
        openEmailFn(buildBugEmailUrl(version, navigator.userAgent))
        // dialog stays open — user may need GitHub fallback if mail client fails
      },
      secondaryLabel: 'Report via GitHub',
      secondaryAction: () => {
        openUrlFn(GITHUB_BUG_URL)
        closeFn()
      },
    },
    {
      id: 'request-feature',
      title: 'Request Feature',
      description: 'Suggest an improvement',
      primaryLabel: 'Request via Email',
      primaryAction: () => {
        openEmailFn(buildFeatureEmailUrl(version))
      },
      secondaryLabel: 'Request via GitHub',
      secondaryAction: () => {
        openUrlFn(GITHUB_FEATURE_URL)
        closeFn()
      },
    },
    {
      id: 'love-easycris',
      title: 'Love easyCris?',
      description: 'A GitHub star helps us grow',
      primaryLabel: 'Star on GitHub',
      primaryAction: () => {
        openUrlFn(GITHUB_REPO_URL)
        closeFn()
      },
      secondaryLabel: 'Join Discussions',
      secondaryAction: () => {
        openUrlFn(GITHUB_DISCUSSIONS_URL)
        closeFn()
      },
    },
  ]
}
