import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

vi.mock('@/components/auth-provider', () => ({ useAuth: () => ({ mainAdmin: true }) }))
import { ActivityPanel } from '@/components/activity-panel'

it('renders a visible loading status before the first Activity request completes', () => {
  const html = renderToStaticMarkup(createElement(ActivityPanel))
  expect(html).toContain('role="status"')
  expect(html).toContain('Loading activity…')
  expect(html).toContain('Refreshing…')
  expect(html).not.toContain('No failures recorded.')
})
