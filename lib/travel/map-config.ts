export type MapConfig = { url: string; attribution: string; carto: boolean }

export function mapConfig(key?: string): MapConfig {
  const osm =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  if (!key?.trim()) return { url: '/api/tiles/{z}/{x}/{y}', attribution: osm, carto: false }
  return {
    url: `https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png?key=${encodeURIComponent(key.trim())}`,
    attribution: `${osm}, &copy; <a href="https://carto.com/attribution/">CARTO</a>`,
    carto: true,
  }
}
