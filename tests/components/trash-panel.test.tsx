// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TrashPanel } from '@/components/trash-panel'
import { account, type Call, json, renderAs, stubFetch } from './harness'

const beach = {
  photoId: 11,
  filename: 'beach.jpg',
  albumName: 'Summer 2024',
  expiresAt: '2026-12-01T00:00:00Z',
}
const cabin = {
  photoId: 12,
  filename: 'cabin.jpg',
  albumName: 'Winter 2025',
  expiresAt: '2026-12-05T00:00:00Z',
}
const albums = {
  items: [
    { eventId: 3, eventName: 'Restored photos', canEdit: true },
    { eventId: 4, eventName: 'Shared with me', canEdit: false },
  ],
  nextCursor: null,
}
/** Trash listing and destination albums; writes to Trash go through `write`. */
function server(
  files: (typeof beach)[],
  write: (call: Call) => Response = () => json({ count: 1 }),
) {
  return stubFetch((call) => {
    if (call.url.startsWith('/api/events?')) return json(albums)
    if (call.url === '/api/trash') return write(call)
    if (call.url.startsWith('/api/trash?page=')) return json({ files, hasMore: false })
    return json({ error: 'Not found' }, 404)
  })
}
const writes = (calls: Call[]) => calls.filter((call) => call.method !== 'GET')
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name })
const checkbox = (name: RegExp) => screen.getByRole<HTMLInputElement>('checkbox', { name })
/** Waits for the listing, then ticks the named files. */
async function select(...names: RegExp[]) {
  await screen.findByText('beach.jpg')
  for (const name of names) fireEvent.click(checkbox(name))
}

it('lists the files in Trash with their albums and the albums they can be restored to', async () => {
  const calls = server([beach, cabin])
  renderAs(<TrashPanel />)
  expect(screen.getByRole('status').textContent).toBe('Loading Trash…')

  expect(await screen.findByText('beach.jpg')).toBeTruthy()
  expect(screen.getByText('cabin.jpg')).toBeTruthy()
  expect(screen.getByText(/Summer 2024 · Retained until/)).toBeTruthy()
  expect(screen.getByText(/Winter 2025 · Retained until/)).toBeTruthy()
  expect(calls.map((call) => call.url)).toContain('/api/trash?page=1')

  // Only albums the member can edit are offered as destinations.
  expect(await screen.findByRole('option', { name: 'Restored photos' })).toBeTruthy()
  expect(screen.getByRole('option', { name: 'Original albums' })).toBeTruthy()
  expect(screen.queryByRole('option', { name: 'Shared with me' })).toBeNull()

  // Nothing is selected yet, so nothing can be restored or deleted.
  expect(button('Restore 0 selected').disabled).toBe(true)
  expect(button('Permanently delete selected').disabled).toBe(true)
  expect(button('Previous').disabled).toBe(true)
  expect(button('Next').disabled).toBe(true)
})

it('says so when Trash is empty', async () => {
  server([])
  renderAs(<TrashPanel />)
  expect(await screen.findByText('No files in Trash on this page.')).toBeTruthy()
  expect(button('Select page').disabled).toBe(true)
})

it('restores exactly the selected files to their original albums', async () => {
  const calls = server([beach, cabin], () => json({ count: 1 }))
  renderAs(<TrashPanel />)
  await select(/cabin\.jpg/)

  fireEvent.click(button('Restore 1 selected'))
  expect((await screen.findByText('1 files restored')).getAttribute('role')).toBe('status')
  expect(writes(calls)).toEqual([{ url: '/api/trash', method: 'POST', body: { ids: [12] } }])
  // The listing is read again after the change.
  expect(calls.filter((call) => call.url === '/api/trash?page=1').length).toBeGreaterThan(1)
})

it('restores a whole page to the chosen album', async () => {
  const calls = server([beach, cabin], () => json({ count: 2 }))
  renderAs(<TrashPanel />)
  await screen.findByText('beach.jpg')
  await screen.findByRole('option', { name: 'Restored photos' })

  fireEvent.click(button('Select page'))
  expect(button('Deselect all')).toBeTruthy()
  fireEvent.change(screen.getByRole('combobox', { name: 'Restore destination' }), {
    target: { value: '3' },
  })
  fireEvent.click(button('Restore 2 selected'))
  expect(await screen.findByText('2 files restored')).toBeTruthy()
  expect(writes(calls)[0].body).toEqual({ ids: [11, 12], eventId: 3 })
})

it('does not delete permanently unless the member confirms', async () => {
  const calls = server([beach, cabin])
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  renderAs(<TrashPanel />)
  await select(/beach\.jpg/)

  fireEvent.click(button('Permanently delete selected'))
  expect(confirm).toHaveBeenCalledWith(
    'Permanently delete 1 selected files? This cannot be undone.',
  )
  fireEvent.click(button('Empty Trash'))
  expect(confirm).toHaveBeenLastCalledWith(
    'Permanently delete EVERY file in Trash? This cannot be undone.',
  )
  expect(writes(calls)).toHaveLength(0)
  expect(checkbox(/beach\.jpg/).checked).toBe(true)
})

it('permanently deletes the selected files once confirmed', async () => {
  const calls = server([beach, cabin], () => json({ count: 1 }))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderAs(<TrashPanel />)
  await select(/beach\.jpg/)

  fireEvent.click(button('Permanently delete selected'))
  expect(await screen.findByText(/1 files permanently deleted from Trash/)).toBeTruthy()
  expect(writes(calls)).toEqual([
    {
      url: '/api/trash',
      method: 'DELETE',
      body: { all: false, ids: [11], confirm: 'PERMANENTLY_DELETE' },
    },
  ])
})

it('shows a listing error and loads again on Retry', async () => {
  let available = false
  stubFetch((call) => {
    if (call.url.startsWith('/api/events?')) return json(albums)
    return available
      ? json({ files: [beach], hasMore: false })
      : json({ error: 'Trash is temporarily unavailable.' }, 503)
  })
  renderAs(<TrashPanel />)
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Trash is temporarily unavailable.',
  )
  expect(screen.queryByText('No files in Trash on this page.')).toBeNull()

  available = true
  fireEvent.click(button('Retry'))
  expect(await screen.findByText('beach.jpg')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows why a restore was refused and keeps the files listed', async () => {
  server([beach, cabin], () => json({ error: 'Your upload allowance is full.' }, 409))
  renderAs(<TrashPanel />)
  await select(/beach\.jpg/)

  fireEvent.click(button('Restore 1 selected'))
  expect((await screen.findByRole('alert')).textContent).toContain('Your upload allowance is full.')
  expect(screen.getByText('beach.jpg')).toBeTruthy()
  expect(screen.queryByText(/files restored/)).toBeNull()
})

it('lets a member without manage rights look but not restore or delete', async () => {
  const calls = server([beach])
  renderAs(<TrashPanel />, account({ canManagePersonal: false }))
  await select(/beach\.jpg/)

  expect(button('Restore 1 selected').disabled).toBe(true)
  expect(button('Permanently delete selected').disabled).toBe(true)
  expect(button('Empty Trash').disabled).toBe(true)
  await waitFor(() => expect(writes(calls)).toHaveLength(0))
})
