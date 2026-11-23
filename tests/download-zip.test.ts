import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZipArchive } from 'archiver'
import { strFromU8, unzipSync } from 'fflate'
import { downloadZip, type ZipPhoto } from '@/lib/photos/download-zip'

const mocks = vi.hoisted(() => ({ url: vi.fn(), invalidate: vi.fn() }))
vi.mock('@/lib/media/image-urls', () => ({
  getPresignedUrl: mocks.url,
  invalidateMediaUrl: mocks.invalidate,
}))

let handler: (request: IncomingMessage, response: ServerResponse) => void
let server: ReturnType<typeof createServer>
let temporary: string | undefined
const rows: ZipPhoto[] = [
  { photo_id: 1, source_filename: '../image[1]*.jpg', original_stage_path: 'originals/a' },
  { photo_id: 2, source_filename: 'movie.mov', original_stage_path: 'originals/b' },
]
/** Authorizes every file at the path it was listed with. */
const current = async (photo: ZipPhoto) => photo.original_stage_path

beforeEach(async () => {
  vi.resetAllMocks()
  handler = (_request, response) => response.writeHead(500).end()
  server = createServer((request, response) => handler(request, response))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local fixture address')
  mocks.url.mockImplementation(async (path: string) => `http://127.0.0.1:${address.port}/${path}`)
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  if (temporary) await rm(temporary, { recursive: true, force: true })
  temporary = undefined
})

it('streams ZIP bytes before the original finishes and requests originals one at a time', async () => {
  const requested: string[] = []
  const firstBytes = Buffer.from([0, 1, 255, 42])
  const lastBytes = Buffer.from('the rest of the original')
  let finishFirst!: () => void
  handler = (request, response) => {
    requested.push(request.url!)
    if (request.url === '/originals/a') {
      response.write(firstBytes)
      finishFirst = () => response.end(lastBytes)
    } else response.end('original movie bytes')
  }
  const response = await downloadZip(new Request('https://app/api/photos/download'), rows, current)
  expect(response.headers.get('content-type')).toBe('application/zip')
  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(first.done).toBe(false)
  expect(first.value!.byteLength).toBeGreaterThan(0)
  expect(requested).toEqual(['/originals/a'])
  finishFirst()
  const chunks = [first.value!]
  while (true) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
  }
  const bytes = Buffer.concat(chunks)
  const zip = unzipSync(bytes)
  expect(requested).toEqual(['/originals/a', '/originals/b'])
  // Glob syntax in source names is a literal archive name, never a filesystem pattern.
  expect(Object.keys(zip)).toEqual(['1-.._image[1]*.jpg', '2-movie.mov'])
  expect(Buffer.from(zip['1-.._image[1]*.jpg'])).toEqual(Buffer.concat([firstBytes, lastBytes]))
  expect(strFromU8(zip['2-movie.mov'])).toBe('original movie bytes')
  expect(bytes.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true) // ZIP64 end record.
})

it('aborts the active HTTP original when the ZIP reader cancels and never opens the next file', async () => {
  const requested: string[] = []
  let closed = false
  handler = (request, response) => {
    requested.push(request.url!)
    response.on('close', () => {
      closed = true
    })
    response.write(Buffer.alloc(65536, 7))
    // Hold the response open so completion cannot masquerade as cancellation.
  }
  const response = await downloadZip(new Request('https://app/api/photos/download'), rows, current)
  const reader = response.body!.getReader()
  expect((await reader.read()).done).toBe(false)
  await reader.cancel()
  await vi.waitFor(() => expect(closed).toBe(true))
  expect(requested).toEqual(['/originals/a'])
  expect(mocks.url).toHaveBeenCalledTimes(1)
})

it('fails the archive and closes its active original when the incoming request disconnects', async () => {
  let closed = false
  handler = (_request, response) => {
    response.on('close', () => {
      closed = true
    })
    response.write(Buffer.alloc(65536, 9))
  }
  const controller = new AbortController()
  const response = await downloadZip(
    new Request('https://app/api/photos/download', { signal: controller.signal }),
    rows,
    current,
  )
  const rejected = expect(response.arrayBuffer()).rejects.toThrow()
  controller.abort(new DOMException('Client disconnected', 'AbortError'))
  await rejected
  await vi.waitFor(() => expect(closed).toBe(true))
  expect(mocks.url).toHaveBeenCalledTimes(1)
})

it('leaves out a file that is no longer authorized and never opens its original', async () => {
  const requested: string[] = []
  handler = (request, response) => {
    requested.push(request.url!)
    response.end(`bytes of ${request.url}`)
  }
  const response = await downloadZip(
    new Request('https://app/api/photos/download'),
    [...rows, { photo_id: 3, source_filename: 'c.jpg', original_stage_path: 'originals/c' }],
    async (photo) => (photo.photo_id === 2 ? null : photo.original_stage_path),
  )
  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()))
  expect(Object.keys(zip)).toEqual(['1-.._image[1]*.jpg', '3-c.jpg'])
  expect(requested).toEqual(['/originals/a', '/originals/c'])
})

it.each([
  ['withdrawn', null],
  ['pointing at a different original', 'originals/replaced'],
])(
  'discards an opened original when its authorization is %s before bytes are appended',
  async (_name, second) => {
    let closed = false
    handler = (request, response) => {
      if (request.url === '/originals/b') {
        response.on('close', () => {
          closed = true
        })
        // Storage answers and then keeps sending: the response must be cancelled, not read.
        response.write('bytes of the removed original')
      } else response.end('kept')
    }
    let checks = 0
    const response = await downloadZip(
      new Request('https://app/api/photos/download'),
      rows,
      async (photo) =>
        photo.photo_id === 2 && ++checks === 2 ? second : photo.original_stage_path,
    )
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(Object.keys(unzipSync(bytes))).toEqual(['1-.._image[1]*.jpg'])
    expect(bytes.includes(Buffer.from('bytes of the removed original'))).toBe(false)
    await vi.waitFor(() => expect(closed).toBe(true))
    expect(checks).toBe(2)
  },
)

it('uses the path authorized now, not the one listed when the download began', async () => {
  handler = (request, response) => response.end(`bytes of ${request.url}`)
  const response = await downloadZip(
    new Request('https://app/api/photos/download'),
    rows,
    async (photo) => (photo.photo_id === 2 ? 'originals/current' : photo.original_stage_path),
  )
  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()))
  expect(strFromU8(zip['2-movie.mov'])).toBe('bytes of /originals/current')
})

it('refuses to start an archive when no file is authorized', async () => {
  await expect(
    downloadZip(new Request('https://app/api/photos/download'), rows, async () => null),
  ).rejects.toMatchObject({ status: 404 })
  expect(mocks.url).not.toHaveBeenCalled()
})

it('keeps archiver readdir-glob matching compatible with the scoped minimatch override', async () => {
  temporary = await mkdtemp(join(tmpdir(), 'photoapp-zip-compat-'))
  const files = [
    'photo.jpg',
    'nested/movie.MOV',
    '.hidden.jpg',
    'ignored.jpg',
    'excluded/skip.jpg',
    'notes.txt',
  ]
  for (const name of files) {
    const path = join(temporary, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, name)
  }
  const archive = new ZipArchive({ store: true })
  const chunks: Buffer[] = []
  const completed = (async () => {
    for await (const chunk of archive) chunks.push(Buffer.from(chunk))
  })()
  archive.glob('**/*.{jpg,mov}', {
    cwd: temporary,
    dot: true,
    nocase: true,
    ignore: '**/ignored.jpg',
    skip: 'excluded',
  })
  await archive.finalize()
  await completed
  const zip = unzipSync(Buffer.concat(chunks))
  expect(Object.keys(zip).sort()).toEqual(['.hidden.jpg', 'nested/movie.MOV', 'photo.jpg'])
  for (const [name, bytes] of Object.entries(zip)) expect(strFromU8(bytes)).toBe(name)
})
