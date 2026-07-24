export type PasteJobSource = 'paste' | 'paste-values' | 'paste-transpose' | 'e2e-paste'

export interface PasteJobLockController {
  acquire: (params: {
    owner: string
    operation: string
    stage?: string
    progress?: number
    indeterminate?: boolean
  }) => string | null
  update: (
    token: string,
    updates: {
      stage?: string
      progress?: number
      indeterminate?: boolean
      operation?: string
    }
  ) => void
  release: (token: string) => boolean
}

export type PasteJobResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'lock-unavailable' }

export interface SingleChunkPasteJobOptions<T> {
  source: PasteJobSource
  useVisualLock: boolean
  lock?: PasteJobLockController
  run: (progress?: {
    update: (updates: {
      stage?: string
      progress?: number
      indeterminate?: boolean
      operation?: string
    }) => void
  }) => Promise<T> | T
}

export async function runSingleChunkPasteJob<T>({
  useVisualLock,
  lock,
  run,
}: SingleChunkPasteJobOptions<T>): Promise<PasteJobResult<T>> {
  if (!useVisualLock) {
    return { ok: true, value: await run() }
  }

  const token = lock?.acquire({
    owner: 'paste',
    operation: 'Pasting data',
    stage: 'Preparing paste...',
    progress: 0,
  }) ?? null
  if (!token) {
    return { ok: false, reason: 'lock-unavailable' }
  }

  try {
    lock?.update(token, {
      stage: 'Preparing paste...',
      progress: 5,
    })
    const value = await run({
      update: (updates) => lock?.update(token, updates),
    })
    return { ok: true, value }
  } finally {
    lock?.release(token)
  }
}
