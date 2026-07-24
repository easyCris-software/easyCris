import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface RemoteJoinUrlStoreState {
  dialogOpen: boolean
  pendingUrl: string | null
  setPendingUrl: (url: string) => void
  hideDialog: () => void
  clearPendingUrl: (url: string) => void
}

export const useRemoteJoinUrlStore = create<RemoteJoinUrlStoreState>()(
  devtools(
    (set, get) => ({
      dialogOpen: false,
      pendingUrl: null,
      setPendingUrl: url =>
        set(
          { dialogOpen: true, pendingUrl: url },
          undefined,
          'remoteJoinUrl/setPendingUrl'
        ),
      hideDialog: () =>
        set({ dialogOpen: false }, undefined, 'remoteJoinUrl/hideDialog'),
      clearPendingUrl: url => {
        if (get().pendingUrl !== url) return
        set(
          { dialogOpen: false, pendingUrl: null },
          undefined,
          'remoteJoinUrl/clearPendingUrl'
        )
      },
    }),
    { name: 'remote-join-url-store' }
  )
)
