import type { CacheHealthSummary } from '@/services/cacheService'

export type CacheHealthWarnPolicy =
  | 'cache_or_disk'
  | 'cache_and_disk'
  | 'cache_only'
  | 'disk_only'

export type CacheHealthThresholds = {
  cacheThresholdBytes: number
  lowDiskThresholdBytes: number
}

export type CacheHealthConfig = {
  thresholds: CacheHealthThresholds
  warnPolicy: CacheHealthWarnPolicy
  suppressDays: number
}

export type CacheHealthDecision = {
  shouldWarn: boolean
  cacheAboveThreshold: boolean
  diskBelowThreshold: boolean
}

export type CacheHealthNotification = {
  title: string
  description: string
}

export type CacheHealthSuppression =
  | { kind: 'never' }
  | { kind: 'until'; untilMs: number }
  | null

export type LocalStorageLike = Pick<Storage, 'getItem' | 'setItem'>

const DEFAULT_CACHE_THRESHOLD_BYTES = 5 * 1024 * 1024 * 1024
const DEFAULT_LOW_DISK_THRESHOLD_BYTES = 10 * 1024 * 1024 * 1024
const DEFAULT_SUPPRESS_DAYS = 7
const DEFAULT_WARN_POLICY: CacheHealthWarnPolicy = 'cache_or_disk'
const SUPPRESSION_NEVER_VALUE = 'never'

const parsePositiveInteger = (
  fieldName: string,
  value: unknown,
  fallback: number
): number => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    console.warn(`[CacheHealth] Invalid ${fieldName} value "${value}". Using default ${fallback}.`)
    return fallback
  }
  const parsed = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[CacheHealth] Invalid ${fieldName} value "${value}". Using default ${fallback}.`)
    return fallback
  }
  return parsed
}

const parseWarnPolicy = (value: unknown): CacheHealthWarnPolicy => {
  if (value === 'cache_and_disk') return 'cache_and_disk'
  if (value === 'cache_only') return 'cache_only'
  if (value === 'disk_only') return 'disk_only'
  return DEFAULT_WARN_POLICY
}

export const resolveCacheHealthConfig = (
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>
): CacheHealthConfig => {
  const cacheThresholdBytes = parsePositiveInteger(
    'VITE_CACHE_HEALTH_CACHE_THRESHOLD_BYTES',
    env.VITE_CACHE_HEALTH_CACHE_THRESHOLD_BYTES,
    DEFAULT_CACHE_THRESHOLD_BYTES
  )
  const lowDiskThresholdBytes = parsePositiveInteger(
    'VITE_CACHE_HEALTH_LOW_DISK_THRESHOLD_BYTES',
    env.VITE_CACHE_HEALTH_LOW_DISK_THRESHOLD_BYTES,
    DEFAULT_LOW_DISK_THRESHOLD_BYTES
  )
  const suppressDays = parsePositiveInteger(
    'VITE_CACHE_HEALTH_SUPPRESS_DAYS',
    env.VITE_CACHE_HEALTH_SUPPRESS_DAYS,
    DEFAULT_SUPPRESS_DAYS
  )
  const warnPolicy = parseWarnPolicy(env.VITE_CACHE_HEALTH_WARN_POLICY)

  return {
    thresholds: {
      cacheThresholdBytes,
      lowDiskThresholdBytes,
    },
    warnPolicy,
    suppressDays,
  }
}

export const getCacheHealthDecision = (
  summary: CacheHealthSummary,
  config: CacheHealthConfig
): CacheHealthDecision => {
  const cacheAboveThreshold = summary.cacheBytes >= config.thresholds.cacheThresholdBytes
  const diskBelowThreshold =
    typeof summary.availableDiskBytes === 'number' &&
    summary.availableDiskBytes < config.thresholds.lowDiskThresholdBytes

  const shouldWarn =
    config.warnPolicy === 'cache_and_disk'
      ? cacheAboveThreshold && diskBelowThreshold
      : config.warnPolicy === 'cache_only'
        ? cacheAboveThreshold
        : config.warnPolicy === 'disk_only'
          ? diskBelowThreshold
          : cacheAboveThreshold || diskBelowThreshold

  return {
    shouldWarn,
    cacheAboveThreshold,
    diskBelowThreshold,
  }
}

export const readCacheHealthSuppression = (
  storage: LocalStorageLike,
  storageKey: string,
  nowMs: number
): CacheHealthSuppression => {
  try {
    const raw = storage.getItem(storageKey)
    if (!raw) return null
    if (raw === SUPPRESSION_NEVER_VALUE) {
      return { kind: 'never' }
    }
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return null
    if (parsed <= nowMs) return null
    return { kind: 'until', untilMs: parsed }
  } catch {
    return null
  }
}

export const writeCacheHealthSuppressionForDays = (
  storage: LocalStorageLike,
  storageKey: string,
  suppressDays: number,
  nowMs: number = Date.now()
): void => {
  const safeDays = Number.isFinite(suppressDays) && suppressDays > 0 ? suppressDays : DEFAULT_SUPPRESS_DAYS
  const suppressUntil = nowMs + safeDays * 24 * 60 * 60 * 1000
  try {
    storage.setItem(storageKey, String(suppressUntil))
  } catch {
    // Best effort only.
  }
}

export const writeCacheHealthSuppressionForever = (
  storage: LocalStorageLike,
  storageKey: string
): void => {
  try {
    storage.setItem(storageKey, SUPPRESSION_NEVER_VALUE)
  } catch {
    // Best effort only.
  }
}

export const buildCacheHealthNotification = (
  summary: CacheHealthSummary,
  decision: CacheHealthDecision,
  formatBytes: (bytes: number) => string
): CacheHealthNotification => {
  const totalText = formatBytes(summary.cacheBytes)
  const appText = typeof summary.appCacheBytes === 'number' ? formatBytes(summary.appCacheBytes) : null
  const projectText =
    typeof summary.projectDataBytes === 'number' ? formatBytes(summary.projectDataBytes) : null
  const freeDiskText =
    typeof summary.availableDiskBytes === 'number' ? formatBytes(summary.availableDiskBytes) : null

  const reason =
    decision.cacheAboveThreshold && decision.diskBelowThreshold
      ? 'easyCris storage is large and disk space is low.'
      : decision.cacheAboveThreshold
        ? 'easyCris storage is above the configured threshold.'
        : 'Disk space is below the configured threshold.'

  const detailParts = [`Total storage: ${totalText}.`]
  if (appText) detailParts.push(`AppData cache: ${appText}.`)
  if (projectText) detailParts.push(`Project-adjacent data: ${projectText}.`)
  if (freeDiskText) detailParts.push(`Minimum free disk across storage drives: ${freeDiskText}.`)

  return {
    title: 'Storage check',
    description: `${reason} ${detailParts.join(' ')} Use File > Cache for cleanup controls.`,
  }
}

export const createSingleFlightRunner = <T>() => {
  let inFlight: Promise<T> | null = null
  return (task: () => Promise<T>): Promise<T> => {
    if (inFlight) return inFlight
    inFlight = task().finally(() => {
      inFlight = null
    })
    return inFlight
  }
}
