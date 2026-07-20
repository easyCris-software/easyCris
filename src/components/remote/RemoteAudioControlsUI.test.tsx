import { fireEvent, render, screen } from '@/test/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteAudioControlsUI } from './RemoteAudioControlsUI'

const baseAudioState = {
  connecting: false,
  localEnabled: true,
  localMuted: false,
  remotePlaybackEnabled: false,
}

type Overrides = Partial<Parameters<typeof RemoteAudioControlsUI>[0]>

function renderControls(overrides: Overrides = {}) {
  const props = {
    audioInputDevices: [],
    audioLabel: 'Audio on',
    audioState: baseAudioState,
    microphoneLabel: 'Guest microphone',
    micLevel: 0,
    onDeviceChange: vi.fn(),
    onEnable: vi.fn(),
    onMute: vi.fn(),
    onPlaybackVolumeChange: vi.fn(),
    onStop: vi.fn(),
    playbackVolume: 1,
    selectedDeviceId: '',
    testIdPrefix: 'remote-guest' as const,
    ...overrides,
  }
  render(<RemoteAudioControlsUI {...props} />)
  return props
}

describe('RemoteAudioControlsUI', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows only a single enable button when audio is off', () => {
    renderControls({ audioState: { ...baseAudioState, localEnabled: false } })

    expect(screen.getByTestId('remote-guest-audio-enable')).toBeInTheDocument()
    expect(
      screen.queryByTestId('remote-guest-audio-mute')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('remote-guest-audio-more')
    ).not.toBeInTheDocument()
  })

  it('disables the enable button while connecting', () => {
    renderControls({
      audioState: { ...baseAudioState, localEnabled: false, connecting: true },
    })

    expect(screen.getByTestId('remote-guest-audio-enable')).toBeDisabled()
  })

  it('enables audio when the off-state button is clicked', async () => {
    const user = userEvent.setup()
    const props = renderControls({
      audioState: { ...baseAudioState, localEnabled: false },
    })

    await user.click(screen.getByTestId('remote-guest-audio-enable'))

    expect(props.onEnable).toHaveBeenCalledOnce()
  })

  it('uses a stable "turn on audio" label when off but not connecting', () => {
    renderControls({
      audioLabel: 'Audio off',
      audioState: { ...baseAudioState, localEnabled: false },
    })

    // The status string ("Audio off") must NOT become the button's name, and
    // the visible bar copy stays compact.
    const enableButton = screen.getByTestId('remote-guest-audio-enable')
    expect(enableButton).toHaveAccessibleName('Turn on audio')
    expect(enableButton).toHaveTextContent('Audio')
    expect(enableButton).not.toHaveTextContent('Turn on audio')
  })

  it('announces the connecting state on the enable button', () => {
    renderControls({
      audioLabel: 'Connecting audio',
      audioState: { ...baseAudioState, localEnabled: false, connecting: true },
    })

    const enableButton = screen.getByTestId('remote-guest-audio-enable')
    expect(enableButton).toHaveAccessibleName('Connecting audio')
    expect(enableButton).toHaveTextContent('Audio')
  })

  it('renders a compact split audio button with secondary controls hidden until expanded', () => {
    renderControls()

    expect(screen.getByTestId('remote-guest-audio-mute')).toBeInTheDocument()
    expect(screen.getByTestId('remote-guest-audio-more')).toBeInTheDocument()
    expect(
      screen.queryByTestId('remote-guest-speaker-volume')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('remote-guest-audio-options')
    ).not.toBeInTheDocument()
    // Stop, volume, and device selection live behind the options panel, not inline.
    expect(
      screen.queryByTestId('remote-guest-audio-stop')
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('shows the visible "Audio" label on the mute button (not sr-only)', () => {
    renderControls()
    const label = screen
      .getByTestId('remote-guest-audio-mute')
      .querySelector('span')
    expect(label).toHaveTextContent('Audio')
    expect(label).not.toHaveClass('sr-only')
  })

  it('rotates the expand caret when the options panel opens', async () => {
    const user = userEvent.setup()
    renderControls()

    const caretIcon = screen
      .getByTestId('remote-guest-audio-more')
      .querySelector('svg')
    expect(caretIcon).not.toBeNull()
    expect(caretIcon).not.toHaveClass('rotate-90')

    await user.click(screen.getByTestId('remote-guest-audio-more'))

    expect(caretIcon).toHaveClass('rotate-90')
  })

  it('toggles mute from the primary button', async () => {
    const user = userEvent.setup()
    const props = renderControls()

    await user.click(screen.getByTestId('remote-guest-audio-mute'))

    expect(props.onMute).toHaveBeenCalledOnce()
  })

  it('labels the primary button by mute state for screen readers', () => {
    renderControls()
    expect(screen.getByTestId('remote-guest-audio-mute')).toHaveAccessibleName(
      'Mute mic'
    )
  })

  it('does not render a separate mic level meter beside the mic icon', () => {
    renderControls({ micLevel: 0.72 })

    expect(screen.queryByTestId('remote-guest-mic-level')).toBeNull()
  })

  it('tints the mic button only for audible unmuted input', () => {
    const { rerender } = render(
      <RemoteAudioControlsUI
        audioInputDevices={[]}
        audioLabel="Audio on"
        audioState={baseAudioState}
        microphoneLabel="Guest microphone"
        micLevel={0.09}
        onDeviceChange={vi.fn()}
        onEnable={vi.fn()}
        onMute={vi.fn()}
        onPlaybackVolumeChange={vi.fn()}
        onStop={vi.fn()}
        playbackVolume={1}
        selectedDeviceId=""
        testIdPrefix="remote-guest"
      />
    )

    expect(screen.getByTestId('remote-guest-audio-mute')).toHaveClass(
      'text-primary'
    )

    rerender(
      <RemoteAudioControlsUI
        audioInputDevices={[]}
        audioLabel="Audio on"
        audioState={baseAudioState}
        microphoneLabel="Guest microphone"
        micLevel={0.08}
        onDeviceChange={vi.fn()}
        onEnable={vi.fn()}
        onMute={vi.fn()}
        onPlaybackVolumeChange={vi.fn()}
        onStop={vi.fn()}
        playbackVolume={1}
        selectedDeviceId=""
        testIdPrefix="remote-guest"
      />
    )
    expect(screen.getByTestId('remote-guest-audio-mute')).not.toHaveClass(
      'text-primary'
    )

    rerender(
      <RemoteAudioControlsUI
        audioInputDevices={[]}
        audioLabel="Audio on"
        audioState={{ ...baseAudioState, localMuted: true }}
        microphoneLabel="Guest microphone"
        micLevel={0.6}
        onDeviceChange={vi.fn()}
        onEnable={vi.fn()}
        onMute={vi.fn()}
        onPlaybackVolumeChange={vi.fn()}
        onStop={vi.fn()}
        playbackVolume={1}
        selectedDeviceId=""
        testIdPrefix="remote-guest"
      />
    )
    expect(screen.getByTestId('remote-guest-audio-mute')).not.toHaveClass(
      'text-primary'
    )
  })

  it('opens a contained audio options panel from the caret', async () => {
    const user = userEvent.setup()
    renderControls()

    await user.click(screen.getByTestId('remote-guest-audio-more'))

    const panel = await screen.findByTestId('remote-guest-audio-options')
    expect(panel).toBeInTheDocument()
    expect(screen.getByTestId('remote-guest-audio-more')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('remote-guest-audio-more')).toHaveAttribute(
      'aria-controls',
      'remote-guest-audio-options'
    )
    expect(
      screen.getByTestId('remote-guest-speaker-volume')
    ).toBeInTheDocument()
  })

  it('changes speaker playback volume from the expanded audio options panel', async () => {
    const user = userEvent.setup()
    const props = renderControls({ playbackVolume: 0.65 })

    await user.click(screen.getByTestId('remote-guest-audio-more'))
    const slider = screen.getByRole('slider', { name: 'Speaker volume' })

    expect(slider).toHaveAttribute('aria-valuenow', '65')
    slider.focus()
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })

    expect(props.onPlaybackVolumeChange).toHaveBeenCalledWith(0.6)
  })

  it('labels the primary button as unmute when muted', () => {
    renderControls({ audioState: { ...baseAudioState, localMuted: true } })
    expect(screen.getByTestId('remote-guest-audio-mute')).toHaveAccessibleName(
      'Unmute mic'
    )
  })

  it('turns off audio from the more menu', async () => {
    const user = userEvent.setup()
    const props = renderControls()

    await user.click(screen.getByTestId('remote-guest-audio-more'))
    await user.click(await screen.findByTestId('remote-guest-audio-stop'))

    expect(props.onStop).toHaveBeenCalledOnce()
  })

  it('selects a microphone from the more menu in host mode — parity with guest', async () => {
    const user = userEvent.setup()
    const props = renderControls({
      audioInputDevices: [
        { deviceId: 'mic-1', label: 'Headset microphone' },
        { deviceId: 'mic-2', label: 'Conference microphone' },
      ],
      selectedDeviceId: 'mic-1',
      microphoneLabel: 'Host microphone',
      testIdPrefix: 'remote-host',
    })

    await user.click(screen.getByTestId('remote-host-audio-more'))
    await user.click(
      await screen.findByRole('button', { name: 'Conference microphone' })
    )

    expect(props.onDeviceChange).toHaveBeenCalledWith('mic-2')
  })

  it('marks the currently selected microphone as checked in the menu', async () => {
    const user = userEvent.setup()
    renderControls({
      audioInputDevices: [
        { deviceId: 'mic-1', label: 'Headset microphone' },
        { deviceId: 'mic-2', label: 'Conference microphone' },
      ],
      selectedDeviceId: 'mic-2',
    })

    await user.click(screen.getByTestId('remote-guest-audio-more'))

    expect(
      screen.getByRole('group', { name: 'Guest microphone' })
    ).toContainElement(
      screen.getByRole('button', { name: 'Conference microphone' })
    )
    expect(
      await screen.findByRole('button', { name: 'Conference microphone' })
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByRole('button', { name: 'Headset microphone' })
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('selects the default microphone (empty device id) from the menu', async () => {
    const user = userEvent.setup()
    const props = renderControls({
      audioInputDevices: [{ deviceId: 'mic-1', label: 'Headset microphone' }],
      selectedDeviceId: 'mic-1',
    })

    await user.click(screen.getByTestId('remote-guest-audio-more'))
    await user.click(
      await screen.findByRole('button', { name: 'Default microphone' })
    )

    expect(props.onDeviceChange).toHaveBeenCalledWith('')
  })

  it('closes the audio options panel after selecting a device or stopping audio', async () => {
    const user = userEvent.setup()
    const props = renderControls({
      audioInputDevices: [{ deviceId: 'mic-1', label: 'Headset microphone' }],
    })

    await user.click(screen.getByTestId('remote-guest-audio-more'))
    await user.click(
      await screen.findByRole('button', { name: 'Headset microphone' })
    )

    expect(props.onDeviceChange).toHaveBeenCalledWith('mic-1')
    expect(
      screen.queryByTestId('remote-guest-audio-options')
    ).not.toBeInTheDocument()

    await user.click(screen.getByTestId('remote-guest-audio-more'))
    await user.click(await screen.findByTestId('remote-guest-audio-stop'))

    expect(props.onStop).toHaveBeenCalledOnce()
    expect(
      screen.queryByTestId('remote-guest-audio-options')
    ).not.toBeInTheDocument()
  })

  it('closes the audio options panel on Escape and outside pointer down', async () => {
    const user = userEvent.setup()
    renderControls()

    await user.click(screen.getByTestId('remote-guest-audio-more'))
    expect(screen.getByTestId('remote-guest-audio-options')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(
      screen.queryByTestId('remote-guest-audio-options')
    ).not.toBeInTheDocument()

    await user.click(screen.getByTestId('remote-guest-audio-more'))
    expect(screen.getByTestId('remote-guest-audio-options')).toBeInTheDocument()
    fireEvent.pointerDown(document.body, { button: 0 })

    expect(
      screen.queryByTestId('remote-guest-audio-options')
    ).not.toBeInTheDocument()
  })

  it('keeps the audio options panel open when pointer down starts inside it', async () => {
    const user = userEvent.setup()
    renderControls()

    await user.click(screen.getByTestId('remote-guest-audio-more'))
    const panel = await screen.findByTestId('remote-guest-audio-options')

    fireEvent.pointerDown(panel, { button: 0 })

    expect(screen.getByTestId('remote-guest-audio-options')).toBeInTheDocument()
  })

  it('lets controlled callers force the panel closed while still receiving open requests', async () => {
    const user = userEvent.setup()
    const onOptionsOpenChange = vi.fn()
    renderControls({ optionsOpen: false, onOptionsOpenChange })

    await user.click(screen.getByTestId('remote-guest-audio-more'))

    expect(onOptionsOpenChange).toHaveBeenCalledWith(true)
    expect(
      screen.queryByTestId('remote-guest-audio-options')
    ).not.toBeInTheDocument()
  })

  it('lets controlled callers force the panel open', () => {
    renderControls({ optionsOpen: true })

    expect(screen.getByTestId('remote-guest-audio-options')).toBeInTheDocument()
    expect(screen.getByTestId('remote-guest-audio-more')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('exposes the split audio control with a visible label in host mode too', () => {
    renderControls({ testIdPrefix: 'remote-host' })
    const hostLabel = screen
      .getByTestId('remote-host-audio-mute')
      .querySelector('span')
    expect(hostLabel).toHaveTextContent('Audio')
    expect(hostLabel).not.toHaveClass('sr-only')

    expect(screen.getByTestId('remote-host-audio-mute')).toBeInTheDocument()
    expect(screen.getByTestId('remote-host-audio-more')).toBeInTheDocument()
  })

  it('omits the microphone section when no input devices are available', async () => {
    const user = userEvent.setup()
    renderControls()

    await user.click(screen.getByTestId('remote-guest-audio-more'))

    expect(
      await screen.findByTestId('remote-guest-audio-stop')
    ).toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })
})
