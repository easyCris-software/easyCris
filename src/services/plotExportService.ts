/**
 * Kaleido Export Service
 *
 * Exports Plotly figures via Python + Kaleido for high-quality output.
 */

import {
  exportPlotImageViaBackend,
  pingPlotBackend,
  type PlotExportRequest,
  type PlotExportResponse,
} from './plotBackendService'
import type { PlotSpec } from '@/store/plots-store'
import { tempDir, join } from '@tauri-apps/api/path'
import { remove } from '@tauri-apps/plugin-fs'

export type KaleidoFormat = 'png' | 'jpg' | 'jpeg' | 'webp' | 'svg' | 'pdf' | 'tiff'

export interface KaleidoExportOptions {
  format: KaleidoFormat
  width?: number
  height?: number
  /** Target DPI for raster formats (png/jpg/jpeg/webp). */
  dpi?: number
  /** Explicit scale factor; overrides dpi if set. */
  scale?: number
  /** Transparent background for PNG exports. */
  transparent?: boolean
}

export interface KaleidoExportResult {
  success: boolean
  path?: string
  format?: string
  width?: number
  height?: number
  dpi?: number
  scale?: number | null
  error?: string
  error_type?: string
  details?: string
  suspect_paths?: string[]
  debug_payload_path?: string
  replay_command?: string
  backend_fingerprint?: Record<string, unknown>
}

// Keep this above backend timeout so UI does not fail before backend finishes.
const KALEIDO_TIMEOUT_MS = 300000
const CAPABILITY_PROBE_TIMEOUT_MS = 45000
const CAPABILITY_REASON_MAX_LEN = 200
const CAPABILITY_CACHE_TTL_MS = 10 * 60 * 1000
const CAPABILITY_FORCE_REFRESH_COOLDOWN_MS = 2 * 60 * 1000
const WARMUP_TIMEOUT_MS = 60000

export type BackendOnlyExportFormat = 'pdf' | 'tiff'

export interface KaleidoFormatCapability {
  supported: boolean
  reason?: string
  checkedAt: number
}

export type KaleidoCapabilities = Record<BackendOnlyExportFormat, KaleidoFormatCapability>

let kaleidoQueue: Promise<void> = Promise.resolve()
let kaleidoWarmupPromise: Promise<void> | null = null
let kaleidoWarmupDone = false
let kaleidoCapabilitiesCache: KaleidoCapabilities | null = null
let kaleidoCapabilitiesPromise: Promise<KaleidoCapabilities> | null = null
let kaleidoBackendCallInFlight: Promise<void> | null = null
let lastForcedCapabilityRefreshAt = 0
let startupWarmupPromise: Promise<void> | null = null
const invalidJsonCircuitBreaker = new Set<string>()

function enqueueKaleidoTask<T>(task: () => Promise<T>): Promise<T> {
  const run = kaleidoQueue.then(task, task)
  kaleidoQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function runSerializedBackendExport(
  request: PlotExportRequest
): Promise<PlotExportResponse> {
  if (kaleidoBackendCallInFlight) {
    try {
      await kaleidoBackendCallInFlight
    } catch {
      // Ignore previous failure and continue with next request.
    }
  }

  const operation = exportPlotImageViaBackend(request)
  const marker = operation.then(
    () => undefined,
    () => undefined
  )
  kaleidoBackendCallInFlight = marker

  try {
    return await operation
  } finally {
    if (kaleidoBackendCallInFlight === marker) {
      kaleidoBackendCallInFlight = null
    }
  }
}

async function ensureKaleidoWarmup(): Promise<void> {
  if (kaleidoWarmupDone) return
  if (!kaleidoWarmupPromise) {
    kaleidoWarmupPromise = (async () => {
      const backendReady = await pingPlotBackend()
      if (!backendReady) {
        throw new Error('Plot backend is not ready')
      }

      const dir = await tempDir()
      const warmupPath = await join(dir, `easycris-kaleido-warmup-${Date.now()}.png`)
      try {
        const timeoutResult = new Promise<KaleidoExportResult>((resolve) => {
          setTimeout(
            () =>
              resolve({
                success: false,
                error: `Kaleido warmup timed out after ${WARMUP_TIMEOUT_MS}ms`,
              }),
            WARMUP_TIMEOUT_MS
          )
        })
        const result = await Promise.race([
          runSerializedBackendExport({
            plotlyJson: {
              data: [{ type: 'scatter', x: [0, 1], y: [0, 1] }],
              layout: { title: { text: 'warmup' } },
            },
            outputPath: warmupPath,
            options: { format: 'png', width: 32, height: 32 },
          }),
          timeoutResult,
        ])
        if (!result.success) {
          throw new Error(result.error ?? 'Kaleido warmup failed')
        }
        kaleidoWarmupDone = true
      } finally {
        try {
          await remove(warmupPath)
        } catch {
          // Non-fatal cleanup failure.
        }
      }
    })()
      .catch((error) => {
        console.warn('[Kaleido] warmup skipped:', error)
      })
      .finally(() => {
        kaleidoWarmupPromise = null
      })
  }

  await kaleidoWarmupPromise
}

const trimCapabilityReason = (value: unknown): string => {
  const normalized =
    typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : 'Unknown Kaleido error'
  return normalized.length > CAPABILITY_REASON_MAX_LEN
    ? `${normalized.slice(0, CAPABILITY_REASON_MAX_LEN)}...`
    : normalized
}

const probeSingleCapability = async (
  format: BackendOnlyExportFormat
): Promise<KaleidoFormatCapability> => {
  const checkedAt = Date.now()
  const dir = await tempDir()
  const probePath = await join(dir, `easycris-kaleido-probe-${format}-${checkedAt}.${format}`)
  try {
    const timeoutResult = new Promise<KaleidoExportResult>((resolve) => {
      setTimeout(
        () =>
          resolve({
            success: false,
            error: `Capability probe timed out after ${CAPABILITY_PROBE_TIMEOUT_MS}ms`,
          }),
        CAPABILITY_PROBE_TIMEOUT_MS
      )
    })

    const result = await Promise.race([
      runSerializedBackendExport({
        plotlyJson: {
          data: [{ type: 'scatter', mode: 'lines', x: [0, 1], y: [0, 1], name: 'probe' }],
          layout: { title: { text: `Kaleido ${format} probe` } },
        },
        outputPath: probePath,
        options: { format, width: 80, height: 80 },
      }),
      timeoutResult,
    ])

    if (result.success) {
      return { supported: true, checkedAt }
    }

    return {
      supported: false,
      reason: trimCapabilityReason(result.error),
      checkedAt,
    }
  } catch (error) {
    return {
      supported: false,
      reason: trimCapabilityReason(error instanceof Error ? error.message : String(error)),
      checkedAt,
    }
  } finally {
    try {
      await remove(probePath)
    } catch {
      // Ignore cleanup failures.
    }
  }
}

const buildUnavailableCapabilities = (reason: string): KaleidoCapabilities => {
  const checkedAt = Date.now()
  return {
    pdf: { supported: false, reason, checkedAt },
    tiff: { supported: false, reason, checkedAt },
  }
}

async function probeKaleidoCapabilities(): Promise<KaleidoCapabilities> {
  const backendReady = await pingPlotBackend()
  if (!backendReady) {
    return buildUnavailableCapabilities('Plot backend is not ready')
  }

  await ensureKaleidoWarmup()

  // Probe sequentially to avoid profile/contention races in shared Kaleido runtime.
  const pdf = await probeSingleCapability('pdf')
  const tiff = await probeSingleCapability('tiff')

  return { pdf, tiff }
}

export async function getKaleidoCapabilities(
  forceRefresh = false,
  bypassForceRefreshCooldown = false
): Promise<KaleidoCapabilities> {
  if (kaleidoCapabilitiesPromise) {
    return kaleidoCapabilitiesPromise
  }

  const cacheFresh =
    kaleidoCapabilitiesCache &&
    Date.now() - Math.max(kaleidoCapabilitiesCache.pdf.checkedAt, kaleidoCapabilitiesCache.tiff.checkedAt) <
      CAPABILITY_CACHE_TTL_MS

  if (!forceRefresh && kaleidoCapabilitiesCache && cacheFresh) {
    return kaleidoCapabilitiesCache
  }

  if (
    forceRefresh &&
    !bypassForceRefreshCooldown &&
    kaleidoCapabilitiesCache &&
    Date.now() - lastForcedCapabilityRefreshAt < CAPABILITY_FORCE_REFRESH_COOLDOWN_MS
  ) {
    return kaleidoCapabilitiesCache
  }

  if (forceRefresh) {
    lastForcedCapabilityRefreshAt = Date.now()
  }

  kaleidoCapabilitiesPromise = probeKaleidoCapabilities()
    .then((result) => {
      kaleidoCapabilitiesCache = result
      return result
    })
    .catch((error) => {
      const fallback = buildUnavailableCapabilities(
        trimCapabilityReason(error instanceof Error ? error.message : String(error))
      )
      kaleidoCapabilitiesCache = fallback
      return fallback
    })
    .finally(() => {
      kaleidoCapabilitiesPromise = null
    })

  return kaleidoCapabilitiesPromise
}

export async function prewarmKaleidoOnIdle(): Promise<void> {
  if (kaleidoWarmupDone) return
  if (!startupWarmupPromise) {
    startupWarmupPromise = enqueueKaleidoTask(async () => {
      await ensureKaleidoWarmup()
    }).finally(() => {
      startupWarmupPromise = null
    })
  }
  await startupWarmupPromise
}

export function getCachedKaleidoCapabilities(): KaleidoCapabilities | null {
  return kaleidoCapabilitiesCache
}

const normalizePieMarkers = (data: unknown[]): unknown[] => {
  return data.map((trace) => {
    if (!trace || typeof trace !== 'object') return trace
    const typed = trace as { type?: string; marker?: Record<string, unknown>; labels?: unknown }
    if (typed.type !== 'pie') return trace
    const marker = typed.marker && typeof typed.marker === 'object' ? { ...typed.marker } : {}
    if ('color' in marker && !('colors' in marker)) {
      const labelCount = Array.isArray(typed.labels) ? typed.labels.length : 1
      marker.colors = Array.from({ length: Math.max(1, labelCount) }, () => marker.color)
    }
    if ('color' in marker) {
      delete marker.color
    }
    return { ...typed, marker }
  })
}

const isTypedArray = (value: unknown): value is ArrayLike<number> =>
  ArrayBuffer.isView(value) && !(value instanceof DataView)

const isInvalidNumber = (value: unknown): boolean =>
  typeof value === 'number' && !Number.isFinite(value)

const isInvalidRangeValue = (value: unknown): boolean =>
  value === null || isInvalidNumber(value)

const hasInvalidPath = (value: unknown): boolean =>
  typeof value === 'string' && /NaN|Infinity/.test(value)

const sanitizeValue = (value: unknown): unknown => {
  if (value === null) return null
  if (value === undefined) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()

  if (Array.isArray(value)) {
    return value.map((entry) => {
      const sanitized = sanitizeValue(entry)
      return sanitized === undefined ? null : sanitized
    })
  }

  if (isTypedArray(value)) {
    return Array.from(value, (entry) => (Number.isFinite(entry) ? entry : null))
  }

  if (typeof value === 'object') {
    const cleaned: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue
      const sanitized = sanitizeValue(entry)
      if (sanitized !== undefined) {
        cleaned[key] = sanitized
      }
    }
    return cleaned
  }

  return value
}

const isValidAnnotation = (annotation: unknown): boolean => {
  if (!annotation || typeof annotation !== 'object') return false
  const ann = annotation as Record<string, unknown>
  if ('x' in ann && isInvalidRangeValue(ann.x)) return false
  if ('y' in ann && isInvalidRangeValue(ann.y)) return false
  if ('ax' in ann && isInvalidRangeValue(ann.ax)) return false
  if ('ay' in ann && isInvalidRangeValue(ann.ay)) return false
  if (hasInvalidPath(ann.path)) return false
  return true
}

const isValidShape = (shape: unknown): boolean => {
  if (!shape || typeof shape !== 'object') return false
  const shp = shape as Record<string, unknown>
  if (hasInvalidPath(shp.path)) return false
  if ('x0' in shp && isInvalidRangeValue(shp.x0)) return false
  if ('x1' in shp && isInvalidRangeValue(shp.x1)) return false
  if ('y0' in shp && isInvalidRangeValue(shp.y0)) return false
  if ('y1' in shp && isInvalidRangeValue(shp.y1)) return false
  if ('x' in shp && isInvalidRangeValue(shp.x)) return false
  if ('y' in shp && isInvalidRangeValue(shp.y)) return false
  return true
}

const sanitizeAxisForExport = (axis: unknown): unknown => {
  if (!axis || typeof axis !== 'object') return axis
  const axisObj = axis as Record<string, unknown>
  const range = axisObj.range
  if (Array.isArray(range) && range.some((value) => isInvalidRangeValue(value))) {
    const next = { ...axisObj }
    delete next.range
    return next
  }
  return axisObj
}

const sanitizeTraceForExport = (trace: unknown): unknown => {
  const sanitized = sanitizeValue(trace)
  if (!sanitized || typeof sanitized !== 'object') return sanitized
  const cleaned = { ...(sanitized as Record<string, unknown>) }
  delete cleaned.customdata
  delete cleaned.hovertemplate
  delete cleaned.hovertext
  delete cleaned.text  // Remove text field to prevent WebGL rendering crash (plotly/plotly.py#5300)
  delete cleaned.meta
  delete cleaned.uid
  delete cleaned.ids
  delete cleaned.transforms
  return cleaned
}

const cleanLayoutForExport = (layout: unknown): unknown => {
  if (!layout || typeof layout !== 'object') return layout ?? {}

  const sanitized = sanitizeValue(layout)
  if (!sanitized || typeof sanitized !== 'object') return sanitized ?? {}

  const cleaned = { ...(sanitized as Record<string, unknown>) }

  if (Array.isArray(cleaned.annotations)) {
    cleaned.annotations = cleaned.annotations.filter((ann) => isValidAnnotation(ann))
  }

  if (Array.isArray(cleaned.shapes)) {
    cleaned.shapes = cleaned.shapes.filter((shape) => isValidShape(shape))
  }

  if ('xaxis' in cleaned) {
    cleaned.xaxis = sanitizeAxisForExport(cleaned.xaxis)
  }

  if ('yaxis' in cleaned) {
    cleaned.yaxis = sanitizeAxisForExport(cleaned.yaxis)
  }

  return cleaned
}

const isInvalidJsonTransformError = (result: KaleidoExportResult): boolean => {
  const errorText = `${result.error ?? ''} ${result.details ?? ''}`
  return /invalid json/i.test(errorText)
}

const hashString = (input: string): string => {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(16)
}

const buildPayloadSignature = (
  format: KaleidoFormat,
  payload: { data: unknown[]; layout: unknown }
): string => {
  const serialized = JSON.stringify(payload)
  if (!serialized) return `${format}:empty`
  const sampled = serialized.length > 300_000 ? `${serialized.slice(0, 300_000)}::${serialized.length}` : serialized
  return `${format}:${hashString(sampled)}`
}

const stripPrivateKeysDeep = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => stripPrivateKeysDeep(entry))
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  const next: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('_')) continue
    next[key] = stripPrivateKeysDeep(entry)
  }
  return next
}

const buildBackendOnlyPayload = (
  plotlyJson: { data: unknown[]; layout: unknown },
  format: KaleidoFormat
): { data: unknown[]; layout: unknown } => {
  if (format !== 'pdf' && format !== 'tiff') {
    return plotlyJson
  }

  const data = (Array.isArray(plotlyJson.data) ? plotlyJson.data : [])
    .map((trace) => sanitizeTraceForExport(trace))
    .map((trace) => stripPrivateKeysDeep(trace))
    .filter((trace) => trace && typeof trace === 'object')

  const layout = stripPrivateKeysDeep(cleanLayoutForExport(plotlyJson.layout ?? {}))
  const typedLayout = (layout as Record<string, unknown>) ?? {}
  delete typedLayout.meta
  delete typedLayout.template
  delete typedLayout.updatemenus
  delete typedLayout.sliders
  delete typedLayout.selections
  delete typedLayout.activeselection
  delete typedLayout.newshape
  delete typedLayout.modebar

  return { data, layout: typedLayout }
}

const buildStrictFallbackPayload = (plotlyJson: {
  data: unknown[]
  layout: unknown
}): { data: unknown[]; layout: unknown } => {
  const strictData = (Array.isArray(plotlyJson.data) ? plotlyJson.data : [])
    .map((trace) => sanitizeTraceForExport(trace))
    .map((trace) => {
      if (!trace || typeof trace !== 'object') return trace
      const next = { ...(trace as Record<string, unknown>) }
      delete next.legendgrouptitle
      delete next.hoverlabel
      return next
    })
    .filter((trace) => trace && typeof trace === 'object')

  const strictLayout =
    (cleanLayoutForExport(plotlyJson.layout ?? {}) as Record<string, unknown>) ?? {}
  delete strictLayout.meta
  delete strictLayout.template
  delete strictLayout.updatemenus
  delete strictLayout.sliders

  return {
    data: strictData,
    layout: strictLayout,
  }
}

const runKaleidoExport = async (
  plotlyJson: { data: unknown[]; layout: unknown },
  outputPath: string,
  options: KaleidoExportOptions
): Promise<KaleidoExportResult> => {
  const runAttemptWithTimeout = (
    payload: { data: unknown[]; layout: unknown }
  ): Promise<KaleidoExportResult> => {
    const timeoutPromise = new Promise<KaleidoExportResult>((resolve) => {
      setTimeout(
        () => resolve({ success: false, error: `Kaleido export timed out after ${KALEIDO_TIMEOUT_MS}ms` }),
        KALEIDO_TIMEOUT_MS
      )
    })

    return Promise.race([
      runSerializedBackendExport({
        plotlyJson: payload as Record<string, unknown>,
        outputPath,
        options: {
          ...options,
          dpi: options.dpi ?? 300,
        },
      }),
      timeoutPromise,
    ])
  }

  return enqueueKaleidoTask(async () => {
    const backendPayload = buildBackendOnlyPayload(plotlyJson, options.format)
    const payloadSignature = buildPayloadSignature(options.format, backendPayload)

    if (
      (options.format === 'pdf' || options.format === 'tiff') &&
      invalidJsonCircuitBreaker.has(payloadSignature)
    ) {
      return {
        success: false,
        error: 'Skipped Kaleido for known invalid JSON payload signature in this session',
      }
    }

    if (options.format === 'pdf' || options.format === 'tiff') {
      let capabilities = await getKaleidoCapabilities()
      let capability = capabilities[options.format]
      if (!capability.supported) {
        // Allow one immediate bypassed refresh on actual export attempt.
        capabilities = await getKaleidoCapabilities(true, true)
        capability = capabilities[options.format]
      }
      if (!capability.supported) {
        return {
          success: false,
          error: capability.reason ?? `${options.format.toUpperCase()} export is unavailable`,
        }
      }
    }
    await ensureKaleidoWarmup()
    let result = await runAttemptWithTimeout(backendPayload)

    if (!result.success && isInvalidJsonTransformError(result)) {
      const strictPayload = buildStrictFallbackPayload(backendPayload)
      result = await runAttemptWithTimeout(strictPayload)
    }
    if (!result.success && isInvalidJsonTransformError(result)) {
      invalidJsonCircuitBreaker.add(payloadSignature)
    }
    if (!result.success) {
      console.error('[Kaleido] export failed:', {
        format: options.format,
        error: result.error ?? 'unknown',
        errorType: result.error_type,
        details: result.details,
        suspectPaths: result.suspect_paths,
        debugPayloadPath: result.debug_payload_path,
        replayCommand: result.replay_command,
        backendFingerprint: result.backend_fingerprint,
      })
    }
    return result
  })
}

export async function exportPlotlyWithKaleido(
  plotlyData: unknown[],
  plotlyLayout: unknown,
  outputPath: string,
  options: KaleidoExportOptions
): Promise<KaleidoExportResult> {
  const normalizedData = normalizePieMarkers(plotlyData ?? [])
  const cleanedData = Array.isArray(normalizedData)
    ? normalizedData
        .map((trace) => sanitizeTraceForExport(trace))
        .filter((trace) => trace && typeof trace === 'object')
    : []

  const plotlyJson = {
    data: Array.isArray(cleanedData) ? cleanedData : normalizedData,
    layout: cleanLayoutForExport(plotlyLayout ?? {}),
  }

  return runKaleidoExport(plotlyJson, outputPath, options)
}

export async function exportPlotWithKaleido(
  plot: PlotSpec,
  outputPath: string,
  options: KaleidoExportOptions
): Promise<KaleidoExportResult> {
  return exportPlotlyWithKaleido(
    (plot.plotlyData ?? []) as unknown[],
    plot.plotlyLayout ?? {},
    outputPath,
    options
  )
}

export const KALEIDO_FORMATS: KaleidoFormat[] = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'svg',
  'pdf',
  'tiff',
]

export default exportPlotWithKaleido
