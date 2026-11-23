import { pgQueryOne } from '../postgres'
import { getPresignedUrl } from '../media/image-urls'
import { VIDEO_MAX_BYTES } from './video-analysis-format'

/** Only completed copies of the current original qualify. Missing/stale files fall back safely. */
export async function preparedAnalysisSource(photoId: number, original: string) {
  try {
    const row = await pgQueryOne<{ renditions: { name: string; stage_path: string }[] }>(
      `SELECT renditions FROM video_playback WHERE photo_id=$1 AND original_path=$2 AND status='ready' AND format_version=2`,
      [photoId, original],
    )
    for (const name of ['720', '1080']) {
      const candidate = row?.renditions?.find((r) => r.name === name)
      if (
        !candidate ||
        !/^display\/(?:video|prepared)\/[a-f0-9-]+\/(720|1080)\/playback\.mp4$/.test(
          candidate.stage_path,
        )
      )
        continue
      try {
        const response = await fetch(await getPresignedUrl(candidate.stage_path), {
          // GET_PRESIGNED_URL signs GET; HEAD can return 403 for an existing copy.
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        })
        try {
          const range = /^bytes 0-0\/([1-9][0-9]*)$/.exec(
            response.headers.get('content-range') ?? '',
          )
          const bytes = Number(range?.[1])
          if (response.status === 206 && Number.isSafeInteger(bytes) && bytes < VIDEO_MAX_BYTES)
            return { path: candidate.stage_path, bytes }
        } finally {
          // Also stop a server that ignores Range and sends the entire video.
          await response.body?.cancel().catch(() => {})
        }
      } catch {
        /* Try the next ready rendition, then the original. */
      }
    }
  } catch (error) {
    console.error('[video-analysis-source]', error)
  }
  return null
}
