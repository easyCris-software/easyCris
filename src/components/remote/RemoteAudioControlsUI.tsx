import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Mic, MicOff, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import type { RemoteAudioInputDevice } from '@/services/remoteAudioMedia'
import type { RemoteSessionAudioState } from '@/store/remote-session-store'

interface RemoteAudioControlsUIProps {
  audioInputDevices: RemoteAudioInputDevice[]
  audioLabel: string
  audioState: RemoteSessionAudioState
  microphoneLabel: string
  micLevel?: number
  onDeviceChange: (deviceId: string) => void
  onEnable: () => void
  onMute: () => void
  onOptionsOpenChange?: (open: boolean) => void
  onPlaybackVolumeChange: (volume: number) => void
  onStop: () => void
  optionsOpen?: boolean
  playbackVolume: number
  selectedDeviceId: string
  testIdPrefix: 'remote-guest' | 'remote-host'
}

// Single compact size for host and guest so the two floating bars stay
// visually identical. Height and the "Audio" label are intentionally NOT
// coupled — both surfaces show the label.
const SIZE_CLASS = 'h-9'

/**
 * Zoom-style audio control: a single split button, identical for host and guest.
 * - The primary segment toggles mic mute/unmute (the icon reflects live vs muted
 *   state); when audio is off entirely it collapses to one "Turn on audio" button.
 * - The caret segment opens a contained command panel with less-frequent actions.
 *   It deliberately avoids a portal dropdown because the host controls live inside
 *   a small native WebViewWindow and anything outside that window gets clipped.
 */
export function RemoteAudioControlsUI({
  audioInputDevices,
  audioLabel,
  audioState,
  microphoneLabel,
  micLevel = 0,
  onDeviceChange,
  onEnable,
  onMute,
  onOptionsOpenChange,
  onPlaybackVolumeChange,
  onStop,
  optionsOpen,
  playbackVolume,
  selectedDeviceId,
  testIdPrefix,
}: RemoteAudioControlsUIProps) {
  const [uncontrolledOptionsOpen, setUncontrolledOptionsOpen] = useState(false)
  const audioOptionsOpen = optionsOpen ?? uncontrolledOptionsOpen
  const rootRef = useRef<HTMLDivElement | null>(null)
  const displayMicLevel = audioState.localMuted
    ? 0
    : Math.min(1, Math.max(0, micLevel))
  const volumeValue = Math.round(Math.min(1, Math.max(0, playbackVolume)) * 100)
  const setAudioOptionsOpen = useCallback(
    (open: boolean) => {
      if (optionsOpen === undefined) {
        setUncontrolledOptionsOpen(open)
      }
      onOptionsOpenChange?.(open)
    },
    [onOptionsOpenChange, optionsOpen]
  )

  useEffect(() => {
    if (!audioOptionsOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAudioOptionsOpen(false)
      }
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null
      if (target && rootRef.current?.contains(target)) return
      setAudioOptionsOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [audioOptionsOpen, setAudioOptionsOpen])

  if (!audioState.localEnabled) {
    // The button's job is "turn on audio"; only surface the status label while
    // connecting (so screen readers don't announce a stale "Audio off").
    const enableLabel =
      audioState.connecting && audioLabel ? audioLabel : 'Turn on audio'
    return (
      <Button
        type="button"
        size="sm"
        className={cn(SIZE_CLASS, 'shrink-0')}
        onClick={onEnable}
        disabled={audioState.connecting}
        aria-label={enableLabel}
        title={enableLabel}
        data-testid={`${testIdPrefix}-audio-enable`}
      >
        <Mic className="h-4 w-4" />
        <span>Audio</span>
      </Button>
    )
  }

  const muteActionLabel = audioState.localMuted ? 'Unmute mic' : 'Mute mic'
  const optionsPanelId = `${testIdPrefix}-audio-options`
  const microphoneLabelId = `${testIdPrefix}-audio-microphone-label`

  return (
    <div className="relative flex shrink-0 items-center" ref={rootRef}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={cn(
          SIZE_CLASS,
          'shrink-0 rounded-r-none px-3',
          displayMicLevel > 0.08 && !audioState.localMuted && 'text-primary'
        )}
        onClick={onMute}
        aria-label={muteActionLabel}
        title={muteActionLabel}
        data-testid={`${testIdPrefix}-audio-mute`}
      >
        {audioState.localMuted ? (
          <MicOff className="h-4 w-4" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
        <span>Audio</span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={cn(SIZE_CLASS, 'shrink-0 rounded-l-none border-l-0 px-2')}
        aria-controls={audioOptionsOpen ? optionsPanelId : undefined}
        aria-expanded={audioOptionsOpen}
        aria-label="More audio controls"
        title="More audio controls"
        data-testid={`${testIdPrefix}-audio-more`}
        onClick={() => setAudioOptionsOpen(!audioOptionsOpen)}
      >
        {/* A right-caret that rotates down when the panel opens below it, so the
            glyph always points at where the panel is / will be. */}
        <ChevronRight
          className={cn(
            'h-4 w-4 transition-transform',
            audioOptionsOpen && 'rotate-90'
          )}
        />
      </Button>
      {audioOptionsOpen ? (
        <div
          id={optionsPanelId}
          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 max-h-[18rem] w-80 overflow-y-auto rounded-md border bg-popover p-2 text-popover-foreground shadow-lg"
          data-testid={optionsPanelId}
          role="region"
          aria-label="Audio options"
          // Prevent panel gestures from bubbling into RemoteControlsPanel's
          // drag surface; the outside-dismiss listener already ignores this.
          onPointerDown={event => event.stopPropagation()}
        >
          <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Audio
          </div>
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-sm px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              onStop()
              setAudioOptionsOpen(false)
            }}
            data-testid={`${testIdPrefix}-audio-stop`}
          >
            Turn off audio
          </button>
          <div className="mt-1 flex items-center gap-3 rounded-sm px-2 py-2">
            <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-xs text-muted-foreground">
                Speaker volume
              </div>
              <Slider
                aria-label="Speaker volume"
                data-testid={`${testIdPrefix}-speaker-volume`}
                max={100}
                min={0}
                step={5}
                value={[volumeValue]}
                onValueChange={value =>
                  onPlaybackVolumeChange((value[0] ?? volumeValue) / 100)
                }
              />
            </div>
          </div>
          {audioInputDevices.length > 0 ? (
            <div
              className="mt-2 border-t pt-2"
              role="group"
              aria-labelledby={microphoneLabelId}
            >
              <div
                id={microphoneLabelId}
                className="px-2 pb-1 text-xs font-medium text-muted-foreground"
              >
                {microphoneLabel}
              </div>
              <button
                type="button"
                aria-pressed={selectedDeviceId === ''}
                className="flex w-full items-center justify-between rounded-sm px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onDeviceChange('')
                  setAudioOptionsOpen(false)
                }}
              >
                Default microphone
                {selectedDeviceId === '' ? (
                  <span aria-hidden="true">•</span>
                ) : null}
              </button>
              {audioInputDevices.map(device => (
                <button
                  type="button"
                  aria-pressed={selectedDeviceId === device.deviceId}
                  key={device.deviceId}
                  className="flex w-full items-center justify-between rounded-sm px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    onDeviceChange(device.deviceId)
                    setAudioOptionsOpen(false)
                  }}
                >
                  <span className="min-w-0 truncate">{device.label}</span>
                  {selectedDeviceId === device.deviceId ? (
                    <span aria-hidden="true">•</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default RemoteAudioControlsUI
