import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // PGlite fixtures each start a database; bound parallelism to avoid local
  // CPU/memory contention. SQL functional tests include WASM database startup;
  // allow that setup on hosted runners. Performance gates have separate limits.
  test: {
    environment: 'node',
    // Component tests (tests/components/*.test.tsx) opt in to jsdom with a per-file docblock.
    include: ['tests/**/*.test.{ts,tsx}'],
    maxWorkers: process.env.CI ? 1 : 2,
    testTimeout: 30000,
  },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
})
