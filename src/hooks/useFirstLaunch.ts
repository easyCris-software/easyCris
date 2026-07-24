/**
 * useFirstLaunch Hook
 *
 * Detects if this is the user's first launch of the app.
 * Uses localStorage to track if welcome screen has been seen.
 */

import { useState, useEffect } from 'react'
import { isE2EEnabled } from '@/utils/e2eMode'
import { E2E_FORCE_FIRST_LAUNCH_KEY } from '@/utils/e2eAuthHooks'

export function useFirstLaunch() {
  const [isFirstLaunch, setIsFirstLaunch] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (isE2EEnabled()) {
      const forceFirstLaunch = localStorage.getItem(E2E_FORCE_FIRST_LAUNCH_KEY) === 'true'
      if (forceFirstLaunch) {
        localStorage.removeItem('hasSeenWelcome')
        setIsFirstLaunch(true)
        setIsLoading(false)
        return
      }

      localStorage.setItem('hasSeenWelcome', 'true')
      setIsFirstLaunch(false)
      setIsLoading(false)
      return
    }

    const hasSeenWelcome = localStorage.getItem('hasSeenWelcome')
    if (!hasSeenWelcome) {
      setIsFirstLaunch(true)
    }
    setIsLoading(false)
  }, [])

  const markWelcomeSeen = () => {
    localStorage.setItem('hasSeenWelcome', 'true')
    setIsFirstLaunch(false)
  }

  return { isFirstLaunch, isLoading, markWelcomeSeen }
}
