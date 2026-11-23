import { expect, it } from 'vitest'
import { parseAllowance } from '@/components/access/allowance-form'

it('accepts the server limits exactly and converts storage to bytes', () => {
  expect(parseAllowance('10', '10', '0')).toEqual({
    uploads: 10,
    bytes: 10737418240,
    aiSearches: 0,
  })
  expect(parseAllowance('0', '0', '0')).toEqual({ uploads: 0, bytes: 0, aiSearches: 0 })
  expect(parseAllowance('1000000', '10240', '10000')).toEqual({
    uploads: 1000000,
    bytes: 10995116277760,
    aiSearches: 10000,
  })
  expect(parseAllowance('5', '0.5', '1')).toMatchObject({ bytes: 536870912 })
})
it('rejects blank, negative, fractional, non-numeric and out-of-range values with a field message', () => {
  for (const files of ['', ' ', '-1', '1.5', 'ten', '1000001', 'Infinity'])
    expect(parseAllowance(files, '10', '0')).toMatch(/file allowance/)
  for (const storage of ['', '-1', 'big', '10241', 'NaN'])
    expect(parseAllowance('10', storage, '0')).toMatch(/storage allowance/)
  for (const searches of ['', '-1', '0.5', '10001', 'x'])
    expect(parseAllowance('10', '10', searches)).toMatch(/AI search allowance/)
})
