import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createThumbnailLoader } from '../public/thumbnail-loader.mjs'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function setup(concurrency = 2) {
  const listeners = new Map<string, Set<() => void>>()
  const frames = new Map<number, () => void>()
  const starts: string[] = []
  let id = 0
  const win = {
    innerHeight: 600,
    innerWidth: 400,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn: () => void) => {
      frames.set(++id, fn)
      return id
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    addEventListener: (name: string, fn: () => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(fn)
    },
    removeEventListener: (name: string, fn: () => void) => listeners.get(name)?.delete(fn),
  }
  function image(name: string, top: number, left = 0) {
    const events = new Map<string, () => void>()
    let url = ''
    return {
      top,
      left,
      width: 100,
      fetchPriority: '',
      dataset: {} as Record<string, string>,
      getBoundingClientRect() {
        return {
          top: this.top,
          bottom: this.top + 100,
          left: this.left,
          right: this.left + 100,
          width: this.width,
          height: 100,
        }
      },
      addEventListener: (event: string, fn: () => void) => events.set(event, fn),
      removeEventListener: (event: string) => events.delete(event),
      removeAttribute: () => {
        url = ''
      },
      get src() {
        return url
      },
      set src(value: string) {
        url = value
        starts.push(name)
      },
      emit: (event: string) => events.get(event)?.(),
    }
  }
  const loader = createThumbnailLoader(win, { concurrency })
  const frame = () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((fn) => fn())
  }
  const scroll = () => {
    listeners.get('scroll')?.forEach((fn) => fn())
    frame()
  }
  return { loader, image, starts, frame, scroll, listeners }
}
it('starts visible images in page order before nearby images, with bounded parallelism', () => {
  const { loader, image, starts, frame } = setup()
  const nearby = image('nearby', 700)
  const right = image('right', 0, 100)
  const left = image('left', 0)
  const lower = image('lower', 120)
  const far = image('far', 2000)
  for (const img of [nearby, lower, right, far, left]) loader.observe(img, '/thumb')
  frame()
  expect(starts).toEqual(['left', 'right'])
  // A later image finishing releases its slot without waiting for the first.
  right.emit('load')
  frame()
  expect(starts).toEqual(['left', 'right', 'lower'])
  lower.emit('load')
  frame()
  expect(starts.at(-1)).toBe('nearby')
  expect(far.src).toBe('')
})
it('starts newly visible images immediately by preempting distant downloads', () => {
  const { loader, image, starts, frame, scroll } = setup(1)
  const first = image('first', 0)
  const old = image('old', 100)
  const next = image('next', 1800)
  for (const img of [old, next, first]) loader.observe(img, '/thumb')
  frame()
  expect(first.fetchPriority).toBe('high')
  first.top = -1800
  old.top = -1700
  next.top = 0
  scroll()
  expect(first.fetchPriority).toBe('low')
  expect(next.fetchPriority).toBe('high')
  expect(starts).toEqual(['first', 'next'])
  expect(first.src).toBe('')
  expect(first.dataset.thumbnailState).toBe('deferred')
  expect(first.dataset.thumbnailAttempt).toBe('0')
  first.emit('error') // A cancelled old request cannot consume a retry.
  expect(first.dataset.thumbnailState).toBe('deferred')
  next.emit('load')
  first.top = 0
  scroll()
  expect(starts).toEqual(['first', 'next', 'first'])
  expect(first.dataset.thumbnailAttempt).toBe('0')
})
it('retries failures at most twice and lets other images load during backoff', () => {
  const { loader, image, starts, frame } = setup(1)
  const broken = image('broken', 0)
  const good = image('good', 100)
  const states: string[] = []
  loader.observe(broken, '/thumb?grant=existing', (state: string) => states.push(state))
  loader.observe(good, '/other')
  frame()
  broken.emit('error')
  frame()
  expect(starts).toEqual(['broken', 'good'])
  good.emit('load')
  frame()
  vi.advanceTimersByTime(750)
  frame()
  expect(broken.src).toBe('/thumb?grant=existing&thumbnailRetry=1')
  broken.emit('error')
  vi.advanceTimersByTime(1500)
  frame()
  broken.emit('error')
  vi.advanceTimersByTime(60000)
  frame()
  expect(starts.filter((x) => x === 'broken')).toHaveLength(3)
  expect(states.at(-1)).toBe('failed')
})
it('recovers silent stalls and cleans up requests, timers and listeners on unmount', () => {
  const { loader, image, frame, starts, listeners } = setup(1)
  const img = image('stall', 0)
  const dispose = loader.observe(img, '/thumb')
  frame()
  vi.advanceTimersByTime(25000)
  expect(img.src).toBe('')
  vi.advanceTimersByTime(750)
  frame()
  expect(starts).toHaveLength(2)
  dispose()
  expect(img.src).toBe('')
  expect(listeners.get('scroll')?.size).toBe(0)
  expect(listeners.get('resize')?.size).toBe(0)
  vi.advanceTimersByTime(60000)
  frame()
  expect(starts).toHaveLength(2)
  expect(vi.getTimerCount()).toBe(0)
})
it('does not load hidden or horizontally distant images and works without IntersectionObserver', () => {
  const { loader, image, frame, starts, scroll } = setup()
  const hidden = image('hidden', 0)
  const distant = image('distant', 0, 1200)
  hidden.width = 0
  loader.observe(hidden, '/hidden')
  loader.observe(distant, '/distant')
  frame()
  expect(starts).toEqual([])
  hidden.width = 100
  distant.left = 100
  scroll()
  expect(starts).toEqual(['hidden', 'distant'])
})
it('keeps nearby transfers running and cancels no work without visible demand', () => {
  const { loader, image, starts, frame, scroll } = setup(1)
  const first = image('first', 0)
  const next = image('next', 1800)
  loader.observe(first, '/first')
  loader.observe(next, '/next')
  frame()
  first.top = -150
  next.top = 0
  scroll()
  expect(starts).toEqual(['first'])
  expect(first.src).toBe('/first')
  first.top = -2000
  next.top = 700
  scroll()
  expect(first.src).toBe('/first')
  expect(starts).toEqual(['first'])
  next.top = 0
  scroll()
  expect(starts).toEqual(['first', 'next'])
})
