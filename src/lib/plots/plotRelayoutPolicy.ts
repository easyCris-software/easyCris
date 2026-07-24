import { SYSTEM_ANNOTATION_NAME_SET } from './annotationPersistence'

type AnnotationRecord = Record<string, unknown>

const CUSTOM_MARKUP_PREFIX = 'custom_markup_'

const getAnnotationName = (entry: unknown): string | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined
  const name = (entry as { name?: unknown }).name
  return typeof name === 'string' && name.trim().length > 0 ? name : undefined
}

const isCustomMarkupAnnotation = (entry: unknown): boolean => {
  if (typeof entry !== 'object' || entry === null) return false
  const name = getAnnotationName(entry)
  if (name && name.startsWith(CUSTOM_MARKUP_PREFIX)) return true
  const meta = (entry as { meta?: unknown }).meta
  return (
    typeof meta === 'object' &&
    meta !== null &&
    (meta as { customMarkup?: unknown }).customMarkup === true
  )
}

export function hasExplicitAnnotationClearIntent(relayoutData: Record<string, unknown>): boolean {
  if (relayoutData['easycris.annotationClearIntent'] === true) return true
  return Object.entries(relayoutData).some(
    ([key, value]) => /^annotations\[\d+\]$/.test(key) && value === null
  )
}

export function shouldApplyFullAnnotationPayload(relayoutData: Record<string, unknown>): boolean {
  if (Object.keys(relayoutData).some((key) => /^annotations\[\d+\](\.|$)/.test(key))) {
    return true
  }
  const annotationsPayload = relayoutData.annotations
  return Array.isArray(annotationsPayload) && annotationsPayload.length > 0
}

export function retainAnnotationsAfterClearIntent(annotations: unknown[]): AnnotationRecord[] {
  return annotations
    .filter((entry): entry is AnnotationRecord => typeof entry === 'object' && entry !== null)
    .filter((entry) => {
      const name = getAnnotationName(entry)
      if (!name) return false
      if (SYSTEM_ANNOTATION_NAME_SET.has(name)) return true
      return !isCustomMarkupAnnotation(entry)
    })
}
