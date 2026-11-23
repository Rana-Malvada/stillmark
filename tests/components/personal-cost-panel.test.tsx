// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { PersonalCostPanel } from '@/components/personal-cost-panel'
import { deferred, json, stubFetch } from './harness'

// jsdom has no layout, so the chart's width observer has nothing to report.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

const GIB = 1024 ** 3
const report = (overrides: Record<string, unknown> = {}) => ({
  selected: 'alice',
  selectedLabel: 'Alice',
  timeZone: 'America/New_York',
  periodEnd: '2026-11-20',
  canFilter: false,
  canRefresh: false,
  asOf: '2026-11-20T12:00:00Z',
  trackingStarted: null,
  users: [],
  userLabels: {},
  errors: [],
  subtotalUsd: 12.5,
  prices: { creditUsd: 2, storageTbMonthUsd: 23 },
  storage: { bytes: 2 * GIB, monthlyUsd: 0.05, files: 10 },
  transfers: { uploadedBytes: GIB, requestedDownloadBytes: GIB / 2 },
  services: [
    { key: 'warehouse', label: 'Warehouse', method: 'Metered query time.', credits: 1.5, usd: 3 },
    { key: 'photo_ai', label: 'Photo AI', method: 'Billed tokens.', credits: null, usd: null },
  ],
  daily: [{ day: '2026-11-20', usd: 1.25, warehouse: 1.25 }],
  staleSources: [],
  ...overrides,
})
/** The figure shown in a summary card, found by the card's heading. */
const card = (heading: string) =>
  within(screen.getByRole('heading', { name: heading }).closest('section')!)
const everyone = (subtotalUsd: number, selected = 'all') =>
  report({
    selected,
    selectedLabel: selected === 'all' ? 'All users' : selected,
    canFilter: true,
    users: ['alice', 'bob'],
    userLabels: { alice: 'Alice', bob: 'Bob' },
    subtotalUsd,
  })

it('renders the figures of a valid report', async () => {
  const calls = stubFetch(() => json(report()))
  render(<PersonalCostPanel />)
  expect(screen.getByRole('status').textContent).toBe('Loading costs…')

  expect(await screen.findByRole('heading', { name: 'My costs · Alice' })).toBeTruthy()
  expect(calls.map((call) => call.url)).toEqual(['/api/my-costs'])
  expect(card('Compute subtotal').getByText('$12.50')).toBeTruthy()
  expect(card('Original media').getByText('2.00 GiB')).toBeTruthy()
  expect(card('Transfers').getByText('Uploaded: 1.00 GiB')).toBeTruthy()
  expect(card('Transfers').getByText('Downloads requested: 0.50 GiB')).toBeTruthy()

  const warehouse = within(screen.getByRole('row', { name: /Warehouse/ }))
  expect(warehouse.getByText('1.500000')).toBeTruthy()
  expect(warehouse.getByText('$3.00')).toBeTruthy()
  expect(screen.getByRole('button', { name: '2026-11-20: Total cost 1.25 USD' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  await waitFor(() => expect(screen.queryByText(/Loading costs/)).toBeNull())
  // A member's own report offers neither a user filter nor a refresh.
  expect(screen.queryByRole('combobox', { name: /Show costs for/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
})

it('shows a missing cost as Unavailable, never as zero', async () => {
  stubFetch(() => json(report({ subtotalUsd: null, restUsageMissing: true })))
  render(<PersonalCostPanel />)
  await screen.findByRole('heading', { name: 'My costs · Alice' })

  expect(card('Compute subtotal').getByText('Unavailable')).toBeTruthy()
  expect(screen.queryByText('$0.00')).toBeNull()
  const photoAi = within(screen.getByRole('row', { name: /Photo AI/ }))
  expect(photoAi.getAllByText('Unavailable')).toHaveLength(2)
  expect(screen.getByText(/The subtotal excludes unavailable amounts/)).toBeTruthy()
})

it('warns when usage sources failed or are stale', async () => {
  stubFetch(() =>
    json(
      report({
        errors: ['Warehouse metering'],
        staleSources: [{ label: 'Cortex REST', lastSuccessAt: '2026-11-18T12:00:00Z' }],
      }),
    ),
  )
  render(<PersonalCostPanel />)
  expect(
    await screen.findByText(/Some usage sources are unavailable: Warehouse metering\./),
  ).toBeTruthy()
  expect(screen.getByText('Some totals include older measurements.')).toBeTruthy()
  expect(screen.getByText(/Cortex REST — last successful measurement/)).toBeTruthy()
})

it('shows the error state for a malformed report, and recovers on Retry report', async () => {
  let body: unknown = { ...report(), subtotalUsd: 'twelve dollars' }
  const calls = stubFetch(() => json(body))
  render(<PersonalCostPanel />)

  expect((await screen.findByRole('alert')).textContent).toContain(
    'Could not load costs. Please retry.',
  )
  expect(screen.queryByRole('heading', { name: 'Compute subtotal' })).toBeNull()
  expect(screen.queryByText('twelve dollars')).toBeNull()

  body = report()
  fireEvent.click(screen.getByRole('button', { name: 'Retry report' }))
  await screen.findByRole('heading', { name: 'Compute subtotal' })
  expect(card('Compute subtotal').getByText('$12.50')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(calls).toHaveLength(2)
})

it('shows the error state when the server refuses, without exposing its message', async () => {
  stubFetch(() => json({ error: 'relation "usage" does not exist' }, 500))
  render(<PersonalCostPanel />)
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Could not load costs. Please retry.',
  )
  expect(screen.queryByText(/relation/)).toBeNull()
})

it('requests the chosen user and keeps the previous report on screen meanwhile', async () => {
  const bob = deferred()
  const calls = stubFetch((call) =>
    call.url.endsWith('?user=bob') ? bob.response : json(everyone(40)),
  )
  render(<PersonalCostPanel />)
  const filter = await screen.findByRole<HTMLSelectElement>('combobox', { name: /Show costs for/ })
  expect(filter.value).toBe('all')
  expect(within(filter).getByRole('option', { name: 'Bob' })).toBeTruthy()

  fireEvent.change(filter, { target: { value: 'bob' } })
  expect(await screen.findByText(/Loading costs for Bob/)).toBeTruthy()
  expect(screen.getByText(/Showing previous report: all users\./)).toBeTruthy()
  expect(card('Compute subtotal').getByText('$40.00')).toBeTruthy()
  expect(calls.map((call) => call.url)).toEqual(['/api/my-costs', '/api/my-costs?user=bob'])

  bob.settle(json(everyone(7, 'bob')))
  expect(await card('Compute subtotal').findByText('$7.00')).toBeTruthy()
  expect(screen.queryByText(/Loading costs/)).toBeNull()
})

it('ignores a late reply for a selection that has since been replaced', async () => {
  const alice = deferred()
  const bob = deferred()
  stubFetch((call) =>
    call.url.endsWith('?user=alice')
      ? alice.response
      : call.url.endsWith('?user=bob')
        ? bob.response
        : json(everyone(40)),
  )
  render(<PersonalCostPanel />)
  const filter = await screen.findByRole('combobox', { name: /Show costs for/ })

  // Alice is requested first, then replaced by Bob before she answers.
  fireEvent.change(filter, { target: { value: 'alice' } })
  fireEvent.change(filter, { target: { value: 'bob' } })
  bob.settle(json(everyone(7, 'bob')))
  expect(await card('Compute subtotal').findByText('$7.00')).toBeTruthy()

  alice.settle(json(everyone(99, 'alice')))
  // Give the late reply every chance to be applied before checking it was not.
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(card('Compute subtotal').getByText('$7.00')).toBeTruthy()
  expect(screen.queryByText('$99.00')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('ignores a late failure for a selection that has since been replaced', async () => {
  const alice = deferred()
  stubFetch((call) =>
    call.url.endsWith('?user=alice')
      ? alice.response
      : json(everyone(call.url.endsWith('?user=bob') ? 7 : 40)),
  )
  render(<PersonalCostPanel />)
  const filter = await screen.findByRole('combobox', { name: /Show costs for/ })
  fireEvent.change(filter, { target: { value: 'alice' } })
  fireEvent.change(filter, { target: { value: 'bob' } })
  expect(await card('Compute subtotal').findByText('$7.00')).toBeTruthy()

  alice.settle(json({ error: 'Forbidden' }, 403))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(card('Compute subtotal').getByText('$7.00')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})
