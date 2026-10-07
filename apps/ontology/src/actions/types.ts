/**
 * Shared contract between HTTP dispatch, domain actions, and proposal decisions.
 * Context carries execution/audit information separately from business parameters.
 */
import type { Kysely } from 'kysely'
import type { Database } from '../schema.ts'

export type ActionContext = {
  /** Root query builder for standalone calls, or the active transaction for inner calls. */
  database: Kysely<Database>
  /** Catalog schema used for object/action lookup and audit writes. */
  metadataSchema: string
  // UUIDs below identify metadata rows; API names identify public types and registry keys.
  objectTypeId: string
  objectTypeApiName: string
  actionTypeId: string
  actionApiName: string
  /** Legacy actor field retained for existing handlers. */
  actor: string
  /** Explicit caller attribution; proposal execution supplies the approving user here. */
  callerIdentity?: string
  /** Added only to audit params; it must not become a business-action input. */
  authorizedByProposal?: number
}

/** Uniform registry signature; individual handlers retain their specific instance/param types. */
export type ActionHandler = (
  instance: Record<string, unknown>,
  params: unknown | undefined,
  context: ActionContext,
) => Promise<Record<string, unknown>>

/** Adapt typed domain handlers after HTTP/proposal validation has checked runtime inputs. */
export function defineActionHandler<TInstance, TParams, TResult>(
  handler: (instance: TInstance, params: TParams | undefined, context: ActionContext) => Promise<TResult>,
): ActionHandler {
  return async (instance, params, context) =>
    handler(instance as TInstance, params as TParams, context) as Promise<Record<string, unknown>>
}
