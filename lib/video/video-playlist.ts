/** Only our generated single-file VOD playlists are accepted. No external URLs. */
export function videoPlaylist(manifest: string, mediaUrl: string) {
  if (
    !manifest.startsWith('#EXTM3U\n') ||
    !manifest.includes('#EXT-X-ENDLIST') ||
    manifest.length > 200000 ||
    !mediaUrl.startsWith('/') ||
    mediaUrl.startsWith('//') ||
    /[\r\n"<>]/.test(mediaUrl)
  )
    throw new Error('Invalid playback playlist')
  const lines = manifest.trim().split('\n')
  for (const line of lines) {
    if (line && !line.startsWith('#') && line !== 'playback.mp4')
      throw new Error('Invalid playback segment')
    if (line.includes('URI=') && !/^#EXT-X-MAP:URI="playback\.mp4",BYTERANGE="\d+@0"$/.test(line))
      throw new Error('Invalid playback initialization')
    if (line.startsWith('#EXT-X-KEY')) throw new Error('Unexpected playlist key')
  }
  return (
    lines
      .map((line) =>
        line === 'playback.mp4'
          ? mediaUrl
          : line.replace('URI="playback.mp4"', `URI="${mediaUrl}"`),
      )
      .join('\n') + '\n'
  )
}

export type PlaybackRendition = {
  name: string
  stage_path: string
  playlist: string
  bandwidth: number
  averageBandwidth?: number
  width?: number
  height?: number
  frameRate?: number
  codecs?: string
}
export function adaptivePlaylist(renditions: PlaybackRendition[], url: (name: string) => string) {
  if (!renditions.length) throw new Error('No playback renditions')
  return (
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n' +
    renditions
      .map((r) => {
        if (!/^(720|1080)$/.test(r.name) || !Number.isSafeInteger(r.bandwidth) || r.bandwidth <= 0)
          throw new Error('Invalid rendition')
        const path = url(r.name)
        if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path))
          throw new Error('Invalid rendition URL')
        if (
          !r.width ||
          !r.height ||
          !r.frameRate ||
          !r.averageBandwidth ||
          !/^avc1\.[a-f0-9]{6}(,mp4a\.40\.2)?$/.test(r.codecs || '')
        )
          throw new Error('Missing rendition metadata')
        return `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},AVERAGE-BANDWIDTH=${r.averageBandwidth},RESOLUTION=${r.width}x${r.height},FRAME-RATE=${r.frameRate.toFixed(3)},CODECS="${r.codecs}"\n${path}\n`
      })
      .join('')
  )
}
