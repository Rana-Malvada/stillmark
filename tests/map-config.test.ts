import { expect, it } from 'vitest'
import { mapConfig } from '@/lib/travel/map-config'

it('uses direct CARTO Positron tiles with both required credits', () => {
  const config = mapConfig('test&key')
  expect(config.url).toBe(
    'https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=test%26key',
  )
  expect(config.attribution).toContain('OpenStreetMap')
  expect(config.attribution).toContain('CARTO')
  expect(config.carto).toBe(true)
})

it('keeps the existing map for installations without a key', () => {
  expect(mapConfig().url).toBe('/api/tiles/{z}/{x}/{y}')
  expect(mapConfig('  ').carto).toBe(false)
})
