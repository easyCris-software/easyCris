import type { Layout } from 'plotly.js'

export const SYSTEM_ANNOTATION_NAMES = [
  '_title_',
  '_xaxis_title_',
  '_yaxis_title_',
  '_legend_',
] as const

export type SystemAnnotationName = (typeof SYSTEM_ANNOTATION_NAMES)[number]

export const SYSTEM_ANNOTATION_NAME_SET = new Set<string>(SYSTEM_ANNOTATION_NAMES)

type AnnotationRecord = Record<string, unknown>

export interface SystemAnnotationTextHints {
  titleText?: string
  xAxisTitleText?: string
  yAxisTitleText?: string
  legendText?: string
}

interface MergeAnnotationsByIdentityOptions {
  current: unknown[]
  incoming: unknown[]
  rendered?: unknown[]
  protectedNames?: ReadonlySet<string>
}

const HINT_KEY_BY_NAME: Record<SystemAnnotationName, keyof SystemAnnotationTextHints> = {
  _title_: 'titleText',
  _xaxis_title_: 'xAxisTitleText',
  _yaxis_title_: 'yAxisTitleText',
  _legend_: 'legendText',
}

const stripMarkup = (value: string): string =>
  value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const cloneAnnotation = (entry: unknown): AnnotationRecord | null => {
  if (typeof entry !== 'object' || entry === null) return null
  return { ...(entry as AnnotationRecord) }
}

const getAnnotationName = (entry: unknown): string | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined
  const name = (entry as { name?: unknown }).name
  return typeof name === 'string' && name.trim().length > 0 ? name : undefined
}

const getAnnotationText = (entry: unknown): string | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined
  const text = (entry as { text?: unknown }).text
  return typeof text === 'string' ? stripMarkup(text) : undefined
}

const getAnnotationCoord = (entry: unknown, key: 'x' | 'y'): number | null => {
  if (typeof entry !== 'object' || entry === null) return null
  const value = (entry as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const getAnnotationRef = (entry: unknown, key: 'xref' | 'yref'): string | null => {
  if (typeof entry !== 'object' || entry === null) return null
  const value = (entry as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

const isLikelySystemAnnotationCandidate = (
  entry: AnnotationRecord,
  systemName: SystemAnnotationName
): boolean => {
  const xref = getAnnotationRef(entry, 'xref')
  const yref = getAnnotationRef(entry, 'yref')
  if ((xref && xref !== 'paper') || (yref && yref !== 'paper')) return false

  const showarrow = entry.showarrow
  if (typeof showarrow === 'boolean' && showarrow) return false

  const x = getAnnotationCoord(entry, 'x')
  const y = getAnnotationCoord(entry, 'y')

  if (systemName === '_title_') {
    return y === null || y >= 0.75
  }
  if (systemName === '_xaxis_title_') {
    return y !== null && y <= 0.2
  }
  if (systemName === '_yaxis_title_') {
    return x !== null && x <= 0.2
  }
  if (systemName === '_legend_') {
    return x !== null && y !== null && x >= 0.55 && y >= 0.1
  }
  return false
}

const mergeAnnotationObjects = (
  current: AnnotationRecord,
  incoming: AnnotationRecord,
  forcedName?: string
): AnnotationRecord => {
  const merged: AnnotationRecord = {
    ...current,
    ...incoming,
  }
  if (forcedName) {
    merged.name = forcedName
  }

  const currentMeta =
    typeof current.meta === 'object' && current.meta !== null
      ? (current.meta as Record<string, unknown>)
      : undefined
  const incomingMeta =
    typeof incoming.meta === 'object' && incoming.meta !== null
      ? (incoming.meta as Record<string, unknown>)
      : undefined

  if (currentMeta || incomingMeta) {
    merged.meta = {
      ...(currentMeta ?? {}),
      ...(incomingMeta ?? {}),
    }
  }

  return merged
}

const dedupeProtectedByName = (
  annotations: AnnotationRecord[],
  protectedNames: ReadonlySet<string>
): AnnotationRecord[] => {
  const seen = new Set<string>()
  return annotations.filter((annotation) => {
    const name = getAnnotationName(annotation)
    if (!name || !protectedNames.has(name)) return true
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })
}

export function normalizeSystemAnnotationIdentity(
  annotations: unknown[],
  hints: SystemAnnotationTextHints
): { annotations: AnnotationRecord[]; changed: boolean } {
  const next = annotations
    .map((entry) => cloneAnnotation(entry))
    .filter((entry): entry is AnnotationRecord => entry !== null)
  let changed = false

  for (const systemName of SYSTEM_ANNOTATION_NAMES) {
    const existingIndex = next.findIndex((entry) => getAnnotationName(entry) === systemName)
    if (existingIndex >= 0) continue

    const hintKey = HINT_KEY_BY_NAME[systemName]
    const hintValue = hints[hintKey]
    if (typeof hintValue !== 'string' || stripMarkup(hintValue).length === 0) continue
    const normalizedHint = stripMarkup(hintValue)

    const candidateIndex = next.findIndex((entry) => {
      const name = getAnnotationName(entry)
      if (name) return false
      const text = getAnnotationText(entry)
      return (
        typeof text === 'string' &&
        text === normalizedHint &&
        isLikelySystemAnnotationCandidate(entry, systemName)
      )
    })

    if (candidateIndex < 0) continue
    next[candidateIndex] = {
      ...next[candidateIndex],
      name: systemName,
    }
    changed = true
  }

  return { annotations: next, changed }
}

export function mergeAnnotationsByIdentity({
  current,
  incoming,
  rendered,
  protectedNames = SYSTEM_ANNOTATION_NAME_SET,
}: MergeAnnotationsByIdentityOptions): AnnotationRecord[] {
  const currentRecords = current
    .map((entry) => cloneAnnotation(entry))
    .filter((entry): entry is AnnotationRecord => entry !== null)
  const incomingRecords = incoming
    .map((entry) => cloneAnnotation(entry))
    .filter((entry): entry is AnnotationRecord => entry !== null)
  const renderedRecords = (rendered ?? [])
    .map((entry) => cloneAnnotation(entry))
    .filter((entry): entry is AnnotationRecord => entry !== null)

  const resolvedIncoming = incomingRecords.map((entry, index) => {
    const renderedEntry = renderedRecords[index]
    const renderedName = getAnnotationName(renderedEntry)
    const renderedMeta =
      renderedEntry && typeof renderedEntry.meta === 'object' && renderedEntry.meta !== null
        ? (renderedEntry.meta as Record<string, unknown>)
        : undefined

    if (!getAnnotationName(entry) && renderedName) {
      entry.name = renderedName
    }
    if (
      (entry.meta === undefined || entry.meta === null) &&
      renderedMeta &&
      Object.keys(renderedMeta).length > 0
    ) {
      entry.meta = { ...renderedMeta }
    }
    return entry
  })

  const next = [...currentRecords]
  const indexByName = new Map<string, number>()
  next.forEach((entry, index) => {
    const name = getAnnotationName(entry)
    if (name && !indexByName.has(name)) {
      indexByName.set(name, index)
    }
  })

  resolvedIncoming.forEach((entry, index) => {
    const name = getAnnotationName(entry)
    if (name) {
      const existingIndex = indexByName.get(name)
      if (existingIndex !== undefined) {
        next[existingIndex] = mergeAnnotationObjects(next[existingIndex]!, entry, name)
      } else {
        next.push(entry)
        indexByName.set(name, next.length - 1)
      }
      return
    }

    const existing = next[index]
    const existingName = getAnnotationName(existing)
    if (existing && existingName && protectedNames.has(existingName)) {
      next[index] = mergeAnnotationObjects(existing, entry, existingName)
      return
    }
    if (existing) {
      next[index] = mergeAnnotationObjects(existing, entry)
    } else {
      next.push(entry)
    }
  })

  return dedupeProtectedByName(next, protectedNames)
}

export function getSystemAnnotationTextHints(
  layout: Partial<Layout>,
  titleText: string
): SystemAnnotationTextHints {
  const xAxisTitle =
    typeof layout.xaxis?.title === 'object'
      ? layout.xaxis.title?.text
      : (layout.xaxis?.title as string | undefined)
  const yAxisTitle =
    typeof layout.yaxis?.title === 'object'
      ? layout.yaxis.title?.text
      : (layout.yaxis?.title as string | undefined)
  const legendText = Array.isArray(layout.annotations)
    ? (() => {
        const legendAnnotation = layout.annotations.find((annotation) => {
          if (typeof annotation !== 'object' || annotation === null) return false
          const name = (annotation as { name?: unknown }).name
          return name === '_legend_'
        }) as { text?: unknown } | undefined
        return typeof legendAnnotation?.text === 'string' ? stripMarkup(legendAnnotation.text) : undefined
      })()
    : undefined

  return {
    titleText,
    xAxisTitleText: typeof xAxisTitle === 'string' ? xAxisTitle : undefined,
    yAxisTitleText: typeof yAxisTitle === 'string' ? yAxisTitle : undefined,
    legendText,
  }
}
