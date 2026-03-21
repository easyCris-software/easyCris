import { describe, expect, it, vi } from 'vitest'
import {
  buildCacheHealthNotification,
  createSingleFlightRunner,
  getCacheHealthDecision,
  readCacheHealthSuppression,
  resolveCacheHealthConfig,
  writeCacheHealthSuppressionForDays,
  writeCacheHealthSuppressionForever,
} from '@/utils/cacheHealth'

describe('cacheHealth', () => {
  it('uses defaults when env values are absent', () => {
    const config = resolveCacheHealthConfig({})
    expect(config.thresholds.cacheThresholdBytes).toBe(5 * 1024 * 1024 * 1024)
    expect(config.thresholds.lowDiskThresholdBytes).toBe(10 * 1024 * 1024 * 1024)
    expect(config.warnPolicy).toBe('cache_or_disk')
    expect(config.suppressDays).toBe(7)
  })

  it('uses valid env overrides', () => {
    const config = resolveCacheHealthConfig({
      VITE_CACHE_HEALTH_CACHE_THRESHOLD_BYTES: '100',
      VITE_CACHE_HEALTH_LOW_DISK_THRESHOLD_BYTES: '200',
      VITE_CACHE_HEALTH_WARN_POLICY: 'cache_and_disk',
      VITE_CACHE_HEALTH_SUPPRESS_DAYS: '14',
    })

    expect(config.thresholds.cacheThresholdBytes).toBe(100)
    expect(config.thresholds.lowDiskThresholdBytes).toBe(200)
    expect(config.warnPolicy).toBe('cache_and_disk')
    expect(config.suppressDays).toBe(14)
  })

  it('warns and falls back when env values are malformed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = resolveCacheHealthConfig({
      VITE_CACHE_HEALTH_CACHE_THRESHOLD_BYTES: '2.5e9',
      VITE_CACHE_HEALTH_LOW_DISK_THRESHOLD_BYTES: '2,000,000',
      VITE_CACHE_HEALTH_SUPPRESS_DAYS: '-7',
    })

    expect(config.thresholds.cacheThresholdBytes).toBe(5 * 1024 * 1024 * 1024)
    expect(config.thresholds.lowDiskThresholdBytes).toBe(10 * 1024 * 1024 * 1024)
    expect(config.suppressDays).toBe(7)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('does not warn when exactly at low disk threshold boundary', () => {
    const config = resolveCacheHealthConfig({
      VITE_CACHE_HEALTH_CACHE_THRESHOLD_BYTES: '1000',
      VITE_CACHE_HEALTH_LOW_DISK_THRESHOLD_BYTES: '200',
    })
    const decision = getCacheHealthDecision(
      { cacheBytes: 10, availableDiskBytes: 200 },
      config
    )

    expect(decision.diskBelowThreshold).toBe(false)
    expect(decision.shouldWarn).toBe(false)
  })

  it('does not warn when disk info is null and cache is under threshold', () => {
    const config = resolveCacheHealthConfig({
      VITE_CACHE_HEALTH_CACHE_THRESHOLD_BYTES: '1000',
      VITE_CACHE_HEALTH_LOW_DISK_THRESHOLD_BYTES: '200',
    })
    const decision = getCacheHealthDecision(
      { cacheBytes: 100, availableDiskBytes: null },
      config
    )

    expect(decision.shouldWarn).toBe(false)
    expect(decision.diskBelowThreshold).toBe(false)
  })

  it('supports warn policy switching', () => {
    const summary = { cacheBytes: 150, availableDiskBytes: 50 }
    const cacheOnly = getCacheHealthDecision(
      summary,
      resolveCacheHealthConfig({
        VITE_CACHE_HEALTH_CACHE_THRESHOLD_BYTES: '100',
        VITE_CACHE_HEALTH_LOW_DISK_THRESHOLD_BYTES: '100',
        VITE_CACHE_HEALTH_WARN_POLICY: 'cache_only',
      })
    )
    const diskOnly = getCacheHealthDecision(
      summary,
      resolveCacheHealthConfig({
        VITE_CACHE_HEALTH_CACHE_THRESHOLD_BYTES: '100',
        VITE_CACHE_HEALTH_LOW_DISK_THRESHOLD_BYTES: '100',
        VITE_CACHE_HEALTH_WARN_POLICY: 'disk_only',
      })
    )
    const andPolicy = getCacheHealthDecision(
      summary,
      resolveCacheHealthConfig({
        VITE_CACHE_HEALTH_CACHE_THRESHOLD_BYTES: '100',
        VITE_CACHE_HEALTH_LOW_DISK_THRESHOLD_BYTES: '100',
        VITE_CACHE_HEALTH_WARN_POLICY: 'cache_and_disk',
      })
    )

    expect(cacheOnly.shouldWarn).toBe(true)
    expect(diskOnly.shouldWarn).toBe(true)
    expect(andPolicy.shouldWarn).toBe(true)
  })

  it('reads and writes suppression values safely', () => {
    const storageMap = new Map<string, string>()
    const storage = {
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageMap.set(key, value)
      },
    }
    const key = 'cache-key'
    const now = Date.UTC(2026, 1, 28)

    expect(readCacheHealthSuppression(storage, key, now)).toBeNull()
    writeCacheHealthSuppressionForDays(storage, key, 7, now)
    expect(readCacheHealthSuppression(storage, key, now)).toEqual({
      kind: 'until',
      untilMs: now + 7 * 24 * 60 * 60 * 1000,
    })

    writeCacheHealthSuppressionForever(storage, key)
    expect(readCacheHealthSuppression(storage, key, now)).toEqual({ kind: 'never' })
  })

  it('builds stable notification text from summary + decision', () => {
    const notification = buildCacheHealthNotification(
      {
        cacheBytes: 1024,
        appCacheBytes: 512,
        projectDataBytes: 512,
        availableDiskBytes: 2048,
      },
      {
        shouldWarn: true,
        cacheAboveThreshold: true,
        diskBelowThreshold: true,
      },
      (value) => `${value}B`
    )

    expect(notification.title).toBe('Storage check')
    expect(notification.description).toContain('easyCris storage is large and disk space is low.')
    expect(notification.description).toContain('Total storage: 1024B.')
  })

  it('single-flight runner deduplicates concurrent calls', async () => {
    const runSingleFlight = createSingleFlightRunner<number>()
    const fn = vi.fn(async () => 42)

    const [a, b] = await Promise.all([runSingleFlight(fn), runSingleFlight(fn)])
    expect(a).toBe(42)
    expect(b).toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('single-flight runner allows a new flight after resolve', async () => {
    const runSingleFlight = createSingleFlightRunner<number>()
    const fn = vi.fn(async () => 42)

    await runSingleFlight(fn)
    await runSingleFlight(fn)

    expect(fn).toHaveBeenCalledTimes(2)
  })
})
