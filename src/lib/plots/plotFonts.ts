export const PLOT_FONTS = [
  { value: 'Inter', label: 'Inter' },
  { value: 'Lato', label: 'Lato' },
  { value: 'Open Sans', label: 'Open Sans' },
  { value: 'Noto Sans', label: 'Noto Sans' },
  { value: 'PT Sans', label: 'PT Sans' },
  { value: 'Source Sans 3', label: 'Source Sans 3' },
  { value: 'Nunito Sans', label: 'Nunito Sans' },
  { value: 'Liberation Sans', label: 'Liberation Sans' },
  { value: 'Arimo', label: 'Arimo' },
  { value: 'Tinos', label: 'Tinos' },
  { value: 'Roboto Slab', label: 'Roboto Slab' },
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
] as const

export const PLOT_FONT_ALIASES: Record<string, string> = {
  Arial: 'Arimo',
  'Times New Roman': 'Tinos',
  'Source Sans Pro': 'Source Sans 3',
}

const PLOT_FONT_VALUES: Set<string> = new Set(
  PLOT_FONTS.map(font => font.value)
)
const PLOT_FONT_BY_LOWERCASE = new Map(
  PLOT_FONTS.map(font => [font.value.toLowerCase(), font.value])
)
const PLOT_FONT_ALIASES_BY_LOWERCASE = new Map(
  Object.entries(PLOT_FONT_ALIASES).map(([alias, value]) => [
    alias.toLowerCase(),
    value,
  ])
)

export function resolvePlotFontFamily(font?: string): string {
  if (!font) return 'Inter'
  const firstFamily = font
    .split(',')
    .map(part => part.trim().replace(/^['"]|['"]$/g, ''))
    .find(Boolean)
  if (!firstFamily) return 'Inter'
  if (PLOT_FONT_VALUES.has(firstFamily)) return firstFamily
  return (
    PLOT_FONT_BY_LOWERCASE.get(firstFamily.toLowerCase()) ??
    PLOT_FONT_ALIASES_BY_LOWERCASE.get(firstFamily.toLowerCase()) ??
    'Inter'
  )
}
