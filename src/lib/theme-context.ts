import { createContext } from 'react'

export type Theme = 'dark' | 'light'

export interface ThemeProviderState {
  theme: Theme
  resolvedTheme: Theme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: 'light',
  resolvedTheme: 'light',
  setTheme: () => null,
}

export const ThemeProviderContext =
  createContext<ThemeProviderState>(initialState)
