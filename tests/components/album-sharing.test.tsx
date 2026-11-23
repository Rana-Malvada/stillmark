// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AlbumSharing } from '@/components/album-sharing'
import { account, type Call, json, renderAs, stubFetch } from './harness'

type Sharing = {
  owner: string
  ownerDisplayName?: string
  visibility: 'PRIVATE' | 'GALLERY'
  canEdit: boolean
  mainAdmin: boolean
  shares: { username: string; displayName?: string }[]
}
const privateAlbum = (): Sharing => ({
  owner: 'alice',
  ownerDisplayName: 'Alice',
  visibility: 'PRIVATE',
  canEdit: true,
  mainAdmin: false,
  shares: [],
})
/** A small sharing endpoint: reads return the album, writes go through `write`. */
function server(album: Sharing, write: (call: Call) => Response = () => json({ ok: true })) {
  return stubFetch((call) => {
    if (call.url !== '/api/events/7/sharing') return json({ error: 'Not found' }, 404)
    return call.method === 'POST' ? write(call) : json(album)
  })
}
const writes = (calls: Call[]) => calls.filter((call) => call.method === 'POST')
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
const username = () =>
  screen.getByRole<HTMLInputElement>('textbox', { name: 'Gallery username to share with' })
/** Opens the panel and waits until the loaded controls accept input. */
async function openAccess(control: string) {
  fireEvent.click(button('Album access'))
  await waitFor(() => expect(button(control).disabled).toBe(false))
}

it('shows an owner who is sharing with, and the share and visibility controls', async () => {
  const album = { ...privateAlbum(), shares: [{ username: 'bob', displayName: 'Bob' }] }
  const calls = server(album)
  renderAs(<AlbumSharing eventId={7} canEdit />)
  expect(calls).toHaveLength(0)

  await openAccess('Share with all gallery users')
  expect(screen.getByRole('region', { name: 'Album access' })).toBeTruthy()
  expect(screen.getByText(/Owner: Alice · Private/)).toBeTruthy()
  expect(screen.getByText('Bob · Viewer')).toBeTruthy()
  expect(button('Remove access').disabled).toBe(false)
  expect(username().disabled).toBe(false)
  // Nothing to share with until a username is entered.
  expect(button('Share as viewer').disabled).toBe(true)
  // Ownership transfer is the main admin's control only.
  expect(screen.queryByRole('button', { name: 'Transfer to entered username' })).toBeNull()
})

it('shows a viewer who cannot edit no access control at all', () => {
  const calls = server(privateAlbum())
  const view = renderAs(<AlbumSharing eventId={7} canEdit={false} />)
  expect(screen.queryByRole('button', { name: 'Album access' })).toBeNull()
  expect(view.container.textContent).toBe('')
  expect(calls).toHaveLength(0)
})

it('lets a read-only admin see who has access with every control disabled', async () => {
  const album = { ...privateAlbum(), canEdit: false, shares: [{ username: 'bob' }] }
  const calls = server(album)
  renderAs(<AlbumSharing eventId={7} canEdit={false} />, account({ role: 'admin_readonly' }))

  fireEvent.click(button('Album access'))
  expect(await screen.findByText('bob · Viewer')).toBeTruthy()
  expect(username().disabled).toBe(true)
  expect(button('Remove access').disabled).toBe(true)
  expect(button('Share with all gallery users').disabled).toBe(true)
  expect(button('Transfer to entered username').disabled).toBe(true)
  fireEvent.click(button('Share with all gallery users'))
  expect(writes(calls)).toHaveLength(0)
})

it('asks before making an album visible to all, and sends nothing if declined', async () => {
  const calls = server(privateAlbum())
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  renderAs(<AlbumSharing eventId={7} canEdit />)
  await openAccess('Share with all gallery users')

  fireEvent.click(button('Share with all gallery users'))
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(confirm.mock.calls[0][0]).toMatch(/everyone who is signed in to the gallery/)
  expect(writes(calls)).toHaveLength(0)
  expect(button('Share with all gallery users')).toBeTruthy()
})

it('makes the album visible to all once confirmed, then offers to make it private', async () => {
  const album = privateAlbum()
  const calls = server(album, (call) => {
    album.visibility = (call.body as { visibility: Sharing['visibility'] }).visibility
    return json({ ok: true })
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderAs(<AlbumSharing eventId={7} canEdit />)
  await openAccess('Share with all gallery users')

  fireEvent.click(button('Share with all gallery users'))
  expect(await screen.findByRole('button', { name: 'Make private' })).toBeTruthy()
  expect(writes(calls).map((call) => call.body)).toEqual([
    expect.objectContaining({ action: 'visibility', visibility: 'GALLERY' }),
  ])
  expect(screen.getByText(/Shared collection — all gallery users/)).toBeTruthy()

  // Narrowing access needs no confirmation.
  await waitFor(() => expect(button('Make private').disabled).toBe(false))
  fireEvent.click(button('Make private'))
  expect(await screen.findByRole('button', { name: 'Share with all gallery users' })).toBeTruthy()
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(writes(calls)[1].body).toMatchObject({ action: 'visibility', visibility: 'PRIVATE' })
})

it('shares with the entered username and lists the new viewer', async () => {
  const album = privateAlbum()
  const calls = server(album, (call) => {
    album.shares = [{ username: (call.body as { username: string }).username }]
    return json({ ok: true })
  })
  renderAs(<AlbumSharing eventId={7} canEdit />)
  await openAccess('Share with all gallery users')

  fireEvent.change(username(), { target: { value: 'bob' } })
  fireEvent.click(button('Share as viewer'))
  expect(await screen.findByText('bob · Viewer')).toBeTruthy()
  expect(writes(calls).map((call) => call.body)).toEqual([{ action: 'share', username: 'bob' }])
  await waitFor(() => expect(username().value).toBe(''))
})

it('removes the chosen viewer', async () => {
  const album = { ...privateAlbum(), shares: [{ username: 'bob' }, { username: 'carol' }] }
  const calls = server(album, (call) => {
    const removed = (call.body as { username: string }).username
    album.shares = album.shares.filter((share) => share.username !== removed)
    return json({ ok: true })
  })
  renderAs(<AlbumSharing eventId={7} canEdit />)
  await openAccess('Share with all gallery users')

  fireEvent.click(screen.getAllByRole('button', { name: 'Remove access' })[1])
  await waitFor(() => expect(screen.queryByText('carol · Viewer')).toBeNull())
  expect(screen.getByText('bob · Viewer')).toBeTruthy()
  expect(writes(calls)[0].body).toMatchObject({ action: 'revoke', username: 'carol' })
})

it('reports a refused change, keeps the album as it was, and never repeats the write', async () => {
  const calls = server(privateAlbum(), () => json({ error: 'No gallery user has that name.' }, 400))
  renderAs(<AlbumSharing eventId={7} canEdit />)
  await openAccess('Share with all gallery users')

  fireEvent.change(username(), { target: { value: 'nobody' } })
  fireEvent.click(button('Share as viewer'))
  expect((await screen.findByRole('alert')).textContent).toBe('No gallery user has that name.')
  expect(screen.getByText(/Owner: Alice · Private/)).toBeTruthy()
  expect(writes(calls)).toHaveLength(1)
})

it('shows a load failure and loads again on Retry access', async () => {
  let available = false
  stubFetch(() =>
    available ? json(privateAlbum()) : json({ error: 'Album access is unavailable.' }, 503),
  )
  renderAs(<AlbumSharing eventId={7} canEdit />)
  fireEvent.click(button('Album access'))
  expect((await screen.findByRole('alert')).textContent).toBe('Album access is unavailable.')
  expect(screen.queryByRole('button', { name: 'Share with all gallery users' })).toBeNull()

  available = true
  await waitFor(() => expect(button('Retry access').disabled).toBe(false))
  fireEvent.click(button('Retry access'))
  expect(await screen.findByText(/Owner: Alice · Private/)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})
