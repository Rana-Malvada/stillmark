'use client'

import { createContext, type ReactNode, useContext } from 'react'
import { mapConfig, type MapConfig } from '@/lib/travel/map-config'

const Context = createContext<MapConfig>(mapConfig())
export function MapProvider({ config, children }: { config: MapConfig; children: ReactNode }) {
  return <Context.Provider value={config}>{children}</Context.Provider>
}
export function useMapConfig() {
  return useContext(Context)
}
