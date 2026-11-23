'use client'
import { useEffect, useRef, useState } from 'react'
import type { DailyData } from '@/lib/costs/daily-chart'

const colors = Array.from({ length: 8 }, (_, i) => `var(--chart-${i + 1})`)
const number = (value: number) =>
  value !== 0 && Math.abs(value) < 0.001
    ? value.toExponential(2)
    : value.toLocaleString(undefined, { maximumFractionDigits: 4 })
export function DailyUsageChart({
  data,
  unit,
  label,
  timeZone = 'UTC',
}: {
  data: DailyData
  unit: string
  label: string
  timeZone?: string
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const [chartWidth, setChartWidth] = useState(780)
  useEffect(() => {
    const node = root.current
    if (!node) return
    const observer = new ResizeObserver(() => setChartWidth(Math.max(240, node.clientWidth)))
    observer.observe(node)
    return () => observer.disconnect()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the chart root only mounts once a series exists; observe it when that changes
  }, [data.series.length])
  const compact = chartWidth < 500
  if (!data.series.length)
    return <p className="text-sm text-muted-foreground">No data reported for this period.</p>
  const width = chartWidth
  const height = 260
  const left = compact ? 60 : 78
  const right = 18
  const top = 20
  const bottom = 42
  const values = data.series.flatMap((s) => s.values.filter((v): v is number => v !== null))
  const min = Math.min(0, ...values)
  const max = Math.max(...values, 0) || 1
  const range = max - min
  const x = (i: number) => left + (i * (width - left - right)) / Math.max(1, data.days.length - 1)
  const y = (v: number) => top + ((max - v) * (height - top - bottom)) / range
  const ticks = [
    ...new Set([
      0,
      ...(compact ? [] : [Math.round((data.days.length - 1) / 4)]),
      Math.round((data.days.length - 1) / 2),
      ...(compact ? [] : [Math.round((3 * (data.days.length - 1)) / 4)]),
      data.days.length - 1,
    ]),
  ]
  return (
    <div ref={root} className="space-y-3 min-w-0">
      <p className="text-xs text-muted-foreground">
        Daily {unit} · {timeZone === 'America/New_York' ? 'Eastern time' : timeZone}. Gaps mean no
        data was reported. Tap a day or use the date selector for values.
      </p>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          aria-label={`${label}: daily ${unit}`}
        >
          <title>
            {label}: daily {unit}
          </title>
          {[0, 1, 2, 3, 4].map((t) => {
            const value = min + (range * t) / 4
            return (
              <g key={t}>
                <line
                  x1={left}
                  x2={width - right}
                  y1={y(value)}
                  y2={y(value)}
                  stroke="currentColor"
                  opacity="0.12"
                />
                <text
                  x={left - 8}
                  y={y(value) + 4}
                  textAnchor="end"
                  fill="currentColor"
                  fontSize="11"
                >
                  {number(value)}
                </text>
              </g>
            )
          })}
          {ticks.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={height - 14}
              textAnchor="middle"
              fill="currentColor"
              fontSize="11"
            >
              {data.days[i].slice(5)}
            </text>
          ))}
          {data.series.map((series, s) => {
            const path = series.values
              .map((value, i) =>
                value === null
                  ? ''
                  : `${i === 0 || series.values[i - 1] === null ? 'M' : 'L'}${x(i)},${y(value)}`,
              )
              .join(' ')
            return (
              <g key={series.name} fill={colors[s % colors.length]}>
                <path
                  d={path}
                  fill="none"
                  stroke={colors[s % colors.length]}
                  strokeWidth="2"
                  strokeDasharray={s >= colors.length ? '5 3' : undefined}
                />
                {series.values.map((v, i) =>
                  v === null ? null : (
                    <circle key={i} cx={x(i)} cy={y(v)} r={selected === i ? 4 : 2.5} />
                  ),
                )}
              </g>
            )
          })}
          {data.days.map((day, i) => (
            <rect
              key={day}
              x={x(i) - (width - left - right) / Math.max(1, data.days.length - 1) / 2}
              y={top}
              width={(width - left - right) / Math.max(1, data.days.length - 1)}
              height={height - top - bottom}
              fill="transparent"
              tabIndex={0}
              role="button"
              aria-label={`${day}: ${data.series.map((s) => `${s.name} ${s.values[i] === null ? 'unreported' : number(s.values[i]!)} ${unit}`).join(', ')}`}
              onMouseEnter={() => setSelected(i)}
              onFocus={() => setSelected(i)}
              onClick={() => setSelected(i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setSelected(i)
                }
              }}
              stroke={selected === i ? 'currentColor' : 'none'}
              strokeOpacity="0.25"
            />
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">
        {data.series.map((s, i) => (
          <span key={s.name} className="inline-flex items-center gap-2">
            <span className="h-2 w-4 rounded" style={{ background: colors[i % colors.length] }} />
            {s.name}
          </span>
        ))}
      </div>
      <label className="flex flex-wrap gap-2 items-center text-sm">
        Inspect day
        <select
          className="control max-w-full"
          value={selected ?? ''}
          onChange={(e) => setSelected(e.target.value === '' ? null : Number(e.target.value))}
        >
          <option value="">Choose a day</option>
          {data.days.map((day, i) => (
            <option key={day} value={i}>
              {day}
            </option>
          ))}
        </select>
      </label>
      <p aria-live="polite" className="min-h-10 text-sm">
        {selected !== null && data.days[selected] ? (
          <>
            <strong>{data.days[selected]}</strong>
            {data.series.map((s) => (
              <span key={s.name} className="ml-4 inline-block">
                {s.name}:{' '}
                {s.values[selected] === null
                  ? 'Not reported'
                  : `${number(s.values[selected]!)} ${unit}`}
              </span>
            ))}
          </>
        ) : (
          'Select a day to inspect its values.'
        )}
      </p>
    </div>
  )
}
