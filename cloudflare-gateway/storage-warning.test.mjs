import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EmailAlerts, storageWarningBytes, storageWarningMessage } from './alerts.mjs'

test('storage email derives the configured decimal byte threshold and states its scope', () => {
  for (const bytes of ['8000000000', '24000000000', '12500000000']) {
    const env = { PG_STORAGE_WARNING_BYTES: bytes }
    assert.equal(storageWarningBytes(env), Number(bytes))
    const message = storageWarningMessage(env)
    assert.ok(message.includes(`${Number(bytes) / 1e9} GB (${bytes} bytes)`))
    assert.match(message, /database size only, excluding WAL and other disk overhead/)
    assert.match(message, /not physical-disk utilization/)
  }
})
test('invalid storage thresholds fail closed and are never interpolated into email', () => {
  for (const value of [
    undefined,
    '',
    '0',
    '-1',
    'Infinity',
    'NaN',
    '1e9',
    '1.5',
    ' 24',
    '9007199254740992',
    'private\nvalue',
  ]) {
    const env = { PG_STORAGE_WARNING_BYTES: value }
    assert.equal(storageWarningBytes(env), null)
    const message = storageWarningMessage(env)
    assert.match(message, /configuration is invalid/)
    assert.doesNotMatch(message, /private|reached|8 GB/)
  }
})
test('canonical and generated threshold agree with the approved 30 GB database-size warning', () => {
  for (const name of [
    '../config/templates/cloudflare-gateway/wrangler.jsonc',
    './wrangler.jsonc',
  ]) {
    const text = readFileSync(new URL(name, import.meta.url), 'utf8')
    assert.match(text, /"PG_STORAGE_WARNING_BYTES": "24000000000"/)
  }
})
test('live monitor uses threshold boundaries and rejects invalid config or observations', async () => {
  const original = globalThis.fetch
  try {
    for (const [threshold, databaseBytes, expected] of [
      ['24000000000', 23999999999, true],
      ['24000000000', 24000000000, false],
      ['24000000000', 24000000001, false],
      ['8000000000', 8000000000, false],
      ['Infinity', 1, false],
      [undefined, 1, false],
      ['24000000000', -1, false],
      ['24000000000', '1', false],
    ]) {
      globalThis.fetch = async (url) =>
        new URL(url).pathname.endsWith('/live')
          ? Response.json({ status: 'ok' })
          : Response.json({ database: true, databaseBytes, failedUploadsLastHour: 0 })
      const state = new Map()
      const monitor = new EmailAlerts(
        { storage: { get: async (k) => state.get(k), put: async (k, v) => state.set(k, v) } },
        {
          PG_STORAGE_WARNING_BYTES: threshold,
          GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
          SNOWFLAKE_ORIGIN: 'https://example.snowflakecomputing.app',
          SNOWFLAKE_PAT: 'synthetic',
          GATEWAY_TOKENS: {
            idFromName: () => 1,
            get: () => ({
              fetch: async (url) =>
                url.endsWith('/token')
                  ? new Response('synthetic')
                  : Response.json({ expiresAt: Date.now() + 10 * 86400000 }),
            }),
          },
        },
      )
      const result = await monitor.check()
      assert.equal(result.storage, expected, `${threshold} / ${databaseBytes}`)
      assert.equal(state.get('storage').failures, expected ? 0 : 1)
      assert.equal(result.database, true)
      assert.equal(result.uploads, true)
    }
  } finally {
    globalThis.fetch = original
  }
})
