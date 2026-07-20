import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirm } from '@tauri-apps/plugin-dialog'
import { useUIStore } from '@/store/ui-store'
import { useAppStore } from '@/store/app-store'
import { useCommandContext } from './use-command-context'
import { logger } from '@/lib/logger'
import { runUpdaterFlow, type UpdaterProgressEvent } from '@/lib/updater'

let closePromptInProgress = false

/**
 * Main window event listeners - handles global keyboard shortcuts and other app-level events
 *
 * This hook provides a centralized place for all global event listeners, keeping
 * the MainWindow component clean while maintaining good separation of concerns.
 */
type MainWindowEventListenerOptions = {
  disabled?: boolean
}

export function useMainWindowEventListeners(options: MainWindowEventListenerOptions = {}) {
  const { disabled = false } = options
  const { openPreferences, showToast } = useCommandContext()

  useEffect(() => {
    if (disabled) {
      return
    }

    let disposed = false
    let menuUnlisteners: (() => void)[] = []

    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for keyboard shortcuts
      if (e.metaKey || e.ctrlKey) {
        switch (e.key) {
          case 's':
          case 'S': {
            // Smart Save (Part 1 - SAVE_AND_PASTE_FIX_PLAN)
            e.preventDefault()
            if (e.shiftKey) {
              useAppStore.getState().saveProjectAs()
            } else {
              useAppStore.getState().saveProject()
            }
            break
          }
          case 'o':
          case 'O': {
            e.preventDefault()
            useAppStore.getState().openProject()
            break
          }
          case ',': {
            e.preventDefault()
            openPreferences()
            break
          }
          case '1': {
            e.preventDefault()
            const { leftSidebarVisible, setLeftSidebarVisible } =
              useUIStore.getState()
            setLeftSidebarVisible(!leftSidebarVisible)
            break
          }
          case '2': {
            e.preventDefault()
            const { rightSidebarVisible, setRightSidebarVisible } =
              useUIStore.getState()
            setRightSidebarVisible(!rightSidebarVisible)
            break
          }
        }
      }
    }

    // Set up native menu event listeners
    const setupMenuListeners = async () => {
      logger.debug('Setting up menu event listeners')

      const ensureUpdateInstallPreflight = async (): Promise<boolean> => {
        const { projectDirty, saveProject } = useAppStore.getState()
        if (!projectDirty) return true

        const confirmContinueWithoutSaving = async () => {
          return await confirm(
            'Install update without saving?\n\nThe app may close during installer handoff.',
            { title: 'Install Without Saving', kind: 'warning' }
          )
        }

        const shouldSave = await confirm(
          'You have unsaved changes. Save before installing this update?',
          { title: 'Unsaved Changes', kind: 'warning' }
        )

        if (shouldSave) {
          const saveHandler = useAppStore.getState().saveProjectHandler
          if (!saveHandler) {
            const continueWithoutSaving = await confirm(
              'Save is currently unavailable for this project.\n\nInstall update without saving?',
              { title: 'Save Unavailable', kind: 'warning' }
            )
            if (!continueWithoutSaving) {
              showToast('Update canceled because save is unavailable.', 'info')
              return false
            }
            return true
          }

          await saveProject()
          if (useAppStore.getState().projectDirty) {
            showToast(
              'Update canceled because save did not complete.',
              'info'
            )
            return false
          }
          return true
        }

        const continueWithoutSaving = await confirmContinueWithoutSaving()
        return continueWithoutSaving
      }

      const handleMenuUpdaterProgress = (() => {
        let lastPhase: UpdaterProgressEvent['phase'] | null = null
        return (event: UpdaterProgressEvent) => {
          if (event.phase === lastPhase) return
          lastPhase = event.phase
          switch (event.phase) {
            case 'checking':
              showToast('Checking for updates…', 'info')
              break
            case 'downloading':
              showToast(
                event.progressPercent !== null && event.progressPercent !== undefined
                  ? `Downloading update… ${event.progressPercent}%`
                  : 'Downloading update…',
                'info'
              )
              break
            case 'installing':
              showToast('Installing update…', 'info')
              break
            case 'closing_for_install':
              showToast(
                'Launching installer. easyCris will close now.',
                'info'
              )
              break
            default:
              break
          }
        }
      })()

      const unlisteners = await Promise.all([
        listen('menu-about', () => {
          logger.debug('About menu event received')
          // Show simple about dialog
          const appVersion = '0.1.0' // Could be dynamic from package.json
          alert(
            `Tauri Template App\n\nVersion: ${appVersion}\n\nBuilt with Tauri v2 + React + TypeScript`
          )
        }),

        listen('menu-check-updates', async () => {
          logger.debug('Check for updates menu event received')

          const status = await runUpdaterFlow({
            source: 'menu',
            onProgress: handleMenuUpdaterProgress,
            beforeInstall: ensureUpdateInstallPreflight,
          })

          switch (status) {
            case 'no-update':
              showToast('No updates available. You are on the latest version.', 'info')
              break
            case 'installed':
              if (/windows/i.test(navigator.userAgent)) {
                showToast(
                  'Update handoff complete. Installer will continue update.',
                  'success'
                )
              } else {
                showToast(
                  'Update installed. Restart when prompted to finish.',
                  'success'
                )
              }
              break
            case 'skipped':
              showToast('Update installation skipped', 'info')
              break
            case 'busy':
              showToast(
                'Update check already in progress',
                'info'
              )
              break
            case 'failed':
              showToast(
                'Unable to check for updates right now. Please try again.',
                'error'
              )
              break
          }
        }),

        listen('menu-preferences', () => {
          logger.debug('Preferences menu event received')
          openPreferences()
        }),

        listen('menu-toggle-left-sidebar', () => {
          logger.debug('Toggle left sidebar menu event received')
          const { leftSidebarVisible, setLeftSidebarVisible } =
            useUIStore.getState()
          setLeftSidebarVisible(!leftSidebarVisible)
        }),

        listen('menu-toggle-right-sidebar', () => {
          logger.debug('Toggle right sidebar menu event received')
          const { rightSidebarVisible, setRightSidebarVisible } =
            useUIStore.getState()
          setRightSidebarVisible(!rightSidebarVisible)
        }),

        // Part 3: Close confirmation when there are unsaved changes
        listen('app-before-close', async () => {
          if (closePromptInProgress) {
            return
          }

          closePromptInProgress = true
          logger.debug('app-before-close event received')
          const { projectDirty, saveProject } = useAppStore.getState()
          const appWindow = getCurrentWindow()

          const forceClose = async () => {
            try {
              // Allow the next CloseRequested event to proceed (prevents close loop).
              await invoke('allow_app_close')
            } catch (error) {
              logger.error('Failed to allow app close:', { error: String(error) })
              // If this fails, we intentionally do NOT close (window remains open).
              return
            }
            await appWindow.close()
          }

          try {
            if (!projectDirty) {
              // No unsaved changes - just close
              await forceClose()
              return
            }

            // Unsaved changes - ask user what to do
            const shouldSave = await confirm(
              'You have unsaved changes. Save before exiting?',
              { title: 'Unsaved Changes', kind: 'warning' }
            )

            if (shouldSave) {
              // User chose to save
              await saveProject()
              // Check if save succeeded (dirty flag cleared means save was successful)
              if (useAppStore.getState().projectDirty) {
                // Save was cancelled or failed - don't close
                logger.debug('Save cancelled or failed, not closing')
                return
              }
              await forceClose()
            } else {
              // User chose not to save - ask for confirmation to discard
              const discardChanges = await confirm(
                'Discard unsaved changes and exit?',
                { title: 'Discard Changes', kind: 'warning' }
              )
              if (discardChanges) {
                await forceClose()
              }
              // If user cancels discard, don't close (stay in app)
            }
          } finally {
            closePromptInProgress = false
          }
        }),
      ])

      logger.debug(
        `Menu listeners set up successfully: ${unlisteners.length} listeners`
      )
      return unlisteners
    }

    document.addEventListener('keydown', handleKeyDown)

    setupMenuListeners()
      .then(unlisteners => {
        if (disposed) {
          unlisteners.forEach(u => {
            try {
              u()
            } catch {
              // ignore
            }
          })
          return
        }

        menuUnlisteners = unlisteners
        logger.debug('Menu listeners initialized successfully')
      })
      .catch(error => {
        logger.error('Failed to setup menu listeners:', error)
      })

    return () => {
      disposed = true
      document.removeEventListener('keydown', handleKeyDown)
      menuUnlisteners.forEach(unlisten => {
        if (unlisten && typeof unlisten === 'function') {
          unlisten()
        }
      })
    }
  }, [disabled, openPreferences, showToast])

  // Future: Other global event listeners can be added here
  // useWindowFocusListeners()
}
