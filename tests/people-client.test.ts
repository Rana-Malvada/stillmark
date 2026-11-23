import { afterEach, expect, it, vi } from 'vitest'
import { peopleApi } from '@/lib/people/people-client'
import {
  isPeopleOverview,
  isPeopleSettings,
  loadPeopleOverview,
} from '@/lib/people/people-overview-contract'
import { UnconfirmedMutationError } from '@/lib/client-operation'

const page = {
  named: [
    {
      personId: 'p',
      name: 'Name',
      hidden: false,
      coverFaceId: '42',
      photoCount: 1,
      reviewCount: 0,
    },
  ],
  unnamed: [],
  hidden: [],
  nextCursor: null,
  more: false,
}
const totals = {
  reviewCount: 0,
  lowerConfidenceCount: 0,
  unknownCount: 0,
  ignoredCount: 0,
  unnamedCount: 0,
  peopleCount: 1,
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it.each(['headers', 'body'])('bounds People reads including stalled %s', async (phase) => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, init) => {
      signal = init.signal
      return phase === 'headers'
        ? new Promise(() => {})
        : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) })
    }),
  )
  const checked = expect(peopleApi('/api/people')).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(45001)
  await checked
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it('never replays an uncertain People correction', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal('fetch', fetch)
  const checked = expect(
    peopleApi('/api/people/assign', 'POST', { faceIds: [1], name: 'Person' }),
  ).rejects.toBeInstanceOf(UnconfirmedMutationError)
  await vi.advanceTimersByTimeAsync(45001)
  await checked
  expect(fetch).toHaveBeenCalledOnce()
})
it('requires totals for initial views but accepts omitted totals for pagination', async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json(page)))
  vi.stubGlobal('fetch', fetch)
  await expect(loadPeopleOverview('/api/people')).rejects.toThrow('Unable to load people')
  expect(
    (await loadPeopleOverview('/api/people?summary=false', undefined, false)).named[0].coverFaceId,
  ).toBe(42)
  fetch.mockImplementation(() => Promise.resolve(Response.json({ ...page, ...totals })))
  expect(await loadPeopleOverview('/api/people')).toMatchObject({
    ...totals,
    named: [{ coverFaceId: 42 }],
  })
})
it('rejects malformed People cards/settings before rendering', () => {
  for (const bad of [
    {},
    null,
    [],
    { ...page, named: [null] },
    { ...page, named: [{ ...page.named[0], coverFaceId: '9007199254740993' }] },
    { ...page, unknownCount: '0' },
  ])
    expect(isPeopleOverview(bad)).toBe(false)
  expect(isPeopleSettings({ enabled: true, shareNames: false })).toBe(true)
  expect(isPeopleSettings({})).toBe(false)
})
