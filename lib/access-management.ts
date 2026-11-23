// Stable route/API surface; policy, commands and journal remain separate internally.
export {
  ACCESS_MANAGER_ROLE,
  BASE_ROLES,
  accessRequest,
  operationId,
} from './access-management/contracts'
export type { AccessRequest } from './access-management/contracts'
export { runAccessOperation } from './access-management/operations'
export { accessOverview } from './access-management/overview'
