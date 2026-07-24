import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { initializeCommandSystem } from './lib/commands'
import { logger } from './lib/logger'
import { runUpdaterFlow, type UpdaterProgressEvent } from './lib/updater'
import { cleanupOldFiles } from './lib/recovery'
import { useAppStore } from './store/app-store'
import { useDeviceAuthStore } from './store/deviceAuthStore'
import {
  bootstrapDeviceAuthSession,
  DEVICE_AUTH_REFRESH_INTERVAL_MS,
  refreshLinkedDeviceSession,
} from './services/deviceAuthRuntime'
import { toast } from 'sonner'
import './App.css'
import './styles/fonts.css'
import { AppShell } from './components/layout/AppShell'
import { RemoteHostIdentityLabelWindow } from './components/remote/RemoteHostIdentityLabelWindow'
import { RemoteHostControlsWindow } from './components/remote/RemoteHostControlsWindow'
import { ThemeProvider } from './components/ThemeProvider'
import ErrorBoundary from './components/ErrorBoundary'
import {
  REMOTE_HOST_CONTROLS_WINDOW_PATH,
  REMOTE_HOST_IDENTITY_LABEL_WINDOW_PATH,
} from './services/remoteHostControlsWindow'
import { initRemoteHostControlsService } from './services/remoteHostControlsService'

function MainApp() {
  const setDeviceFingerprint = useDeviceAuthStore((state) => state.setDeviceFingerprint)
  const restoreLinkedSession = useDeviceAuthStore((state) => state.restoreLinkedSession)
  const markInvalid = useDeviceAuthStore((state) => state.markInvalid)
  const mode = useDeviceAuthStore((state) => state.mode)
  const sessionToken = useDeviceAuthStore((state) => state.sessionToken)

  // Initialize command system and cleanup on app startup
  useEffect(() => {
    let updateTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    logger.info('🚀 Frontend application starting up')
    initializeCommandSystem()
    logger.debug('Command system initialized')

    // Clean up old recovery files on startup
    cleanupOldFiles().catch(error => {
      logger.warn('Failed to cleanup old recovery files', { error })
    })

    // Example of logging with context
    logger.info('App environment', {
      isDev: import.meta.env.DEV,
      mode: import.meta.env.MODE,
    })

    const autoUpdateDisabledByBuildFlag =
      import.meta.env.VITE_DISABLE_AUTO_UPDATE === '1' ||
      import.meta.env.VITE_DISABLE_AUTO_UPDATE === 'true'

    const resolveAutoUpdatePolicy = async () => {
      let autoUpdateDisabledByRuntimeFlag = false

      if (!import.meta.env.DEV) {
        try {
          autoUpdateDisabledByRuntimeFlag = await invoke<boolean>(
            'is_auto_update_disabled'
          )
        } catch (error) {
          logger.warn('Failed to read runtime auto-update disable flag', {
            error: String(error),
          })
        }
      }

      const autoUpdateDisabled =
        autoUpdateDisabledByBuildFlag || autoUpdateDisabledByRuntimeFlag
      const shouldAutoCheckUpdates =
        !import.meta.env.DEV &&
        import.meta.env.MODE !== 'e2e' &&
        !autoUpdateDisabled

      if (disposed) return

      if (shouldAutoCheckUpdates) {
        // Delay slightly to avoid contention with first-render startup work.
        updateTimer = setTimeout(async () => {
          const { projectDirty } = useAppStore.getState()
          if (projectDirty) {
            logger.info('Skipping startup auto-update because project is dirty')
            return
          }

          let lastPhase: UpdaterProgressEvent['phase'] | null = null
          await runUpdaterFlow({
            source: 'startup',
            onProgress: (event) => {
              if (event.phase === lastPhase) return
              lastPhase = event.phase
              switch (event.phase) {
                case 'update_available':
                  toast.info(
                    event.version
                      ? `Update ${event.version} available`
                      : 'Update available'
                  )
                  break
                case 'downloading':
                  toast.info(
                    event.progressPercent !== null &&
                    event.progressPercent !== undefined
                      ? `Downloading update… ${event.progressPercent}%`
                      : 'Downloading update…'
                  )
                  break
                case 'installing':
                  toast.info('Installing update…')
                  break
                case 'closing_for_install':
                  toast.info('Launching installer. easyCris will close now.')
                  break
                case 'failed':
                  toast.error(
                    'Automatic update failed. Use Help > Update easyCris to retry.'
                  )
                  break
                default:
                  break
              }
            },
          })
        }, 5000)
      } else if (autoUpdateDisabled) {
        logger.info('Startup auto-update is disabled', {
          buildFlag: autoUpdateDisabledByBuildFlag,
          runtimeFlag: autoUpdateDisabledByRuntimeFlag,
        })
      }
    }

    void resolveAutoUpdatePolicy()

    return () => {
      disposed = true
      if (updateTimer) {
        clearTimeout(updateTimer)
      }
    }
  }, [])

  useEffect(() => {
    let disposed = false

    const bootstrap = async () => {
      try {
        const result = await bootstrapDeviceAuthSession()
        if (disposed) return

        setDeviceFingerprint(result.fingerprint)

        if (result.status === 'linked') {
          restoreLinkedSession(result.session)
          return
        }

        if (result.status === 'linked_stale') {
          restoreLinkedSession(result.session)
          toast.info('Unable to verify this desktop link right now. easyCris is keeping the existing link and will retry later.')
          return
        }

        if (result.status === 'invalid') {
          markInvalid(result.reason)
          toast.info('This desktop link is no longer valid. You can continue as guest or relink it from Preferences > Account.')
        }
      } catch (error) {
        logger.warn('Failed to bootstrap desktop device auth', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void bootstrap()

    return () => {
      disposed = true
    }
  }, [markInvalid, restoreLinkedSession, setDeviceFingerprint])

  useEffect(() => {
    if (mode !== 'linked' || !sessionToken) {
      return
    }

    let disposed = false

    const refresh = async () => {
      try {
        const result = await refreshLinkedDeviceSession(sessionToken)
        if (disposed) return

        if (result.status === 'linked') {
          restoreLinkedSession(result.session)
          return
        }

        markInvalid(result.reason)
        toast.info('This desktop link was revoked or expired. easyCris has switched back to guest mode.')
      } catch (error) {
        logger.warn('Failed to refresh desktop device session', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const timer = window.setInterval(() => {
      void refresh()
    }, DEVICE_AUTH_REFRESH_INTERVAL_MS)

    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [markInvalid, mode, restoreLinkedSession, sessionToken])

  useEffect(() => {
    // NOTE: For custom context menus (Radix), add data-allow-contextmenu="custom"
    // to the trigger or wrapper element so right-click isn't blocked globally.
    const shouldAllowNativeContextMenu = (target: HTMLElement | null): boolean => {
      if (!target) return false
      if (target.closest('[data-allow-contextmenu="custom"]')) return true
      if (target.closest('[data-allow-contextmenu="native"]')) return true
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return true
      return false
    }

    const handleContextMenu = (event: MouseEvent) => {
      if (shouldAllowNativeContextMenu(event.target as HTMLElement | null)) {
        return
      }
      event.preventDefault()
    }

    document.addEventListener('contextmenu', handleContextMenu, true)
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu, true)
    }
  }, [])

  useEffect(() => initRemoteHostControlsService(), [])

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AppShell />
      </ThemeProvider>
    </ErrorBoundary>
  )
}

function App() {
  if (window.location.pathname === REMOTE_HOST_CONTROLS_WINDOW_PATH) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <RemoteHostControlsWindow />
        </ThemeProvider>
      </ErrorBoundary>
    )
  }

  if (window.location.pathname === REMOTE_HOST_IDENTITY_LABEL_WINDOW_PATH) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <RemoteHostIdentityLabelWindow />
        </ThemeProvider>
      </ErrorBoundary>
    )
  }

  return <MainApp />
}

export default App
