/**
 * FPS Monitor - Development utility for monitoring frame rate
 *
 * Usage:
 *   import { startFPSMonitor, stopFPSMonitor } from '@/utils/fpsMonitor'
 *
 *   // Start monitoring
 *   startFPSMonitor()
 *
 *   // Stop monitoring
 *   stopFPSMonitor()
 */

let isMonitoring = false
let frameCount = 0
let lastTime = performance.now()
let rafId: number | null = null

const measureFPS = () => {
  if (!isMonitoring) return

  frameCount++
  const now = performance.now()
  const elapsed = now - lastTime

  // Log FPS every second
  if (elapsed >= 1000) {
    const fps = Math.round((frameCount * 1000) / elapsed)

    // Color-coded output based on FPS
    const color = fps >= 55 ? '#4ade80' : fps >= 30 ? '#facc15' : '#f87171'

    console.log(
      `%c[FPS Monitor] ${fps} FPS`,
      `color: ${color}; font-weight: bold; font-size: 12px;`
    )

    frameCount = 0
    lastTime = now
  }

  rafId = requestAnimationFrame(measureFPS)
}

/**
 * Start FPS monitoring (logs to console every second)
 */
export const startFPSMonitor = () => {
  if (isMonitoring) {
    console.warn('[FPS Monitor] Already monitoring')
    return
  }

  console.log('%c[FPS Monitor] Started', 'color: #3b82f6; font-weight: bold;')
  isMonitoring = true
  frameCount = 0
  lastTime = performance.now()
  rafId = requestAnimationFrame(measureFPS)
}

/**
 * Stop FPS monitoring
 */
export const stopFPSMonitor = () => {
  if (!isMonitoring) {
    console.warn('[FPS Monitor] Not monitoring')
    return
  }

  console.log('%c[FPS Monitor] Stopped', 'color: #3b82f6; font-weight: bold;')
  isMonitoring = false

  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

/**
 * Check if FPS monitoring is active
 */
export const isFPSMonitoring = () => isMonitoring
