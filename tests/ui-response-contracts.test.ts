import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFolderOptions, loadFolderOptions } from '../lib/albums/folder-options'
import {
  isActivityStatus,
  isFaceScanStatus,
  isVideoPreparationStatus,
} from '../lib/process-status-contracts'
import { loadAlbumDestinations } from '../lib/albums/album-destinations'
import { isSearchBatchStatus } from '../lib/search/search-batch-status'

afterEach(() => vi.unstubAllGlobals())
const idle = () => ({
  summary: { pending: 0, running: 0, completed: 0, failed: 0 },
  searches: { pending: 0 },
  pipeline: null,
  automaticPublishing: null,
  warmIdle: false,
  checkedAt: new Date().toISOString(),
  rankingEnabled: false,
})
describe('browser status and folder response contracts', () => {
  it('accepts an empty search history and rejects missing or malformed counters', () => {
    expect(isSearchBatchStatus(idle())).toBe(true)
    expect(isSearchBatchStatus({ ...idle(), summary: {} })).toBe(false)
    expect(isSearchBatchStatus({ ...idle(), summary: { ...idle().summary, pending: '3' } })).toBe(
      false,
    )
    expect(isSearchBatchStatus({ ...idle(), pipeline: { active: true } })).toBe(false)
  })
  it('requires explicit selection capability, not only a plausible folder ID', () => {
    expect(isFolderOptions([{ folderId: 1, folderName: 'Main', canEdit: true }])).toBe(false)
    expect(
      isFolderOptions([{ folderId: 1, folderName: 'Main', canEdit: false, canSelect: true }]),
    ).toBe(true)
  })
  for (const response of [
    new Response('<html>', { status: 502 }),
    new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
    new Response(JSON.stringify([{ folderId: 1 }])),
  ])
    it(`rejects failed/malformed folder responses (${response.status})`, async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
      await expect(loadFolderOptions(new AbortController().signal)).rejects.toThrow()
    })
  it('only exposes folders the server marks selectable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { folderId: 1, folderName: 'Allowed', canEdit: false, canSelect: true },
            { folderId: 2, folderName: 'Other', canEdit: true, canSelect: false },
          ]),
        ),
      ),
    )
    expect(await loadFolderOptions(new AbortController().signal)).toEqual([
      { folderId: 1, folderName: 'Allowed', canEdit: false, canSelect: true },
    ])
  })
  it('rejects malformed worker/status rows before rendering', () => {
    for (const check of [isFaceScanStatus, isVideoPreparationStatus, isActivityStatus]) {
      expect(check({})).toBe(false)
      expect(check({ summary: {} })).toBe(false)
      expect(check(null)).toBe(false)
    }
    expect(
      isActivityStatus({
        summary: { active_ai: '2' },
        asOf: '2026-11-21',
        uploads: [],
        failures: [],
        cleanup: [],
        sync: null,
      }),
    ).toBe(true)
    expect(
      isFaceScanStatus({
        summary: { total: 0, scanned: 0, pending: 0, failed: 0, owners: 0 },
        progress: null,
        failures: [],
        continuing: false,
        estimatedMinutes: 0,
      }),
    ).toBe(true)
    expect(
      isVideoPreparationStatus({
        summary: { total: 0, ready: 0, pending: 0, skipped: 0 },
        progress: null,
        failures: [],
        excluded: [],
      }),
    ).toBe(true)
  })
  for (const [name, load] of [
    ['folders', (signal: AbortSignal) => loadFolderOptions(signal)],
    ['albums', (signal: AbortSignal) => loadAlbumDestinations(null, signal)],
  ] as const)
    it(`bounds a stalled ${name} lookup and retains caller cancellation`, async () => {
      const timeout = new AbortController()
      const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url, options) =>
            new Promise((_resolve, reject) => {
              options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                once: true,
              })
            }),
        ),
      )
      try {
        const caller = new AbortController()
        const deadlineRead = load(caller.signal)
        const rejected = expect(deadlineRead).rejects.toThrow('Request timed out')
        timeout.abort(new Error('Request timed out'))
        await rejected
        expect(spy).toHaveBeenCalledWith(45000)
        spy.mockReturnValue(new AbortController().signal)
        const cancelledRead = load(caller.signal)
        const cancelled = expect(cancelledRead).rejects.toThrow('Closed')
        caller.abort(new Error('Closed'))
        await cancelled
      } finally {
        spy.mockRestore()
      }
    })
})
