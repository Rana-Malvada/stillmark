/**
 * SQL condition limiting a public-link query to the link's selected photos.
 * Row security enforces the same rule; public routes repeat it so that a
 * selection never depends on a single layer. `param` is the bind position of
 * `publicSelection(link)`.
 */
export function selectedPhotos(param: number, column = 'photo_id') {
  if (!Number.isInteger(param) || param < 1 || !/^[a-z_.]+$/.test(column))
    throw new Error('Invalid selection condition')
  return ` AND ($${param}::integer[] IS NULL OR ${column}=ANY($${param}::integer[]))`
}
export function publicSelection(link: { photo_ids?: number[] | null }) {
  return link.photo_ids ?? null
}
