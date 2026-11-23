import { Slideshow } from '@/components/slideshow'
import { integer } from '@/lib/http'

export default async function Page({ params }: { params: Promise<{ eventId: string }> }) {
  return <Slideshow eventId={integer((await params).eventId, 'eventId')} />
}
