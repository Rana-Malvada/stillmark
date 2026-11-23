import { BASE_PATH, BOUNDARY, PLAN, PREFIX, SUFFIX } from './http3-upload-probe-plan.mjs'

export const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Isolated upload probe</title>
<style>body{font:16px system-ui;max-width:1000px;margin:24px auto;padding:12px}button,input{font:inherit;padding:8px;margin:6px}textarea{width:100%;height:420px;font:12px monospace}label{display:block}</style>
<h1>Isolated upload transport probe</h1>
<p>Synthetic memory only. No files, accounts, upstream service, or database. Twenty uploads across both protocol lanes; no retries. Keep this page open for each lane.</p>
<p>Protocol must match the selected lane. Connection reuse is unknown; this test cannot identify the cause of the original production failure by itself.</p>
<label>Temporary probe token <input id="token" type="password" autocomplete="off" spellcheck="false"></label>
<button id="check">Check connection</button><button id="h2">Run H2 lane</button><button id="h3">Run H3 lane</button><button id="stop">Stop</button>
<p id="status" role="status">Waiting. The token stays in memory and is never included in results.</p>
<label>Probe results<textarea id="results" readonly></textarea></label>
<script src="${BASE_PATH}/client.js"></script></html>`

// Keep browser code as source text: keepNames bundlers add closure-level helpers
// to function bodies, which function.toString() would serialize without them.
const BROWSER_CLIENT = String.raw`(() => {
  const output = document.getElementById('results')
  const status = document.getElementById('status')
  const tokenInput = document.getElementById('token')
  const buttons = ['check', 'h2', 'h3'].map((id) => document.getElementById(id))
  const results = []
  const used = new Set()
  const active = new Set()
  let running = false
  let stopped = false
  let token = ''
  window.__uploadProbeResults = results
  const record = (value) => {
    results.push(value)
    output.value = results.map((item) => JSON.stringify(item)).join('\n')
  }
  function lock(value) {
    running = value
    for (const button of buttons) button.disabled = value
  }
  function credential() {
    const entered = tokenInput.value.trim()
    if (entered) {
      token = entered
      tokenInput.value = ''
    }
    if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Enter the temporary probe token.')
    return token
  }
  async function check() {
    const response = await fetch(BASE_PATH + '/status', {
      headers: { Authorization: 'Bearer ' + credential() },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw Error('Probe unavailable, expired, or token rejected.')
    const info = await response.json()
    record({
      kind: 'connection',
      protocol: info.protocol,
      colo: info.colo,
      remainingMs: info.remainingMs,
    })
    return info
  }
  function send(item) {
    used.add(item.slot)
    const data = new Uint8Array(item.payloadBytes)
    for (let i = 0; i < data.length; i++) data[i] = i % 251
    const multipart = item.format === 'multipart'
    const body = new Blob(multipart ? [PREFIX, data, SUFFIX] : [data], {
      type: multipart ? 'multipart/form-data; boundary=' + BOUNDARY : 'application/octet-stream',
    })
    if (body.size !== item.wireBytes) throw Error('Synthetic body size mismatch.')
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      const start = performance.now()
      let firstProgressMs = null
      let lastProgressMs = null
      let loaded = 0
      let progressEvents = 0
      const url = BASE_PATH + '/upload/' + item.slot
      xhr.open('POST', url)
      xhr.timeout = 25000
      xhr.setRequestHeader('Authorization', 'Bearer ' + token)
      xhr.upload.onprogress = (event) => {
        if (event.loaded <= loaded) return
        loaded = event.loaded
        firstProgressMs ??= Math.round(performance.now() - start)
        lastProgressMs = Math.round(performance.now() - start)
        progressEvents++
      }
      let outcome = 'response'
      xhr.onerror = () => {
        outcome = 'network_error'
      }
      xhr.ontimeout = () => {
        outcome = 'client_timeout'
      }
      xhr.onabort = () => {
        outcome = 'client_abort'
      }
      xhr.onloadend = () => {
        clearTimeout(abortTimer)
        active.delete(xhr)
        let response = null
        try {
          response = JSON.parse(xhr.responseText)
        } catch {
          /* No raw body retained. */
        }
        const timing = performance.getEntriesByName(new URL(url, location.origin).href).at(-1)
        const browserProtocol = ['h2', 'h3', 'http/1.1'].includes(timing?.nextHopProtocol)
          ? timing.nextHopProtocol
          : 'unknown'
        const server = response?.event === 'upload_probe_result' ? response : null
        const rayHeader = xhr.getResponseHeader('cf-ray') ?? ''
        const edgeRay = /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(rayHeader) ? rayHeader : null
        const protocolMatch = server?.protocol === item.lane && browserProtocol === item.lane
        const expectedStatus = item.mode === 'reject' ? 413 : 200
        const expectedAbort = item.mode === 'abort' && outcome === 'client_abort'
        const passed =
          item.mode === 'abort'
            ? null
            : protocolMatch &&
              xhr.status === expectedStatus &&
              server?.reason === (item.mode === 'reject' ? 'deliberate_reject' : 'complete') &&
              server?.bytes === (item.mode === 'reject' ? 0 : body.size)
        record({
          slot: item.slot,
          lane: item.lane,
          mode: item.mode,
          format: item.format,
          sentBytes: body.size,
          status: xhr.status,
          outcome,
          edgeRay,
          elapsedMs: Math.round(performance.now() - start),
          loaded,
          progressEvents,
          firstProgressMs,
          lastProgressMs,
          browserProtocol,
          protocolMatch,
          passed,
          expectedAbort,
          connectionReuse: 'unknown',
          server,
        })
        resolve(passed || expectedAbort)
      }
      active.add(xhr)
      const abortTimer = item.mode === 'abort' ? setTimeout(() => xhr.abort(), 100) : undefined
      xhr.send(body)
    })
  }
  async function run(lane) {
    if (running) return
    lock(true)
    stopped = false
    try {
      const info = await check()
      if (info.protocol !== lane)
        throw Error('Actual connection protocol does not match selected lane.')
      const plan = PLAN.filter((item) => item.lane === lane)
      if (plan.some((item) => used.has(item.slot)))
        throw Error('This lane has already started. No automatic replay.')
      const start = performance.now()
      for (let i = 0; i < plan.length;) {
        if (stopped || performance.now() - start >= 160000) break
        const group = i === 4 ? plan.slice(4, 8) : [plan[i]]
        status.textContent = 'Running ' + lane + ': ' + group.map((item) => item.slot).join(', ')
        const passed = await Promise.all(group.map(send))
        i += group.length
        if (passed.some((value) => !value)) {
          status.textContent = 'Stopped after a failure or protocol mismatch. No retries.'
          return
        }
      }
      status.textContent = stopped
        ? 'Stopped by operator.'
        : 'Lane finished. Results are measurements, not a root-cause conclusion.'
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Probe failed.'
    } finally {
      lock(false)
    }
  }
  document.getElementById('check').onclick = async () => {
    if (running) return
    lock(true)
    try {
      await check()
      status.textContent = 'Connection checked.'
    } catch {
      status.textContent = 'Probe unavailable, expired, or token rejected.'
    } finally {
      lock(false)
    }
  }
  document.getElementById('h2').onclick = () => run('h2')
  document.getElementById('h3').onclick = () => run('h3')
  document.getElementById('stop').onclick = () => {
    stopped = true
    for (const xhr of active) xhr.abort()
    status.textContent = 'Stopped by operator.'
  }
})();`

export const CLIENT = `const BASE_PATH=${JSON.stringify(BASE_PATH)},BOUNDARY=${JSON.stringify(BOUNDARY)},PREFIX=${JSON.stringify(PREFIX)},SUFFIX=${JSON.stringify(SUFFIX)},PLAN=${JSON.stringify(PLAN)};${BROWSER_CLIENT}`
