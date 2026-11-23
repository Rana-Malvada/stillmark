'use client'
import { type RefObject, useEffect } from 'react'
/** Keep native dialog controls inside the visible area above a mobile keyboard. */
export function useDialogViewport(ref: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => {
      const height = viewport?.height ?? window.innerHeight
      ref.current?.style.setProperty('--dialog-visible-height', `${height * 0.85}px`)
      ref.current?.style.setProperty(
        '--dialog-center',
        `${(viewport?.offsetTop ?? 0) + height / 2}px`,
      )
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [ref])
}
