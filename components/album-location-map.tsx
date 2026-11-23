'use client'
import { useMapColors } from './use-map-colors'
import { useEffect } from 'react'
import { CircleMarker, MapContainer, useMap } from 'react-leaflet'
import { BasemapLayer } from './basemap-layer'
import { MapGestures } from './map-gestures'
import type { AlbumPlace } from '@/lib/albums/album-location'
import 'leaflet/dist/leaflet.css'

function Position({ place }: { place: AlbumPlace }) {
  const map = useMap()
  useEffect(() => {
    map.invalidateSize()
    map.setView([place.lat, place.lng], 10)
  }, [map, place])
  return null
}
export default function AlbumLocationMap({ place }: { place: AlbumPlace }) {
  const colors = useMapColors()
  return (
    <MapContainer
      center={[place.lat, place.lng]}
      zoom={10}
      scrollWheelZoom={false}
      className="h-56 w-full rounded-xl"
      touchZoom
    >
      <MapGestures />
      <Position place={place} />
      <BasemapLayer />
      {colors && (
        <CircleMarker
          center={[place.lat, place.lng]}
          radius={9}
          pathOptions={{ ...colors, fillOpacity: 0.95, weight: 2 }}
        />
      )}
    </MapContainer>
  )
}
