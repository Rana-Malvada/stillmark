'use client'

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'

import { clearViewerImages } from '@/lib/viewer-image-buffer'
import { clearGridCaches } from '@/lib/grid-cache'
import { endGallerySession } from '@/lib/browser-logout'
import { clientOperation } from '@/lib/client-operation'
import { ClientResponseError } from '@/lib/client-response'
import { isAuthResponse, isLogoutDestination } from '@/lib/identity/account-response'

interface AuthState {
  authenticated: boolean
  username: string | null
  displayName?: string | null
  role: 'admin' | 'admin_readonly' | 'viewer' | null
  canManagePersonal: boolean
  mainAdmin: boolean
  canManageAccess: boolean
  loading: boolean
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const defaultState: AuthState = {
  authenticated: false,
  username: null,
  role: null,
  canManageAccess: false,
  mainAdmin: false,
  canManagePersonal: false,
  loading: true,
  refresh: async () => {},
  logout: async () => {},
}

const AuthContext = createContext<AuthState>(defaultState)

export function AuthProvider({
  children,
  initialState,
}: {
  children: ReactNode
  initialState?: Omit<AuthState, 'refresh' | 'logout'>
}) {
  const [state, setState] = useState<Omit<AuthState, 'refresh' | 'logout'>>(
    initialState ?? {
      authenticated: false,
      username: null,
      role: null,
      canManageAccess: false,
      mainAdmin: false,
      canManagePersonal: false,
      loading: true,
    },
  )

  const imageIdentity = useRef<string | null>(initialState?.username ?? null)
  const [signedOut, setSignedOut] = useState(false)
  const [logoutUrl, setLogoutUrl] = useState('')
  const activeRequest = useRef<AbortController | null>(null)
  const logoutRequest = useRef<AbortController | null>(null)
  const logout = useCallback(async () => {
    logoutRequest.current?.abort()
    const controller = new AbortController()
    logoutRequest.current = controller
    // Resolve configuration while ingress is still authenticated.
    const { url } = await clientOperation(
      '/api/auth/logout-url',
      {
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      },
      'Unable to prepare logout. Please try again.',
      isLogoutDestination,
      15_000,
    )
    await endGallerySession()
    controller.signal.throwIfAborted()
    activeRequest.current?.abort()
    window.dispatchEvent(new Event('gallery-logout'))
    clearGridCaches()
    clearViewerImages()
    setLogoutUrl(url)
    setSignedOut(true)
    // Top-level navigation lets Auth0 clear its first-party SSO cookie.
    window.location.replace(url)
  }, [])

  const refresh = useCallback(async () => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    try {
      const data = await clientOperation(
        '/api/auth/me',
        { cache: 'no-store', signal: controller.signal },
        'Unable to refresh account. Please try again.',
        isAuthResponse,
      )
      if (controller.signal.aborted) return
      const username = data.authenticated ? data.username : null
      // Clear before rendering the new identity: a parent effect would run after
      // the child attaches its newly authorized image and could erase that image.
      if (imageIdentity.current !== username) {
        window.dispatchEvent(new Event('gallery-logout'))
        clearViewerImages()
        imageIdentity.current = username
      }
      if (data.authenticated) {
        setState({
          authenticated: true,
          username: data.username,
          displayName: data.displayName ?? null,
          role: data.role,
          canManagePersonal: data.canManagePersonal === true,
          canManageAccess: data.canManageAccess === true,
          mainAdmin: data.mainAdmin === true,
          loading: false,
        })
      } else {
        setState({
          authenticated: false,
          username: null,
          role: null,
          canManageAccess: false,
          mainAdmin: false,
          canManagePersonal: false,
          loading: false,
        })
      }
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof ClientResponseError && [401, 403].includes(error.status)) {
        window.dispatchEvent(new Event('gallery-logout'))
        clearViewerImages()
        clearGridCaches()
        imageIdentity.current = null
        setState({ ...defaultState, loading: false })
      } else setState((s) => ({ ...s, loading: false }))
      throw error
    }
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- nothing is set synchronously: refresh only sets state after its request settles
    if (!initialState) void refresh().catch(() => {})
    return () => {
      activeRequest.current?.abort()
      logoutRequest.current?.abort()
    }
  }, [refresh, initialState])

  useEffect(() => {
    clearGridCaches()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- username is the trigger: cached grids belong to the previous identity
  }, [state.username])

  if (signedOut)
    return (
      <main className="min-h-dvh flex items-center justify-center p-6">
        <section className="surface-panel max-w-md w-full p-8 text-center space-y-5">
          <h1 className="text-2xl font-semibold">Finishing logout…</h1>
          <p className="text-muted-foreground">
            Ending your remembered login. You’ll return to the sign-in screen.
          </p>
          <a href={logoutUrl} className="primary-button inline-flex">
            Continue logout
          </a>
        </section>
      </main>
    )
  return (
    <AuthContext.Provider value={{ ...state, refresh, logout }}>{children}</AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
