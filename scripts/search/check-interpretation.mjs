// Opt-in paid model evaluation against a synthetic catalog, actual search routes,
// RLS, pagination and browser. No customer photographs or production mutation.
import { spawnSync } from 'node:child_process'

const result = spawnSync('npx', ['vitest', 'run', 'tests/search-acceptance.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, SEARCH_ACCEPTANCE_LIVE: '1' },
})
process.exitCode = result.status ?? 1
