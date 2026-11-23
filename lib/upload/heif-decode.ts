import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { HttpError } from '../http'

const execute = promisify(execFile)

/** Decode once in a bounded native subprocess, outside the Node event loop.
 * Only browser renditions use this buffer; hashing, EXIF and storage use the original. */
export async function decodeHeif(buffer: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'stillmark-heif-'))
  try {
    const input = join(dir, 'original.heic')
    const output = join(dir, 'display.png')
    await writeFile(input, buffer, { mode: 0o600 })
    const { stdout } = await execute(
      process.env.HEIF_PYTHON ?? '/opt/heif/bin/python',
      [join(process.cwd(), 'workers/upload-cpu/decode-heif.py'), input, output],
      { timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
    )
    const { width, height } = JSON.parse(stdout)
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
      throw new Error('Invalid decoder dimensions')
    return { buffer: await readFile(output), width, height }
  } catch (error) {
    const failure = error as { killed?: boolean; code?: string | number }
    if (failure.code === 'ENOENT')
      throw new HttpError(
        503,
        'HEIC decoding is unavailable on this upload worker. Please retry later.',
      )
    if (failure.killed)
      throw new HttpError(422, 'This HEIC image exceeded the image decoding time limit.')
    if (failure.code === 2)
      throw new HttpError(
        422,
        'Unable to decode this HEIC image. It may be damaged or exceed the 80-megapixel limit.',
      )
    throw new HttpError(500, 'HEIC image processing failed. Please retry.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
