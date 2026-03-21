export interface MainEffectContrastSummary {
  summary: string
  count: number
}

export function buildMainEffectContrastSummary(params: {
  referenceLevel?: string
  testLevel?: string
  levels?: string[]
}): MainEffectContrastSummary {
  const rawReference = String(params.referenceLevel ?? '').trim()
  const rawTest = String(params.testLevel ?? '').trim()
  const levels = Array.from(
    new Set((params.levels ?? []).map((level) => String(level).trim()).filter(Boolean))
  )

  const reference = rawReference || levels[0] || 'ref'
  let tests = levels.filter((level) => level !== reference)
  if (rawTest && rawTest !== reference) {
    tests = Array.from(new Set([rawTest, ...tests]))
  }

  if (tests.length === 0) {
    return {
      summary: 'No valid contrast yet',
      count: 0,
    }
  }

  const contrastPairs = tests.map((test) => `${test} vs ${reference}`)
  return {
    summary:
      contrastPairs.length > 1
        ? `${contrastPairs.join(', ')} (${contrastPairs.length} contrasts)`
        : contrastPairs[0] ?? 'No valid contrast yet',
    count: contrastPairs.length,
  }
}

