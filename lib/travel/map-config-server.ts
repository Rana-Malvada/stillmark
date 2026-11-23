import { getSecret, SecretType } from '../snowflake'
import { mapConfig } from './map-config'

// Read the mounted key at runtime, never from committed source or a build-time bundle.
// This website-restricted key is intentionally delivered to map clients.
export function runtimeMapConfig() {
  let key: string | undefined
  try {
    key = getSecret('CARTO_BASEMAPS', SecretType.GENERIC_STRING)
  } catch {
    // Local development and installations without CARTO retain the existing OSM map.
  }
  return mapConfig(key)
}
