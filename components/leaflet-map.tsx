'use client'
import { BasemapLayer } from './basemap-layer'
import { MapGestures } from './map-gestures'

import { MapContainer, Marker } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const markerIcon = L.divIcon({
  className: 'photo-location-marker',
  html: '<span></span>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

export default function LeafletMap({ lat, lng, zoom }: { lat: number; lng: number; zoom: number }) {
  return (
    <MapContainer
      center={[lat, lng]}
      zoom={zoom}
      className="w-full h-[75vh]"
      scrollWheelZoom={false}
      touchZoom={true}
      zoomSnap={0}
      dragging={true}
      zoomControl={true}
    >
      <MapGestures />
      <BasemapLayer />
      <Marker position={[lat, lng]} icon={markerIcon} />
    </MapContainer>
  )
}
