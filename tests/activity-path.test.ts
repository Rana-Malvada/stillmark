import { expect, it, vi } from 'vitest'
import { globSync } from 'node:fs'
import { isActivityPath } from '@/lib/observability/activity-path'
import { acknowledgeActivity, pendingActivity, queueActivity } from '@/lib/browser-activity'

it('supports every app page including people and batch tools', () => {
  for (const file of globSync('app/**/page.tsx')) {
    const path =
      file
        .replace(/^app/, '')
        .replace(/\/page.tsx$/, '')
        .replace('[personId]', '11111111-1111-4111-8111-111111111111')
        .replace(/\[(?:eventId|photoId)\]/g, '123') || '/'
    expect(isActivityPath(path), path).toBe(true)
  }
})
it('does not queue unsupported paths or sensitive URL contents ahead of valid activity', () => {
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  try {
    for (const path of [
      '/api/users',
      '/share/private-token',
      '/people?name=private',
      'https://example.com',
      '/unknown',
    ]) {
      expect(isActivityPath(path)).toBe(false)
      queueActivity({ path })
    }
    queueActivity({ path: '/people' })
    queueActivity({ path: '/travels' })
    expect(pendingActivity().map((e) => e.path)).toEqual(['/people', '/travels'])
  } finally {
    acknowledgeActivity(new Set(pendingActivity().map((e) => e.id)))
    vi.unstubAllGlobals()
  }
})
