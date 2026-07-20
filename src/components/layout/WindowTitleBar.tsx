/**
 * WindowTitleBar Component
 *
 * Custom Windows-style title bar with min/max/close controls.
 * Replaces macOS template title bar for Phase 3B.
 *
 * Features:
 * - Draggable region (data-tauri-drag-region)
 * - Windows-style window controls (right-aligned)
 * - Application title and icon
 * - Status indicators (Python health, etc.)
 */

import { useState, useEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Square, X, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'

interface WindowTitleBarProps {
  className?: string
}

export function WindowTitleBar({ className }: WindowTitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false)
  const { pythonStatus } = useAppStore()

  // Tauri window can be injected after dev hot-reload; resolve lazily.
  const appWindowRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null

    const setupListeners = async () => {
      const appWindow = appWindowRef.current
      if (!appWindow || cancelled) return

      const checkMaximized = async () => {
        if (cancelled) return
        const maximized = await appWindow.isMaximized()
        if (!cancelled) setIsMaximized(maximized)
      }

      await checkMaximized()
      const unlistenPromise = appWindow.onResized(() => {
        void checkMaximized()
      })
      const unlistenFn = await unlistenPromise
      unlisten = unlistenFn
    }

    const tryInit = async () => {
      if (appWindowRef.current) return true
      if (typeof window === 'undefined' || !('__TAURI__' in window)) return false
      appWindowRef.current = getCurrentWindow()
      await setupListeners()
      return true
    }

    let interval: number | null = null
    void (async () => {
      const ready = await tryInit()
      if (!ready && typeof window !== 'undefined') {
        interval = window.setInterval(() => {
          void tryInit().then((ok) => {
            if (ok && interval !== null) {
              clearInterval(interval)
              interval = null
            }
          })
        }, 200)
      }
    })()

    return () => {
      cancelled = true
      if (interval !== null) {
        clearInterval(interval)
      }
      if (unlisten) {
        unlisten()
      }
    }
  }, [])

  const handleMinimize = async () => {
    const appWindow = appWindowRef.current
    if (appWindow) await appWindow.minimize()
  }

  const handleMaximize = async () => {
    const appWindow = appWindowRef.current
    if (appWindow) await appWindow.toggleMaximize()
  }

  const handleClose = async () => {
    const appWindow = appWindowRef.current
    if (appWindow) await appWindow.close()
  }

  return (
    <div
      data-tauri-drag-region
      className={cn(
        'flex h-8 w-full items-center justify-between bg-background border-b border-border',
        'select-none', // Prevent text selection in drag region
        className
      )}
    >
      {/* Left: App Icon + Title */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 px-3 h-full"
      >
        {/* App Icon - Phase 3C: Using actual easyCris PNG icon */}
        <img
          src="/easycris.png"
          srcSet="/easycris.png 1x, /easycris.png 2x"
          alt="easyCris"
          className="w-4 h-4"
        />

        {/* App Title */}
        <span className="text-sm font-medium text-foreground">
          easyCris
        </span>

        {/* Python Status Indicator */}
        {pythonStatus && (
          <div className="flex items-center gap-1.5 ml-4">
            <Circle
              className={cn(
                'h-2 w-2 fill-current',
                pythonStatus.available
                  ? 'text-[#06A77D]'
                  : 'text-destructive'
              )}
            />
            <span className="text-xs text-muted-foreground">
              Python {pythonStatus.version || 'N/A'}
            </span>
          </div>
        )}
      </div>

      {/* Center: Additional Info (Future: Open File Path) */}
      <div data-tauri-drag-region className="flex-1 h-full" />

      {/* Right: Window Controls */}
      <div className="flex h-full">
        {/* Minimize Button */}
        <button
          onClick={handleMinimize}
          className={cn(
            'w-12 h-full flex items-center justify-center',
            'hover:bg-accent/50 transition-colors',
            'focus:outline-none focus:ring-1 focus:ring-ring'
          )}
          aria-label="Minimize"
        >
          <Minus className="h-4 w-4 text-foreground" />
        </button>

        {/* Maximize/Restore Button */}
        <button
          onClick={handleMaximize}
          className={cn(
            'w-12 h-full flex items-center justify-center',
            'hover:bg-accent/50 transition-colors',
            'focus:outline-none focus:ring-1 focus:ring-ring'
          )}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          <Square className="h-3.5 w-3.5 text-foreground" />
        </button>

        {/* Close Button */}
        <button
          onClick={handleClose}
          className={cn(
            'w-12 h-full flex items-center justify-center',
            'hover:bg-destructive hover:text-destructive-foreground transition-colors',
            'focus:outline-none focus:ring-1 focus:ring-ring'
          )}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

export default WindowTitleBar
