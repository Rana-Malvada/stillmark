export type PreparationServiceState = {
  status: string
  pool: string
  diagnostics?: {
    activeNodes: number
    idleNodes: number
    targetNodes: number
    errorCode: string
    message: string
  }
  containers?: { status: string; message: string }[]
}
export function startupStatusMessage(state: PreparationServiceState) {
  const d = state.diagnostics
  const waiting = state.pool === 'STARTING' && (!d || d.activeNodes + d.idleNodes === 0)
  const phase = waiting
    ? 'Waiting for Snowflake to provision the GPU'
    : state.status === 'RUNNING'
      ? 'Worker started; waiting for its progress report'
      : 'Starting the video worker'
  const details = [
    `Pool: ${state.pool}; job: ${state.status}`,
    d ? `Nodes ready: ${d.activeNodes + d.idleNodes}/${d.targetNodes}` : null,
    d?.errorCode ? `Snowflake error ${d.errorCode}` : null,
    d?.message,
    ...(state.containers?.map((c) => [c.status, c.message].filter(Boolean).join(': ')) ?? []),
  ].filter(Boolean)
  return [phase, ...details].join('. ').slice(0, 3500)
}
