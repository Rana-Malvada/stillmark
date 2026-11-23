import { describe, expect, it } from 'vitest'
import { objects } from '../config/deployment.mjs'
import { mediaStage } from '@/lib/snowflake/media-stage'

describe('media stage routing', () => {
  it.each([
    ['display/prepared/abc/720/playback.mp4', objects.derived],
    ['faces/0b6c1a52-7f0e-4a7e-9a55-3f5d2f1c9e10.webp', objects.derived],
    ['originals/86 Santa Barbara June 2026/IMG_4850.jpeg', objects.originals],
    ['display/abc.jpg', objects.originals],
    ['thumbnails/abc.jpg', objects.originals],
    ['upload-chunks/abc/0', objects.originals],
    // Prefix matching is exact: look-alike folders stay on the originals stage.
    ['facesx/abc.webp', objects.originals],
    ['originals/faces/abc.webp', objects.originals],
  ])('routes %s', (path, stage) => {
    expect(mediaStage(path)).toBe('@' + stage)
  })
})
