export interface Face {
  faceId: number
  photoId: number
  eventId?: number
  thumbnailPath?: string | null
  hasCrop: boolean
  qualityOk?: boolean
  status?: 'suggested' | 'auto' | 'confirmed' | null
  score?: number | null
  source?: 'detected' | 'manual'
  personId?: string | null
  personName?: string | null
}
export interface Person {
  personId: string
  name: string | null
  hidden: boolean
  coverFaceId: number | null
  photoCount: number
  reviewCount: number
}
export interface Changed {
  message: string
  /** The correction this message describes; absent for changes without Undo (settings). */
  correctionId?: number
}

export const personLabel = (p: { name: string | null }) => p.name ?? 'Unnamed'

export interface Settings {
  enabled: boolean
  shareNames: boolean
}
