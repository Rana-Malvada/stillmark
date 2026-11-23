import { expect, it } from 'vitest'
import { costContext, costQueryTag } from '@/lib/costs/cost-context'

it('keeps concurrent identities isolated and resets outside attributed work', async () => {
  const tags = await Promise.all(
    ['a', 'b'].map((id) =>
      costContext.run(id, async () => {
        await new Promise((r) => setTimeout(r, id === 'a' ? 10 : 1))
        return costQueryTag()
      }),
    ),
  )
  expect(tags).toEqual(['personal-photos:a', 'personal-photos:b'])
  expect(costQueryTag()).toBe('')
})
