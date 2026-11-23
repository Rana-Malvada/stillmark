import { spawn } from 'node:child_process'

// Test-image-only supervisor. Never copied into the production worker image.
if (
  process.env.PG_DATABASE !== 'stillmark_loadtest_baseline' ||
  process.env.SNOWFLAKE_DATABASE !== 'STILLMARK_LOADTEST_BASELINE' ||
  process.env.UPLOAD_QUEUE_DIAGNOSTICS !== 'true' ||
  process.env.LOAD_TEST_CRASH_ONCE !== 'true'
)
  throw Error('Isolated crash test only')
let crashed = false
let stopping = false
let child
function launch() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: '/app',
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let pending = ''
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    pending += chunk.toString()
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const line of lines) {
      if (crashed || !line.startsWith('[upload-queue-test] ')) continue
      let event
      try {
        event = JSON.parse(line.slice('[upload-queue-test] '.length))
      } catch {
        continue
      }
      if (event.event !== 'claimed') continue
      crashed = true
      child.kill('SIGSTOP')
      console.log(
        JSON.stringify({
          fault: 'SIGKILL_AFTER_CLAIM',
          uploadId: event.uploadId,
          at: new Date().toISOString(),
        }),
      )
      child.kill('SIGKILL')
    }
  })
  child.on('exit', (code, signal) => {
    console.log(JSON.stringify({ workerExit: true, code, signal }))
    if (!stopping && crashed && signal === 'SIGKILL') setTimeout(launch, 1000)
    else process.exit(code ?? 1)
  })
}
process.on('SIGTERM', () => {
  stopping = true
  child?.kill('SIGTERM')
})
launch()
