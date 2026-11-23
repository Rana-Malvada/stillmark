'use client'
import { CostRefreshProgress, StaleCostNotice } from './cost-refresh-progress'
import type { CostRefreshProgress as Progress } from '@/lib/costs/cost-refresh-state'
import { useEffect, useRef, useState } from 'react'
import { refreshCostUsage } from '@/lib/costs/cost-refresh-client'
import Link from 'next/link'
import { DailyUsageChart } from './daily-usage-chart'
import { dailyData } from '@/lib/costs/daily-chart'
import { costChartMetrics } from '@/lib/costs/cost-chart-selection'
import { CostChartFilter } from './cost-chart-filter'
import { CostExplanation } from './cost-explanation'
import { ClientResponseError, readClientResponse } from '@/lib/client-response'
import {
  type PersonalCostData as Data,
  isPersonalCostData,
} from '@/lib/costs/personal-cost-response'

const usd = (n: number | null) =>
  n === null
    ? 'Unavailable'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }).format(n)
const gib = (n: number) => (n / 1024 ** 3).toFixed(2) + ' GiB'
export function PersonalCostPanel() {
  const [data, setData] = useState<Data | null>(null)
  const [user, setUser] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [revision, setRevision] = useState(0)
  const [chartTypes, setChartTypes] = useState<string[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const refreshController = useRef<AbortController | null>(null)
  useEffect(() => () => refreshController.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- the flags must be raised after the previous user's load is aborted in this effect, or its late completion could clear them mid-load
    setLoading(true)
    setError('')
    fetch('/api/my-costs' + (user ? '?user=' + encodeURIComponent(user) : ''), {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
      cache: 'no-store',
    })
      .then(async (r) => {
        const d = await readClientResponse(
          r,
          'Could not load costs. Please retry.',
          isPersonalCostData,
        )
        if (!controller.signal.aborted) setData(d)
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          if (e instanceof ClientResponseError && [401, 403].includes(e.status)) setData(null)
          setError('Could not load costs. Please retry.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- revision is the reload trigger after a usage refresh or Retry
  }, [user, revision])
  async function refresh() {
    if (refreshController.current) return
    const controller = new AbortController()
    refreshController.current = controller
    setRefreshing(true)
    setProgress(null)
    setError('')
    try {
      await refreshCostUsage(data?.asOf ?? null, controller.signal, (next) => {
        if (!controller.signal.aborted) setProgress(next)
      })
      if (!controller.signal.aborted) setRevision((n) => n + 1)
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Refresh failed')
    } finally {
      if (refreshController.current === controller) {
        refreshController.current = null
        if (!controller.signal.aborted) setRefreshing(false)
      }
    }
  }
  return (
    <main className="report-page w-full min-w-0 px-5 sm:px-8 py-5 space-y-4">
      <StaleCostNotice sources={data?.staleSources ?? []} />
      <div className="page-header">
        <div>
          <p className="eyebrow mb-1.5">Library insights</p>
          <h1 className="page-title">Costs &amp; usage</h1>
        </div>
        <Link className="control" href="/">
          Back to collection
        </Link>
      </div>
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <p>Last 30 days · Eastern time · Estimates</p>
        <CostExplanation
          title="Cost report"
          explanation="Includes today. Dates follow Eastern time, including daylight saving. These are estimates, not invoices. Cloudflare and Auth0 are excluded. Viewing this report uses cached usage data. Snowflake reporting can lag up to 8 hours; missing or unallocated amounts are excluded from the subtotal."
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}{' '}
          {!refreshing && (
            <button type="button" className="underline" onClick={() => setRevision((n) => n + 1)}>
              Retry report
            </button>
          )}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading costs
          {user
            ? ` for ${user === 'all' ? 'all users' : data?.userLabels[user] || 'selected user'}`
            : ''}
          …
          {data &&
            ` Showing previous report: ${data.selected === 'all' ? 'all users' : data.selectedLabel}.`}
        </p>
      )}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-4">
            {data.canFilter ? (
              <label className="text-sm">
                Show costs for{' '}
                <select
                  className="control ml-2"
                  value={user || data.selected}
                  onChange={(e) => setUser(e.target.value)}
                >
                  <option value="all">All users</option>
                  {data.users.map((name) => (
                    <option key={name} value={name}>
                      {data.userLabels[name] || 'Member'}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <h2 className="text-lg font-semibold">
                {data.selected === 'all' ? 'All users' : `My costs · ${data.selectedLabel}`}
              </h2>
            )}
            {data.canRefresh && (
              <button
                className="control disabled:opacity-50"
                disabled={refreshing}
                onClick={refresh}
              >
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
            <p className="text-xs text-muted-foreground">
              {data.asOf
                ? `Updated ${new Date(data.asOf).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })}`
                : 'No usage refresh yet'}
            </p>
          </div>
          {refreshing && <CostRefreshProgress progress={progress} />}
          {data.errors.length > 0 && (
            <p className="text-warning">
              Some usage sources are unavailable: {data.errors.join(', ')}. Refresh may require
              account permissions.
            </p>
          )}
          {data.timezoneRefreshNeeded && (
            <p role="status" className="text-sm text-warning">
              This saved report still uses UTC days. Refresh usage to rebuild it in Eastern time;
              the existing daily figures have not been relabeled.
            </p>
          )}
          {data.restUsageMissing && (
            <p role="status" className="text-sm text-warning">
              Some Cortex REST photo or search usage is unavailable or awaiting a usage refresh. The
              subtotal excludes unavailable amounts.
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <section className="rounded-xl border bg-card p-5">
              <div className="flex items-center justify-between gap-1">
                <h2 className="text-sm text-muted-foreground">Compute subtotal</h2>
                <CostExplanation
                  title="Compute subtotal"
                  explanation={`Partial estimate at $${data.prices.creditUsd}/credit (Standard list-price assumption). REST photo and search AI include matched billed credits and available estimates. Missing costs are excluded. Storage and transfer are separate.`}
                />
              </div>
              <p className="text-3xl font-semibold tabular-nums">{usd(data.subtotalUsd)}</p>
            </section>
            <section className="rounded-xl border bg-card p-5">
              <div className="flex items-center justify-between gap-1">
                <h2 className="text-sm text-muted-foreground">Original media</h2>
                <CostExplanation
                  title="Original media"
                  explanation={`${data.storage.files} active files, plus retained trash. Approximately ${usd(data.storage.monthlyUsd)}/month at the current size. This is a current run rate, not historical spending.`}
                />
              </div>
              <p className="text-3xl font-semibold tabular-nums">{gib(data.storage.bytes)}</p>
            </section>
            <section className="rounded-xl border bg-card p-5">
              <div className="flex items-center justify-between gap-1">
                <h2 className="text-sm text-muted-foreground">Transfers</h2>
                <CostExplanation
                  title="Transfers"
                  explanation="Requested file sizes, not metered network traffic. Transfer dollars are unavailable; not assumed free."
                />
              </div>
              <p className="font-semibold tabular-nums">
                Uploaded: {gib(data.transfers.uploadedBytes)}
              </p>
              <p className="text-sm tabular-nums mt-1">
                Downloads requested: {gib(data.transfers.requestedDownloadBytes)}
              </p>
            </section>
          </div>
          <section className="rounded-xl border p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1">
                <h2 className="font-semibold">Daily estimated costs</h2>
                <CostExplanation
                  title="Daily estimated costs"
                  explanation="Total includes reported services; missing costs, storage and transfer are excluded."
                />
              </div>
              <CostChartFilter
                selected={chartTypes}
                services={data.services}
                onChange={setChartTypes}
              />
            </div>
            <DailyUsageChart
              timeZone={data.timeZone}
              label="Daily estimated cost"
              unit="USD"
              data={dailyData(
                data.daily,
                costChartMetrics(chartTypes, data.services),
                data.periodEnd,
                30,
              )}
            />
          </section>
          <section className="rounded-xl border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="bg-muted">
                    <th className="px-3 py-2 font-medium">Service</th>
                    <th className="px-3 py-2 text-right font-medium">Credits</th>
                    <th className="px-3 py-2 text-right whitespace-nowrap font-medium">Est. USD</th>
                  </tr>
                </thead>
                <tbody>
                  {data.services.map((s) => (
                    <tr key={s.key} className="border-t align-middle">
                      <td className="px-3 py-1">
                        <div className="flex items-center gap-1">
                          <p className="font-semibold">{s.label}</p>
                          <CostExplanation title={s.label} explanation={s.method} />
                        </div>
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums whitespace-nowrap">
                        {s.key === 'photo_openai'
                          ? 'Not Snowflake'
                          : s.credits === null
                            ? 'Unavailable'
                            : s.credits.toFixed(6)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums whitespace-nowrap">
                        {usd(s.usd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer py-3 font-medium">How to read this report</summary>
            <div className="space-y-3 pb-3 max-w-prose">
              <p>
                Personal AI and warehouse attribution starts{' '}
                {data.trackingStarted
                  ? new Date(data.trackingStarted).toLocaleDateString()
                  : 'with new AI or search-sync work after this release'}
                . Earlier costs cannot be reconstructed per user. A zero in those rows means no
                attributed credits reported, not proof that no costs were incurred.
              </p>
              <p>
                Search indexing follows the album owner when content is submitted, even when an
                administrator clicks Sync. Ownership transfers affect future work; previous
                attribution stays with its recorded owner.
              </p>
              <p>
                Storage is a current monthly run rate at ${data.prices.storageTbMonthUsd}/TB-month,
                not historical spending. It excludes thumbnails, previews, temporary chunks, backups
                and database storage. Shared originals may be counted more than once.
              </p>
              <p>
                All users includes account-wide costs that cannot be assigned to individuals, so
                individual reports may not add up to it. PostgreSQL and hosting are split equally.
                Warehouse idle time and untracked work remain unallocated. Contract discounts, taxes
                and unlisted services are excluded.
              </p>
            </div>
          </details>
        </>
      )}
    </main>
  )
}
