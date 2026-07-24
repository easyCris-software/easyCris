import { check } from '@tauri-apps/plugin-updater'
import { confirm } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import { logger } from './logger'

export type UpdaterStatus =
  | 'no-update'
  | 'installed'
  | 'skipped'
  | 'failed'
  | 'busy'

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'update_available'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'closing_for_install'
  | 'relaunching'
  | 'done'
  | 'failed'
  | 'busy'

export type UpdaterProgressEvent = {
  phase: UpdaterPhase
  message: string
  version?: string | null
  releaseNotes?: string | null
  downloadedBytes?: number | null
  totalBytes?: number | null
  progressPercent?: number | null
  error?: string | null
}

export type UpdaterStatusSnapshot = {
  lastCheckAt: string | null
  lastResult: UpdaterStatus | 'checking' | null
  lastVersion: string | null
  lastError: string | null
  events: Array<{
    at: string
    kind: string
    phase: UpdaterPhase
    detail?: string
    version?: string
  }>
}

type UpdaterFlowOptions = {
  source: 'startup' | 'menu'
  onProgress?: (event: UpdaterProgressEvent) => void
  beforeInstall?: () => Promise<boolean>
  platformOverride?: 'windows' | 'other'
}

let updateFlowInProgress = false
const UPDATER_STATUS_KEY = 'easycris.updater.status.v1'
const MAX_STATUS_EVENTS = 40
const MAX_RELEASE_NOTES_CHARS = 4000

function getDefaultUpdaterStatusSnapshot(): UpdaterStatusSnapshot {
  return {
    lastCheckAt: null,
    lastResult: null,
    lastVersion: null,
    lastError: null,
    events: [],
  }
}

export function readUpdaterStatusSnapshot(): UpdaterStatusSnapshot {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return getDefaultUpdaterStatusSnapshot()
    }
    const raw = window.localStorage.getItem(UPDATER_STATUS_KEY)
    if (!raw) return getDefaultUpdaterStatusSnapshot()
    const parsed = JSON.parse(raw) as Partial<UpdaterStatusSnapshot>
    return {
      ...getDefaultUpdaterStatusSnapshot(),
      ...parsed,
      events: Array.isArray(parsed.events)
        ? parsed.events.slice(-MAX_STATUS_EVENTS)
        : [],
    }
  } catch {
    return getDefaultUpdaterStatusSnapshot()
  }
}

function writeUpdaterStatusSnapshot(snapshot: UpdaterStatusSnapshot): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return
    }
    window.localStorage.setItem(UPDATER_STATUS_KEY, JSON.stringify(snapshot))
  } catch {
    // no-op (storage errors should never break updater flow)
  }
}

function appendUpdaterEvent(
  snapshot: UpdaterStatusSnapshot,
  event: {
    kind: string
    phase: UpdaterPhase
    detail?: string
    version?: string
  }
): UpdaterStatusSnapshot {
  const nextEvents = [
    ...snapshot.events,
    {
      at: new Date().toISOString(),
      kind: event.kind,
      phase: event.phase,
      detail: event.detail,
      version: event.version,
    },
  ].slice(-MAX_STATUS_EVENTS)
  return {
    ...snapshot,
    events: nextEvents,
  }
}

function detectWindowsPlatform(options: UpdaterFlowOptions): boolean {
  if (options.platformOverride) {
    return options.platformOverride === 'windows'
  }
  if (typeof navigator === 'undefined') return false
  return /windows/i.test(navigator.userAgent)
}

function looksLikeNoUpdateCondition(error: unknown): boolean {
  const message = String(error ?? '').toLowerCase()
  return (
    message.includes('404') ||
    message.includes('204') ||
    message.includes('not found') ||
    message.includes('no release') ||
    message.includes('release not found') ||
    message.includes('latest.json') ||
    message.includes('did not respond with a successful status code') ||
    message.includes('plugin') && message.includes('disabled') ||
    message.includes('updater') && message.includes('not enabled') ||
    message.includes('updater') && message.includes('not active')
  )
}

function trimReleaseNotes(notes: string): string {
  const normalized = notes.trim()
  if (normalized.length <= MAX_RELEASE_NOTES_CHARS) {
    return normalized
  }
  return `${normalized.slice(0, MAX_RELEASE_NOTES_CHARS).trimEnd()}…`
}

export async function runUpdaterFlow(
  options: UpdaterFlowOptions
): Promise<UpdaterStatus> {
  const isWindows = detectWindowsPlatform(options)
  let snapshot = readUpdaterStatusSnapshot()
  let downloadedBytes = 0
  let totalBytes: number | null = null
  let lastLoggedPercent = -1
  let windowsHandoffRecorded = false
  const emit = (event: UpdaterProgressEvent) => {
    options.onProgress?.(event)
  }

  if (updateFlowInProgress) {
    logger.info('Update flow already in progress, skipping duplicate request')
    emit({
      phase: 'busy',
      message: 'Update already in progress.',
    })
    snapshot = appendUpdaterEvent(snapshot, {
      kind: 'update_busy',
      phase: 'busy',
      detail: `source=${options.source}`,
    })
    writeUpdaterStatusSnapshot(snapshot)
    return 'busy'
  }

  updateFlowInProgress = true

  try {
    emit({
      phase: 'checking',
      message: 'Checking for updates…',
    })
    snapshot = {
      ...appendUpdaterEvent(snapshot, {
        kind: 'check_start',
        phase: 'checking',
        detail: `source=${options.source}`,
      }),
      lastCheckAt: new Date().toISOString(),
      lastResult: 'checking',
      lastError: null,
    }
    writeUpdaterStatusSnapshot(snapshot)

    logger.info('Updater lifecycle event', {
      event: 'check_start',
      source: options.source,
    })

    let update: Awaited<ReturnType<typeof check>>
    try {
      update = await check()
    } catch (error) {
      if (looksLikeNoUpdateCondition(error)) {
        logger.info(`No update available (${options.source})`, {
          reason: String(error),
        })
        emit({
          phase: 'done',
          message: 'No updates available. You are on the latest version.',
        })
        snapshot = {
          ...appendUpdaterEvent(snapshot, {
            kind: 'check_no_update',
            phase: 'done',
            detail: String(error),
          }),
          lastResult: 'no-update',
          lastError: null,
        }
        writeUpdaterStatusSnapshot(snapshot)
        return 'no-update'
      }
      throw error
    }

    if (!update) {
      logger.debug(`No update available (${options.source})`)
      emit({
        phase: 'done',
        message: 'No updates available. You are on the latest version.',
      })
      snapshot = {
        ...appendUpdaterEvent(snapshot, {
          kind: 'check_no_update',
          phase: 'done',
          detail: 'check() returned null',
        }),
        lastResult: 'no-update',
        lastError: null,
      }
      writeUpdaterStatusSnapshot(snapshot)
      return 'no-update'
    }

    logger.info(`Update available (${options.source})`, {
      version: update.version,
      currentVersion: update.currentVersion,
    })
    logger.info('Updater lifecycle event', {
      event: 'update_available',
      version: update.version,
      source: options.source,
    })

    const fallbackNotes = (update.rawJson as { notes?: unknown })?.notes
    const whatsNew =
      update.body?.trim() ||
      (typeof fallbackNotes === 'string' ? fallbackNotes.trim() : '')
    const releaseNotes = whatsNew ? trimReleaseNotes(whatsNew) : null
    emit({
      phase: 'update_available',
      message: `Update ${update.version} is available.`,
      version: update.version,
      releaseNotes,
    })
    snapshot = {
      ...appendUpdaterEvent(snapshot, {
        kind: 'update_available',
        phase: 'update_available',
        version: update.version,
      }),
      lastVersion: update.version,
      lastError: null,
    }
    writeUpdaterStatusSnapshot(snapshot)

    const updateMessage =
      `Update ${update.version} is available.` +
      (releaseNotes ? `\n\nWhat's new:\n${releaseNotes}` : '') +
      '\n\nDownload and install now?'

    const shouldUpdate = await confirm(
      updateMessage,
      {
        title: 'Update Available',
        kind: 'info',
      }
    )

    if (!shouldUpdate) {
      logger.info(`User skipped update install (${options.source})`)
      emit({
        phase: 'done',
        message: 'Update installation skipped.',
        version: update.version,
        releaseNotes,
      })
      snapshot = {
        ...appendUpdaterEvent(snapshot, {
          kind: 'update_skipped',
          phase: 'done',
          version: update.version,
          detail: `source=${options.source}`,
        }),
        lastResult: 'skipped',
        lastError: null,
      }
      writeUpdaterStatusSnapshot(snapshot)
      return 'skipped'
    }

    const proceedToInstall = options.beforeInstall
      ? await options.beforeInstall()
      : true

    if (!proceedToInstall) {
      emit({
        phase: 'done',
        message: 'Update installation canceled before download.',
        version: update.version,
      })
      snapshot = {
        ...appendUpdaterEvent(snapshot, {
          kind: 'install_preflight_canceled',
          phase: 'done',
          version: update.version,
        }),
        lastResult: 'skipped',
        lastError: null,
      }
      writeUpdaterStatusSnapshot(snapshot)
      return 'skipped'
    }

    emit({
      phase: 'downloading',
      message: 'Downloading update…',
      version: update.version,
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: null,
      releaseNotes,
    })
    snapshot = appendUpdaterEvent(snapshot, {
      kind: 'download_start',
      phase: 'downloading',
      version: update.version,
    })
    writeUpdaterStatusSnapshot(snapshot)
    logger.info('Updater lifecycle event', {
      event: 'download_start',
      version: update.version,
    })

    await update.downloadAndInstall(event => {
      switch (event.event) {
        case 'Started':
          totalBytes = event.data.contentLength ?? null
          downloadedBytes = 0
          emit({
            phase: 'downloading',
            message: 'Downloading update…',
            version: update.version,
            downloadedBytes,
            totalBytes,
            progressPercent: null,
            releaseNotes,
          })
          logger.info('Update download started', {
            bytes: event.data.contentLength ?? null,
          })
          logger.info('Updater lifecycle event', {
            event: 'download_started',
            version: update.version,
            bytesTotal: event.data.contentLength ?? null,
          })
          break
        case 'Progress': {
          downloadedBytes += event.data.chunkLength
          const percent =
            totalBytes && totalBytes > 0
              ? Math.max(
                  downloadedBytes > 0 ? 1 : 0,
                  Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
                )
              : null
          emit({
            phase: 'downloading',
            message: percent !== null
              ? `Downloading update… ${percent}%`
              : 'Downloading update…',
            version: update.version,
            downloadedBytes,
            totalBytes,
            progressPercent: percent,
            releaseNotes,
          })
          if (percent !== null && percent >= 0) {
            if (percent - lastLoggedPercent >= 5 || percent === 100) {
              lastLoggedPercent = percent
              snapshot = appendUpdaterEvent(snapshot, {
                kind: 'download_progress',
                phase: 'downloading',
                version: update.version,
                detail: `${percent}%`,
              })
              writeUpdaterStatusSnapshot(snapshot)
            }
          }
          logger.debug('Update download progress', {
            chunkBytes: event.data.chunkLength,
          })
          break
        }
        case 'Finished':
          emit({
            phase: 'installing',
            message: isWindows
              ? 'Installing update… easyCris will close to launch installer.'
              : 'Installing update…',
            version: update.version,
            downloadedBytes,
            totalBytes,
            progressPercent: 100,
            releaseNotes,
          })
          snapshot = appendUpdaterEvent(snapshot, {
            kind: 'download_finished',
            phase: 'verifying',
            version: update.version,
          })
          writeUpdaterStatusSnapshot(snapshot)
          logger.info('Update download finished')
          logger.info('Updater lifecycle event', {
            event: 'download_finished',
            version: update.version,
          })
          if (isWindows) {
            // Record handoff state before installer launch since process can exit during install.
            emit({
              phase: 'closing_for_install',
              message: 'Closing easyCris to launch installer…',
              version: update.version,
            })
            snapshot = {
              ...appendUpdaterEvent(snapshot, {
                kind: 'app_exit_for_install',
                phase: 'closing_for_install',
                version: update.version,
              }),
              lastResult: 'installed',
              lastError: null,
              lastVersion: update.version,
            }
            writeUpdaterStatusSnapshot(snapshot)
            windowsHandoffRecorded = true
          }
          break
      }
    })

    if (!windowsHandoffRecorded) {
      snapshot = appendUpdaterEvent(snapshot, {
        kind: isWindows ? 'app_exit_for_install' : 'install_success',
        phase: isWindows ? 'closing_for_install' : 'done',
        version: update.version,
      })
      writeUpdaterStatusSnapshot(snapshot)
    }

    if (isWindows) {
      return 'installed'
    }

    const shouldRestart = await confirm(
      'Update installed successfully.\n\nRestart now to apply the update?',
      {
        title: 'Restart Required',
        kind: 'info',
      }
    )

    if (shouldRestart) {
      snapshot = {
        ...appendUpdaterEvent(snapshot, {
          kind: 'relaunch_requested',
          phase: 'relaunching',
          version: update.version,
        }),
        lastResult: 'installed',
        lastError: null,
        lastVersion: update.version,
      }
      writeUpdaterStatusSnapshot(snapshot)
      emit({
        phase: 'relaunching',
        message: 'Restarting easyCris…',
        version: update.version,
      })
      await relaunch()
      return 'installed'
    }

    emit({
      phase: 'done',
      message: 'Update installed. Restart later to finish.',
      version: update.version,
    })
    snapshot = {
      ...appendUpdaterEvent(snapshot, {
        kind: 'install_complete_waiting_restart',
        phase: 'done',
        version: update.version,
      }),
      lastResult: 'installed',
      lastError: null,
      lastVersion: update.version,
    }
    writeUpdaterStatusSnapshot(snapshot)

    return 'installed'
  } catch (error) {
    logger.warn(`Updater flow failed (${options.source})`, {
      error: String(error),
    })
    logger.warn('Updater lifecycle event', {
      event: 'install_error',
      source: options.source,
      error: String(error),
    })
    emit({
      phase: 'failed',
      message: 'Update failed. Please retry.',
      error: String(error),
    })
    snapshot = {
      ...appendUpdaterEvent(snapshot, {
        kind: 'install_error',
        phase: 'failed',
        detail: String(error),
      }),
      lastResult: 'failed',
      lastError: String(error),
    }
    writeUpdaterStatusSnapshot(snapshot)
    return 'failed'
  } finally {
    updateFlowInProgress = false
  }
}
