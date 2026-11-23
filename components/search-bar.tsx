'use client'

import { Search } from 'lucide-react'
import { useRouter } from 'next/navigation'

export function SearchBar() {
  const router = useRouter()

  return (
    <button
      aria-label="Search library"
      onClick={() => router.push('/search')}
      className="nav-tool sm:px-2"
    >
      <Search className="w-3.5 h-3.5" />
      <span className="hidden sm:inline">Search</span>
    </button>
  )
}
