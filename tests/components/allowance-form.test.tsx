// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AllowanceForm } from '@/components/access/allowance-form'
import './harness'

const field = (name: string) => screen.getByRole<HTMLInputElement>('spinbutton', { name })
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
function open(onSave = vi.fn(async () => {})) {
  render(<AllowanceForm busy={false} onSave={onSave} />)
  fireEvent.click(button('Set upload allowance'))
  return onSave
}
function fill(files: string, storage: string, searches: string) {
  fireEvent.change(field('Total files'), { target: { value: files } })
  fireEvent.change(field('Total storage (GiB)'), { target: { value: storage } })
  fireEvent.change(field('AI searches per day'), { target: { value: searches } })
}
// Dispatching submit skips the browser's own number-field validation, so these tests
// exercise the component's check, which is what protects the request if that is bypassed.
const submit = () => fireEvent.submit(screen.getByRole('form', { name: 'Upload allowance' }))

it('stays collapsed until asked, then shows its three labelled fields', () => {
  render(<AllowanceForm busy={false} onSave={vi.fn()} />)
  const toggle = button('Set upload allowance')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('form')).toBeNull()

  fireEvent.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(field('Total files').value).toBe('')
  expect(field('Total storage (GiB)').value).toBe('')
  expect(field('AI searches per day').value).toBe('0')
  expect(button('Save allowance')).toBeTruthy()
})

it('explains an out-of-range value and does not save it', () => {
  const onSave = open()
  fill('10', '20000', '0')
  submit()
  expect(screen.getByRole('alert').textContent).toBe(
    'Enter a storage allowance from 0 to 10,240 GiB.',
  )
  expect(onSave).not.toHaveBeenCalled()
})

it('does not save while a field is blank', () => {
  const onSave = open()
  submit()
  expect(screen.getByRole('alert').textContent).toMatch(/file allowance/)
  fill('10', '', '0')
  submit()
  expect(screen.getByRole('alert').textContent).toMatch(/storage allowance/)
  fill('10', '5', '')
  submit()
  expect(screen.getByRole('alert').textContent).toMatch(/AI search allowance/)
  expect(onSave).not.toHaveBeenCalled()
})

it('saves the parsed numbers, converting GiB to bytes', async () => {
  const onSave = open()
  fill('500', '2.5', '25')
  submit()
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
  expect(onSave).toHaveBeenCalledWith({ uploads: 500, bytes: 2684354560, aiSearches: 25 })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('clears an earlier problem once the values are corrected', async () => {
  const onSave = open()
  fill('1.5', '1', '0')
  submit()
  expect(screen.getByRole('alert')).toBeTruthy()
  fill('2', '1', '0')
  submit()
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledWith({ uploads: 2, bytes: 1073741824, aiSearches: 0 }),
  )
  expect(screen.queryByRole('alert')).toBeNull()
})

it('Cancel closes the form without saving and forgets the problem', () => {
  const onSave = open()
  submit()
  expect(screen.getByRole('alert')).toBeTruthy()
  fireEvent.click(button('Cancel'))
  expect(screen.queryByRole('form')).toBeNull()
  expect(onSave).not.toHaveBeenCalled()

  fireEvent.click(button('Set upload allowance'))
  expect(screen.queryByRole('alert')).toBeNull()
})

it('cannot be opened or edited while a save is in progress', () => {
  const view = render(<AllowanceForm busy={false} onSave={vi.fn()} />)
  fireEvent.click(button('Set upload allowance'))
  view.rerender(<AllowanceForm busy onSave={vi.fn()} />)
  expect(button('Set upload allowance').disabled).toBe(true)
  expect(field('Total files').disabled).toBe(true)
  expect(button('Save allowance').disabled).toBe(true)
  expect(button('Cancel').disabled).toBe(true)
})
