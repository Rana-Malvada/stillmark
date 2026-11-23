interface AudioStream {
  codec_type: string
  codec_name?: string
}

/** The deployed FFmpeg cannot decode Apple's APAC spatial track. Use an
 * alternate recognized track when available; never silently remove sound. */
export function videoAudioMap(streams: AudioStream[]): string[] {
  const audio = streams.filter((stream) => stream.codec_type === 'audio')
  if (!audio.length) return ['-an']
  const index = audio.findIndex(
    (stream) => stream.codec_name && !['none', 'unknown', 'apple_apac'].includes(stream.codec_name),
  )
  if (index < 0)
    throw Error(
      'No compatible audio track is available. The original video and its sound are unchanged.',
    )
  return ['-map', `0:a:${index}`]
}
