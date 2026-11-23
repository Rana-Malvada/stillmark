export function gpuPlan(video: any) {
  const width = Number(video.width)
  const height = Number(video.height)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2)
    throw Error('Invalid dimensions')
  const rawRotation = Number(
    video.side_data_list?.find((s: any) => s.rotation !== undefined)?.rotation ??
      video.tags?.rotate ??
      0,
  )
  const rotation = ((Math.round(rawRotation) % 360) + 360) % 360
  if (![0, 90, 180, 270].includes(rotation)) throw Error('Unsupported rotation')
  const [n, d] = (video.r_frame_rate || '30/1').split('/').map(Number)
  const rate = Number.isFinite(n / d) && n / d > 0 ? Math.min(60, n / d) : 30
  const edge = Math.max(width, height)
  const large = Math.min(edge, 1920)
  const dims = (limit: number) => [
    Math.max(2, Math.floor((width * Math.min(1, limit / edge)) / 2) * 2),
    Math.max(2, Math.floor((height * Math.min(1, limit / edge)) / 2) * 2),
  ]
  const [w, h] = dims(large)
  const hdr = ['arib-std-b67', 'smpte2084'].includes(video.color_transfer)
  const filters = [`scale_cuda=${w}:${h}`]
  if (hdr)
    filters.push('tonemap_cuda=format=yuv420p:p=bt709:t=bt709:m=bt709:r=tv:tonemap=hable:desat=0')
  else filters.push('scale_cuda=format=yuv420p')
  if (rotation === 270) filters.push('transpose_cuda=clock')
  if (rotation === 90) filters.push('transpose_cuda=cclock')
  if (rotation === 180) filters.push('transpose_cuda=reversal')
  filters.push('setsar=1', `fps=${rate}`)
  const plans =
    edge > 1280
      ? [
          { name: '720', kbps: 3500 },
          { name: '1080', kbps: 8000 },
        ]
      : [{ name: '720', kbps: 3500 }]
  const [lw, lh] = dims(1280)
  const portrait = rotation === 90 || rotation === 270
  const graph =
    plans.length === 1
      ? `[0:v:0]${filters.join(',')}[v0]`
      : `[0:v:0]${filters.join(',')},split=2[lo][v1];[lo]scale_cuda=${portrait ? lh : lw}:${portrait ? lw : lh}[v0]`
  return { plans, graph, rate, hdr }
}
export function safeOriginal(path: string) {
  if (
    !path ||
    path.startsWith('/') ||
    path.split('/').some((x) => x === '..' || x === '.') ||
    /[\0\r\n\\]/.test(path)
  )
    throw Error('Unsafe original path')
  return path
}

// FFprobe calls full-range 8-bit 4:2:0 yuvj420p; it is the same H.264 chroma format.
export function compatibleVideoTrack(p: any) {
  return p?.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(p.pix_fmt)
}
