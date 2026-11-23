'use client'

import { useEffect, useState } from 'react'
import { useTheme } from './theme-provider'

/** Canvas markers need resolved colors; CSS variables alone only work in SVG. */
export function useMapColors() {
  const { resolvedTheme } = useTheme()
  const [colors, setColors] = useState<{ color: string; fillColor: string } | null>(null)
  useEffect(() => {
    const style = getComputedStyle(document.documentElement)
    // oxlint-disable-next-line react/set-state-in-effect -- resolved CSS colours exist only in the DOM once the theme class is applied; they cannot be derived during render
    setColors({
      color: style.getPropertyValue('--primary-foreground').trim(),
      fillColor: style.getPropertyValue('--primary').trim(),
    })
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- resolvedTheme is the trigger: the computed colours change with the root theme class
  }, [resolvedTheme])
  return colors
}
