/**
 * Minimal stdio MCP bridge between Codex and the ontology HTTP tools.
 * Only explicitly allowed tools are advertised or executed; stdout is reserved for JSON-RPC.
 */
import { proposeBatchCancel, proposeBatchCancelInput, executeProposeBatchCancel } from '../manufacturing/proposeBatchCancel.ts'
import { proposeBatchDeferStart, proposeBatchDeferStartInput, executeProposeBatchDeferStart } from '../manufacturing/proposeBatchDeferStart.ts'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { batchDeferStart, batchDeferStartInput, executeBatchDeferStart } from '../manufacturing/batchDeferStart.ts'
import { batchFlag, batchFlagInput, executeBatchFlag } from '../manufacturing/batchFlag.ts'
import { batchPlaceOnHold, batchPlaceOnHoldInput, executeBatchPlaceOnHold } from '../manufacturing/batchPlaceOnHold.ts'
import { proposeBatchExtendRest, proposeBatchExtendRestInput, executeProposeBatchExtendRest } from '../manufacturing/proposeBatchExtendRest.ts'
import { proposeBatchScheduleEarlyTransfer, proposeBatchScheduleEarlyTransferInput, executeProposeBatchScheduleEarlyTransfer } from '../manufacturing/proposeBatchScheduleEarlyTransfer.ts'
import { tankScheduleMaintenance, tankScheduleMaintenanceInput, executeTankScheduleMaintenance } from '../manufacturing/tankScheduleMaintenance.ts'
import { executeGetObject, getObjectInput } from './getObject.ts'
import { executeQueryObjects, queryObjectsInput } from './queryObjects.ts'
import { proposalApprove, proposalApproveInput, executeProposalApprove } from '../manufacturing/proposalApprove.ts'
import { proposalReject, proposalRejectInput, executeProposalReject } from '../manufacturing/proposalReject.ts'
import { proposalEscalate, proposalEscalateInput, executeProposalEscalate } from '../manufacturing/proposalEscalate.ts'

type JsonRpcRequest = {
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

// MCP-visible JSON schemas mirror the executor contracts; each call is still parsed locally.
const queryObjectsSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', description: "The object type's API name, for example batch." },
    filters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          property: { type: 'string' },
          op: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'isNull', 'isNotNull'] },
          value: {},
        },
        required: ['property', 'op'],
      },
    },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  },
  required: ['type'],
} as const

const getObjectSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', description: "The object type's API name, for example batch." },
    id: { type: 'string', description: "The object's primary-key value, for example B-2105." },
  },
  required: ['type', 'id'],
} as const

// Catalog of supported tools, later filtered by the run-specific allowlist.
const allTools = [
  { name: proposalApprove.name, description: proposalApprove.description, inputSchema: z.toJSONSchema(proposalApproveInput) },
  { name: proposalReject.name, description: proposalReject.description, inputSchema: z.toJSONSchema(proposalRejectInput) },
  { name: proposalEscalate.name, description: proposalEscalate.description, inputSchema: z.toJSONSchema(proposalEscalateInput) },
  { name: batchPlaceOnHold.name, description: batchPlaceOnHold.description, inputSchema: z.toJSONSchema(batchPlaceOnHoldInput) },
  { name: proposeBatchExtendRest.name, description: proposeBatchExtendRest.description, inputSchema: z.toJSONSchema(proposeBatchExtendRestInput) },
  { name: proposeBatchScheduleEarlyTransfer.name, description: proposeBatchScheduleEarlyTransfer.description, inputSchema: z.toJSONSchema(proposeBatchScheduleEarlyTransferInput) },
  {
    name: batchFlag.name,
    description: batchFlag.description,
    inputSchema: z.toJSONSchema(batchFlagInput),
  },
  {
    name: proposeBatchDeferStart.name,
    description: proposeBatchDeferStart.description,
    inputSchema: z.toJSONSchema(proposeBatchDeferStartInput),
  },
  {
    name: proposeBatchCancel.name,
    description: proposeBatchCancel.description,
    inputSchema: z.toJSONSchema(proposeBatchCancelInput),
  },
  {
    name: batchDeferStart.name,
    description: batchDeferStart.description,
    inputSchema: z.toJSONSchema(batchDeferStartInput),
  },
  {
    name: tankScheduleMaintenance.name,
    description: tankScheduleMaintenance.description,
    inputSchema: z.toJSONSchema(tankScheduleMaintenanceInput),
  },
  {
    name: 'query_objects',
    description: 'Query instances of an ontology object type using metadata-backed property filters.',
    inputSchema: queryObjectsSchema,
  },
  {
    name: 'get_object',
    description: 'Get one ontology object instance and its resolved links by type and primary-key ID.',
    inputSchema: getObjectSchema,
  },
] as const

/** Invalid or missing configuration grants no tools; the runtime must opt in by name. */
function allowedToolNames(): Set<string> {
  try {
    const configured = JSON.parse(process.env.ONTOLOGY_ALLOWED_TOOLS ?? '[]')
    return new Set(Array.isArray(configured) ? configured.filter((name): name is string => typeof name === 'string') : [])
  } catch {
    return new Set()
  }
}

const allowedTools = allowedToolNames()

/** JSON-RPC notifications have no ID and therefore receive no response. */
function send(id: JsonRpcRequest['id'], result: unknown) {
  if (id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }
}

/** Return protocol errors without mixing debug logs into stdout. */
function sendError(id: JsonRpcRequest['id'], code: number, message: string) {
  if (id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
  }
}

/** Dispatch MCP initialization, discovery, and calls; executable access is checked again per call. */
async function handle(request: JsonRpcRequest) {
  switch (request.method) {
    case 'initialize':
      send(request.id, {
        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ontology-query', version: '0.0.0' },
      })
      return
    // Discovery and execution use the same restriction so disabled tools cannot be invoked by guessing a name.
    case 'tools/list':
      send(request.id, {
        tools: allTools.filter((tool) => allowedTools.has(tool.name)),
      })
      return
    case 'tools/call': {
      const params = request.params ?? {}
      const name = String(params.name)
      if (!allowedTools.has(name)) {
        sendError(request.id, -32601, `Tool is not enabled for this agent: ${name}`)
        return
      }
      const result = await callTool(name, params.arguments, request.id)
      if (result === undefined) return
      send(request.id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      })
      return
    }
    default:
      if (request.id !== undefined) sendError(request.id, -32601, `Unknown method: ${request.method}`)
  }
}

/** Map protocol names to typed HTTP executors, returning -32602 for invalid arguments. */
async function callTool(name: string, arguments_: unknown, id: JsonRpcRequest['id']) {
  // Decisions execute directly; only approval invokes the stored business action.
  if (name === 'proposal_approve') {
    const parsed = proposalApproveInput.safeParse(arguments_)
    if (!parsed.success) { sendError(id, -32602, parsed.error.message); return undefined }
    return executeProposalApprove(parsed.data)
  }
  if (name === 'proposal_reject') {
    const parsed = proposalRejectInput.safeParse(arguments_)
    if (!parsed.success) { sendError(id, -32602, parsed.error.message); return undefined }
    return executeProposalReject(parsed.data)
  }
  if (name === 'proposal_escalate') {
    const parsed = proposalEscalateInput.safeParse(arguments_)
    if (!parsed.success) { sendError(id, -32602, parsed.error.message); return undefined }
    return executeProposalEscalate(parsed.data)
  }

  // Only the hold executes immediately; medium intervention tools persist pending proposals.
  if (name === 'batch_place_on_hold') {
    const parsed = batchPlaceOnHoldInput.safeParse(arguments_)
    if (!parsed.success) { sendError(id, -32602, parsed.error.message); return undefined }
    return executeBatchPlaceOnHold(parsed.data)
  }
  if (name === 'propose_batch_extend_rest') {
    const parsed = proposeBatchExtendRestInput.safeParse(arguments_)
    if (!parsed.success) { sendError(id, -32602, parsed.error.message); return undefined }
    return executeProposeBatchExtendRest(parsed.data)
  }
  if (name === 'propose_batch_schedule_early_transfer') {
    const parsed = proposeBatchScheduleEarlyTransferInput.safeParse(arguments_)
    if (!parsed.success) { sendError(id, -32602, parsed.error.message); return undefined }
    return executeProposeBatchScheduleEarlyTransfer(parsed.data)
  }

  // Flag creation runs through the ontology action, including its validation and audit transaction.
  if (name === 'batch_flag') {
    const parsed = batchFlagInput.safeParse(arguments_)
    if (!parsed.success) {
      sendError(id, -32602, parsed.error.message)
      return undefined
    }
    return executeBatchFlag(parsed.data)
  }

  // Proposal tools persist requests; the approval action controls execution separately.
  if (name === 'propose_batch_cancel') {
    const parsed = proposeBatchCancelInput.safeParse(arguments_)
    if (!parsed.success) {
      sendError(id, -32602, parsed.error.message)
      return undefined
    }
    return executeProposeBatchCancel(parsed.data)
  }

  // Proposal tools persist requests; the approval action controls execution separately.
  if (name === 'propose_batch_defer_start') {
    const parsed = proposeBatchDeferStartInput.safeParse(arguments_)
    if (!parsed.success) {
      sendError(id, -32602, parsed.error.message)
      return undefined
    }
    return executeProposeBatchDeferStart(parsed.data)
  }

  if (name === 'batch_defer_start') {
    const parsed = batchDeferStartInput.safeParse(arguments_)
    if (!parsed.success) {
      sendError(id, -32602, parsed.error.message)
      return undefined
    }
    return executeBatchDeferStart(parsed.data)
  }

  if (name === 'tank_schedule_maintenance') {
    const parsed = tankScheduleMaintenanceInput.safeParse(arguments_)
    if (!parsed.success) {
      sendError(id, -32602, parsed.error.message)
      return undefined
    }
    return executeTankScheduleMaintenance(parsed.data)
  }

  if (name === 'query_objects') {
    const parsed = queryObjectsInput.safeParse(arguments_)
    if (!parsed.success) {
      sendError(id, -32602, parsed.error.message)
      return undefined
    }
    return executeQueryObjects(parsed.data)
  }

  if (name === 'get_object') {
    const parsed = getObjectInput.safeParse(arguments_)
    if (!parsed.success) {
      sendError(id, -32602, parsed.error.message)
      return undefined
    }
    return executeGetObject(parsed.data)
  }

  sendError(id, -32601, `Unknown tool: ${name}`)
  return undefined
}

// MCP stdio transport is newline-delimited JSON; request IDs correlate asynchronous responses.
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  try {
    const request = JSON.parse(line) as JsonRpcRequest
    void handle(request).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Tool execution failed'
      sendError(request.id, -32603, message)
    })
  } catch {
    // JSON-RPC parse errors cannot be tied to a request id.
  }
})
