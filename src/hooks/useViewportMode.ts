import * as React from 'react'

export type ViewportMode = 'full' | 'compact' | 'constrained'

const getViewportMode = (width: number, height: number): ViewportMode => {
  if (width < 1100 || height < 700) {
    return 'constrained'
  }
  if (width < 1280 || height < 800) {
    return 'compact'
  }
  return 'full'
}

const readViewportMode = (): ViewportMode => {
  if (typeof window === 'undefined') {
    return 'full'
  }
  return getViewportMode(window.innerWidth, window.innerHeight)
}

export function useViewportMode() {
  const [mode, setMode] = React.useState<ViewportMode>(() => readViewportMode())

  React.useEffect(() => {
    if (typeof window === 'undefined') return

    const onResize = () => {
      const next = readViewportMode()
      setMode((current) => (current === next ? current : next))
    }

    onResize()
    window.addEventListener('resize', onResize, { passive: true })
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return {
    mode,
    isFull: mode === 'full',
    isNotFull: mode !== 'full',
    isCompact: mode === 'compact',
    isConstrained: mode === 'constrained',
  }
}
