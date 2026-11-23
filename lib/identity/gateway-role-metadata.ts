import { identityControl } from './identity-control'

// Shared role graphs are identical across users. Expiry travels with the result
// so composing caches never extends the authorization freshness window.
const entries = new Map<string, { rows: Record<string, any>[]; expires: number }>()
const pending = new Map<string, Promise<{ rows: Record<string, any>[]; expires: number }>>()
export async function gatewayRoleMetadata(name: string, fresh: boolean) {
  const read = async () => {
    const started = Date.now()
    const rows = await identityControl('roleGrants', { name })
    return { rows, expires: started + 15_000 }
  }
  if (fresh) return read()
  const cached = entries.get(name)
  if (cached && cached.expires > Date.now()) return cached
  let work = pending.get(name)
  if (!work) {
    work = read().then((result) => {
      entries.delete(name)
      if (entries.size >= 500) entries.delete(entries.keys().next().value!)
      entries.set(name, result)
      return result
    })
    pending.set(name, work)
  }
  try {
    return await work
  } finally {
    if (pending.get(name) === work) pending.delete(name)
  }
}
