/** Retain token-specific pools while useful, without retaining idle sessions forever. */
export class CallerPoolCache<P extends { borrowed: number; pending: number }> {
  private entries = new Map<string, { pool: P; touched: number }>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private retire: (pool: P) => void,
    private idleMs = 120_000,
    private maxIdle = 512,
  ) {
    if (idleMs <= 0 || !Number.isFinite(idleMs) || !Number.isInteger(maxIdle) || maxIdle < 1)
      throw new Error('Invalid caller pool retention')
  }

  get size() {
    return this.entries.size
  }
  has(key: string) {
    return this.entries.has(key)
  }
  *values() {
    for (const entry of this.entries.values()) yield entry.pool
  }

  getOrCreate(key: string, create: () => P): P {
    const existing = this.entries.get(key)
    const pool = existing?.pool ?? create()
    // Insertion order is least recently used first. Never retire the pool being acquired.
    this.entries.delete(key)
    this.entries.set(key, { pool, touched: Date.now() })
    if (!this.timer) {
      this.timer = setInterval(() => this.sweep(), Math.min(this.idleMs, 30_000))
      this.timer.unref?.()
    }
    this.sweep(key)
    return pool
  }

  private sweep(protectedKey?: string) {
    const now = Date.now()
    // Do not allocate a full entry array plus a filtered array on every lookup.
    // Pools can change borrowed/pending state between calls, so count live state.
    let idleCount = 0
    for (const [key, { pool }] of this.entries) {
      if (key !== protectedKey && pool.borrowed === 0 && pool.pending === 0) idleCount++
    }
    let excess = Math.max(0, idleCount - this.maxIdle)
    for (const [key, entry] of this.entries) {
      if (key === protectedKey || entry.pool.borrowed !== 0 || entry.pool.pending !== 0) continue
      if (now - entry.touched < this.idleMs && excess <= 0) continue
      this.entries.delete(key)
      excess--
      this.retire(entry.pool)
    }
    if (!this.entries.size) this.stopTimer()
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  // Callers explicitly drain/clear the returned pools during token rotation or shutdown.
  clear() {
    this.entries.clear()
    this.stopTimer()
  }
}
