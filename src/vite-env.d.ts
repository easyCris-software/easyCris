/// <reference types="vite/client" />

declare global {
  interface Window {
    __EASYCRIS_DEBUG__?: boolean
    __EASYCRIS_GRID_DEBUG__?: boolean
    __EASYCRIS_APP_DEBUG__?: boolean
    __EASYCRIS_PASTE_DEBUG__?: boolean
    __EASYCRIS_REMOTE_INPUT_DEBUG__?: boolean
  }
}

export {}
