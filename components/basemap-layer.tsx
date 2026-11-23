'use client'

import { TileLayer } from 'react-leaflet'
import { useMapConfig } from './map-provider'

export function BasemapLayer({ maxZoom = 19 }: { maxZoom?: number }) {
  const config = useMapConfig()
  return (
    <TileLayer
      url={config.url}
      attribution={config.attribution}
      className={config.carto ? 'carto-basemap' : 'osm-basemap'}
      maxZoom={maxZoom}
      // CARTO validates the website. Send only the origin, never a photo or share URL.
      referrerPolicy="origin"
    />
  )
}
