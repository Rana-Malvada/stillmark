import { pgQuery } from '@/lib/postgres'
import { visibleAccountName } from '@/lib/identity/account-presentation'

/** Batched presentation lookup. IDs remain unchanged for authorization and mutations. */
export async function accountDisplayNames(usernames: string[]): Promise<Map<string, string>> {
  const names = [...new Set(usernames.filter(Boolean))]
  const labels = new Map(names.map((name) => [name, visibleAccountName(name)]))
  if (!names.length) return labels
  const rows = await pgQuery<{ name: string; display_name: string | null }>(
    `SELECT name,display_name FROM deleted_accounts WHERE name=ANY($1::text[])
     UNION ALL SELECT name,display_name FROM gallery_access_objects WHERE kind='user' AND name=ANY($1::text[])`,
    [names],
  )
  for (const row of rows) labels.set(row.name, visibleAccountName(row.display_name || row.name))
  return labels
}

export async function accountDisplayName(username: string): Promise<string> {
  return (await accountDisplayNames([username])).get(username) || 'Member'
}
