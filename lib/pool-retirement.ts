/** Drain stops new work but does not destroy idle SDK connections. */
export async function retireConnectionPool(pool: {
  drain(): Promise<unknown>
  clear(): Promise<unknown>
}): Promise<void> {
  await pool.drain()
  await pool.clear()
}
