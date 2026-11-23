import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readSelection,
  restoreSelection,
  selectionKey,
  writeSelection,
} from '../lib/people/people-selection'

describe('People selection memory', () => {
  beforeEach(() => {
    const values = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  it('restores selection and loaded pages after navigation and drops missing faces', () => {
    const key = selectionKey('owner', 'list:unknown')
    writeSelection(key, [12, 250, 99], 400)
    const saved = readSelection(key)
    expect(saved.loaded).toBe(400)
    expect([...restoreSelection(saved.ids, [12, 18, 250])]).toEqual([12, 250])
    writeSelection(key, [], 400)
    expect(readSelection(key).ids).toEqual([])
  })
  it('keeps users, people, and lists separate', () => {
    writeSelection(selectionKey('one', 'person:1'), [12], 200)
    for (const key of [
      selectionKey('two', 'person:1'),
      selectionKey('one', 'person:2'),
      selectionKey('one', 'list:unknown'),
      selectionKey(null, 'person:1'),
    ])
      expect(readSelection(key).ids).toEqual([])
  })
  it('matches bigint IDs while retaining the API value type', () => {
    const apiIds = JSON.parse('["123","456"]')
    expect([...restoreSelection(['123'], apiIds)]).toEqual(['123'])
    expect([...restoreSelection(['123'], [123, 456])]).toEqual([123])
  })
  it('tolerates unavailable or malformed session storage', () => {
    sessionStorage.setItem('bad', '{')
    expect(readSelection('bad').ids).toEqual([])
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(readSelection('blocked').ids).toEqual([])
    expect(() => writeSelection('blocked', [12], 200)).not.toThrow()
  })
})
