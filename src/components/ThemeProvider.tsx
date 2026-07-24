import { useEffect, useLayoutEffect, useState, useRef } from 'react'
import {
  getCurrentWebviewWindow,
  type Color,
} from '@tauri-apps/api/webviewWindow'
import { ThemeProviderContext, type Theme } from '@/lib/theme-context'
import { usePreferences } from '@/services/preferences'

interface ThemeProviderProps {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function normalizeThemePreference(value: string | null | undefined): Theme {
  if (value === 'dark' || value === 'light') {
    return value
  }
  return getSystemTheme()
}

const parseHexColor = (value: string): [number, number, number] | null => {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim())
  if (!match) return null
  const raw = match[1]
  if (!raw) return null
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ]
}

const parseRgbColor = (value: string): [number, number, number] | null => {
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(
    value.trim()
  )
  if (!match) return null
  return [
    Math.round(Number(match[1])),
    Math.round(Number(match[2])),
    Math.round(Number(match[3])),
  ]
}

const clampByte = (value: number) =>
  Math.round(Math.max(0, Math.min(255, value)))

const linearSrgbToByte = (value: number) => {
  const clamped = Math.max(0, Math.min(1, value))
  const encoded =
    clamped <= 0.0031308
      ? 12.92 * clamped
      : 1.055 * clamped ** (1 / 2.4) - 0.055
  return clampByte(encoded * 255)
}

const parseOklchChannel = (value: string) => {
  const trimmed = value.trim()
  if (trimmed.endsWith('%')) {
    return Number.parseFloat(trimmed.slice(0, -1)) / 100
  }
  return Number.parseFloat(trimmed)
}

const parseOklchColor = (value: string): [number, number, number] | null => {
  const match = /^oklch\(\s*([^\s]+)\s+([^\s]+)\s+([^\s/]+)(?:\s*\/[^)]*)?\)$/i.exec(
    value.trim()
  )
  if (!match) return null
  const lightness = parseOklchChannel(match[1] ?? '')
  const chroma = parseOklchChannel(match[2] ?? '')
  const hue = Number.parseFloat(match[3] ?? '')
  if (![lightness, chroma, hue].every(Number.isFinite)) return null

  const hueRadians = (hue * Math.PI) / 180
  const a = chroma * Math.cos(hueRadians)
  const b = chroma * Math.sin(hueRadians)
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b
  const l = lPrime ** 3
  const m = mPrime ** 3
  const s = sPrime ** 3

  return [
    linearSrgbToByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearSrgbToByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearSrgbToByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

const cssColorToTauriColor = (value: string): Color | null => {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed =
    parseHexColor(trimmed) ??
    parseRgbColor(trimmed) ??
    parseOklchColor(trimmed)
  if (parsed) return parsed

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return null
  const sentinel = '#000001'
  context.fillStyle = sentinel
  context.fillStyle = trimmed
  const normalized = context.fillStyle
  if (normalized === sentinel) return null
  return parseHexColor(normalized) ?? parseRgbColor(normalized) ?? null
}

const currentThemeBackgroundColor = (): Color | null => {
  const background = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue('--background')
  return cssColorToTauriColor(background)
}

export function ThemeProvider({
  children,
  defaultTheme = 'light',
  storageKey = 'ui-theme',
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => normalizeThemePreference(localStorage.getItem(storageKey)) || defaultTheme
  )

  // Load theme from persistent preferences
  const { data: preferences } = usePreferences()
  const hasSyncedPreferences = useRef(false)

  // Sync theme with preferences when they load
  // This is a legitimate case of syncing with external async state (persistent preferences)
  // The ref ensures this only happens once when preferences first load
  useLayoutEffect(() => {
    if (preferences?.theme && !hasSyncedPreferences.current) {
      hasSyncedPreferences.current = true
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Syncing with external async preferences on initial load
      setTheme(normalizeThemePreference(preferences.theme))
    }
  }, [preferences?.theme])
  const resolvedTheme = theme

  useEffect(() => {
    const root = window.document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    const color = currentThemeBackgroundColor()
    if (!color) return
    void getCurrentWebviewWindow()
      .setBackgroundColor(color)
      .catch(() => undefined)
  }, [resolvedTheme])

  const value = {
    theme,
    resolvedTheme,
    setTheme: (theme: Theme) => {
      localStorage.setItem(storageKey, theme)
      setTheme(theme)
    },
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}
