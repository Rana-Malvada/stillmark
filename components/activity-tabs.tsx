'use client'
import Link from 'next/link'
import { HeaderNavigation } from './header-navigation'
import { usePathname } from 'next/navigation'
import { useAuth } from './auth-provider'

export function ActivityTabs() {
  const pathname = usePathname()
  const { role, canManageAccess, mainAdmin } = useAuth()
  if (role !== 'admin' && role !== 'admin_readonly') return null
  const tabs = [
    ...(role === 'admin' || role === 'admin_readonly'
      ? [{ href: '/admin/activity', label: 'Activity' }]
      : []),
    ...(canManageAccess || role === 'admin_readonly'
      ? [{ href: '/admin/users-activity', label: 'User Activity' }]
      : []),
    { href: '/activity/shared-links', label: 'Shared Links' },
    ...(mainAdmin ? [{ href: '/admin/processing', label: 'Processing' }] : []),
  ]
  return (
    <div className="w-full min-w-0 px-5 sm:px-8 pt-4 border-b border-border">
      <HeaderNavigation label="Activity sections">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={pathname === tab.href ? 'page' : undefined}
            className="nav-link"
          >
            {tab.label}
          </Link>
        ))}
      </HeaderNavigation>
    </div>
  )
}
