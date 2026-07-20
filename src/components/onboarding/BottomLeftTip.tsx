/**
 * BottomLeftTip Component
 *
 * Shows contextual tips in the bottom-left corner for new users.
 * Features:
 * - Rotating tips based on app state
 * - Dismissible per-tip or globally
 * - Optional action button per tip (e.g. "Star on GitHub")
 * - Snooze support: tips with snoozeOnLater=true defer 14 days instead of dismissing
 * - Smooth animations
 * - Tailwind + Radix UI styling
 */

import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Button } from '@/components/ui/button'
import { useDataStore } from '@/store/data-store'
import { useResultsStore } from '@/store/results-store'
import { usePlotsStore } from '@/store/plots-store'
import { isSnoozed, snooze } from '@/lib/feedback/tipSnooze'
import { GITHUB_REPO_URL } from '@/lib/feedback/feedbackLinks'

interface Tip {
  id: string
  message: string
  condition: () => boolean
  /** Optional CTA button rendered before the standard controls. */
  actionButton?: { label: string; icon?: React.ReactNode; onClick: () => void }
  /** When true, "Later" snoozes 14 days instead of permanently dismissing. */
  snoozeOnLater?: boolean
}

const TIPS: Tip[] = [
  {
    id: 'import-data',
    message: 'Click "Import Data" or use Welcome > Browse Examples or Help > Statistics Sample Datasets to get started.',
    condition: () => {
      const datasets = useDataStore.getState().datasets
      return datasets.length === 0
    },
  },
  {
    id: 'sample-datasets',
    message: 'New to easyCris? Open Help > Statistics Sample Datasets for tests, or Help > RNA-seq Sample Dataset for a paired demo import.',
    condition: () => {
      const launchCount = parseInt(localStorage.getItem('easycris-launch-count') || '0', 10)
      return launchCount <= 5
    },
  },
  {
    id: 'navigator',
    message: 'Use the navigator (left sidebar) to quickly switch between Data, Results, and Plots.',
    condition: () => {
      const results = useResultsStore.getState().results
      return results.length > 0
    },
  },
  {
    id: 'export-results',
    message: 'In Plots, use the Export (download) button in the toolbar to save PNG, SVG, PDF, or more.',
    condition: () => {
      const results = useResultsStore.getState().results
      const plots = usePlotsStore.getState().plots
      return results.length >= 2 || plots.length >= 1
    },
  },
  {
    id: 'grid-shortcuts',
    message: 'Grid shortcuts: Ctrl+C/Ctrl+X/Ctrl+V, Ctrl+H for Find/Replace, Ctrl+Shift+H for Highlights.',
    condition: () => {
      const datasets = useDataStore.getState().datasets
      return datasets.length > 0
    },
  },
  {
    id: 'keyboard-shortcuts',
    message: 'Press Ctrl+K (or Ctrl+Shift+P) to open the command palette.',
    condition: () => {
      const results = useResultsStore.getState().results
      return results.length >= 5
    },
  },
  {
    id: 'rate-us',
    message: 'Loving easyCris? A GitHub star helps us reach more researchers.',
    condition: () => {
      const launchCount = parseInt(localStorage.getItem('easycris-launch-count') || '0', 10)
      const results = useResultsStore.getState().results
      if (isSnoozed('rate-us')) return false
      return launchCount >= 5 && results.length >= 1
    },
    actionButton: {
      label: 'Star on GitHub',
      icon: <Star className="h-3 w-3" />,
      onClick: () => { openUrl(GITHUB_REPO_URL).catch(() => {}) },
    },
    snoozeOnLater: true,
  },
]

const GLOBAL_DISABLE_KEY = 'easycris-tips-disabled'

function findActiveTipIndex(currentIndex: number | null = null): number {
  return TIPS.findIndex((tip, idx) => {
    if (currentIndex !== null && idx <= currentIndex) return false
    const dismissed = localStorage.getItem(`tip-dismissed-${tip.id}`) === 'true'
    const conditionMet = tip.condition()
    return !dismissed && conditionMet
  })
}

export function BottomLeftTip() {
  const [currentTipIndex, setCurrentTipIndex] = useState<number | null>(null)
  const [isVisible, setIsVisible] = useState(false)

  // Check if tips are globally disabled
  const tipsDisabled = localStorage.getItem(GLOBAL_DISABLE_KEY) === 'true'

  // Find the first tip that matches conditions and hasn't been dismissed
  useEffect(() => {
    if (tipsDisabled) {
      setIsVisible(false)
      return
    }

    // Increment launch count for condition checking
    const launchCount = parseInt(localStorage.getItem('easycris-launch-count') || '0', 10)
    localStorage.setItem('easycris-launch-count', String(launchCount + 1))

    const timer = setTimeout(() => {
      const activeTipIndex = findActiveTipIndex()
      if (activeTipIndex !== -1) {
        setCurrentTipIndex(activeTipIndex)
        setIsVisible(true)
      }
    }, 2000) // Delay 2s after app loads

    return () => clearTimeout(timer)
  }, [tipsDisabled])

  // Re-check tips when store state changes
  useEffect(() => {
    if (tipsDisabled || !isVisible) return

    const recheck = () => {
      const activeTipIndex = findActiveTipIndex()
      if (activeTipIndex !== -1 && activeTipIndex !== currentTipIndex) {
        setCurrentTipIndex(activeTipIndex)
        setIsVisible(true)
      }
    }

    const unsubscribeData = useDataStore.subscribe(recheck)
    const unsubscribeResults = useResultsStore.subscribe(recheck)
    const unsubscribePlots = usePlotsStore.subscribe(recheck)

    return () => {
      unsubscribeData()
      unsubscribeResults()
      unsubscribePlots()
    }
  }, [tipsDisabled, isVisible, currentTipIndex])

  const handleDismiss = () => {
    if (currentTipIndex === null) return
    const tip = TIPS[currentTipIndex]
    if (!tip) return
    localStorage.setItem(`tip-dismissed-${tip.id}`, 'true')
    setIsVisible(false)
    setCurrentTipIndex(null)
  }

  const handleLater = () => {
    if (currentTipIndex === null) return
    const tip = TIPS[currentTipIndex]
    if (!tip) return
    if (tip.snoozeOnLater) {
      snooze(tip.id)
    } else {
      localStorage.setItem(`tip-dismissed-${tip.id}`, 'true')
    }
    setIsVisible(false)
    setCurrentTipIndex(null)
  }

  const handleNextTip = () => {
    if (currentTipIndex === null) return
    const currentTip = TIPS[currentTipIndex]
    if (!currentTip) {
      setIsVisible(false)
      setCurrentTipIndex(null)
      return
    }
    localStorage.setItem(`tip-dismissed-${currentTip.id}`, 'true')

    const nextTipIndex = findActiveTipIndex(currentTipIndex)
    if (nextTipIndex !== -1) {
      setCurrentTipIndex(nextTipIndex)
    } else {
      setIsVisible(false)
      setCurrentTipIndex(null)
    }
  }

  const handleDisableAllTips = () => {
    localStorage.setItem(GLOBAL_DISABLE_KEY, 'true')
    setIsVisible(false)
    setCurrentTipIndex(null)
  }

  if (!isVisible || currentTipIndex === null || tipsDisabled) {
    return null
  }

  const tip = TIPS[currentTipIndex]
  if (!tip) {
    return null
  }

  const isRateUsTip = tip.snoozeOnLater === true

  return (
    <div
      className="fixed bottom-4 left-4 w-80 bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-lg p-4 shadow-lg z-50 animate-in slide-in-from-bottom-2 fade-in duration-300"
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-indigo-900 uppercase tracking-wide">
            {isRateUsTip ? 'Enjoying easyCris?' : 'Tip'}
          </p>
          <p className="text-sm text-indigo-700 mt-1 leading-relaxed">
            {tip.message}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {tip.actionButton && (
          <Button
            variant="default"
            size="sm"
            className="text-xs h-7 gap-1"
            onClick={tip.actionButton.onClick}
          >
            {tip.actionButton.icon}
            {tip.actionButton.label}
          </Button>
        )}
        {!isRateUsTip && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7 text-indigo-700 hover:text-indigo-900 hover:bg-indigo-100"
            onClick={handleNextTip}
          >
            Next Tip
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-xs h-7 text-indigo-600 hover:text-indigo-800 hover:bg-indigo-100"
          onClick={handleDisableAllTips}
        >
          Don't Show Tips
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs h-7 text-indigo-600 hover:text-indigo-800 hover:bg-indigo-100"
          onClick={isRateUsTip ? handleLater : handleDismiss}
        >
          {isRateUsTip ? 'Later' : 'Dismiss'}
        </Button>
      </div>
    </div>
  )
}
