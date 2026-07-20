export interface RemoteInputModifiers {
  shift: boolean
  ctrl: boolean
  alt: boolean
  meta: boolean
}

export interface RemoteVideoPoint {
  normalized_x: number
  normalized_y: number
  source_width: number
  source_height: number
}

export interface RemoteInputTargetRect {
  target_left?: number | null
  target_top?: number | null
  target_width?: number | null
  target_height?: number | null
}

export interface RemoteInputTargetGeometry {
  left: number
  top: number
  width: number
  height: number
}

interface VideoRect {
  left: number
  top: number
  width: number
  height: number
}

export interface NormalizeVideoPointerOptions {
  clientX: number
  clientY: number
  rect: VideoRect
  videoWidth: number
  videoHeight: number
  objectFit?: 'contain' | 'cover'
}

export type RemoteMouseButton = 'left' | 'right' | 'middle'
export type RemoteMouseAction = 'move' | 'down' | 'up' | 'click' | 'wheel'
export type RemoteKeyAction = 'down' | 'up' | 'click'

export type RemoteKey =
  | { kind: 'character'; value: string }
  | {
      kind: 'named'
      value:
        | 'enter'
        | 'escape'
        | 'tab'
        | 'backspace'
        | 'delete'
        | 'space'
        | 'arrow_up'
        | 'arrow_down'
        | 'arrow_left'
        | 'arrow_right'
    }

export interface RemoteInputMouseEventPayload
  extends RemoteVideoPoint,
    RemoteInputTargetRect {
  session_id: string
  guest_device_id: string
  action: RemoteMouseAction
  button: RemoteMouseButton | null
  modifiers: RemoteInputModifiers
  wheel_delta_x?: number | null
  wheel_delta_y?: number | null
}

export interface RemoteInputKeyEventPayload {
  session_id: string
  guest_device_id: string
  key: RemoteKey
  action: RemoteKeyAction
  modifiers: RemoteInputModifiers
}

export type RemoteInputChannelMessage =
  | { type: 'mouse'; event: RemoteInputMouseEventPayload }
  | { type: 'key'; event: RemoteInputKeyEventPayload }
  | { type: 'target_geometry'; rect: RemoteInputTargetGeometry }
  | {
      type: 'audio_state'
      seq?: number
      sending: boolean
      receiving: boolean
      muted: boolean
    }

const remoteMouseActions = new Set<RemoteMouseAction>([
  'move',
  'down',
  'up',
  'click',
  'wheel',
])
const remoteMouseButtons = new Set<RemoteMouseButton>(['left', 'right', 'middle'])
const remoteKeyActions = new Set<RemoteKeyAction>(['down', 'up', 'click'])
const remoteNamedKeys = new Set<Extract<RemoteKey, { kind: 'named' }>['value']>([
  'enter',
  'escape',
  'tab',
  'backspace',
  'delete',
  'space',
  'arrow_up',
  'arrow_down',
  'arrow_left',
  'arrow_right',
])

const roundUnit = (value: number) => Math.round(value * 1_000_000) / 1_000_000

export const normalizeVideoPointer = ({
  clientX,
  clientY,
  rect,
  videoWidth,
  videoHeight,
  objectFit = 'contain',
}: NormalizeVideoPointerOptions): RemoteVideoPoint | null => {
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    return null
  }

  const scale =
    objectFit === 'cover'
      ? Math.max(rect.width / videoWidth, rect.height / videoHeight)
      : Math.min(rect.width / videoWidth, rect.height / videoHeight)
  const contentWidth = videoWidth * scale
  const contentHeight = videoHeight * scale
  const contentLeft = rect.left + (rect.width - contentWidth) / 2
  const contentTop = rect.top + (rect.height - contentHeight) / 2
  const x = clientX - contentLeft
  const y = clientY - contentTop

  if (objectFit === 'cover') {
    // Cover crops the video to fill the element — every pixel inside the element
    // is valid; reject only clicks that land outside it.
    const relX = clientX - rect.left
    const relY = clientY - rect.top
    if (relX < 0 || relY < 0 || relX > rect.width || relY > rect.height) {
      return null
    }
  } else {
    if (x < 0 || y < 0 || x > contentWidth || y > contentHeight) {
      return null
    }
  }

  return {
    normalized_x: roundUnit(x / contentWidth),
    normalized_y: roundUnit(y / contentHeight),
    source_width: Math.round(videoWidth),
    source_height: Math.round(videoHeight),
  }
}

export const modifiersFromEvent = (
  event: Pick<
    KeyboardEvent | MouseEvent | WheelEvent,
    'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'
  >
): RemoteInputModifiers => ({
  shift: event.shiftKey,
  ctrl: event.ctrlKey,
  alt: event.altKey,
  meta: event.metaKey,
})

export const remoteMouseButtonFromEvent = (
  button: number
): RemoteMouseButton | null => {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return null
}

export const remoteKeyFromEvent = (
  event: Pick<KeyboardEvent, 'key'>
): RemoteKey | null => {
  if (event.key.length === 1) {
    return { kind: 'character', value: event.key }
  }

  switch (event.key) {
    case 'Enter':
      return { kind: 'named', value: 'enter' }
    case 'Escape':
      return { kind: 'named', value: 'escape' }
    case 'Tab':
      return { kind: 'named', value: 'tab' }
    case 'Backspace':
      return { kind: 'named', value: 'backspace' }
    case 'Delete':
      return { kind: 'named', value: 'delete' }
    case ' ':
    case 'Spacebar':
      return { kind: 'named', value: 'space' }
    case 'ArrowUp':
      return { kind: 'named', value: 'arrow_up' }
    case 'ArrowDown':
      return { kind: 'named', value: 'arrow_down' }
    case 'ArrowLeft':
      return { kind: 'named', value: 'arrow_left' }
    case 'ArrowRight':
      return { kind: 'named', value: 'arrow_right' }
    default:
      return null
  }
}

export const parseRemoteInputChannelMessage = (
  raw: string
): RemoteInputChannelMessage => {
  const parsed = JSON.parse(raw) as unknown
  if (isRemoteInputChannelMessage(parsed)) return parsed
  throw new Error('Invalid remote input channel message')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const isRemoteMouseAction = (value: unknown): value is RemoteMouseAction =>
  isString(value) && remoteMouseActions.has(value as RemoteMouseAction)

const isRemoteMouseButton = (value: unknown): value is RemoteMouseButton =>
  isString(value) && remoteMouseButtons.has(value as RemoteMouseButton)

const isRemoteKeyAction = (value: unknown): value is RemoteKeyAction =>
  isString(value) && remoteKeyActions.has(value as RemoteKeyAction)

const isRemoteNamedKey = (
  value: unknown
): value is Extract<RemoteKey, { kind: 'named' }>['value'] =>
  isString(value) &&
  remoteNamedKeys.has(value as Extract<RemoteKey, { kind: 'named' }>['value'])

const isModifiers = (value: unknown): value is RemoteInputModifiers => {
  if (!isRecord(value)) return false
  return (
    typeof value.shift === 'boolean' &&
    typeof value.ctrl === 'boolean' &&
    typeof value.alt === 'boolean' &&
    typeof value.meta === 'boolean'
  )
}

const isRemoteInputTargetGeometry = (
  value: unknown
): value is RemoteInputTargetGeometry => {
  if (!isRecord(value)) return false
  return (
    isFiniteNumber(value.left) &&
    isFiniteNumber(value.top) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  )
}

const isOptionalFiniteNumber = (
  value: unknown
): value is number | null | undefined =>
  value === undefined || value === null || isFiniteNumber(value)

const isRemoteKey = (value: unknown): value is RemoteKey => {
  if (!isRecord(value)) return false
  if (value.kind === 'character') {
    return isString(value.value) && [...value.value].length === 1
  }
  return value.kind === 'named' && isRemoteNamedKey(value.value)
}

const isRemoteInputMouseEventPayload = (
  value: unknown
): value is RemoteInputMouseEventPayload => {
  if (!isRecord(value)) return false
  return (
    isString(value.session_id) &&
    isString(value.guest_device_id) &&
    isFiniteNumber(value.normalized_x) &&
    isFiniteNumber(value.normalized_y) &&
    isFiniteNumber(value.source_width) &&
    isFiniteNumber(value.source_height) &&
    isRemoteMouseAction(value.action) &&
    (value.button === null || isRemoteMouseButton(value.button)) &&
    isModifiers(value.modifiers) &&
    isOptionalFiniteNumber(value.target_left) &&
    isOptionalFiniteNumber(value.target_top) &&
    isOptionalFiniteNumber(value.target_width) &&
    isOptionalFiniteNumber(value.target_height) &&
    isOptionalFiniteNumber(value.wheel_delta_x) &&
    isOptionalFiniteNumber(value.wheel_delta_y)
  )
}

const isRemoteInputKeyEventPayload = (
  value: unknown
): value is RemoteInputKeyEventPayload => {
  if (!isRecord(value)) return false
  return (
    isString(value.session_id) &&
    isString(value.guest_device_id) &&
    isRemoteKey(value.key) &&
    isRemoteKeyAction(value.action) &&
    isModifiers(value.modifiers)
  )
}

const isRemoteInputChannelMessage = (
  value: unknown
): value is RemoteInputChannelMessage => {
  if (!isRecord(value)) return false
  if (value.type === 'mouse') return isRemoteInputMouseEventPayload(value.event)
  if (value.type === 'key') return isRemoteInputKeyEventPayload(value.event)
  if (value.type === 'target_geometry') {
    return isRemoteInputTargetGeometry(value.rect)
  }
  if (value.type === 'audio_state') {
    return (
      (value.seq === undefined ||
        (isFiniteNumber(value.seq) && value.seq >= 0)) &&
      typeof value.sending === 'boolean' &&
      typeof value.receiving === 'boolean' &&
      typeof value.muted === 'boolean'
    )
  }
  return false
}
