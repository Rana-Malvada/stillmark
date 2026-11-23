/** One scheduler per replica, independent of how many media-processing slots it has.
 * Claims stay bounded separately from processing; empty queues use one poll per tick. */
export function startUploadDispatcher(options: {
  slots: number
  maxClaims?: number
  runOne: (claimed: () => void) => Promise<void>
  onError: (error: unknown) => void
  idleDelayMs: () => number
  startDelayMs?: number
}) {
  const maxClaims = options.maxClaims ?? 2
  if (
    !Number.isSafeInteger(options.slots) ||
    options.slots < 1 ||
    !Number.isSafeInteger(maxClaims) ||
    maxClaims < 1
  )
    throw Error('Invalid upload dispatcher capacity')
  let stopped = false
  let inFlight = 0
  let claiming = 0
  let claimBudget = 1
  let pollAfter = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (delay = 0) => {
    if (stopped || timer) return
    timer = setTimeout(pump, Math.max(delay, pollAfter - Date.now(), 0))
    timer.unref()
  }
  const launch = () => {
    inFlight++
    claiming++
    let claimed = false
    // Promise boundary also catches a synchronous admission failure.
    void Promise.resolve()
      .then(() =>
        options.runOne(() => {
          if (claimed) return
          claimed = true
          claiming--
          claimBudget = maxClaims
          schedule()
        }),
      )
      .catch((error) => {
        options.onError(error)
      })
      .finally(() => {
        inFlight--
        if (!claimed) {
          claiming--
          claimBudget = 1
          pollAfter = Date.now() + options.idleDelayMs()
        }
        schedule()
      })
  }
  function pump() {
    timer = undefined
    if (stopped) return
    if (Date.now() < pollAfter) {
      schedule()
      return
    }
    while (inFlight < options.slots && claiming < claimBudget) launch()
  }
  schedule(options.startDelayMs ?? 0)
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      // Already-issued claims and jobs retain their reservation and finish normally.
    },
  }
}
