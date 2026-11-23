// Allocatable capacities verified with SHOW COMPUTE POOL INSTANCE FAMILIES on
// 2026-10-25 in this AWS account. Unknown families fail closed; verify before adding.
export const uploadNodeProfiles = Object.freeze({
  CPU_X64_XS: { cpu: 1, memoryGiB: 6 },
  CPU_X64_S: { cpu: 3, memoryGiB: 13 },
  CPU_X64_M: { cpu: 6, memoryGiB: 28 },
  CPU_X64_SL: { cpu: 14, memoryGiB: 58 },
  CPU_X64_L: { cpu: 28, memoryGiB: 116 },
})
export function uploadWorkerResources(family) {
  const node = uploadNodeProfiles[family]
  if (!node) throw Error(`Unsupported upload instance family: ${family}`)
  const memoryGiB = node.memoryGiB - (node.cpu === 1 ? 1 : 2)
  return {
    requests: { cpu: node.cpu, memory: `${memoryGiB - 1}Gi` },
    limits: { cpu: node.cpu, memory: `${memoryGiB}Gi` },
  }
}
