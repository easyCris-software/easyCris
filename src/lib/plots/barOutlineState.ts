export type BarOutlineWidthState =
  | { mode: 'missing'; enabled: boolean }
  | { mode: 'scalar'; enabled: boolean; width: number }
  | { mode: 'array'; enabled: boolean; widths: number[] }

const toFiniteWidth = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

export const getBarOutlineWidthState = (
  width: unknown,
  defaultEnabledWhenMissing = true
): BarOutlineWidthState => {
  if (Array.isArray(width)) {
    const parsedWidths = width.map((entry) => toFiniteWidth(entry) ?? 0)
    const enabled = parsedWidths.some((entry) => entry > 0)
    return { mode: 'array', enabled, widths: parsedWidths }
  }

  const parsed = toFiniteWidth(width)
  if (parsed !== null) {
    return { mode: 'scalar', enabled: parsed > 0, width: parsed }
  }

  return { mode: 'missing', enabled: defaultEnabledWhenMissing }
}

export const getBarOutlineEnabledFromWidth = (
  width: unknown,
  defaultEnabledWhenMissing = true
): boolean => {
  return getBarOutlineWidthState(width, defaultEnabledWhenMissing).enabled
}
