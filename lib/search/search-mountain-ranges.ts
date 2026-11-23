// Geographic names from GeoNames (CC BY 4.0). See scripts/search/build-mountain-ranges.py.
import ranges from '../../config/search-mountain-ranges.json'

export function mountainRangeNames(country: string): string[] {
  return Object.hasOwn(ranges, country) ? ranges[country as keyof typeof ranges] : []
}
