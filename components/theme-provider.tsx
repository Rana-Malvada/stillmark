'use client'

import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  resolvedTheme: 'dark',
  setTheme: () => {},
})

export function useTheme() {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark')
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('dark')
  const [ready, setReady] = useState(false)

  // Load stored preference on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem('theme') as Theme | null
      // oxlint-disable-next-line react/set-state-in-effect -- the stored preference is read after hydration so the first client render matches the server's; ready then gates the root class
      if (stored === 'light' || stored === 'dark' || stored === 'system') setThemeState(stored)
    } catch {
      /* Use dark mode when browser storage is unavailable. */
    }
    setReady(true)
  }, [])

  // Apply theme class whenever theme changes
  useEffect(() => {
    if (!ready) return
    const root = document.documentElement
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme

    // oxlint-disable-next-line react/set-state-in-effect -- the resolved theme comes from matchMedia and must change together with the root class this effect applies
    setResolvedTheme(resolved)
    root.classList.toggle('dark', resolved === 'dark')
  }, [theme, ready])

  // Keep in sync with OS preference changes when using system theme
  useEffect(() => {
    if (!ready || theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      const next = e.matches ? 'dark' : 'light'
      setResolvedTheme(next)
      document.documentElement.classList.toggle('dark', e.matches)
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme, ready])

  function setTheme(next: Theme) {
    setThemeState(next)
    try {
      localStorage.setItem('theme', next)
    } catch {
      /* Keep the choice for this session. */
    }
  }

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
