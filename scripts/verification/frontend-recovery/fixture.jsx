import React, { useState } from 'react'
import { UserActivityPanel } from '../../../components/user-activity-panel'
import { ActivityPanel } from '../../../components/activity-panel'
import { UploadPanel } from '../../../components/upload-panel'
import { PeoplePanel } from '../../../components/people/people-panel'
import { peopleApi, useChange } from '../../../components/people/shared'
import { createRoot } from 'react-dom/client'
import { BufferedVideo } from '../../../components/buffered-video'
import Search from '../../../app/search/search-results'
import { PersonalCostPanel } from '../../../components/personal-cost-panel'
import { TrashPanel } from '../../../components/trash-panel'
import { AlbumDate } from '../../../components/album-date'
import { PhotoLabelEditor } from '../../../components/photo-label-editor'
import { AlbumLocation } from '../../../components/album-location'
import { CustomerDefaultsPanel } from '../../../components/customer-defaults-panel'

function PeopleWriteProbe() {
  const [name, setName] = useState('Old name')
  const reload = async () => {
    const result = await peopleApi('/api/people/probe')
    setName(result.name)
  }
  const { run, busy, bar } = useChange(reload)
  return (
    <>
      <p>{name}</p>
      {bar}
      <button
        disabled={busy}
        onClick={() =>
          void run('Saved', () => peopleApi('/api/people/probe', 'PATCH', { name: 'New name' }))
        }
      >
        Change person
      </button>
    </>
  )
}
function UserActivityProbe() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <button onClick={() => setOpen((v) => !v)}>
        {open ? 'Close activity fixture' : 'Open activity fixture'}
      </button>
      {open && <UserActivityPanel />}
    </>
  )
}
const kind = new URLSearchParams(location.search).get('probe')
const element =
  kind === 'user-activity' ? (
    <UserActivityProbe />
  ) : kind === 'activity' ? (
    <ActivityPanel />
  ) : kind === 'upload-folder' ? (
    <UploadPanel />
  ) : kind === 'people' ? (
    <PeoplePanel />
  ) : kind === 'people-write' ? (
    <PeopleWriteProbe />
  ) : kind === 'video' ? (
    <BufferedVideo photoId={1} src="/original.mp4" controls />
  ) : kind === 'costs' ? (
    <PersonalCostPanel />
  ) : kind === 'search' ? (
    <Search />
  ) : kind === 'trash' ? (
    <TrashPanel />
  ) : kind === 'date' ? (
    <AlbumDate eventId={7} canEdit />
  ) : kind === 'labels' ? (
    <PhotoLabelEditor
      photoId={1}
      canEdit
      caption="caption"
      aiDescription={null}
      tags={[]}
      onSaved={() => {}}
    />
  ) : kind === 'location' ? (
    <AlbumLocation eventId={7} canEdit />
  ) : (
    <CustomerDefaultsPanel />
  )
createRoot(document.getElementById('root')).render(element)
