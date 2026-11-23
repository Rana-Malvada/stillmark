'use client'

import Image from 'next/image'
import { HeaderNavigation } from '@/components/header-navigation'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { APP_TITLE, LOGO_SRC } from '@/lib/constants'
import { ThemeToggle } from '@/components/theme-toggle'
import { AccountMenu } from '@/components/account-menu'
import { useUploads } from '@/components/upload-provider'
import { useAuth } from '@/components/auth-provider'
import {
  Activity,
  Coins,
  FolderOpen,
  Heart,
  Images,
  LogIn,
  MapPin,
  ShieldCheck,
  Trash2,
  Upload,
  UsersRound,
} from 'lucide-react'
import { GalleryStats } from '@/components/gallery-stats'
import { SearchBar } from '@/components/search-bar'
import { galleryParent } from '@/components/gallery-position'
import { useEffect, useRef, useState } from 'react'
import { useClientValue } from './use-client-value'

export function AppHeader() {
  const {
    authenticated,
    username,
    displayName,
    role,
    mainAdmin,
    canManageAccess,
    loading: authLoading,
    logout,
  } = useAuth()
  const { batches } = useUploads()
  const uploading = batches.some((batch) => batch.running)
  const [loggingOut, setLoggingOut] = useState(false)
  async function handleLogout() {
    if (loggingOut || uploading) return
    setLoggingOut(true)
    setError(null)
    try {
      await logout()
    } catch {
      setError(
        'Unable to confirm logout. Please retry, or reopen the gallery if your session has already ended.',
      )
      setLoggingOut(false)
    }
  }
  const isAdmin = role === 'admin' || role === 'admin_readonly'
  const pathname = usePathname()
  // The list an album was opened from is remembered in session storage, which
  // only the browser has; the server and hydration render "not from My Albums".
  const albumFromMine = useClientValue(() => {
    const album = /^\/events\/(\d+)(?:\/|$)/.exec(pathname)
    return !!album && /^\/my-albums(?:\?|$)/.test(galleryParent(username, `album:${album[1]}`, '/'))
  }, false)
  const myAlbumsActive = pathname === '/my-albums' || albumFromMine
  const collectionActive = pathname === '/' || (pathname.startsWith('/events/') && !albumFromMine)
  const [error, setError] = useState<string | null>(null)

  const headerRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const header = headerRef.current
    if (!header) return
    const update = () =>
      document.documentElement.style.setProperty(
        '--app-header-offset',
        `${header.getBoundingClientRect().height}px`,
      )
    const observer = new ResizeObserver(update)
    observer.observe(header)
    update()
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--app-header-offset')
    }
  }, [])

  const detailPage = /^\/(events|photos)\//.test(pathname) || /^\/people\/[^/]+/.test(pathname)
  // One destination list drives desktop navigation and the mobile section picker.
  const destinations = [
    { href: '/', label: 'Library', Icon: Images, active: collectionActive, visible: true },
    {
      href: '/my-albums',
      label: 'My Albums',
      Icon: FolderOpen,
      active: myAlbumsActive,
      visible: true,
    },
    {
      href: '/costs',
      label: 'Costs',
      Icon: Coins,
      active: pathname === '/costs' || pathname === '/admin/costs',
      visible: authenticated,
    },
    {
      href: '/travels',
      label: 'Places',
      Icon: MapPin,
      active: pathname === '/travels',
      visible: true,
    },
    {
      href: '/people',
      label: 'People',
      Icon: UsersRound,
      active: pathname.startsWith('/people'),
      visible: authenticated,
    },
    {
      href: '/favorites',
      label: 'Favorites',
      Icon: Heart,
      active: pathname === '/favorites',
      visible: true,
    },
    {
      href: '/admin/activity',
      label: 'Activity',
      Icon: Activity,
      active: [
        '/admin/activity',
        '/admin/users-activity',
        '/activity/shared-links',
        '/admin/processing',
      ].includes(pathname),
      visible: authenticated && isAdmin,
    },
    {
      href: '/trash',
      label: 'Trash',
      Icon: Trash2,
      active: pathname === '/trash',
      visible: authenticated,
    },
    {
      href: '/admin/access',
      label: 'Users & Roles',
      mobileLabel: 'Access',
      Icon: ShieldCheck,
      active: pathname === '/admin/access',
      visible: canManageAccess || role === 'admin_readonly',
    },
  ].filter((destination) => destination.visible)
  const currentSection = destinations.find((destination) => destination.active)
  const sectionLabel =
    currentSection?.mobileLabel ??
    currentSection?.label ??
    (pathname === '/admin/upload' ? 'Upload' : 'Library')
  return (
    <>
      <header
        data-detail={detailPage || undefined}
        ref={headerRef}
        className="app-header sticky top-0 z-40 w-full text-foreground"
      >
        {error && (
          <p role="alert" className="px-4 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="app-header-row">
          <Link
            href="/"
            aria-label={APP_TITLE}
            className="app-brand flex items-center gap-2.5 shrink-0 hover:opacity-80 transition-opacity"
          >
            {LOGO_SRC && (
              <Image
                src={LOGO_SRC}
                alt=""
                width={36}
                height={36}
                className="shrink-0 w-7 h-7 sm:w-9 sm:h-9"
              />
            )}
            <span className="app-brand-wordmark block">
              <span className="block font-display font-semibold text-sm sm:text-lg leading-tight tracking-tight">
                {APP_TITLE}
              </span>
              <span className="hidden sm:block mt-0.5 text-xs text-muted-foreground">
                Personal media archive
              </span>
            </span>
          </Link>
          <HeaderNavigation compactMobile mobileLabel={sectionLabel}>
            {destinations.map(({ href, label, Icon, active }) => (
              <Link
                key={href}
                href={href}
                className="nav-link"
                aria-current={active ? 'page' : undefined}
              >
                <Icon className="navigation-section-icon" size={18} aria-hidden="true" />
                {label}
              </Link>
            ))}
          </HeaderNavigation>
          <div className="app-header-tools flex shrink-0 items-center gap-1 sm:gap-2">
            <SearchBar />
            {isAdmin && <GalleryStats key={`${username}:${role}`} canManage={mainAdmin} />}
            {authenticated && (
              <Link
                href="/admin/upload"
                aria-label="Upload photos"
                className="primary-button header-upload !p-2.5 sm:!px-4"
              >
                <Upload className="w-4 h-4" />
                <span className="hidden sm:inline">Upload</span>
              </Link>
            )}
            {authenticated ? (
              <AccountMenu
                username={
                  displayName || (/^U_[a-f0-9]{32}$/.test(username ?? '') ? 'Member' : username)
                }
                role={role}
                uploading={uploading}
                loggingOut={loggingOut}
                onLogout={() => void handleLogout()}
              />
            ) : (
              <>
                <ThemeToggle />
                {!authLoading && (
                  <a href="/" className="nav-tool shrink-0">
                    <LogIn className="w-4 h-4" aria-hidden="true" />
                    <span>Log in</span>
                  </a>
                )}
              </>
            )}
          </div>
        </div>
      </header>
    </>
  )
}
