import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'

vi.mock('@/lib/media/image-urls', () => ({}))
vi.mock('@/lib/snowflake/stage-upload', () => ({}))
vi.mock('@/lib/postgres', () => ({}))
vi.mock('@/lib/snowflake', () => ({}))
import { videoPoster } from '@/lib/video/video-compression'

it('makes a JPEG poster from an uploaded video without modifying the source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'poster-test-'))
  try {
    const path = join(dir, 'test.mp4')
    execFileSync(require('ffmpeg-static'), [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=640x360:d=1',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      path,
    ])
    const before = await stat(path)
    const poster = await videoPoster(path)
    const metadata = await sharp(poster).metadata()
    expect(metadata.format).toBe('jpeg')
    expect(metadata.width).toBe(400)
    expect(metadata.height).toBe(225)
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
