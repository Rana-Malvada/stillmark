import AccountPage from '../../../app/account/page'
import { useAlbumDestinations } from '../../../components/gallery/use-album-destinations'
import { SavePhotoButton } from '../../../components/save-photo-button'
import { AuthProvider as ActualAuthProvider, useAuth as useActualAuth } from 'actual-auth'
import { IdentityActivityPanel } from '../../../components/identity-activity-panel'
import { AlbumPublicLinks } from '../../../components/album-public-links'
import { AddPhotosButton } from '../../../components/add-photos-button'
import { Slideshow } from '../../../components/slideshow'
import { AlbumSharing } from '../../../components/album-sharing'
import { SharedLinksPanel } from '../../../components/shared-links-panel'
import { AccessPanel } from '../../../components/access-panel'
import { PhotoViewer } from '../../../components/photo-viewer'
import { IgnoredFaceDialog } from '../../../components/ignored-face-dialog'
import { TrashPanel } from '../../../components/trash-panel'
import { EventActions } from '../../../components/event-actions'
import { ActivityPanel } from '../../../components/activity-panel'
import { PhotoPeoplePanel, usePhotoPeople } from '../../../components/people/photo-people-panel'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TravelsPanel } from '../../../components/travels-panel'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
import { AppHeader } from '../../../components/app-header'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import SearchResults from '../../../app/search/search-results'
import { EventGrid } from '../../../components/event-grid'
import { PersonDetail } from '../../../components/people/person-detail'
import { PeoplePanel } from '../../../components/people/people-panel'
import { galleryQueryString, galleryReturnPath } from '../../../lib/gallery-query'
import { PhotoGrid } from '../../../components/photo-grid'
import { ActivityTabs } from '../../../components/activity-tabs'
import { FaceScanPanel } from '../../../components/face-scan-panel'
import { VideoPreparationPanel } from '../../../components/video-preparation-panel'
import { SearchBatchPanel } from '../../../components/search-batch-panel'
import TravelMap from '../../../components/travel-map'
import { Map as LeafletMap } from 'leaflet'
import { requestGalleryReturn } from '../../../components/gallery-position'
import { PersonalCostPanel } from '../../../components/personal-cost-panel'
import { navigate } from './stubs'

// Expose the real map only in the isolated fixture for geometry/gesture checks.
LeafletMap.addInitHook(function () {
  window.fixtureMap = this
})

const initialAuth = {
  authenticated: true,
  username: 'ALICE',
  displayName: 'Alice',
  role: 'viewer',
  mainAdmin: false,
  canManageAccess: false,
  canManagePersonal: true,
  loading: false,
}
function AlbumDestinationsFixture() {
  const [scope, setScope] = useState('first')
  const controller = useAlbumDestinations({ scope, order: 'natural' })
  return (
    <>
      <button onClick={() => void controller.load(null)}>Load destinations</button>
      <button disabled={!controller.cursor} onClick={() => void controller.load(controller.cursor)}>
        Next destinations
      </button>
      <button onClick={() => setScope('second')}>Change destination scope</button>
      <button onClick={() => void controller.load(controller.retryCursor.current)}>
        Retry destinations
      </button>
      <select
        aria-label="Destination"
        value={controller.destination}
        onChange={(e) => controller.setDestination(e.target.value)}
      >
        <option value="">Choose</option>
        {controller.albums.map((album) => (
          <option key={album.eventId} value={album.eventId}>
            {album.eventName}
          </option>
        ))}
      </select>
      {controller.error && <p role="alert">{controller.error}</p>}
      <p>{controller.loading ? 'Loading destinations' : 'Destinations settled'}</p>
    </>
  )
}
function AuthActions() {
  const auth = useActualAuth()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function run(action) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <p>Identity: {auth.username ?? 'signed out'}</p>
      <button disabled={busy} onClick={() => void run(auth.logout)}>
        Sign out
      </button>
      <button disabled={busy} onClick={() => void run(auth.refresh)}>
        Refresh identity
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  )
}
function AccountFixture({ authOnly = false }) {
  const [show, setShow] = useState(true)
  return (
    <ActualAuthProvider initialState={initialAuth}>
      <AuthActions />
      {!authOnly && (
        <>
          <button onClick={() => setShow(false)}>Leave account</button>
          {show ? <AccountPage /> : <p>Account closed</p>}
        </>
      )}
    </ActualAuthProvider>
  )
}

function IdentityFixture() {
  const [user, setUser] = useState('ALICE')
  return (
    <>
      <button onClick={() => setUser('BOB')}>Change report user</button>
      <IdentityActivityPanel user={user} kind="" days="30" />
    </>
  )
}
function PublicLinksFixture() {
  const [eventId, setEventId] = useState(101)
  const [canEdit, setCanEdit] = useState(true)
  return (
    <>
      <button onClick={() => setEventId(101)}>Album A</button>
      <button onClick={() => setEventId(102)}>Album B</button>
      <button onClick={() => setCanEdit(false)}>Revoke editing</button>
      <AlbumPublicLinks eventId={eventId} canEdit={canEdit} />
    </>
  )
}
function GalleryWritesFixture() {
  const [eventId, setEventId] = useState(7)
  return (
    <>
      <button onClick={() => setEventId(8)}>Change album</button>
      <PhotoGrid eventId={eventId} canEdit />
    </>
  )
}
function SharingFixture() {
  const [eventId, setEventId] = useState(101)
  return (
    <>
      <button onClick={() => setEventId(101)}>Album A</button>
      <button onClick={() => setEventId(102)}>Album B</button>
      <AlbumSharing eventId={eventId} canEdit />
    </>
  )
}
function PhotoPeopleFixture() {
  const [photoId, setPhotoId] = useState(1)
  const { data, loading, error, reload } = usePhotoPeople(photoId)
  return (
    <>
      <button onClick={() => setPhotoId(photoId === 1 ? 2 : 1)}>Change photo</button>
      <button onClick={() => void reload()}>Refresh people</button>
      <PhotoPeoplePanel
        photoId={photoId}
        data={data}
        loading={loading}
        loadError={error}
        reload={reload}
        readOnly={false}
        selectedFaceId={null}
        onSelectFace={() => {}}
      />
    </>
  )
}

function IgnoredFaceFixture() {
  const [open, setOpen] = useState(true)
  return open ? (
    <IgnoredFaceDialog
      face={{ faceId: 1, photoId: 1, hasCrop: false, personName: 'Existing assignment' }}
      onClose={() => setOpen(false)}
      onSaved={async () => setOpen(false)}
    />
  ) : (
    <p>Saved face</p>
  )
}

// Actual components; only the Next router and signed-in identity are fixture ports.
function App() {
  const [path, setPath] = useState(location.pathname)
  useEffect(() => {
    const update = () => setPath(location.pathname)
    addEventListener('fixture:navigate', update)
    return () => removeEventListener('fixture:navigate', update)
  }, [])
  if (path === '/fixture/account') return <AccountFixture />
  if (path === '/fixture/destinations') return <AlbumDestinationsFixture />
  if (path === '/fixture/auth') return <AccountFixture authOnly />
  if (path === '/fixture/save-original')
    return <SavePhotoButton url="/original" filename="original.mp4" isVideo />
  if (path === '/fixture/identity') return <IdentityFixture />
  if (path === '/fixture/public-links') return <PublicLinksFixture />
  if (path === '/fixture/gallery-writes') return <GalleryWritesFixture />
  if (path === '/fixture/add-photos')
    return <AddPhotosButton eventId={7} folderId={1} sourceFolder="Fixture album" canEdit />
  if (path.startsWith('/fixture/slideshow/'))
    return <Slideshow eventId={Number(path.split('/')[3])} />
  if (path === '/fixture/sharing') return <SharingFixture />
  if (path === '/fixture/shared-links') return <SharedLinksPanel />
  if (path === '/fixture/access') return <AccessPanel />
  if (path.startsWith('/photos/') && new URLSearchParams(location.search).has('fixtureViewer'))
    return <PhotoViewer photoId={Number(path.split('/')[2])} context={location.search.slice(1)} />
  if (path === '/fixture/ignored-face') return <IgnoredFaceFixture />
  if (path === '/fixture/trash') return <TrashPanel />
  if (path === '/fixture/album-editor')
    return (
      <EventActions
        canEdit
        eventId={7}
        eventName="Fixture album"
        location="Paris"
        sortOrder={1}
        eventMonth={6}
        eventYear={2026}
        folderId={1}
      />
    )
  if (path === '/fixture/photo-people') return <PhotoPeopleFixture />
  if (path === '/fixture/activity') return <ActivityPanel />
  if (path === '/fixture/faces') return <FaceScanPanel />
  if (path === '/fixture/video') return <VideoPreparationPanel />
  if (path === '/fixture/search-status') return <SearchBatchPanel readOnly={false} />
  if (path === '/travel-map')
    return (
      <TravelMap
        places={[
          { lat: 64, lng: -20 },
          { lat: 38, lng: -122 },
          { lat: -34, lng: 18 },
          { lat: 35, lng: 140 },
          { lat: -34, lng: 151 },
          { lat: 48, lng: 2 },
        ].map((p, i) => ({
          ...p,
          id: String(i),
          label: 'Location ' + i,
          count: 1000 + i,
          stops: [],
        }))}
        selected={null}
        onSelect={() => {}}
        scope="mine"
        year="all"
      />
    )
  if (path === '/travels')
    return (
      <QueryClientProvider client={queryClient}>
        <TravelsPanel />
      </QueryClientProvider>
    )
  if (path === '/search') return <SearchResults />
  if (path === '/favorites')
    return (
      <main>
        <PhotoGrid initialQuery={galleryQueryString(new URLSearchParams(location.search))} />
      </main>
    )
  if (path === '/admin/processing')
    return (
      <>
        <ActivityTabs />
        <main>
          <FaceScanPanel automatic />
          <VideoPreparationPanel automatic />
          <SearchBatchPanel readOnly={false} automatic />
        </main>
      </>
    )
  if (path === '/costs') return <PersonalCostPanel />
  if (path === '/people') return <PeoplePanel />
  if (path.startsWith('/people/'))
    return (
      <>
        {!new URLSearchParams(location.search).has('fixtureHeader') && (
          <button onClick={() => navigate('/people/22222222-2222-4222-8222-222222222222')}>
            Change person
          </button>
        )}
        <PersonDetail personId={path.split('/')[2]} />
      </>
    )
  if (path.startsWith('/photos/'))
    return (
      <>
        <button
          onClick={() =>
            navigate(requestGalleryReturn('ALICE', galleryReturnPath(7, location.search)))
          }
        >
          Return to album
        </button>
        <button onClick={() => navigate('/events/7')}>Open album normally</button>
      </>
    )
  if (path.startsWith('/events/'))
    return (
      <PhotoGrid
        initialQuery={galleryQueryString(new URLSearchParams(location.search))}
        eventId={7}
        heading={
          <>
            <a href="/" aria-label="Back to collection">
              ←
            </a>
            <h1>Gatlinburg &amp; Pigeon Forge</h1>
          </>
        }
        canEdit={new URLSearchParams(location.search).get('fixtureCanEdit') !== 'false'}
        addActions={<button className="album-menu-item">Upload photos</button>}
        albumActions={
          <>
            <button className="album-menu-item">Edit details</button>
            <button className="album-menu-item">Delete album</button>
          </>
        }
      />
    )
  return <EventGrid mine />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {new URLSearchParams(location.search).has('fixtureHeader') && <AppHeader />}
    <div
      className={
        new URLSearchParams(location.search).has('fixtureHeader') ? 'app-workspace' : undefined
      }
    >
      <App />
    </div>
  </StrictMode>,
)
