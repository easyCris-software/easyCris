import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_HOST_CONTROLS_WINDOW_LABEL,
  REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL,
  openRemoteHostControlsWindow,
  openRemoteHostIdentityLabelWindow,
} from '@/services/remoteHostControlsWindow'

const {
  createdWindows,
  createdEventBehavior,
  existingWindows,
  mockCurrentMonitor,
  mockInvoke,
  mockLoggerWarn,
  mockPrimaryMonitor,
  MockPhysicalPosition,
  MockWebviewWindow,
} = vi.hoisted(() => ({
  createdWindows: [] as unknown[],
  createdEventBehavior: { current: 'fire' as 'fire' | 'miss' },
  existingWindows: new Map<string, unknown>(),
  mockCurrentMonitor: vi.fn(),
  mockInvoke: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockPrimaryMonitor: vi.fn(),
  MockPhysicalPosition: class MockPhysicalPosition {
    readonly kind = 'physical'

    constructor(
      public x: number,
      public y: number
    ) {}
  },
  MockWebviewWindow: class MockWebviewWindow {
    static getByLabel(label: string): Promise<unknown | null> {
      return Promise.resolve(existingWindows.get(label) ?? null)
    }

    readonly destroy = vi.fn().mockResolvedValue(undefined)
    readonly hide = vi.fn().mockResolvedValue(undefined)
    readonly isVisible = vi.fn().mockResolvedValue(true)
    readonly label: string
    readonly once = vi.fn((eventName: string, handler: () => void) => {
      if (
        eventName === 'tauri://created' &&
        createdEventBehavior.current === 'fire'
      ) {
        queueMicrotask(handler)
      }
      return Promise.resolve(vi.fn())
    })
    readonly options: Record<string, unknown>
    readonly outerPosition = vi
      .fn()
      .mockResolvedValue(new MockPhysicalPosition(380, 120))
    readonly outerSize = vi.fn().mockResolvedValue({ width: 420, height: 58 })
    readonly setPosition = vi.fn().mockResolvedValue(undefined)
    readonly show = vi.fn().mockResolvedValue(undefined)

    constructor(label: string, options: Record<string, unknown>) {
      this.label = label
      this.options = options
      createdWindows.push(this)
    }
  },
}))

vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalPosition: MockPhysicalPosition,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}))

vi.mock('@tauri-apps/api/window', () => ({
  currentMonitor: mockCurrentMonitor,
  primaryMonitor: mockPrimaryMonitor,
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: MockWebviewWindow,
}))

const setMonitor = (scaleFactor = 1) => {
  const monitor = {
    position: { x: 100, y: 200 },
    scaleFactor,
    size: { width: 1000, height: 800 },
    workArea: {
      position: { x: 100, y: 200 },
      size: { width: 1000, height: 800 },
    },
  }
  mockCurrentMonitor.mockResolvedValue(monitor)
  mockPrimaryMonitor.mockResolvedValue(monitor)
}

describe('remoteHostControlsWindow placement', () => {
  beforeEach(() => {
    createdWindows.length = 0
    createdEventBehavior.current = 'fire'
    existingWindows.clear()
    mockCurrentMonitor.mockReset()
    mockInvoke.mockReset()
    mockInvoke.mockResolvedValue(undefined)
    mockLoggerWarn.mockClear()
    mockPrimaryMonitor.mockReset()
    setMonitor()
  })

  it('opens host controls at monitor top-center like the guest overlay', async () => {
    const window = await openRemoteHostControlsWindow()

    const createdWindow = window as unknown as {
      options: Record<string, unknown>
      setPosition: ReturnType<typeof vi.fn>
      show: ReturnType<typeof vi.fn>
    }

    expect(createdWindow.options).not.toHaveProperty('center', true)
    expect(createdWindow.options).toHaveProperty('visible', false)
    expect(createdWindow.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'physical',
        x: 390,
        y: 212,
      })
    )
    expect(mockInvoke).toHaveBeenCalledWith('apply_webview_chrome_policy', {
      label: REMOTE_HOST_CONTROLS_WINDOW_LABEL,
    })
    expect(createdWindow.show).toHaveBeenCalled()
    const policyCallOrder = mockInvoke.mock.invocationCallOrder[0]
    const positionCallOrder =
      createdWindow.setPosition.mock.invocationCallOrder[0]
    const showCallOrder = createdWindow.show.mock.invocationCallOrder[0]
    if (
      policyCallOrder === undefined ||
      positionCallOrder === undefined ||
      showCallOrder === undefined
    ) {
      throw new Error('Expected controls window policy, position, and show calls')
    }
    expect(policyCallOrder).toBeLessThan(positionCallOrder)
    expect(positionCallOrder).toBeLessThan(showCallOrder)
  })

  it('shows host controls when the created event was already missed', async () => {
    vi.useFakeTimers()
    createdEventBehavior.current = 'miss'

    try {
      const windowPromise = openRemoteHostControlsWindow()
      const openedPromise = Promise.race([
        windowPromise.then(() => 'opened'),
        new Promise(resolve => setTimeout(() => resolve('timed-out'), 1_600)),
      ])

      await vi.advanceTimersByTimeAsync(1_600)

      expect(await openedPromise).toBe('opened')
      const createdWindow = (await windowPromise) as unknown as {
        setPosition: ReturnType<typeof vi.fn>
        show: ReturnType<typeof vi.fn>
      }
      expect(createdWindow.setPosition).toHaveBeenCalled()
      expect(createdWindow.show).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still shows host controls when positioning fails after a missed created event', async () => {
    vi.useFakeTimers()
    createdEventBehavior.current = 'miss'

    try {
      const windowPromise = openRemoteHostControlsWindow()
      await Promise.resolve()
      const createdWindow = createdWindows[0] as {
        setPosition: ReturnType<typeof vi.fn>
        show: ReturnType<typeof vi.fn>
      }
      createdWindow.setPosition.mockRejectedValueOnce(
        new Error('position failed')
      )

      await vi.advanceTimersByTimeAsync(1_600)

      await expect(windowPromise).resolves.toBe(createdWindow)
      expect(createdWindow.show).toHaveBeenCalled()
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Failed to position remote-host-controls',
        expect.objectContaining({ error: expect.any(Error) })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the host identity label at monitor bottom-center independent of controls', async () => {
    existingWindows.set(
      REMOTE_HOST_CONTROLS_WINDOW_LABEL,
      new MockWebviewWindow(REMOTE_HOST_CONTROLS_WINDOW_LABEL, {})
    )
    createdWindows.length = 0

    const window = await openRemoteHostIdentityLabelWindow()

    const createdWindow = window as unknown as {
      options: Record<string, unknown>
      setPosition: ReturnType<typeof vi.fn>
      show: ReturnType<typeof vi.fn>
    }

    expect(createdWindow.options).toHaveProperty('visible', false)
    expect(createdWindow.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'physical',
        x: 400,
        y: 928,
      })
    )
    expect(mockInvoke).toHaveBeenCalledWith('apply_webview_chrome_policy', {
      label: REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL,
    })
    const controlsWindow = existingWindows.get(
      REMOTE_HOST_CONTROLS_WINDOW_LABEL
    ) as {
      outerPosition: ReturnType<typeof vi.fn>
      outerSize: ReturnType<typeof vi.fn>
    }
    expect(controlsWindow.outerPosition).not.toHaveBeenCalled()
    expect(controlsWindow.outerSize).not.toHaveBeenCalled()
    expect(createdWindow.show).toHaveBeenCalled()
    const positionCallOrder =
      createdWindow.setPosition.mock.invocationCallOrder[0]
    const showCallOrder = createdWindow.show.mock.invocationCallOrder[0]
    const policyCallOrder = mockInvoke.mock.invocationCallOrder[0]
    if (
      policyCallOrder === undefined ||
      positionCallOrder === undefined ||
      showCallOrder === undefined
    ) {
      throw new Error('Expected identity label policy, position, and show calls')
    }
    expect(positionCallOrder).toBeLessThan(showCallOrder)
    expect(policyCallOrder).toBeLessThan(positionCallOrder)
  })

  it('scales host window placement for HiDPI monitors', async () => {
    setMonitor(2)

    const controlsWindow =
      (await openRemoteHostControlsWindow()) as unknown as {
        setPosition: ReturnType<typeof vi.fn>
      }
    const labelWindow =
      (await openRemoteHostIdentityLabelWindow()) as unknown as {
        setPosition: ReturnType<typeof vi.fn>
      }

    expect(controlsWindow.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'physical',
        x: 180,
        y: 224,
      })
    )
    expect(labelWindow.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'physical',
        x: 200,
        y: 856,
      })
    )
  })

  it('does not reposition an already-visible host controls window during state sync', async () => {
    const existing = new MockWebviewWindow(
      REMOTE_HOST_CONTROLS_WINDOW_LABEL,
      {}
    )
    existingWindows.set(REMOTE_HOST_CONTROLS_WINDOW_LABEL, existing)

    await openRemoteHostControlsWindow()

    expect(existing.show).toHaveBeenCalled()
    expect(existing.setPosition).not.toHaveBeenCalled()
  })

  it('does not reposition an already-visible host identity label during state sync', async () => {
    const existing = new MockWebviewWindow(
      REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL,
      {}
    )
    existingWindows.set(REMOTE_HOST_IDENTITY_LABEL_WINDOW_LABEL, existing)

    await openRemoteHostIdentityLabelWindow()

    expect(existing.show).toHaveBeenCalled()
    expect(existing.setPosition).not.toHaveBeenCalled()
  })
})
