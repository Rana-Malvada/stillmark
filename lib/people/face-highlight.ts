export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
}
export interface ImageRect {
  left: number
  top: number
  width: number
  height: number
}

export function parseFaceId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const id = Number(value)
  return Number.isSafeInteger(id) ? id : null
}

export function validFaceBox(box: FaceBox | null | undefined): box is FaceBox {
  return (
    !!box &&
    [box.x, box.y, box.w, box.h].every(Number.isFinite) &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.w > 0 &&
    box.h > 0 &&
    box.x < 1 &&
    box.y < 1 &&
    box.x + box.w <= 1.000001 + Number.EPSILON &&
    box.y + box.h <= 1.000001 + Number.EPSILON
  )
}

/** The visible pixels inside a centered object-contain image element, excluding letterboxing. */
export function imageContentRect(
  element: ImageRect,
  naturalWidth: number,
  naturalHeight: number,
): ImageRect | null {
  if (
    ![element.left, element.top, element.width, element.height, naturalWidth, naturalHeight].every(
      Number.isFinite,
    ) ||
    element.width <= 0 ||
    element.height <= 0 ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  )
    return null
  const scale = Math.min(element.width / naturalWidth, element.height / naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  return {
    left: element.left + (element.width - width) / 2,
    top: element.top + (element.height - height) / 2,
    width,
    height,
  }
}

export function projectFaceBox(image: ImageRect, box: FaceBox): ImageRect | null {
  if (!validFaceBox(box)) return null
  return {
    left: image.left + box.x * image.width,
    top: image.top + box.y * image.height,
    width: Math.min(box.w, 1 - box.x) * image.width,
    height: Math.min(box.h, 1 - box.y) * image.height,
  }
}
