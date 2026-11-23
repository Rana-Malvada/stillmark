import { EventGrid } from '@/components/event-grid'

export const dynamic = 'force-dynamic'
export default function MyAlbums() {
  return (
    <main className="w-full min-w-0 mx-auto">
      <EventGrid mine />
    </main>
  )
}
