import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { startupStatusMessage } from '@/lib/video/video-startup-status'

const sql = readFileSync('setup/75-video-startup-diagnostics.sql', 'utf8')
const bodies = [...sql.matchAll(/AS \$\$([\s\S]*?)\$\$;/g)].map((m) => m[1])
function evaluate(body: string, rows: (q: string) => Record<string, unknown>[]) {
  const calls: string[] = []
  const result = runInNewContext('(function(){' + body + '})()', {
    RUN_ID: 'b36f5954-33a9-41da-aa11-4659af617e80',
    ACTION: 'STATUS',
    snowflake: {
      createStatement: ({ sqlText }: { sqlText: string }) => ({
        execute: () => {
          calls.push(sqlText)
          const data = rows(sqlText)
          let i = -1
          return {
            next: () => ++i < data.length,
            getColumnValue: (k: string | number) =>
              typeof k === 'number' ? Object.values(data[i])[k - 1] : data[i][k],
          }
        },
      }),
    },
  })
  return { result, calls }
}
it('collects pool provisioning errors without resuming or creating jobs', () => {
  const { result, calls } = evaluate(bodies[1], (q) =>
    q.startsWith('DESCRIBE')
      ? [
          {
            state: 'STARTING',
            active_nodes: 0,
            idle_nodes: 0,
            target_nodes: 1,
            error_code: '392507',
            status_message: 'CAPACITY_ERROR',
          },
        ]
      : [{ result: { status: 'PENDING' } }],
  )
  expect(result.diagnostics.errorCode).toBe('392507')
  expect(startupStatusMessage(result)).toContain('Waiting for Snowflake to provision')
  expect(calls).toHaveLength(2)
  expect(calls.some((q) => /RESUME|EXECUTE JOB/.test(q))).toBe(false)
})
it('collects bounded container status for an existing pending job', () => {
  const { result } = evaluate(bodies[0], (q) =>
    q.startsWith('SHOW')
      ? [{ name: 'VIDEO_PREP_B36F595433A941DAAA114659AF617E80', status: 'PENDING' }]
      : [{ status: JSON.stringify([{ status: 'PENDING', message: 'Pulling image' }]) }],
  )
  expect(result.containers).toEqual([{ status: 'PENDING', message: 'Pulling image' }])
  expect(startupStatusMessage({ ...result, pool: 'ACTIVE' })).toContain('Pulling image')
})
