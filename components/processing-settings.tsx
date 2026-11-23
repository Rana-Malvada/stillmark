'use client'

import { createContext, type ReactNode, useContext } from 'react'

// Server-provided configuration, not a health or authorization assertion.
// It avoids a second status request in every photo editor.
const AutomaticSearchContext = createContext(false)

export function ProcessingSettings({
  automaticSearch,
  children,
}: {
  automaticSearch: boolean
  children: ReactNode
}) {
  return (
    <AutomaticSearchContext.Provider value={automaticSearch}>
      {children}
    </AutomaticSearchContext.Provider>
  )
}

export function SearchUpdateHint({ activity = false }: { activity?: boolean }) {
  const automatic = useContext(AutomaticSearchContext)
  if (activity)
    return automatic
      ? 'New uploads and saved changes update search automatically. Check progress or retry an interrupted update here.'
      : 'Search updates run on request. Existing search results remain available.'
  return automatic
    ? 'Saved changes are queued for automatic AI search updates.'
    : 'Use Sync Search in Activity to add saved changes to AI search.'
}
