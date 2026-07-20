import { act, fireEvent, render, screen } from '@/test/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteHostIdentityLabelWindow } from './RemoteHostIdentityLabelWindow'
import {
  REMOTE_HOST_CONTROLS_STATE_EVENT,
  type RemoteHostControlsState,
} from '@/services/remoteHostControlsWindow'

const {
  eventHandlers,
  mockEmit,
  mockSetRemoteWindowCaptureExclusion,
  mockStartDragging,
} = vi.hoisted(() => ({
  eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  mockEmit: vi.fn().mockResolvedValue(undefined),
  mockSetRemoteWindowCaptureExclusion: vi.fn().mockResolvedValue(undefined),
  mockStartDragging: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({
  emit: mockEmit,
  emitTo: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(
    (name: string, handler: (event: { payload: unknown }) => void) => {
      eventHandlers.set(name, handler)
      return Promise.resolve(() => eventHandlers.delete(name))
    }
  ),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: vi.fn(() => ({
    startDragging: mockStartDragging,
  })),
  WebviewWindow: vi.fn(),
}))

vi.mock('@/services/remoteSessionService', () => ({
  setRemoteWindowCaptureExclusion: mockSetRemoteWindowCaptureExclusion,
}))

const activeState: RemoteHostControlsState = {
  active: true,
  audioInputDevices: [],
  audioLabel: 'Audio on',
  audioState: {
    connecting: false,
    localEnabled: true,
    localMuted: false,
    remotePlaybackEnabled: true,
  },
  guestDeviceId: 'guest-device',
  // A generic "Device ..." display name forces the device-id fallback path.
  guestDisplayName: 'Device 4c-158',
  identityLabelVisible: true,
  micLevel: 0,
  playbackVolume: 0.8,
  securityCode: null,
  selectedAudioInputDeviceId: '',
  warningText: null,
}

const emitState = (state: RemoteHostControlsState) => {
  act(() => {
    eventHandlers.get(REMOTE_HOST_CONTROLS_STATE_EVENT)?.({ payload: state })
  })
}

describe('RemoteHostIdentityLabelWindow', () => {
  beforeEach(() => {
    eventHandlers.clear()
    vi.clearAllMocks()
  })

  it('shows a single dedup line and not the guest id as a separate title', () => {
    render(<RemoteHostIdentityLabelWindow />)
    emitState(activeState)

    const label = screen.getByTestId('remote-host-identity-label')
    expect(label).toHaveTextContent(
      'Guest guest-device is controlling your easyCris'
    )
    // The device id must appear exactly once — no duplicated title line.
    const occurrences = (label.textContent?.match(/guest-device/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('stays hidden until the session is active and the label is visible', () => {
    render(<RemoteHostIdentityLabelWindow />)
    emitState({ ...activeState, active: false })
    expect(screen.queryByTestId('remote-host-identity-label')).toBeNull()

    emitState({ ...activeState, identityLabelVisible: false })
    expect(screen.queryByTestId('remote-host-identity-label')).toBeNull()

    emitState(activeState)
    expect(screen.getByTestId('remote-host-identity-label')).toBeInTheDocument()
  })

  it('starts dragging the native label window from the label surface', () => {
    render(<RemoteHostIdentityLabelWindow />)
    emitState(activeState)

    fireEvent.pointerDown(screen.getByTestId('remote-host-identity-label'), {
      button: 0,
    })

    expect(mockStartDragging).toHaveBeenCalledTimes(1)
  })
})
