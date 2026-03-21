export interface PerformTestWarningKeyParams {
  projectId: string | null | undefined
  familyId: string
  datasetId?: string | null
  sessionId: string
}

export function buildPerformTestWarningKey({
  projectId,
  familyId,
  datasetId,
  sessionId,
}: PerformTestWarningKeyParams): string {
  const trimmedProjectId = projectId?.trim()
  const projectScope = trimmedProjectId
    ? `project:${trimmedProjectId}`
    : datasetId
      ? `dataset:${datasetId}`
      : `session:${sessionId}`

  return `${projectScope}:family:${familyId}`
}

