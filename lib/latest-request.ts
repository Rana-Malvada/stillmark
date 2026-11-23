/** Abort superseded work and prevent late responses from committing state. */
export function latestRequest() {
  let active: AbortController | undefined
  return {
    begin() {
      active?.abort()
      const controller = new AbortController()
      active = controller
      return {
        signal: controller.signal,
        current: () => active === controller && !controller.signal.aborted,
      }
    },
    cancel() {
      active?.abort()
      active = undefined
    },
  }
}
