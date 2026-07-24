import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRemoteAudioControls } from './useRemoteAudioControls'
import type { RemoteSessionAudioState } from '@/store/remote-session-store'

describe('useRemoteAudioControls', () => {
  let audioState: RemoteSessionAudioState
  let disableAudio: ReturnType<typeof vi.fn<() => Promise<void>>>
  let enableAudio: ReturnType<typeof vi.fn<() => Promise<void>>>
  let setAudioMuted: ReturnType<typeof vi.fn<(_: boolean) => Promise<void>>>
  let setAudioState: ReturnType<
    typeof vi.fn<(_: Partial<RemoteSessionAudioState>) => void>
  >
  let setMessage: ReturnType<typeof vi.fn<(_: string) => void>>

  beforeEach(() => {
    audioState = {
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    }
    disableAudio = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    enableAudio = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    setAudioMuted = vi
      .fn<(_: boolean) => Promise<void>>()
      .mockResolvedValue(undefined)
    setAudioState = vi.fn<(_: Partial<RemoteSessionAudioState>) => void>(
      patch => {
        audioState = { ...audioState, ...patch }
      }
    )
    setMessage = vi.fn<(_: string) => void>()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      () => undefined
    )
  })

  const renderAudioControls = () =>
    renderHook(() =>
      useRemoteAudioControls({
        audioState,
        disableAudio,
        enableAudio,
        setAudioMuted,
        setAudioState,
        setMessage,
      })
    )

  it('enables the microphone even when incoming playback priming fails', async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValue(new Error('autoplay blocked'))
    const { result } = renderAudioControls()
    result.current.remoteAudioRef.current = document.createElement('audio')

    await act(async () => {
      await result.current.handleEnableAudio()
    })

    expect(play).toHaveBeenCalled()
    expect(enableAudio).toHaveBeenCalled()
    expect(setMessage).toHaveBeenCalledWith(
      'Remote audio playback was blocked. Turn audio off and on to retry.'
    )
    expect(audioState).toMatchObject({
      connecting: false,
      localEnabled: true,
      remotePlaybackEnabled: false,
    })
  })

  it('does not mark incoming playback enabled when the audio element is not mounted', async () => {
    const { result } = renderAudioControls()

    await act(async () => {
      await result.current.handleEnableAudio()
    })

    expect(enableAudio).toHaveBeenCalled()
    expect(setMessage).not.toHaveBeenCalled()
    expect(audioState).toMatchObject({
      connecting: false,
      localEnabled: true,
      remotePlaybackEnabled: false,
    })
  })

  it('keeps the remote stream attached when ending audio inside a live session', async () => {
    audioState = {
      localEnabled: true,
      localMuted: false,
      remotePlaybackEnabled: true,
      connecting: false,
    }
    const { result } = renderAudioControls()
    result.current.remoteAudioRef.current = document.createElement('audio')
    const stream = {} as MediaStream
    result.current.remoteAudioRef.current.srcObject = stream

    await act(async () => {
      await result.current.handleStopAudio()
    })

    expect(disableAudio).toHaveBeenCalled()
    expect(result.current.remoteAudioRef.current.srcObject).toBe(stream)
    expect(audioState).toMatchObject({
      localEnabled: false,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    })
  })

  it('attaches a pending remote stream when the audio element mounts later', () => {
    const { result, rerender } = renderAudioControls()
    const stream = {} as MediaStream
    const audio = document.createElement('audio')
    audio.srcObject = null

    act(() => {
      result.current.attachRemoteAudioStream(stream)
    })
    expect(audio.srcObject).not.toBe(stream)

    result.current.remoteAudioRef.current = audio
    rerender()

    expect(audio.srcObject).toBe(stream)
  })

  it('does not replay an attached stream after a later render', () => {
    const { result, rerender } = renderAudioControls()
    const stream = {} as MediaStream
    const audio = document.createElement('audio')
    audio.srcObject = null

    result.current.remoteAudioRef.current = audio
    act(() => {
      result.current.attachRemoteAudioStream(stream)
    })
    expect(audio.srcObject).toBe(stream)

    audio.srcObject = null
    rerender()

    expect(audio.srcObject).toBeNull()
  })

  it('keeps pending remote streams when stopping local audio fails in a live session', async () => {
    audioState = {
      localEnabled: true,
      localMuted: false,
      remotePlaybackEnabled: true,
      connecting: false,
    }
    disableAudio.mockRejectedValueOnce(new Error('peer closed'))
    const { result, rerender } = renderAudioControls()
    const stream = {} as MediaStream
    const audio = document.createElement('audio')
    let thrown: unknown = null

    act(() => {
      result.current.attachRemoteAudioStream(stream)
    })
    await act(async () => {
      try {
        await result.current.handleStopAudio()
      } catch (error) {
        thrown = error
      }
    })
    result.current.remoteAudioRef.current = audio
    rerender()

    expect(thrown).toBeInstanceOf(Error)
    expect(audio.srcObject).toBe(stream)
    expect(audioState).toMatchObject({
      localEnabled: false,
      remotePlaybackEnabled: false,
      connecting: false,
    })
  })

  it('does not expose a separate incoming playback control', async () => {
    const { result } = renderAudioControls()

    expect('handleTogglePlayback' in result.current).toBe(false)
  })

  it('applies the speaker playback volume to the mounted remote audio element', () => {
    const { result } = renderAudioControls()
    const audio = document.createElement('audio')
    result.current.remoteAudioRef.current = audio

    act(() => {
      result.current.setRemotePlaybackVolume(0.42)
    })

    expect(result.current.remotePlaybackVolume).toBe(0.42)
    expect(audio.volume).toBe(0.42)
  })

  it('does not replay a pending remote stream after full stream teardown', () => {
    const { result, rerender } = renderAudioControls()
    const stream = {} as MediaStream
    const audio = document.createElement('audio')
    audio.srcObject = null

    act(() => {
      result.current.attachRemoteAudioStream(stream)
    })
    act(() => {
      result.current.clearRemoteAudioStream()
    })

    result.current.remoteAudioRef.current = audio
    rerender()

    expect(audio.srcObject).toBeNull()
  })

  it('unmutes the local microphone when enable succeeds after playback priming fails', async () => {
    audioState = {
      localEnabled: false,
      localMuted: true,
      remotePlaybackEnabled: false,
      connecting: false,
    }
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new Error('autoplay blocked')
    )
    const { result } = renderAudioControls()
    result.current.remoteAudioRef.current = document.createElement('audio')

    await act(async () => {
      await result.current.handleEnableAudio()
    })

    expect(audioState).toMatchObject({
      localEnabled: true,
      localMuted: false,
      remotePlaybackEnabled: false,
      connecting: false,
    })
  })

  it('preserves the previous mute state when microphone enabling fails', async () => {
    audioState = {
      localEnabled: false,
      localMuted: true,
      remotePlaybackEnabled: false,
      connecting: false,
    }
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    enableAudio.mockRejectedValueOnce(new DOMException('', 'NotAllowedError'))
    const { result } = renderAudioControls()
    result.current.remoteAudioRef.current = document.createElement('audio')

    await act(async () => {
      await result.current.handleEnableAudio()
    })

    expect(audioState.localMuted).toBe(true)
    expect(setMessage).toHaveBeenCalledWith(
      'Microphone permission was denied. Allow microphone access and try again.'
    )
  })

  it('pauses incoming playback when microphone enabling fails after priming succeeds', async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined)
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => undefined)
    enableAudio.mockRejectedValueOnce(new DOMException('', 'NotAllowedError'))
    const { result } = renderAudioControls()
    result.current.remoteAudioRef.current = document.createElement('audio')

    await act(async () => {
      await result.current.handleEnableAudio()
    })

    expect(play).toHaveBeenCalled()
    expect(pause).toHaveBeenCalled()
    expect(audioState).toMatchObject({
      connecting: false,
      localEnabled: false,
      remotePlaybackEnabled: false,
    })
  })
})
