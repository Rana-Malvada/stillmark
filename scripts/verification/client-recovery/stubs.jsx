import { useSyncExternalStore } from 'react'

export function navigate(path) {
  history.pushState(null, '', path)
  window.dispatchEvent(new Event('fixture:navigate'))
}
const router = { push: navigate, replace: navigate, refresh() {} }
export function useRouter() {
  return router
}
export function usePathname() {
  return location.pathname
}
export function useSearchParams() {
  const search = useSyncExternalStore(
    (notify) => {
      addEventListener('fixture:navigate', notify)
      addEventListener('popstate', notify)
      return () => {
        removeEventListener('fixture:navigate', notify)
        removeEventListener('popstate', notify)
      }
    },
    () => location.search,
  )
  return new URLSearchParams(search)
}
export function useAuth() {
  const params = new URLSearchParams(location.search)
  const role = params.get('fixtureRole') || 'admin'
  return {
    username: 'ALICE',
    role,
    mainAdmin: params.has('fixtureMainAdmin')
      ? params.get('fixtureMainAdmin') === 'true'
      : role === 'admin',
    canManageAccess: role === 'admin',
    canManagePersonal: role !== 'admin_readonly' && params.get('fixtureCanManage') !== 'false',
    authenticated: true,
    loading: false,
  }
}
export default function Link({ href, children, onClick, prefetch: _, ...props }) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) {
          event.preventDefault()
          navigate(href)
        }
      }}
    >
      {children}
    </a>
  )
}

export function useUploads() {
  return {
    batches: [],
    queue: {
      start(files, fields, label) {
        const upload = Object.freeze({
          files: Object.freeze(
            files.map((file) =>
              Object.freeze({
                name: file.name,
                size: file.size,
                type: file.type,
                lastModified: file.lastModified,
              }),
            ),
          ),
          fields: Object.freeze({ ...fields }),
          label,
        })
        window.fixtureUploads = [...(window.fixtureUploads || []), upload]
        return 'fixture-upload'
      },
    },
  }
}
export function useTheme() {
  return { resolvedTheme: 'dark', setTheme() {} }
}
