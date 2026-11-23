import { cleanup, render } from '@testing-library/react'
import type { ComponentProps, ReactElement } from 'react'
import { afterEach, vi } from 'vitest'
import { AuthProvider } from '@/components/auth-provider'

/** Shared by the component tests: unmount, and drop fetch/confirm stubs, after every test. */
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// jsdom renders <dialog> but does not implement opening or closing it. Model only the
// open state, so tests can tell whether a dialog is showing; focus trapping, the backdrop
// and Escape handling remain browser behaviour that these tests do not cover.
const dialog = HTMLDialogElement.prototype
dialog.showModal ??= function (this: HTMLDialogElement) {
  this.open = true
}
dialog.close ??= function (this: HTMLDialogElement) {
  this.open = false
}

type Account = NonNullable<ComponentProps<typeof AuthProvider>['initialState']>

/** A signed-in member who manages their own collection, unless overridden. */
export function account(overrides: Partial<Account> = {}): Account {
  return {
    authenticated: true,
    username: 'alice',
    displayName: 'Alice',
    role: 'viewer',
    canManagePersonal: true,
    canManageAccess: false,
    mainAdmin: false,
    loading: false,
    ...overrides,
  }
}

/** Renders inside the real AuthProvider; a supplied account means it makes no request. */
export function renderAs(ui: ReactElement, state: Account = account()) {
  return render(<AuthProvider initialState={state}>{ui}</AuthProvider>)
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export interface Call {
  url: string
  method: string
  body: unknown
}

/** Replaces fetch with a route function and records each call as the server would see it. */
export function stubFetch(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      }
      calls.push(call)
      return route(call)
    }),
  )
  return calls
}

/** A response the test settles by hand, for ordering late and superseded replies. */
export function deferred() {
  let settle: (response: Response) => void = () => {}
  const response = new Promise<Response>((resolve) => {
    settle = resolve
  })
  return { response, settle }
}
