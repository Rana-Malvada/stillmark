import { expect, it } from 'vitest'
import {
  accountLabel,
  matchesAccountDeletionConfirmation,
  vanityName,
} from '@/lib/identity/account-presentation'

it('shows chosen name and email to distinguish accounts with matching vanity names', () => {
  expect(accountLabel({ display_name: 'Keith', email: 'one@example.com' })).toBe(
    'Keith (one@example.com)',
  )
  expect(accountLabel({ display_name: 'Keith', email: 'two@example.com' })).toBe(
    'Keith (two@example.com)',
  )
})
it('does not present internal IDs or duplicate emails as vanity names', () => {
  expect(vanityName({ display_name: 'U_00000000000000000000000000000004' })).toBe(
    'Vanity name not set',
  )
  expect(vanityName({ display_name: 'one@example.com', email: 'one@example.com' })).toBe(
    'Vanity name not set',
  )
  expect(vanityName({ display_name: 'Member', email: 'one@example.com' })).toBe('Member')
})

it('requires the correct email before confirming account deletion', () => {
  expect(matchesAccountDeletionConfirmation('friend@example.com', 'friend@example.com')).toBe(true)
  expect(matchesAccountDeletionConfirmation('  FRIEND@example.com\n', 'friend@example.com')).toBe(
    true,
  )
  for (const input of [
    '',
    'DELETE',
    'friend',
    'other@example.com',
    'friend@example.com.other',
    'Friend (friend@example.com)',
  ]) {
    expect(matchesAccountDeletionConfirmation(input, 'friend@example.com')).toBe(false)
  }
})
it('requires explicit DELETE only for an account without an email', () => {
  expect(matchesAccountDeletionConfirmation('DELETE', null)).toBe(true)
  expect(matchesAccountDeletionConfirmation('', null)).toBe(false)
  expect(matchesAccountDeletionConfirmation('friend@example.com', null)).toBe(false)
})
