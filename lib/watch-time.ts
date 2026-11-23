/** Wall-clock watch time. Seeking, buffering, background tabs and suspended devices do not count. */
export function watchedSeconds(
  elapsed: number,
  mediaDelta: number,
  rate: number,
  playing: boolean,
) {
  if (
    !playing ||
    elapsed <= 0 ||
    elapsed > 2 ||
    mediaDelta <= 0 ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    mediaDelta > elapsed * rate + 1
  )
    return 0
  return Math.min(elapsed, mediaDelta / rate)
}
