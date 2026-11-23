import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

// Each worker image is built from its own directory, so each needs the public
// PostgreSQL root certificate inside that directory. `certs/postgres-root.crt` is the
// source; this test fails if a copy drifts from it.
const SOURCE = 'certs/postgres-root.crt'
const COPIES = [
  'workers/face-cpu/postgres-root.crt',
  'workers/search-cpu/postgres-root.crt',
  'workers/video-gpu/postgres-root.crt',
]
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

it('worker copies of the PostgreSQL root certificate match the source', () => {
  for (const copy of COPIES) expect(digest(copy), copy).toBe(digest(SOURCE))
})

it('the certificate is public trust material, not a private key', () => {
  const text = readFileSync(SOURCE, 'utf8')
  expect(text).toContain('BEGIN CERTIFICATE')
  expect(text).not.toContain('PRIVATE KEY')
})
