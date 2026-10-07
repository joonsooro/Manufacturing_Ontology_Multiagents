/**
 * Transaction and audit helpers used by standalone actions and proposal-triggered actions.
 * Reusing the outer transaction is what makes approval atomic across both handlers.
 */
import type { Transaction } from 'kysely'
import type { Database } from '../../schema.ts'
import type { ActionContext } from '../types.ts'

/** Inner actions join the approval transaction instead of committing independently. */
export function withActionTransaction<T>(
  context: ActionContext,
  run: (transaction: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (context.database.isTransaction) {
    // Do not start a nested Kysely transaction: approval must own the final commit or rollback.
    return run(context.database as Transaction<Database>)
  }
  // A direct HTTP action has no outer transaction, so this helper creates one.
  return context.database.transaction().execute(run)
}

/** Authorization belongs in the audit envelope, never in action-specific inputs. */
export function auditParams(context: ActionContext, params: Record<string, import('../../schema.ts').JsonValue>) {
  return context.authorizedByProposal === undefined
    ? params
    : { ...params, authorizedByProposal: context.authorizedByProposal }
}
