import { expect, it, vi } from 'vitest'
import { createPool } from 'generic-pool'
import { retireConnectionPool } from '@/lib/pool-retirement'

it('lets borrowed work finish, then destroys every idle connection', async () => {
  const destroyed: object[] = []
  const pool = createPool(
    {
      create: async () => ({}),
      destroy: async (connection: object) => {
        destroyed.push(connection)
      },
    },
    { min: 0, max: 2 },
  )
  const first = await pool.acquire()
  const second = await pool.acquire()
  await pool.release(second)
  let finished = false
  const retirement = retireConnectionPool(pool).then(() => {
    finished = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(finished).toBe(false)
  expect(destroyed).toEqual([])
  await expect(pool.acquire()).rejects.toThrow()
  await pool.release(first)
  await retirement
  expect(destroyed).toHaveLength(2)
  expect(destroyed).toContain(first)
  expect(destroyed).toContain(second)
  expect(pool.size).toBe(0)
})
it('does not clear borrowed connections when draining fails', async () => {
  const error = new Error('drain failed')
  const pool = {
    drain: vi.fn(async () => {
      throw error
    }),
    clear: vi.fn(async () => {}),
  }
  await expect(retireConnectionPool(pool)).rejects.toBe(error)
  expect(pool.clear).not.toHaveBeenCalled()
})
