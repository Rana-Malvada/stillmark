import { Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import SearchResults from './search-results'

export const dynamic = 'force-dynamic'

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[40vh]">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SearchResults />
    </Suspense>
  )
}
