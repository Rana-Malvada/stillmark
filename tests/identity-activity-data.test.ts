import { describe, expect, it } from 'vitest'
import {
  isIdentityImport,
  isIdentityStatus,
  isIdentitySummary,
} from '@/components/activity/identity-data'

describe('Identity activity wire contracts', () => {
  it('validates status before find and valid completion dates', () => {
    expect(
      isIdentityStatus([
        { provider: 'auth0', completed_at: null, imported: 0, error: null, more: false },
      ]),
    ).toBe(true)
    expect(isIdentityStatus({ error: 'unavailable' })).toBe(false)
    expect(
      isIdentityStatus([
        { provider: 'auth0', completed_at: 'bad-date', imported: 0, error: null, more: false },
      ]),
    ).toBe(false)
  })
  it('validates summary row fields before they become React children', () => {
    const row = {
      day: '2026-11-21',
      kind: 'login',
      provider: 'auth0',
      events: 1,
      successes: 1,
      failures: 0,
      displayName: 'Alice',
      email: null,
    }
    expect(isIdentitySummary({ rows: [row], more: false })).toBe(true)
    expect(
      isIdentitySummary({ rows: [{ ...row, displayName: { name: 'Alice' } }], more: false }),
    ).toBe(false)
    expect(isIdentitySummary({ rows: null, more: false })).toBe(false)
  })
  it('does not report import success for an unrecognized body', () => {
    expect(isIdentityImport({ imported: 2, more: true })).toBe(true)
    expect(isIdentityImport({})).toBe(false)
  })
})
