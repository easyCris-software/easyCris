import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
// import { ReactQueryDevtools } from '@tanstack/react-query-devtools' // COMMENTED: Not needed in production
import App from './App'
import { queryClient } from './lib/query-client'
import { startFPSMonitor, stopFPSMonitor, isFPSMonitoring } from './utils/fpsMonitor'
import {
  isRemoteAudioMonitoring,
  startRemoteAudioMonitor,
  stopRemoteAudioMonitor,
} from './utils/remoteAudioMonitor'
import { initializeRemoteProtocolActivation } from './services/remoteProtocolActivation'

// Load E2E shim only in explicit E2E mode (never in normal production builds).
if (import.meta.env.MODE === 'e2e') {
  void import('./utils/e2e-shim')
}

initializeRemoteProtocolActivation()

// Plotly/has-hover expect a Node-like global; map it to browser globalThis.
if (typeof globalThis !== 'undefined' && !(globalThis as typeof globalThis & { global?: typeof globalThis }).global) {
  ;(globalThis as typeof globalThis & { global?: typeof globalThis }).global = globalThis
}

// Development utilities - expose FPS monitor to console
if (import.meta.env.DEV) {
  type DevToolsWindow = typeof window & {
    startFPS?: () => void
    stopFPS?: () => void
    isFPSMonitoring?: () => boolean
    startRemoteAudioMonitor?: () => void
    stopRemoteAudioMonitor?: () => void
    isRemoteAudioMonitoring?: () => boolean
    enableAppDebug?: () => void
    enableGridDebug?: () => void
    enablePasteDebug?: () => void
    enableRemoteInputDebug?: () => void
    enableEasyCrisDebug?: () => void
    disableAppDebug?: () => void
    disableGridDebug?: () => void
    disablePasteDebug?: () => void
    disableRemoteInputDebug?: () => void
    disableEasyCrisDebug?: () => void
    pasteEnable?: () => void
    pasteDisable?: () => void
  }

  const devWindow = window as DevToolsWindow
  devWindow.startFPS = startFPSMonitor
  devWindow.stopFPS = stopFPSMonitor
  devWindow.isFPSMonitoring = isFPSMonitoring
  devWindow.startRemoteAudioMonitor = startRemoteAudioMonitor
  devWindow.stopRemoteAudioMonitor = stopRemoteAudioMonitor
  devWindow.isRemoteAudioMonitoring = isRemoteAudioMonitoring
  devWindow.enableAppDebug = () => {
    window.__EASYCRIS_APP_DEBUG__ = true
    window.localStorage.setItem('easycris:app-debug', '1')
    console.log('[Dev Tools] App debug enabled.')
  }
  devWindow.enableGridDebug = () => {
    window.__EASYCRIS_GRID_DEBUG__ = true
    window.localStorage.setItem('easycris:grid-debug', '1')
    console.log('[Dev Tools] Grid debug enabled.')
  }
  devWindow.enablePasteDebug = () => {
    window.__EASYCRIS_PASTE_DEBUG__ = true
    window.localStorage.setItem('easycris:paste-debug', '1')
    console.log(
      '[Dev Tools] Paste debug enabled. Reproduce the large paste issue and filter logs by [DEBUG:PASTE]. Disable with window.disablePasteDebug() or window.pasteDisable().'
    )
  }
  devWindow.pasteEnable = devWindow.enablePasteDebug
  devWindow.enableRemoteInputDebug = () => {
    window.__EASYCRIS_REMOTE_INPUT_DEBUG__ = true
    window.localStorage.setItem('easycris:remote-input-debug', '1')
    console.log(
      '[Dev Tools] Remote input debug enabled. Reproduce the double-click issue and filter logs by [DEBUG:REMOTE-INPUT].'
    )
  }
  devWindow.enableEasyCrisDebug = () => {
    window.__EASYCRIS_DEBUG__ = true
    window.__EASYCRIS_APP_DEBUG__ = true
    window.__EASYCRIS_GRID_DEBUG__ = true
    window.__EASYCRIS_PASTE_DEBUG__ = true
    window.__EASYCRIS_REMOTE_INPUT_DEBUG__ = true
    window.localStorage.setItem('easycris:debug', '1')
    window.localStorage.setItem('easycris:app-debug', '1')
    window.localStorage.setItem('easycris:grid-debug', '1')
    window.localStorage.setItem('easycris:paste-debug', '1')
    window.localStorage.setItem('easycris:remote-input-debug', '1')
    console.log('[Dev Tools] easyCris app + grid + paste + remote input debug enabled.')
  }
  devWindow.disableAppDebug = () => {
    window.__EASYCRIS_APP_DEBUG__ = false
    window.localStorage.removeItem('easycris:app-debug')
    console.log('[Dev Tools] App debug disabled.')
  }
  devWindow.disableGridDebug = () => {
    window.__EASYCRIS_GRID_DEBUG__ = false
    window.localStorage.removeItem('easycris:grid-debug')
    console.log('[Dev Tools] Grid debug disabled.')
  }
  devWindow.disablePasteDebug = () => {
    window.__EASYCRIS_PASTE_DEBUG__ = false
    window.localStorage.removeItem('easycris:paste-debug')
    console.log('[Dev Tools] Paste debug disabled.')
  }
  devWindow.pasteDisable = devWindow.disablePasteDebug
  devWindow.disableRemoteInputDebug = () => {
    window.__EASYCRIS_REMOTE_INPUT_DEBUG__ = false
    window.localStorage.removeItem('easycris:remote-input-debug')
    console.log('[Dev Tools] Remote input debug disabled.')
  }
  devWindow.disableEasyCrisDebug = () => {
    window.__EASYCRIS_DEBUG__ = false
    window.__EASYCRIS_APP_DEBUG__ = false
    window.__EASYCRIS_GRID_DEBUG__ = false
    window.__EASYCRIS_PASTE_DEBUG__ = false
    window.__EASYCRIS_REMOTE_INPUT_DEBUG__ = false
    window.localStorage.removeItem('easycris:debug')
    window.localStorage.removeItem('easycris:app-debug')
    window.localStorage.removeItem('easycris:grid-debug')
    window.localStorage.removeItem('easycris:paste-debug')
    window.localStorage.removeItem('easycris:remote-input-debug')
    console.log('[Dev Tools] easyCris app + grid + paste + remote input debug disabled.')
  }

  console.log(
    '%c[Dev Tools] FPS monitor available. Use window.startFPS() and window.stopFPS()',
    'color: #8b5cf6; font-weight: bold;'
  )
  console.log(
    '%c[Dev Tools] Remote audio monitor available. Use window.startRemoteAudioMonitor() and window.stopRemoteAudioMonitor()',
    'color: #0ea5e9; font-weight: bold;'
  )
  console.log(
    '%c[Dev Tools] easyCris debug available. Use window.enableEasyCrisDebug() / window.disableEasyCrisDebug(), window.enableAppDebug() / window.disableAppDebug(), and window.enableGridDebug() / window.disableGridDebug()',
    'color: #0ea5e9; font-weight: bold;'
  )
  console.log(
    '%c[Dev Tools] Large paste/cold-row logs available. Use window.enablePasteDebug() and window.disablePasteDebug(); aliases: window.pasteEnable() and window.pasteDisable(). Filter by [DEBUG:PASTE].',
    'color: #f59e0b; font-weight: bold;'
  )
  console.log(
    '%c[Dev Tools] Remote input double-click logs available. Use window.enableRemoteInputDebug() and window.disableRemoteInputDebug()',
    'color: #2563eb; font-weight: bold;'
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <App />
    {/* <ReactQueryDevtools initialIsOpen={false} /> */}
  </QueryClientProvider>
)
