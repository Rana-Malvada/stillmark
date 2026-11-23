type AccountLabel = { display_name?: string | null; email?: string | null }

/** Human-readable account labels; never a replacement for the account's ID. */
export function vanityName(user: AccountLabel): string {
  const name = user.display_name?.trim()
  return name && !/^U_[a-f0-9]{32}$/i.test(name) && name !== user.email
    ? name
    : 'Vanity name not set'
}

export function accountLabel(user: AccountLabel): string {
  return user.email ? `${vanityName(user)} (${user.email})` : vanityName(user)
}

/** Email confirmation tolerates paste whitespace and email casing, never a different address. */
export function matchesAccountDeletionConfirmation(input: string, email?: string | null): boolean {
  const expected = email?.trim()
  return expected
    ? input.trim().toLowerCase() === expected.toLowerCase()
    : input.trim() === 'DELETE'
}

/** Never render storage identities, including legacy Auth0 IDs, as account labels. */
export function visibleAccountName(value?: string | null): string {
  const name = value?.trim()
  return !name ||
    /^(?:U_[a-f0-9]+|auth0\|.*)$/i.test(name) ||
    /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(name)
    ? 'Member'
    : name
}
