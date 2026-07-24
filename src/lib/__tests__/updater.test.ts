import { beforeEach, describe, expect, it, vi } from 'vitest'
import { check } from '@tauri-apps/plugin-updater'
import { confirm } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import { readUpdaterStatusSnapshot, runUpdaterFlow } from '../updater'

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(),
}))

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}))

describe('runUpdaterFlow', () => {
  const checkMock = vi.mocked(check)
  const confirmMock = vi.mocked(confirm)
  const relaunchMock = vi.mocked(relaunch)

  beforeEach(() => {
    vi.clearAllMocks()
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear()
    }
  })

  it('returns no-update when no update is available', async () => {
    checkMock.mockResolvedValueOnce(null)

    const status = await runUpdaterFlow({ source: 'menu' })

    expect(status).toBe('no-update')
    expect(confirmMock).not.toHaveBeenCalled()
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('treats missing update feed/release as no-update', async () => {
    checkMock.mockRejectedValueOnce(new Error('latest.json returned 404'))

    const status = await runUpdaterFlow({ source: 'menu' })

    expect(status).toBe('no-update')
    expect(confirmMock).not.toHaveBeenCalled()
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('treats updater status-code endpoint misses as no-update', async () => {
    checkMock.mockRejectedValueOnce(
      new Error('update endpoint did not respond with a successful status code')
    )

    const status = await runUpdaterFlow({ source: 'menu' })

    expect(status).toBe('no-update')
    expect(confirmMock).not.toHaveBeenCalled()
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('does not treat generic status code failures as no-update', async () => {
    checkMock.mockRejectedValueOnce(new Error('request failed with status code 500'))

    const status = await runUpdaterFlow({ source: 'menu' })

    expect(status).toBe('failed')
    expect(confirmMock).not.toHaveBeenCalled()
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('downloads, installs and relaunches when user confirms', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)

    checkMock.mockResolvedValueOnce({
      version: '0.2.0',
      currentVersion: '0.1.0',
      rawJson: {},
      downloadAndInstall,
    } as any)
    confirmMock
      .mockResolvedValueOnce(true) // Update Available
      .mockResolvedValueOnce(true) // Restart now

    const status = await runUpdaterFlow({
      source: 'startup',
      platformOverride: 'other',
    })

    expect(status).toBe('installed')
    expect(downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(confirmMock).toHaveBeenCalledTimes(2)
    expect(relaunchMock).toHaveBeenCalledTimes(1)
  })

  it('uses windows handoff path without relaunch confirmation', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)

    checkMock.mockResolvedValueOnce({
      version: '0.2.0',
      currentVersion: '0.1.0',
      rawJson: {},
      downloadAndInstall,
    } as any)
    confirmMock.mockResolvedValueOnce(true) // Update Available

    const status = await runUpdaterFlow({
      source: 'menu',
      platformOverride: 'windows',
    })

    expect(status).toBe('installed')
    expect(downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('does not run install preflight when user rejects the update prompt', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
    const beforeInstall = vi.fn().mockResolvedValue(true)

    checkMock.mockResolvedValueOnce({
      version: '0.2.0',
      currentVersion: '0.1.0',
      rawJson: {},
      downloadAndInstall,
    } as any)
    confirmMock.mockResolvedValueOnce(false) // Update Available

    const status = await runUpdaterFlow({
      source: 'menu',
      beforeInstall,
    })

    expect(status).toBe('skipped')
    expect(beforeInstall).not.toHaveBeenCalled()
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })

  it('runs install preflight after update acceptance without re-showing release notes', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
    const beforeInstall = vi.fn().mockResolvedValue(false)

    checkMock.mockResolvedValueOnce({
      version: '0.2.0',
      currentVersion: '0.1.0',
      body: 'Added A',
      rawJson: {},
      downloadAndInstall,
    } as any)
    confirmMock.mockResolvedValueOnce(true) // Update Available

    const status = await runUpdaterFlow({
      source: 'menu',
      beforeInstall,
    })

    expect(status).toBe('skipped')
    expect(beforeInstall).toHaveBeenCalledTimes(1)
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const [message] = confirmMock.mock.calls[0] ?? []
    expect(String(message)).toContain("What's new:\nAdded A")
  })

  it('includes release notes from update body in confirmation message', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)

    checkMock.mockResolvedValueOnce({
      version: '0.2.0',
      currentVersion: '0.1.0',
      body: 'Added A\nFixed B',
      rawJson: {},
      downloadAndInstall,
    } as any)
    confirmMock.mockResolvedValueOnce(false)

    const status = await runUpdaterFlow({ source: 'menu' })

    expect(status).toBe('skipped')
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const [message] = confirmMock.mock.calls[0] ?? []
    expect(String(message)).toContain("What's new:\nAdded A\nFixed B")
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('falls back to rawJson.notes when update body is missing', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)

    checkMock.mockResolvedValueOnce({
      version: '0.2.0',
      currentVersion: '0.1.0',
      rawJson: { notes: 'Fallback notes' },
      downloadAndInstall,
    } as any)
    confirmMock.mockResolvedValueOnce(false)

    const status = await runUpdaterFlow({ source: 'menu' })

    expect(status).toBe('skipped')
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const [message] = confirmMock.mock.calls[0] ?? []
    expect(String(message)).toContain("What's new:\nFallback notes")
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('omits release notes section when no notes are available', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)

    checkMock.mockResolvedValueOnce({
      version: '0.2.0',
      currentVersion: '0.1.0',
      body: '   ',
      rawJson: { notes: 123 },
      downloadAndInstall,
    } as any)
    confirmMock.mockResolvedValueOnce(false)

    const status = await runUpdaterFlow({ source: 'menu' })

    expect(status).toBe('skipped')
    expect(confirmMock).toHaveBeenCalledTimes(1)
    const [message] = confirmMock.mock.calls[0] ?? []
    expect(String(message)).not.toContain("What's new:")
    expect(String(message)).toContain('Update 0.2.0 is available.')
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('returns busy on concurrent invocations', async () => {
    let releaseCheck: ((value: any) => void) | undefined
    checkMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCheck = resolve
        }) as any
    )

    const firstRun = runUpdaterFlow({ source: 'startup' })
    const secondStatus = await runUpdaterFlow({ source: 'menu' })

    expect(secondStatus).toBe('busy')

    releaseCheck?.(null)
    await firstRun
  })

  it('emits staged progress and persists status snapshot', async () => {
    const phases: string[] = []
    const downloadAndInstall = vi.fn().mockImplementation(async (onEvent: any) => {
      onEvent({ event: 'Started', data: { contentLength: 100 } })
      onEvent({ event: 'Progress', data: { chunkLength: 40 } })
      onEvent({ event: 'Progress', data: { chunkLength: 60 } })
      onEvent({ event: 'Finished' })
    })

    checkMock.mockResolvedValueOnce({
      version: '0.2.0',
      currentVersion: '0.1.0',
      rawJson: {},
      downloadAndInstall,
    } as any)
    confirmMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const status = await runUpdaterFlow({
      source: 'menu',
      platformOverride: 'other',
      onProgress: event => phases.push(event.phase),
    })

    expect(status).toBe('installed')
    expect(phases).toContain('checking')
    expect(phases).toContain('update_available')
    expect(phases).toContain('downloading')
    expect(phases).toContain('installing')
    expect(phases).toContain('done')

    const snapshot = readUpdaterStatusSnapshot()
    expect(snapshot.lastResult).toBe('installed')
    expect(snapshot.lastVersion).toBe('0.2.0')
    expect(snapshot.events.length).toBeGreaterThan(0)
  })
})
