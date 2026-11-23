import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProcessingSettings, SearchUpdateHint } from '../components/processing-settings'

describe('search update instructions follow server configuration', () => {
  for (const automatic of [true, false]) {
    it(`shows the same ${automatic ? 'automatic' : 'manual'} mode in activity and editors`, () => {
      const render = (activity: boolean) =>
        renderToStaticMarkup(
          React.createElement(ProcessingSettings, {
            automaticSearch: automatic,
            // oxlint-disable-next-line react/no-children-prop -- createElement's types require the prop here
            children: React.createElement(
              'p',
              null,
              React.createElement(SearchUpdateHint, { activity }),
            ),
          }),
        )
      if (automatic) {
        expect(render(true)).toContain('update search automatically')
        expect(render(false)).toContain('queued for automatic AI search updates')
        expect(render(false)).not.toContain('Use Sync Search')
      } else {
        expect(render(true)).toContain('run on request')
        expect(render(false)).toContain('Use Sync Search in Activity')
        expect(render(false)).not.toContain('automatic AI search updates')
      }
    })
  }

  it('does not promise automatic work without server configuration', () => {
    expect(renderToStaticMarkup(React.createElement(SearchUpdateHint))).toContain('Use Sync Search')
  })
})
