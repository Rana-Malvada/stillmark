import { describe, expect, it } from 'vitest'
import {
  imageContentRect,
  parseFaceId,
  projectFaceBox,
  validFaceBox,
} from '@/lib/people/face-highlight'

describe('face highlight geometry', () => {
  it('excludes letterboxing for landscape photos in a portrait viewport', () => {
    const rect = imageContentRect({ left: 0, top: 0, width: 400, height: 800 }, 800, 400)!
    expect(rect).toEqual({ left: 0, top: 300, width: 400, height: 200 })
    expect(projectFaceBox(rect, { x: 0.5, y: 0.25, w: 0.2, h: 0.5 })).toEqual({
      left: 200,
      top: 350,
      width: 80,
      height: 100,
    })
  })
  it('excludes pillarboxing for portrait photos in fullscreen', () => {
    expect(imageContentRect({ left: 10, top: 20, width: 1200, height: 600 }, 400, 800)).toEqual({
      left: 460,
      top: 20,
      width: 300,
      height: 600,
    })
  })
  it('tracks resized or zoomed image bounds including their offset', () => {
    const box = { x: 0.25, y: 0.2, w: 0.1, h: 0.3 }
    expect(projectFaceBox({ left: 5, top: 40, width: 800, height: 500 }, box)).toEqual({
      left: 205,
      top: 140,
      width: 80,
      height: 150,
    })
    expect(projectFaceBox({ left: 10, top: 80, width: 1600, height: 1000 }, box)).toEqual({
      left: 410,
      top: 280,
      width: 160,
      height: 300,
    })
  })
  it('does not produce overlays for missing, malformed or out-of-image boxes', () => {
    for (const box of [
      null,
      undefined,
      { x: NaN, y: 0, w: 0.2, h: 0.2 },
      { x: -0.1, y: 0, w: 0.2, h: 0.2 },
      { x: 0, y: 0, w: 0, h: 0.2 },
      { x: 0.9, y: 0, w: 0.2, h: 0.2 },
    ])
      expect(validFaceBox(box)).toBe(false)
    expect(imageContentRect({ left: 0, top: 0, width: 400, height: 300 }, 0, 0)).toBeNull()
  })
  it('allows rounding at the image edge but clamps the projected box', () => {
    expect(
      projectFaceBox(
        { left: 0, top: 0, width: 100, height: 100 },
        { x: 0.8, y: 0, w: 0.200001, h: 0.5 },
      )?.width,
    ).toBeCloseTo(20)
  })
})
it('accepts only one positive, safe face ID from the URL', () => {
  expect(parseFaceId('123')).toBe(123)
  for (const value of [
    undefined,
    ['1', '2'],
    '',
    '0',
    '-1',
    '1.5',
    '1e3',
    'NaN',
    '9007199254740992',
  ])
    expect(parseFaceId(value)).toBeNull()
})
