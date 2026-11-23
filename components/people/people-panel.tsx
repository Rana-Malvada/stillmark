'use client'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { HeaderNavigation } from '@/components/header-navigation'
import { useGalleryPosition } from '@/components/gallery-position'
import { useAuth } from '@/components/auth-provider'
import type { PeopleOverview as Overview } from '@/lib/people/people-overview-contract'
import { GroupSelection } from './group-selection'
import { type Person, PersonCard } from './shared'
import { FacesSection } from './face-list-section'
import { HistorySection } from './people-history'
import { SettingsSection } from './people-settings'
import { usePeopleOverview } from './use-people-overview'

const TABS = ['people', 'review', 'unknown', 'ignored', 'history', 'settings'] as const
type Tab = (typeof TABS)[number]

export function PeoplePanel() {
  const router = useRouter()
  const params = useSearchParams()
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'people'
  const quality = ['higher', 'lower'].includes(params.get('quality') ?? '')
    ? params.get('quality')!
    : 'all'
  const requestedFilter = params.get('filter')
  const filter = ['all', 'named', 'unnamed', 'hidden'].includes(requestedFilter ?? '')
    ? requestedFilter!
    : 'named'
  const readOnly = !useAuth().canManagePersonal
  const overviewKind = tab === 'people' ? filter : 'none'
  const { overview, settings, error, load, loadMorePeople, loadingMorePeople, loadedKind } =
    usePeopleOverview(overviewKind)

  const activeView = tab === 'people' ? filter : tab
  const primaryViews = [
    ['named', 'Named'],
    ['unknown', 'Unknown', overview?.unknownCount],
    ['review', 'Review', overview?.reviewCount],
    ['unnamed', 'Groups', overview?.unnamedCount],
  ] as const
  const otherViews = [
    ['all', 'All people'],
    ['hidden', 'Hidden people'],
    ['ignored', 'Ignored faces'],
    ['history', 'History'],
    ['settings', 'Settings'],
  ]
  const title =
    activeView === 'unknown'
      ? 'Unknown faces'
      : activeView === 'review'
        ? 'Review matches'
        : activeView === 'unnamed'
          ? 'Unnamed groups'
          : 'People'
  const changeView = (view: string) => {
    const next = new URLSearchParams(params.toString())
    if (['named', 'all', 'unnamed', 'hidden'].includes(view)) {
      next.set('tab', 'people')
      next.set('filter', view)
    } else {
      next.set('tab', view)
      next.delete('filter')
    }
    router.push(`/people?${next}`, { scroll: false })
  }
  const ready = overview && settings && loadedKind === overviewKind
  const empty = overview?.peopleCount === 0
  return (
    <div className="px-5 sm:px-8">
      {error && (
        <p role="alert" className="text-destructive">
          {error} {ready ? 'Showing the last loaded people.' : ''}{' '}
          <button className="control" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      <header className="pt-4 mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border pb-2">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <div className="order-last w-full min-w-0">
          <HeaderNavigation label="People views">
            {[...primaryViews, ...otherViews].map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                onClick={() => changeView(id)}
                aria-current={activeView === id ? 'page' : undefined}
                className={`shrink-0 min-h-11 sm:min-h-9 px-2 text-xs border-b-2 ${activeView === id ? 'border-primary text-primary font-semibold' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
              >
                {label}
                {typeof count === 'number' && count > 0 && (
                  <span className="ml-1.5 text-[11px] tabular-nums opacity-75">
                    {count.toLocaleString()}
                  </span>
                )}
              </button>
            ))}
          </HeaderNavigation>
        </div>
        {tab === 'unknown' && overview && (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <label htmlFor="face-quality" className="text-xs text-muted-foreground">
              Detection quality
            </label>
            <select
              id="face-quality"
              value={quality}
              className="min-h-11 sm:min-h-9 rounded border border-border bg-background px-2 text-xs"
              onChange={(e) => {
                const next = new URLSearchParams(params.toString())
                next.set('quality', e.target.value)
                router.replace(`/people?${next}`, { scroll: false })
              }}
            >
              <option value="all">All ({overview.unknownCount.toLocaleString()})</option>
              <option value="higher">
                Standard ({(overview.unknownCount - overview.lowerConfidenceCount).toLocaleString()}
                )
              </option>
              <option value="lower">
                Lower ({overview.lowerConfidenceCount.toLocaleString()})
              </option>
            </select>
          </div>
        )}
      </header>
      {!ready ? (
        <div className="min-h-[50vh] flex justify-center py-16" aria-busy={!error}>
          {!error && (
            <Loader2
              className="w-6 h-6 animate-spin text-muted-foreground"
              aria-label="Loading people"
            />
          )}
        </div>
      ) : tab === 'settings' ? (
        <SettingsSection settings={settings} readOnly={readOnly} onChange={load} />
      ) : !settings.enabled && empty ? (
        <div className="max-w-xl text-sm text-muted-foreground space-y-3">
          <p>
            People groups photos by the faces in them, so you can name people and find every photo
            of them. It is off for your library.
          </p>
          <Link href="/people?tab=settings" className="underline text-foreground">
            Review settings and turn on People
          </Link>
        </div>
      ) : tab === 'people' ? (
        <>
          <PeopleSection
            key={params.toString()}
            overview={overview}
            filter={filter}
            readOnly={readOnly}
            onChange={load}
          />
          {overview.more && (
            <button
              type="button"
              className="control mb-8"
              disabled={loadingMorePeople}
              onClick={() => void loadMorePeople()}
            >
              {loadingMorePeople ? 'Loading…' : 'Load more people'}
            </button>
          )}
        </>
      ) : tab === 'history' ? (
        <HistorySection readOnly={readOnly} onChange={load} />
      ) : (
        <FacesSection
          key={`${tab}:${quality}`}
          kind={tab}
          quality={quality}
          readOnly={readOnly}
          onChange={load}
        />
      )}
    </div>
  )
}

function PeopleSection({
  overview,
  filter,
  readOnly,
  onChange,
}: {
  overview: Overview
  filter: string
  readOnly: boolean
  onChange: () => Promise<void>
}) {
  useGalleryPosition(true)
  const visible = (kind: string) => filter === 'all' || filter === kind
  const count =
    (visible('named') ? overview.named.length : 0) +
    (visible('unnamed') ? overview.unnamed.length : 0) +
    (visible('hidden') ? overview.hidden.length : 0)
  const section = (title: string, people: Person[], note?: string) =>
    people.length > 0 && (
      <section className="mb-10" aria-label={title}>
        <h2 className="text-lg font-semibold mb-1">{title}</h2>
        {note && <p className="text-sm text-muted-foreground mb-3">{note}</p>}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3 sm:gap-4">
          {people.map((p) => (
            <PersonCard key={p.personId} person={p} href={`/people/${p.personId}`} />
          ))}
        </div>
      </section>
    )
  if (overview.peopleCount === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No people yet. Faces appear here after your photos are scanned.
      </p>
    )
  return (
    <>
      {count === 0 && <p className="text-sm text-muted-foreground">No people in this category.</p>}
      {visible('named') && section('Named', overview.named)}
      {visible('unnamed') && (
        <GroupSelection people={overview.unnamed} readOnly={readOnly} onChange={onChange} />
      )}
      {visible('hidden') &&
        section('Hidden', overview.hidden, 'Hidden people do not appear in search or on photos.')}
    </>
  )
}
