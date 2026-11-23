import { expect, it } from 'vitest'
import { compatibleVideoTrack, gpuPlan, safeOriginal } from '../workers/video-gpu/plan'

it('keeps HDR conversion and portrait rotation on CUDA with two bounded renditions', () => {
  const p = gpuPlan({
    width: 3840,
    height: 2160,
    r_frame_rate: '60000/1001',
    color_transfer: 'arib-std-b67',
    side_data_list: [{ rotation: -90 }],
  })
  expect(p.graph).toContain('tonemap_cuda=')
  expect(p.graph).toContain('transpose_cuda=clock')
  expect(p.graph).toContain('scale_cuda=720:1280')
  expect(p.rate).toBeCloseTo(59.94, 2)
  expect(p.plans).toHaveLength(2)
})
it('does not upscale small SDR videos or create redundant renditions', () => {
  const p = gpuPlan({ width: 640, height: 480, r_frame_rate: '30/1' })
  expect(p.graph).toContain('scale_cuda=640:480')
  expect(p.graph).not.toContain('tonemap')
  expect(p.plans).toHaveLength(1)
})
it('rejects unsafe paths and invalid dimensions', () => {
  for (const p of ['/etc/passwd', '../input', 'a/../b', 'a\\b'])
    expect(() => safeOriginal(p)).toThrow()
  expect(safeOriginal('originals/1/original.mov')).toBe('originals/1/original.mov')
  expect(() => gpuPlan({ width: 0, height: 1080 })).toThrow()
})

it('accepts limited and full range 8-bit H264 while rejecting incompatible tracks', () => {
  for (const pix_fmt of ['yuv420p', 'yuvj420p'])
    expect(compatibleVideoTrack({ codec_name: 'h264', pix_fmt })).toBe(true)
  for (const pix_fmt of ['yuv420p10le', 'yuv444p'])
    expect(compatibleVideoTrack({ codec_name: 'h264', pix_fmt })).toBe(false)
  expect(compatibleVideoTrack({ codec_name: 'hevc', pix_fmt: 'yuv420p' })).toBe(false)
})
