import { describe, expect, it, vi } from 'vitest'

const missing = new Error('NEXT_HTTP_ERROR_FALLBACK;404')
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw missing
  },
}))
import { authorizePage } from '../lib/page-access'
import { HttpError } from '../lib/http'

describe('protected page boundary', () => {
  it('returns only an authorized result', async () => {
    const caller = { role: 'admin' }
    await expect(authorizePage(async () => caller)).resolves.toBe(caller)
  })
  it.each([401, 403])(
    'renders an unavailable page for %s without continuing to protected data',
    async (status) => {
      const render = vi.fn()
      const page = async () => {
        await authorizePage(async () => {
          throw new HttpError(status, 'Private diagnostic')
        })
        render()
      }
      await expect(page()).rejects.toBe(missing)
      expect(render).not.toHaveBeenCalled()
    },
  )
  it('preserves real outages and framework navigation errors', async () => {
    for (const error of [new HttpError(503, 'Busy'), new Error('Unexpected'), missing]) {
      await expect(
        authorizePage(async () => {
          throw error
        }),
      ).rejects.toBe(error)
    }
  })
})
