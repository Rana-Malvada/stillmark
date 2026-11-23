import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createThumbnailLoader, createThumbnailMemory } from '../public/thumbnail-loader.mjs'

const origin = 'https://photos.example'
const now = Math.floor(Date.now() / 1000)
const path = (i = 1) =>
  `thumbnails/400/1/00000000-0000-4000-8000-${String(i).padStart(12, '0')}/image.jpg`
function url({ sid = 'session', sub = 'user', exp = now + 60, iat = now, file = path() } = {}) {
  const token =
    Buffer.from(
      JSON.stringify({ v: 1, sid, sub, iat, exp, path: file, variant: 'thumbnail', aud: origin }),
    ).toString('base64url') + '.fixture-signature'
  return `/api/images?path=${encodeURIComponent(file)}&grant=${token}`
}
function environment() {
  const events = new Map<string, () => void>()
  const frames: (() => void)[] = []
  const timers = new Map<number, () => void>()
  let id = 0
  let requests = 0
  let objectUrls = 0
  let revoked = 0
  const win = {
    location: { origin },
    innerHeight: 600,
    innerWidth: 400,
    setTimeout(fn: () => void) {
      timers.set(++id, fn)
      return id
    },
    clearTimeout(id: number) {
      timers.delete(id)
    },
    addEventListener(name: string, fn: () => void) {
      events.set(name, fn)
    },
    removeEventListener(name: string) {
      events.delete(name)
    },
    requestAnimationFrame(fn: () => void) {
      frames.push(fn)
      return frames.length
    },
    cancelAnimationFrame() {},
    URL: {
      createObjectURL() {
        return `blob:${++objectUrls}`
      },
      revokeObjectURL() {
        revoked++
      },
    },
    async fetch() {
      requests++
      return new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg' } })
    },
  }
  return { win, events, timers, frames, requests: () => requests, revoked: () => revoked }
}
test('reuses bytes across renewed grants, but separates sessions, subjects and paths', () => {
  const { win } = environment()
  const cache = createThumbnailMemory(win)
  const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
  cache.put(url({ iat: now - 1, exp: now + 59 }), blob, cache.generation())
  assert.equal(cache.get(url()), blob)
  assert.equal(cache.get(url({ sid: 'other' })), null)
  assert.equal(cache.get(url({ sub: 'other' })), null)
  assert.equal(cache.get(url({ file: path(2) })), null)
  assert.equal(cache.get(url({ iat: now - 60, exp: now })), null)
  assert.equal(cache.get('/api/images?path=' + encodeURIComponent(path())), null)
  assert.equal(cache.get(url() + '&download=1'), null)
  assert.equal(cache.get(url({ file: 'originals/private.jpg' })), null)
})
test('logout clears bytes and prevents a previously started request repopulating them', () => {
  const { win, events } = environment()
  const cache = createThumbnailMemory(win)
  const epoch = cache.generation()
  const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
  cache.put(url(), blob, epoch)
  events.get('gallery-logout')!()
  cache.put(url(), blob, epoch)
  assert.equal(cache.get(url()), null)
})
test('enforces the memory budget and idle expiry', () => {
  const { win, timers } = environment()
  const cache = createThumbnailMemory(win)
  const blob = new Blob([new Uint8Array(512 * 1024)], { type: 'image/jpeg' })
  for (let i = 1; i <= 33; i++) cache.put(url({ file: path(i) }), blob, cache.generation())
  assert.equal(cache.get(url({ file: path(1) })), null)
  assert.equal(cache.get(url({ file: path(33) })), blob)
  // oxlint-disable-next-line unicorn/no-useless-spread -- callbacks may add or remove timers
  for (const fn of [...timers.values()]) fn()
  assert.equal(cache.get(url({ file: path(33) })), null)
})
test.each([false, true])('album return reuses bytes with batch transport %s', async (batch) => {
  const env = environment()
  const loader = createThumbnailLoader(
    env.win,
    batch
      ? {
          previewBatch: {
            path: () => path(),
            fetch: async () => (await env.win.fetch()).blob(),
          },
        }
      : {},
  )
  function image() {
    const listeners = new Map<string, () => void>()
    return {
      src: '',
      dataset: {} as Record<string, string>,
      getBoundingClientRect: () => ({
        top: 0,
        bottom: 100,
        left: 0,
        right: 100,
        width: 100,
        height: 100,
      }),
      addEventListener(name: string, fn: () => void) {
        listeners.set(name, fn)
      },
      removeEventListener(name: string) {
        listeners.delete(name)
      },
      removeAttribute() {},
      emit(name: string) {
        listeners.get(name)?.()
      },
    }
  }
  const first = image()
  const dispose = loader.observe(first, url({ iat: now - 1, exp: now + 59 }))
  env.frames.shift()!()
  await new Promise(setImmediate)
  assert.match(first.src, /^blob:/)
  first.emit('load')
  dispose()
  const returned = image()
  loader.observe(returned, url())
  env.frames.shift()!()
  await new Promise(setImmediate)
  assert.match(returned.src, /^blob:/)
  returned.emit('load')
  assert.equal(env.requests(), 1)
  assert.equal(env.revoked(), 2)
})
