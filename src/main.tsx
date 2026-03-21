import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
// import { ReactQueryDevtools } from '@tanstack/react-query-devtools' // COMMENTED: Not needed in production
import App from './App'
import { queryClient } from './lib/query-client'
import { startFPSMonitor, stopFPSMonitor, isFPSMonitoring } from './utils/fpsMonitor'

// Load E2E shim only in explicit E2E mode (never in normal production builds).
if (import.meta.env.MODE === 'e2e') {
  void import('./utils/e2e-shim')
}

// Plotly/has-hover expect a Node-like global; map it to browser globalThis.
if (typeof globalThis !== 'undefined' && !(globalThis as typeof globalThis & { global?: typeof globalThis }).global) {
  ;(globalThis as typeof globalThis & { global?: typeof globalThis }).global = globalThis
}

// Development utilities - expose FPS monitor to console
if (import.meta.env.DEV) {
  ;(window as typeof window & {
    startFPS?: () => void
    stopFPS?: () => void
    isFPSMonitoring?: () => boolean
  }).startFPS = startFPSMonitor
  ;(window as typeof window & {
    startFPS?: () => void
    stopFPS?: () => void
    isFPSMonitoring?: () => boolean
  }).stopFPS = stopFPSMonitor
  ;(window as typeof window & {
    startFPS?: () => void
    stopFPS?: () => void
    isFPSMonitoring?: () => boolean
  }).isFPSMonitoring = isFPSMonitoring

  console.log(
    '%c[Dev Tools] FPS monitor available. Use window.startFPS() and window.stopFPS()',
    'color: #8b5cf6; font-weight: bold;'
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <App />
    {/* <ReactQueryDevtools initialIsOpen={false} /> */}
  </QueryClientProvider>
)
