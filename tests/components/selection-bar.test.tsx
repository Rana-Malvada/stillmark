// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { SelectionBar } from '@/components/selection-bar'
import './harness'

function bar(props: { actionsVisible?: boolean; auxiliaryPanel?: string } = {}) {
  return (
    <SelectionBar label="Photo selection" summary={<span>3 selected</span>} {...props}>
      <button>Delete selected</button>
    </SelectionBar>
  )
}
const toggle = () => screen.getByRole('button', { name: 'Actions' })
const action = () => screen.queryByRole('button', { name: 'Delete selected' })

it('shows the summary with the actions collapsed', () => {
  render(bar())
  expect(screen.getByRole('region', { name: 'Photo selection' })).toBeTruthy()
  expect(screen.getByText('3 selected')).toBeTruthy()
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(action()).toBeNull()
})

it('Actions reveals the actions and hides them again', () => {
  render(bar())
  fireEvent.click(toggle())
  expect(toggle().getAttribute('aria-expanded')).toBe('true')
  expect(action()).toBeTruthy()
  fireEvent.click(toggle())
  expect(action()).toBeNull()
})

it('Escape closes the actions and returns focus to the Actions button', () => {
  render(bar())
  fireEvent.click(toggle())
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(action()).toBeNull()
  expect(document.activeElement).toBe(toggle())
})

it('leaves Escape to an open dialog', () => {
  render(
    <>
      {bar()}
      <dialog open>Confirm</dialog>
    </>,
  )
  fireEvent.click(toggle())
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(action()).toBeTruthy()
})

it('closes when the pointer goes down outside the bar, not inside it', () => {
  render(
    <>
      {bar()}
      <p>Photo grid</p>
    </>,
  )
  fireEvent.click(toggle())
  fireEvent.pointerDown(action()!)
  expect(action()).toBeTruthy()
  fireEvent.pointerDown(screen.getByText('Photo grid'))
  expect(action()).toBeNull()
})

it('selecting the summary closes the actions', () => {
  render(bar())
  fireEvent.click(toggle())
  fireEvent.click(screen.getByText('3 selected'))
  expect(action()).toBeNull()
})

it('offers no actions when there is nothing to act on, and reopens collapsed', () => {
  const view = render(bar())
  fireEvent.click(toggle())
  view.rerender(bar({ actionsVisible: false }))
  expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull()
  expect(action()).toBeNull()
  expect(screen.getByText('3 selected')).toBeTruthy()

  view.rerender(bar())
  expect(toggle().getAttribute('aria-expanded')).toBe('false')
  expect(action()).toBeNull()
})

it('keeps an auxiliary panel visible whether or not the actions are open', () => {
  render(bar({ auxiliaryPanel: 'Moving 3 photos…' }))
  expect(screen.getByText('Moving 3 photos…')).toBeTruthy()
  fireEvent.click(toggle())
  expect(screen.getByText('Moving 3 photos…')).toBeTruthy()
})
