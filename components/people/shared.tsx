'use client'

// Stable People UI entry point; implementations own their separate state lifecycles.
export { peopleApi } from '@/lib/people/people-client'
export { personLabel, type Face, type Person, type Changed } from './types'
export { FaceImage, PersonCard, FaceGrid } from './face-grid'
export { peopleControl, SelectionToolbar, useSelection } from './selection-controls'
export { ChangeBar, useChange } from './correction-feedback'
export { PersonPicker } from './person-picker'
