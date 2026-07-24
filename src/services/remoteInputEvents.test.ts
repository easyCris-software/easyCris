import { describe, expect, it } from 'vitest'
import {
  normalizeVideoPointer,
  parseRemoteInputChannelMessage,
  remoteMouseButtonFromEvent,
} from '@/services/remoteInputEvents'

describe('remoteInputEvents', () => {
  it('normalizes pointer coordinates inside letterboxed video content', () => {
    const point = normalizeVideoPointer({
      clientX: 250,
      clientY: 150,
      rect: { left: 0, top: 0, width: 400, height: 300 },
      videoWidth: 1600,
      videoHeight: 900,
    })

    expect(point).toEqual({
      normalized_x: 0.625,
      normalized_y: 0.5,
      source_width: 1600,
      source_height: 900,
    })
  })

  it('rejects pointer coordinates in video letterbox padding', () => {
    const point = normalizeVideoPointer({
      clientX: 200,
      clientY: 20,
      rect: { left: 0, top: 0, width: 400, height: 300 },
      videoWidth: 1600,
      videoHeight: 900,
    })

    expect(point).toBeNull()
  })

  it('normalizes center click in object-cover fitted video to 0.5, 0.5', () => {
    // 1920×1080 stream (16:9) in 1180×850 container (wider: 1.388)
    // cover scale = max(1180/1920, 850/1080) = 850/1080 = 0.787
    // contentWidth = 1920 × 0.787 = 1511.1  (overflows left/right)
    // contentHeight = 1080 × 0.787 = 850     (fills height)
    // contentLeft = (1180 - 1511.1) / 2 = -165.6  (video starts left of element)
    const point = normalizeVideoPointer({
      clientX: 590,
      clientY: 425,
      rect: { left: 0, top: 0, width: 1180, height: 850 },
      videoWidth: 1920,
      videoHeight: 1080,
      objectFit: 'cover',
    })

    expect(point?.normalized_x).toBeCloseTo(0.5, 4)
    expect(point?.normalized_y).toBeCloseTo(0.5, 4)
    expect(point?.source_width).toBe(1920)
    expect(point?.source_height).toBe(1080)
  })

  it('maps left-edge click in object-cover mode to the visible left crop boundary', () => {
    // With cover, the video overflows the element — leftmost visible pixel is
    // ~10.95% into the full video frame, not 0%
    const point = normalizeVideoPointer({
      clientX: 0,
      clientY: 425,
      rect: { left: 0, top: 0, width: 1180, height: 850 },
      videoWidth: 1920,
      videoHeight: 1080,
      objectFit: 'cover',
    })

    expect(point).not.toBeNull()
    // symmetric: right-edge maps to ~0.8905, so left-edge maps to ~0.1095
    expect(point!.normalized_x).toBeCloseTo(0.1095, 3)
  })

  it('accepts a click in the top letterbox band for object-cover (no dead zones)', () => {
    // With contain, a click at y=10 falls in the 93px top black band → null
    // With cover, the same click is valid (height fills container, no dead zone)
    const containPoint = normalizeVideoPointer({
      clientX: 590,
      clientY: 10,
      rect: { left: 0, top: 0, width: 1180, height: 850 },
      videoWidth: 1920,
      videoHeight: 1080,
      objectFit: 'contain',
    })
    const coverPoint = normalizeVideoPointer({
      clientX: 590,
      clientY: 10,
      rect: { left: 0, top: 0, width: 1180, height: 850 },
      videoWidth: 1920,
      videoHeight: 1080,
      objectFit: 'cover',
    })

    expect(containPoint).toBeNull()
    expect(coverPoint).not.toBeNull()
    expect(coverPoint!.normalized_y).toBeCloseTo(10 / 850, 4)
  })

  it('rejects a click outside the element bounds in object-cover mode', () => {
    const point = normalizeVideoPointer({
      clientX: -10,
      clientY: 425,
      rect: { left: 0, top: 0, width: 1180, height: 850 },
      videoWidth: 1920,
      videoHeight: 1080,
      objectFit: 'cover',
    })

    expect(point).toBeNull()
  })

  it('maps browser mouse buttons to the remote protocol', () => {
    expect(remoteMouseButtonFromEvent(0)).toBe('left')
    expect(remoteMouseButtonFromEvent(1)).toBe('middle')
    expect(remoteMouseButtonFromEvent(2)).toBe('right')
    expect(remoteMouseButtonFromEvent(4)).toBeNull()
  })

  it('parses valid mouse input channel messages', () => {
    expect(
      parseRemoteInputChannelMessage(
        JSON.stringify({
          type: 'mouse',
          event: {
            session_id: 'session',
            guest_device_id: 'guest',
            normalized_x: 0.5,
            normalized_y: 0.25,
            source_width: 1280,
            source_height: 720,
            target_left: 0,
            target_top: 0,
            target_width: 1280,
            target_height: 720,
            action: 'click',
            button: 'left',
            modifiers: { shift: false, ctrl: false, alt: false, meta: false },
          },
        })
      )
    ).toMatchObject({
      type: 'mouse',
      event: {
        action: 'click',
        button: 'left',
        guest_device_id: 'guest',
        session_id: 'session',
      },
    })
  })

  it('accepts nullable optional numeric fields from JSON wire messages', () => {
    expect(
      parseRemoteInputChannelMessage(
        JSON.stringify({
          type: 'mouse',
          event: {
            session_id: 'session',
            guest_device_id: 'guest',
            normalized_x: 0.5,
            normalized_y: 0.25,
            source_width: 1280,
            source_height: 720,
            target_left: null,
            target_top: null,
            target_width: null,
            target_height: null,
            action: 'wheel',
            button: null,
            modifiers: { shift: false, ctrl: false, alt: false, meta: false },
            wheel_delta_x: null,
            wheel_delta_y: null,
          },
        })
      )
    ).toMatchObject({
      type: 'mouse',
      event: {
        action: 'wheel',
        button: null,
        target_left: null,
        target_top: null,
        target_width: null,
        target_height: null,
        wheel_delta_x: null,
        wheel_delta_y: null,
      },
    })
  })

  it('rejects malformed input channel messages before invoking Rust', () => {
    expect(() =>
      parseRemoteInputChannelMessage(
        JSON.stringify({
          type: 'mouse',
          event: {
            session_id: 'session',
            guest_device_id: 'guest',
            normalized_x: 'not-a-number',
            normalized_y: 0.25,
            source_width: 1280,
            source_height: 720,
            action: 'teleport',
            button: 'left',
            modifiers: { shift: false, ctrl: false, alt: false, meta: false },
          },
        })
      )
    ).toThrow('Invalid remote input channel message')
  })

  it('parses valid audio state channel messages', () => {
    expect(
      parseRemoteInputChannelMessage(
        JSON.stringify({
          type: 'audio_state',
          sending: true,
          receiving: false,
          muted: true,
        })
      )
    ).toEqual({
      type: 'audio_state',
      sending: true,
      receiving: false,
      muted: true,
    })
  })

  it('rejects malformed audio state channel messages', () => {
    expect(() =>
      parseRemoteInputChannelMessage(
        JSON.stringify({
          type: 'audio_state',
          sending: true,
          receiving: 'yes',
          muted: false,
        })
      )
    ).toThrow('Invalid remote input channel message')
  })

  it('rejects removed voice-call request channel messages', () => {
    expect(() =>
      parseRemoteInputChannelMessage(
        JSON.stringify({
          type: 'voice_call_request',
          request_id: 'voice-1',
        })
      )
    ).toThrow('Invalid remote input channel message')
  })
})
