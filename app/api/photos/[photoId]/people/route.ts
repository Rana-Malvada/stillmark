import { peopleRead, peopleWrite } from '@/lib/people/people-api'
import { requirePhotoAccess } from '@/lib/albums/album-access'
import { photoPeople, tagPhoto } from '@/lib/people'
import { integer } from '@/lib/http'

export const dynamic = 'force-dynamic'

/** People in a photo for the Info panel; unreadable photos are 404 as elsewhere. */
export const GET = peopleRead(async (_req, { photoId }) => {
  const id = integer(photoId, 'photoId')
  await requirePhotoAccess(id)
  return photoPeople(id)
})

/** Tags someone the scanner missed, with a drawn box or name only. */
export const POST = peopleWrite('tag', (body, { photoId }) => tagPhoto(photoId, body))
