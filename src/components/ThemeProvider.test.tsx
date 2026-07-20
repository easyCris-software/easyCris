import { render, screen, waitFor } from '@/test/test-utils'
import { useTheme } from '@/hooks/use-theme'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from './ThemeProvider'

const usePreferencesMock = vi.fn(() => ({ data: undefined }))
const mockSetBackgroundColor = vi.fn().mockResolvedValue(undefined)

vi.mock('@/services/preferences', () => ({
  usePreferences: () => usePreferencesMock(),
}))

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    setBackgroundColor: mockSetBackgroundColor,
  }),
}))

type MatchMediaRecord = {
  media: string
  matches: boolean
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

let matchMediaRecord: MatchMediaRecord

function installMatchMedia(initialMatches: boolean) {
  matchMediaRecord = {
    media: '(prefers-color-scheme: dark)',
    matches: initialMatches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(() => matchMediaRecord),
  })
}

function ThemeHarness() {
  const { theme, resolvedTheme } = useTheme() as ReturnType<typeof useTheme> & {
    resolvedTheme?: 'light' | 'dark'
  }

  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved-theme">{resolvedTheme}</span>
    </div>
  )
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    document.documentElement.classList.remove('light', 'dark')
    document.documentElement.style.removeProperty('--background')
    usePreferencesMock.mockReturnValue({ data: undefined })
  })

  it('normalizes a legacy system preference to the current OS theme', () => {
    installMatchMedia(false)
    localStorage.setItem('ui-theme', 'system')

    render(
      <ThemeProvider defaultTheme="light">
        <ThemeHarness />
      </ThemeProvider>
    )

    expect(screen.getByTestId('theme')).toHaveTextContent('light')
    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })

  it('keeps an explicit dark preference', () => {
    installMatchMedia(false)
    localStorage.setItem('ui-theme', 'dark')

    render(
      <ThemeProvider defaultTheme="light">
        <ThemeHarness />
      </ThemeProvider>
    )

    expect(screen.getByTestId('theme')).toHaveTextContent('dark')
    expect(screen.getByTestId('resolved-theme')).toHaveTextContent('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('syncs the native webview background with the active CSS theme background', async () => {
    installMatchMedia(false)
    localStorage.setItem('ui-theme', 'dark')
    document.documentElement.style.setProperty('--background', '#112233')

    render(
      <ThemeProvider defaultTheme="light">
        <ThemeHarness />
      </ThemeProvider>
    )

    await waitFor(() =>
      expect(mockSetBackgroundColor).toHaveBeenCalledWith([17, 34, 51])
    )
  })

  it('converts OKLCH theme tokens before syncing the native webview background', async () => {
    installMatchMedia(false)
    document.documentElement.style.setProperty(
      '--background',
      'oklch(0.18 0.02 250)'
    )

    render(
      <ThemeProvider defaultTheme="light">
        <ThemeHarness />
      </ThemeProvider>
    )

    await waitFor(() =>
      expect(mockSetBackgroundColor).toHaveBeenCalledWith([11, 18, 26])
    )
  })

  it('does not sync a native webview background when the CSS token is unset', () => {
    installMatchMedia(false)

    render(
      <ThemeProvider defaultTheme="light">
        <ThemeHarness />
      </ThemeProvider>
    )

    expect(mockSetBackgroundColor).not.toHaveBeenCalled()
  })

  it('does not coerce invalid CSS colors to black', () => {
    installMatchMedia(false)
    document.documentElement.style.setProperty('--background', 'not-a-color')

    render(
      <ThemeProvider defaultTheme="light">
        <ThemeHarness />
      </ThemeProvider>
    )

    expect(mockSetBackgroundColor).not.toHaveBeenCalled()
  })

  it('does not coerce browser-rejected CSS colors to black when canvas parsing is available', () => {
    installMatchMedia(false)
    document.documentElement.style.setProperty('--background', 'not-a-color')
    let fillStyle = '#000000'
    const context = {}
    Object.defineProperty(context, 'fillStyle', {
      get: () => fillStyle,
      set: (value: string) => {
        if (value === '#000001') {
          fillStyle = value
        }
      },
    })
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(
        (contextId: string) =>
          contextId === '2d'
            ? (context as CanvasRenderingContext2D)
            : null
      )

    try {
      render(
        <ThemeProvider defaultTheme="light">
          <ThemeHarness />
        </ThemeProvider>
      )

      expect(mockSetBackgroundColor).not.toHaveBeenCalled()
    } finally {
      getContext.mockRestore()
    }
  })
})
