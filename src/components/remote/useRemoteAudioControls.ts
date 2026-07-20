import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  REMOTE_AUDIO_PLAYBACK_BLOCKED_MESSAGE,
  remoteAudioErrorMessage,
} from '@/services/remoteAudioMedia'
import type { RemoteSessionAudioState } from '@/store/remote-session-store'

interface RemoteAudioControlsOptions {
  audioState: RemoteSessionAudioState
  disableAudio: () => Promise<void>
  enableAudio: () => Promise<void>
  setAudioMuted: (muted: boolean) => Promise<void> | void
  setAudioState: (patch: Partial<RemoteSessionAudioState>) => void
  setAutoplayMessage?: (message: string) => void
  setMessage: (message: string) => void
}

export function useRemoteAudioControls({
  audioState,
  disableAudio,
  enableAudio,
  setAudioMuted,
  setAudioState,
  setAutoplayMessage,
  setMessage,
}: RemoteAudioControlsOptions) {
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const playbackEnabledRef = useRef(false)
  const pendingRemoteAudioStreamRef = useRef<MediaStream | null>(null)
  const [remotePlaybackVolume, setRemotePlaybackVolumeState] = useState(1)
  const remotePlaybackVolumeRef = useRef(1)

  useEffect(() => {
    playbackEnabledRef.current = audioState.remotePlaybackEnabled
  }, [audioState.remotePlaybackEnabled])

  const setRemotePlaybackVolume = useCallback((volume: number) => {
    const nextVolume = Math.min(1, Math.max(0, volume))
    remotePlaybackVolumeRef.current = nextVolume
    setRemotePlaybackVolumeState(nextVolume)
    if (remoteAudioRef.current) {
      remoteAudioRef.current.volume = nextVolume
    }
  }, [])

  const attachRemoteAudioStream = useCallback((stream: MediaStream) => {
    pendingRemoteAudioStreamRef.current = stream
    const audio = remoteAudioRef.current
    if (!audio) return
    const shouldPlay = audio.srcObject !== stream && playbackEnabledRef.current
    audio.srcObject = stream
    audio.volume = remotePlaybackVolumeRef.current
    pendingRemoteAudioStreamRef.current = null
    if (shouldPlay) {
      void audio.play().catch(() => undefined)
    }
  }, [])

  const clearRemoteAudioStream = useCallback(() => {
    pendingRemoteAudioStreamRef.current = null
    playbackEnabledRef.current = false
    const audio = remoteAudioRef.current
    if (audio) {
      audio.pause()
      audio.srcObject = null
    }
  }, [])

  const pauseRemoteAudioPlayback = useCallback(() => {
    playbackEnabledRef.current = false
    remoteAudioRef.current?.pause()
  }, [])

  useEffect(() => {
    const stream = pendingRemoteAudioStreamRef.current
    if (stream && remoteAudioRef.current) {
      attachRemoteAudioStream(stream)
    }
    // Deliberately runs after every render: ref.current changes do not
    // trigger effects, so this drains streams that arrived before <audio>
    // mounted on the first later render. Empty checks are O(1).
  })

  const playRemoteAudio = useCallback(async () => {
    const audio = remoteAudioRef.current
    if (!audio) return false
    await audio.play()
    playbackEnabledRef.current = true
    setAudioState({ remotePlaybackEnabled: true })
    return true
  }, [setAudioState])

  const primeRemoteAudio = useCallback(async () => {
    try {
      const played = await playRemoteAudio()
      if (played) return true
    } catch {
      ;(setAutoplayMessage ?? setMessage)(REMOTE_AUDIO_PLAYBACK_BLOCKED_MESSAGE)
    }
    playbackEnabledRef.current = false
    setAudioState({ remotePlaybackEnabled: false })
    return false
  }, [playRemoteAudio, setAudioState, setAutoplayMessage, setMessage])

  const handleEnableAudio = useCallback(async () => {
    setAudioState({ connecting: true })
    try {
      await primeRemoteAudio()
      await enableAudio()
      setAudioState({
        localEnabled: true,
        localMuted: false,
        connecting: false,
      })
    } catch (error) {
      const message = remoteAudioErrorMessage(error, 'microphone')
      pauseRemoteAudioPlayback()
      setAudioState({
        localEnabled: false,
        remotePlaybackEnabled: false,
        connecting: false,
      })
      setMessage(message)
      toast.error(message)
    }
  }, [
    enableAudio,
    pauseRemoteAudioPlayback,
    primeRemoteAudio,
    setAudioState,
    setMessage,
  ])

  const handleToggleAudioMute = useCallback(async () => {
    const muted = !audioState.localMuted
    await setAudioMuted(muted)
    setAudioState({ localMuted: muted })
  }, [audioState.localMuted, setAudioMuted, setAudioState])

  const handleStopAudio = useCallback(async () => {
    try {
      await disableAudio()
    } finally {
      pauseRemoteAudioPlayback()
      setAudioState({
        localEnabled: false,
        localMuted: false,
        remotePlaybackEnabled: false,
        connecting: false,
      })
    }
  }, [disableAudio, pauseRemoteAudioPlayback, setAudioState])

  const audioLabel = audioState.connecting
    ? 'Connecting audio'
    : audioState.localEnabled
      ? audioState.localMuted
        ? 'Muted'
        : 'Audio on'
      : 'Audio off'

  return {
    attachRemoteAudioStream,
    audioLabel,
    clearRemoteAudioStream,
    handleEnableAudio,
    handleStopAudio,
    handleToggleAudioMute,
    remoteAudioRef,
    remotePlaybackVolume,
    setRemotePlaybackVolume,
  }
}
