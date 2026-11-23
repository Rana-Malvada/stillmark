import { describe, expect, it } from 'vitest'
import { intersectsSelection, selectionBox } from '../lib/selection-box'

describe('drag selection geometry', () => {
  it('selects the same rectangle in all four drag directions', () => {
    for (const [start, end] of [
      [
        { x: 10, y: 20 },
        { x: 80, y: 100 },
      ],
      [
        { x: 80, y: 100 },
        { x: 10, y: 20 },
      ],
      [
        { x: 10, y: 100 },
        { x: 80, y: 20 },
      ],
      [
        { x: 80, y: 20 },
        { x: 10, y: 100 },
      ],
    ])
      expect(selectionBox(start, end)).toEqual({ left: 10, top: 20, width: 70, height: 80 })
  })
  it('selects partially intersecting tiles and excludes neighboring tiles and edge-only contact', () => {
    const box = selectionBox({ x: 0, y: 0 }, { x: 110, y: 110 })
    expect(intersectsSelection(box, { left: 100, top: 100, width: 80, height: 80 })).toBe(true)
    expect(intersectsSelection(box, { left: 110, top: 0, width: 80, height: 80 })).toBe(false)
    expect(intersectsSelection(box, { left: 0, top: 111, width: 80, height: 80 })).toBe(false)
    expect(intersectsSelection(box, { left: 20, top: 20, width: 40, height: 40 })).toBe(true)
  })
})
