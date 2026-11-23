import { pgQuery } from '../postgres'

/**
 * Catalog changes that move, delete or re-own photos and albums serialize on one
 * transaction-scoped advisory lock, so two of them cannot interleave. Call inside a
 * transaction; the lock is released at commit or rollback.
 */
export async function lockManagement(): Promise<void> {
  await pgQuery("SELECT pg_advisory_xact_lock(hashtextextended('photo-management',0))")
}

/** Shared form: many holders may proceed together, but not alongside an exclusive holder. */
export async function lockManagementShared(): Promise<void> {
  await pgQuery("SELECT pg_advisory_xact_lock_shared(hashtextextended('photo-management',0))")
}
