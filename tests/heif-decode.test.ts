import { beforeEach, expect, it, vi } from 'vitest'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const state = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  Object.assign(state.exec, {
    [promisify.custom]: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        state.exec(...args, (error: unknown, stdout: string, stderr: string) => {
          if (error) reject(error)
          else resolve({ stdout, stderr })
        })
      }),
  })
  return { execFile: state.exec }
})
import { decodeHeif } from '@/lib/upload/heif-decode'

beforeEach(() => {
  state.exec.mockReset()
})

it('passes original bytes to the decoder, returns its rendition, and removes temporary files', async () => {
  let directory = ''
  state.exec.mockImplementation((_bin, args, options, callback) => {
    directory = dirname(args[1])
    expect(options).toMatchObject({ timeout: 60_000, killSignal: 'SIGKILL' })
    void (async () => {
      expect(await readFile(args[1])).toEqual(Buffer.from('original HEIC'))
      await writeFile(args[2], 'decoded PNG')
      callback(null, JSON.stringify({ width: 3024, height: 4032 }), '')
    })()
  })
  const result = await decodeHeif(Buffer.from('original HEIC'))
  expect(result).toEqual({ buffer: Buffer.from('decoded PNG'), width: 3024, height: 4032 })
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  [{ code: 'ENOENT' }, 503],
  [{ code: 2 }, 422],
  [{ killed: true }, 422],
  [{ code: 1 }, 500],
])(
  'cleans failed decoding and distinguishes runtime errors from invalid images: %j',
  async (error, status) => {
    let directory = ''
    state.exec.mockImplementation((_bin, args, _options, callback) => {
      directory = dirname(args[1])
      callback(error)
    })
    await expect(decodeHeif(Buffer.from('input'))).rejects.toMatchObject({ status })
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)
