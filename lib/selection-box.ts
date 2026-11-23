export interface Point {
  x: number
  y: number
}
export interface SelectionBox {
  left: number
  top: number
  width: number
  height: number
}
export function selectionBox(start: Point, end: Point): SelectionBox {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}
export function intersectsSelection(box: SelectionBox, tile: SelectionBox) {
  return (
    box.left < tile.left + tile.width &&
    box.left + box.width > tile.left &&
    box.top < tile.top + tile.height &&
    box.top + box.height > tile.top
  )
}
