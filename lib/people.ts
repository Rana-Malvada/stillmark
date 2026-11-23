/**
 * Public People API. Reads rely on owner scope and row security; corrections,
 * snapshots and undo share one atomic owner-locked transaction boundary.
 * Keep consumers on this facade so internal persistence details stay private.
 */
export { personId, personName, faceIds, faceBox } from './people/contracts'
export type { PeopleSettings, PersonSummary, FaceItem } from './people/contracts'
export { getSettings, updateSettings, deleteFaceData } from './people/settings'
export {
  listPeople,
  getPerson,
  reviewQueue,
  unknownFaces,
  photoPeople,
  history,
} from './people/queries'
export {
  renamePerson,
  setHidden,
  setCover,
  confirmFaces,
  rejectFaces,
  assignToPerson,
  tagPhoto,
  mergePeople,
  movePersonFaces,
  splitPerson,
  changeGroups,
  ignorePerson,
  setIgnored,
} from './people/corrections'
export { undo } from './people/correction-store'
