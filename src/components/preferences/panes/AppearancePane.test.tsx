import { fireEvent, render, screen } from '@/test/test-utils'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { AppearancePane } from './AppearancePane'

const useThemeMock = vi.fn(() => ({
  theme: 'light',
  resolvedTheme: 'light',
  setTheme: vi.fn(),
}))

const useSavePreferencesMock = vi.fn(() => ({
  mutate: vi.fn(),
  isPending: false,
}))

vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => useThemeMock(),
}))

vi.mock('@/services/preferences', () => ({
  useSavePreferences: () => useSavePreferencesMock(),
}))

describe('AppearancePane', () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(Element.prototype, 'hasPointerCapture', {
      configurable: true,
      value: vi.fn(() => false),
    })
    Object.defineProperty(Element.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(Element.prototype, 'releasePointerCapture', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('offers only light and dark theme choices', async () => {
    render(<AppearancePane />)

    const trigger = screen.getByRole('combobox')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })

    expect((await screen.findAllByText('Light')).length).toBeGreaterThan(0)
    expect(screen.getByRole('option', { name: 'Dark' })).toBeInTheDocument()
    expect(screen.queryByText('System')).not.toBeInTheDocument()
  })
})
