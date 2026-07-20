export type TransformExecutionMode = 'in-place' | 'new-family'

export interface SchemaAvailability {
  availableColumns: number
  missingColumns: number
  totalColumns: number
  contextLabel: string
}

export interface TransformSchemaDecision {
  allow: boolean
  errorMessage?: string
  warningMessage?: string
}

const formatSchemaSummary = (availability: SchemaAvailability): string =>
  `partial schema: ${availability.missingColumns.toLocaleString()} column(s) unavailable (${availability.availableColumns.toLocaleString()}/${availability.totalColumns.toLocaleString()} available)`

export const evaluateTransformSchemaDecision = (
  mode: TransformExecutionMode,
  availability: SchemaAvailability,
  isPartial: boolean
): TransformSchemaDecision => {
  if (!isPartial || availability.missingColumns <= 0) {
    return { allow: true }
  }

  const summary = formatSchemaSummary(availability)
  if (mode === 'in-place') {
    return {
      allow: false,
      errorMessage:
        `Unable to load full schema for ${availability.contextLabel}. ` +
        `${summary}. In-place transform was blocked to preserve data and undo fidelity.`,
    }
  }

  return {
    allow: true,
    warningMessage:
      `Proceeding with ${availability.contextLabel} using ${summary}. ` +
      'Missing columns will be null-filled in the transformed dataset.',
  }
}
