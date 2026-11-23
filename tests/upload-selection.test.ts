import { expect, it } from 'vitest'
import { selectedMedia } from '@/lib/upload/upload-file-filter'

it('accepts video-only mobile selections, uppercase MOV and M4V', () => {
  const files = [
    new File(['v'], 'IMG_100.MOV', { type: 'video/quicktime' }),
    new File(['v'], 'export.m4v', { type: 'video/x-m4v' }),
  ]
  expect(selectedMedia(files)).toEqual({ files, rejected: 0 })
})
it('preserves extensionless picker video bytes and reports unsupported files', async () => {
  const result = selectedMedia([
    new File(['original'], 'IMG_100', { type: 'video/quicktime', lastModified: 123 }),
    new File(['x'], 'movie.avi', { type: 'video/x-msvideo' }),
  ])
  expect(result.rejected).toBe(1)
  expect(result.files[0].name).toBe('IMG_100.mov')
  expect(result.files[0].lastModified).toBe(123)
  expect(await result.files[0].text()).toBe('original')
})
