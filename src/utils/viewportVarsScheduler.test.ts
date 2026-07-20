import { describe, expect, it, vi } from 'vitest'
import { scheduleViewportVarsRefresh } from './viewportVarsScheduler'

describe('scheduleViewportVarsRefresh', () => {
  it('reads viewport after two animation frames so WebView2 can settle', () => {
    const callbacks: FrameRequestCallback[] = []
    const mockRaf = vi.fn((cb: FrameRequestCallback) => {
      callbacks.push(cb)
      return callbacks.length
    })
    const mockCancel = vi.fn()

    let innerWidth = 1918
    const readViewport = vi.fn(() => ({ width: innerWidth, height: 768 }))
    const applyVars = vi.fn()

    scheduleViewportVarsRefresh(readViewport, applyVars, mockRaf, mockCancel)

    expect(applyVars).not.toHaveBeenCalled()

    // First RAF fires — WebView2 hasn't settled yet
    callbacks[0]!(0)
    expect(applyVars).not.toHaveBeenCalled()
    expect(readViewport).not.toHaveBeenCalled()

    // WebView2 settles between the two frames
    innerWidth = 1920

    // Second RAF fires — now reads the settled value
    callbacks[1]!(0)
    expect(applyVars).toHaveBeenCalledOnce()
    expect(applyVars).toHaveBeenCalledWith(1920, 768)
  })

  it('does not call applyVars at all if cancelled before second frame fires', () => {
    const callbacks: FrameRequestCallback[] = []
    const cancelledIds: number[] = []
    const mockRaf = vi.fn((cb: FrameRequestCallback) => {
      callbacks.push(cb)
      return callbacks.length
    })
    const mockCancel = vi.fn((id: number) => cancelledIds.push(id))

    const applyVars = vi.fn()
    const cancel = scheduleViewportVarsRefresh(
      () => ({ width: 1920, height: 768 }),
      applyVars,
      mockRaf,
      mockCancel
    )

    callbacks[0]!(0) // outer frame fires, inner RAF queued (id=2)
    cancel()         // cancel before inner frame fires

    expect(cancelledIds).toContain(2)
    expect(applyVars).not.toHaveBeenCalled()
  })

  it('does not call applyVars if cancelled before first frame fires', () => {
    const callbacks: FrameRequestCallback[] = []
    const cancelledIds: number[] = []
    const mockRaf = vi.fn((cb: FrameRequestCallback) => {
      callbacks.push(cb)
      return callbacks.length
    })
    const mockCancel = vi.fn((id: number) => cancelledIds.push(id))

    const applyVars = vi.fn()
    const cancel = scheduleViewportVarsRefresh(
      () => ({ width: 1920, height: 768 }),
      applyVars,
      mockRaf,
      mockCancel
    )

    cancel() // cancel immediately, before any frame fires

    expect(cancelledIds).toContain(1)
    expect(applyVars).not.toHaveBeenCalled()
  })
})
