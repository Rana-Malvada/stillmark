import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import manifest from '../../config/search-model.json'
import { objects } from '../../config/deployment.mjs'
import { querySnowflakeStorage } from '../snowflake'

async function verified(path: string, sha: string, bytes: number) {
  try {
    if ((await stat(path)).size !== bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === sha
  } catch {
    return false
  }
}
/** Immutable model files are provisioned on our existing private stage. Downloads
 * happen once per process cache and never trust caller-provided paths or URLs. */
export async function searchModelAssets() {
  if (process.env.SEARCH_MODEL_PATH) return process.env.SEARCH_MODEL_PATH
  const root = join(tmpdir(), 'photo-search-models', manifest.revision)
  for (const file of manifest.files) {
    const path = join(root, file.name)
    if (await verified(path, file.sha256, file.bytes)) continue
    await mkdir(join(path, '..'), { recursive: true })
    const rows = await querySnowflakeStorage(
      `SELECT GET_PRESIGNED_URL(@${objects.derived}, '${manifest.stagePrefix}/${file.name}', 600) AS URL`,
    )
    const response = await fetch(String(rows[0]?.URL), {
      signal: AbortSignal.timeout(600000),
      redirect: 'error',
    })
    if (!response.ok || !response.body) throw new Error('Search model asset unavailable')
    const temporary = path + '.download'
    let bytes = 0
    const hash = createHash('sha256')
    try {
      await pipeline(
        Readable.fromWeb(response.body as WebReadableStream),
        new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length
            if (bytes > file.bytes) return done(new Error('Model asset exceeds expected size'))
            hash.update(chunk)
            done(null, chunk)
          },
        }),
        createWriteStream(temporary, { mode: 0o600 }),
      )
      if (bytes !== file.bytes || hash.digest('hex') !== file.sha256)
        throw new Error('Model checksum mismatch')
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
  return root
}
