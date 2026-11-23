import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DailyUsageChart } from '@/components/daily-usage-chart'
import { MobileActivityCards } from '@/components/mobile-activity-cards'
import { UPLOAD_ROW_HEIGHT, uploadWindow } from '@/lib/upload/upload-progress-summary'

it('labels usage and storage with the correct timezones and offers touch date selection', () => {
  const props = {
    label: 'Costs',
    unit: 'USD',
    data: { days: ['2026-10-24'], series: [{ name: 'AI', values: [1] }] },
  }
  const eastern = renderToStaticMarkup(
    React.createElement(DailyUsageChart, { ...props, timeZone: 'America/New_York' }),
  )
  expect(eastern).toContain('Eastern time')
  expect(eastern).toContain('Inspect day')
  expect(eastern).not.toContain('min-w-[600px]')
  expect(renderToStaticMarkup(React.createElement(DailyUsageChart, props))).toContain('UTC')
})
it('makes mobile activity details available through a disclosure', () => {
  const html = renderToStaticMarkup(
    React.createElement(MobileActivityCards, {
      entries: [
        { id: '1', title: 'Upload', subtitle: 'Today', fields: [{ label: 'Files', value: 4 }] },
      ],
    }),
  )
  expect(html).toContain('<details>')
  expect(html).toContain('View details')
  expect(html).toContain('Files')
})
it('renders enough upload rows for a taller outer dialog scroller', () => {
  const range = uploadWindow(448, 1000, 1000)
  expect(range.before).toBeLessThanOrEqual(448)
  expect(range.end * UPLOAD_ROW_HEIGHT).toBeGreaterThanOrEqual(448 + 1000)
})
