import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useRemoteJoinUrlStore } from '@/store/remote-join-url-store'

let initialized = false
const PENDING_REMOTE_JOIN_RETRY_MS = 250
const PENDING_REMOTE_JOIN_MAX_ATTEMPTS = 20

const applyRemoteJoinUrl = (url: string | null | undefined) => {
  if (url) {
    useRemoteJoinUrlStore.getState().setPendingUrl(url)
  }
}

const readPendingRemoteJoinUrl = (attempt = 1, warned = false) => {
  void invoke<string | null>('take_pending_remote_join_url')
    .then(url => url ?? invoke<string | null>('current_remote_join_url'))
    .then(url => {
      if (url) {
        applyRemoteJoinUrl(url)
      }
    })
    .catch(error => {
      if (attempt < PENDING_REMOTE_JOIN_MAX_ATTEMPTS) {
        if (!warned) {
          console.warn('Remote invite link was not ready yet; retrying:', error)
        }
        window.setTimeout(
          () => readPendingRemoteJoinUrl(attempt + 1, true),
          PENDING_REMOTE_JOIN_RETRY_MS
        )
        return
      }
      console.error('Failed to read pending remote invite link:', error)
    })
}

export function initializeRemoteProtocolActivation() {
  if (initialized || typeof window === 'undefined') return
  initialized = true

  window.addEventListener('easycris-remote-join-link', event => {
    applyRemoteJoinUrl((event as CustomEvent<string>).detail)
  })

  readPendingRemoteJoinUrl()

  void listen<string>('remote-join-link', event => {
    applyRemoteJoinUrl(event.payload)
  }).catch(error => {
    console.error('Failed to listen for remote invite links:', error)
  })
}
