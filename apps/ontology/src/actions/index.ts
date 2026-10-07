/**
 * Executable action registry. Keys are case-sensitive object API name + action API name.
 * Each implementation also needs its action_type metadata row to be reachable over HTTP.
 */
import { createProposalApprove } from './shared/proposalApprove.ts'
import { proposalReject } from './shared/proposalReject.ts'
import { proposalEscalate } from './shared/proposalEscalate.ts'
import { batchDeferStart } from './manufacturing/batchDeferStart.ts'
import { batchFlag } from './manufacturing/batchFlag.ts'
import { batchCancel } from './manufacturing/batchCancel.ts'
import { batchPlaceOnHold } from './manufacturing/batchPlaceOnHold.ts'
import { batchExtendRest } from './manufacturing/batchExtendRest.ts'
import { batchScheduleEarlyTransfer } from './manufacturing/batchScheduleEarlyTransfer.ts'
import { tankScheduleMaintenance } from './manufacturing/tankScheduleMaintenance.ts'
import { defineActionHandler, type ActionHandler } from './types.ts'

export const actionHandlers: Record<string, ActionHandler> = {
  'batch.deferStart': defineActionHandler(batchDeferStart),
  'batch.flag': defineActionHandler(batchFlag),
  'batch.cancel': defineActionHandler(batchCancel),
  'batch.placeOnHold': defineActionHandler(batchPlaceOnHold),
  'batch.extendRest': defineActionHandler(batchExtendRest),
  'batch.scheduleEarlyTransfer': defineActionHandler(batchScheduleEarlyTransfer),
  'tank.scheduleMaintenance': defineActionHandler(tankScheduleMaintenance),
}

// Inject the same registry object after initialization so approval can dispatch any registered action.
actionHandlers['proposal.approve'] = defineActionHandler(createProposalApprove(actionHandlers))
actionHandlers['proposal.reject'] = defineActionHandler(proposalReject)
actionHandlers['proposal.escalate'] = defineActionHandler(proposalEscalate)
