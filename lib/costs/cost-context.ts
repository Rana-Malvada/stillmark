import { AsyncLocalStorage } from 'node:async_hooks'

export const costContext = new AsyncLocalStorage<string>()
export const costQueryTag = () =>
  costContext.getStore() ? `personal-photos:${costContext.getStore()}` : ''
