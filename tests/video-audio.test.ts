import { expect, it } from 'vitest'
import { videoAudioMap } from '@/lib/video-audio'

it.each([undefined, 'none', 'unknown', 'apple_apac'])(
  'selects stereo fallback after an unsupported %s audio track',
  (codec_name) => {
    expect(
      videoAudioMap([
        { codec_type: 'video', codec_name: 'hevc' },
        { codec_type: 'audio', codec_name },
        { codec_type: 'data' },
        { codec_type: 'audio', codec_name: 'aac' },
      ]),
    ).toEqual(['-map', '0:a:1'])
  },
)
it('preserves a supported primary audio track and handles genuinely silent files', () => {
  expect(
    videoAudioMap([
      { codec_type: 'audio', codec_name: 'pcm_s16le' },
      { codec_type: 'audio', codec_name: 'aac' },
    ]),
  ).toEqual(['-map', '0:a:0'])
  expect(videoAudioMap([{ codec_type: 'video', codec_name: 'hevc' }])).toEqual(['-an'])
})
it('fails explicitly rather than silently discarding unsupported audio', () => {
  expect(() => videoAudioMap([{ codec_type: 'audio', codec_name: 'apple_apac' }])).toThrow(
    'No compatible audio track',
  )
})
