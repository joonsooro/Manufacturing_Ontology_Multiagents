/**
 * Agent execution coordinator: restrict ontology tools, load current metadata, run Codex,
 * stream events to a local viewer, and collect optional Langfuse traces.
 * Each run owns its temporary Codex home and cleans up resources on success or failure.
 */
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Codex } from '@openai/codex-sdk'
import { buildSchemaBlock } from './helpers/buildSchemaBlock.ts'
import { createAgentRunTrace, langfuseBaseUrl } from './helpers/agentTracing.ts'
import { eventViewerScript } from './helpers/eventViewer.ts'

const PORT = 3455
// Registry names accepted by this runtime; selecting tools for a run narrows this list further.
const ONTOLOGY_TOOL_NAMES = new Set(['query_objects', 'get_object', 'batch_flag', 'batch_place_on_hold', 'propose_batch_extend_rest', 'propose_batch_schedule_early_transfer', 'proposal_approve', 'proposal_reject', 'proposal_escalate', 'batch_defer_start', 'tank_schedule_maintenance', 'propose_batch_cancel', 'propose_batch_defer_start'])

export type AgentTool = { name: string }

type CodexThreadOptions = NonNullable<Parameters<Codex['startThread']>[0]>

/** Expose only model/reasoning/source choices; the runtime controls tool and sandbox setup. */
export type RunAgentOptions = Pick<
  CodexThreadOptions,
  'model' | 'modelReasoningEffort' | 'threadSource'
>

export type RunAgentInput = {
  /** Passed to ontology requests and tracing so runs remain attributable. */
  identity: string
  /** Application-owned instructions included in the turn text alongside schema context. */
  systemPrompt?: string
  prompt: string
  /** The ontology MCP tools this agent is permitted to use. */
  tools: readonly AgentTool[]
  options?: RunAgentOptions
}

export type AgentRunResult = {
  finalResponse: string
  threadId: string | null
  traceId?: string
}

/** Simplified events shared by the local server and browser viewer. */
type AgentEvent = {
  type: 'status' | 'tool-call' | 'tool-result' | 'assistant' | 'final' | 'error'
  at: string
  payload: unknown
}

type SseClient = { write: (chunk: string) => boolean; end: () => void }

// Self-contained viewer HTML. Its EventSource script is maintained separately in helpers/eventViewer.ts.
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ontology agent</title><style>
:root{font-family:ui-sans-serif,system-ui,sans-serif;color:#182026;background:#f5f8fa}body{margin:0}.bar{padding:18px 28px;background:#30404d;color:#fff}.bar p{margin:4px 0 0;color:#bfccd6}.feed{max-width:960px;margin:24px auto;padding:0 20px}.event{background:#fff;border:1px solid #d8e1e8;border-radius:6px;margin:10px 0;padding:14px 16px;box-shadow:0 1px 2px #18202612}.meta{font-size:12px;color:#738694;text-transform:uppercase;letter-spacing:.04em}.assistant{border-left:4px solid #2d72d2}.tool-call{border-left:4px solid #d9822b}.tool-result{border-left:4px solid #0f9960}.final{border-left:4px solid #137cbd}pre{white-space:pre-wrap;word-break:break-word;margin:8px 0 0;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#394b59}#empty{color:#738694;text-align:center;padding:48px}</style></head>
<body><header class="bar"><strong>Ontology agent run</strong><p id="connection">Connecting to the agent…</p></header><main class="feed"><div id="empty">Waiting for agent events…</div><section id="events"></section></main>
<script>${eventViewerScript}</script></body></html>`

/** Escape values used in Codex configuration override strings. */
function toml(value: unknown): string {
  return JSON.stringify(value)
}

/** Keep metadata loading and tools pointed at the same ontology HTTP server. */
function ontologyBaseUrl(): string {
  return (process.env.ONTOLOGY_URL ?? process.env.HONO_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

/** Optional Codex-process OTLP export config; app-level spans are created separately by AgentRunTrace. */
function langfuseConfig(identity: string): { overrides: string[]; env: Record<string, string> } {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  // The Codex subprocess inherits defined env values; avoid serializing undefined values into its environment.
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const resourceAttributes = [
    inheritedEnv.OTEL_RESOURCE_ATTRIBUTES,
    `service.name=ontology-agent`,
    `langfuse.trace.name=${identity}`,
  ].filter(Boolean).join(',')

  if (!publicKey || !secretKey) {
    return { overrides: [], env: { ...inheritedEnv, OTEL_RESOURCE_ATTRIBUTES: resourceAttributes } }
  }

  const host = langfuseBaseUrl()
  const endpoint = process.env.LANGFUSE_OTLP_ENDPOINT ?? `${host}/api/public/otel/v1/traces`
  // Pass the telemetry credential to configuration without logging it.
  const authorization = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`

  return {
    env: { ...inheritedEnv, OTEL_RESOURCE_ATTRIBUTES: resourceAttributes },
    overrides: [
      `otel.environment=${toml(process.env.LANGFUSE_ENVIRONMENT ?? 'development')}`,
      'otel.trace_exporter="otlp-http"',
      `otel.trace_exporter.otlp-http.endpoint=${toml(endpoint)}`,
      `otel.trace_exporter.otlp-http.headers={Authorization=${toml(authorization)}}`,
      'otel.trace_exporter.otlp-http.protocol="json"',
    ],
  }
}

/** Fail early on unsupported names and deduplicate the requested run-specific tool set. */
function allowedToolNames(tools: readonly AgentTool[]): string[] {
  const names = [...new Set(tools.map((tool) => tool.name))]
  if (!names.length) throw new Error('runAgent requires at least one ontology tool')

  const unsupported = names.filter((name) => !ONTOLOGY_TOOL_NAMES.has(name))
  if (unsupported.length) {
    throw new Error(`Unsupported ontology tool(s): ${unsupported.join(', ')}`)
  }

  return names
}

/** Configure one stdio MCP subprocess, with the caller identity and tool allowlist in its environment. */
function ontologyMcpServer(identity: string, ontologyUrl: string, allowedTools: string[]) {
  const mcpPath = fileURLToPath(new URL('./tools/shared/queryObjectsMcp.ts', import.meta.url))
  const server = {
    command: process.execPath,
    args: [mcpPath],
    env: {
      ONTOLOGY_URL: ontologyUrl,
      HONO_URL: ontologyUrl,
      CALLER_IDENTITY: identity,
      // MCP subprocesses receive explicit environment values; proposal timestamps need the course clock too.
      ...(process.env.COURSE_NOW ? { COURSE_NOW: process.env.COURSE_NOW } : {}),
      ONTOLOGY_ALLOWED_TOOLS: JSON.stringify(allowedTools),
    },
    enabled: true,
    required: true,
    enabled_tools: allowedTools,
    default_tools_approval_mode: 'approve',
  }

  return server
}

/**
 * Codex merges MCP configuration from its home directory. Give each run a clean
 * home so project- or user-configured MCP servers cannot become tools for this
 * agent. Authentication is the only state intentionally carried over.
 */
async function createIsolatedCodexHome(): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), 'ontology-codex-'))
  const sourceAuth = join(process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex'), 'auth.json')

  try {
    await copyFile(sourceAuth, join(codexHome, 'auth.json'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
    // An API-key based environment does not require auth.json.
  }

  return codexHome
}

/** Attach attribution to parent-process ontology fetches, then return a cleanup function. */
function installOntologyIdentityInterceptor(identity: string, ontologyUrl: string): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    // Other network requests retain their original headers; only ontology-prefixed URLs receive this identity.
    if (!url.startsWith(ontologyUrl)) return originalFetch(input, init)

    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    headers.set('x-caller-identity', identity)

    if (input instanceof Request) {
      return originalFetch(new Request(input, { ...init, headers }))
    }
    return originalFetch(input, { ...init, headers })
  }

  return () => { globalThis.fetch = originalFetch }
}

/** Local run viewer plus an SSE feed that replays in-memory history to newly connected browsers. */
function startEventServer() {
  let stopping = false
  const clients = new Set<SseClient>()
  const history: AgentEvent[] = []
  // IDs include a run UUID so the viewer can deduplicate replay without hiding a later run's events.
  const runId = randomUUID()
  const serialize = (event: AgentEvent, index: number) => `id: ${runId}:${index}\ndata: ${JSON.stringify(event)}\n\n`

  const publish = (event: AgentEvent) => {
    history.push(event)
    const message = serialize(event, history.length - 1)
    for (const client of clients) client.write(message)
  }

  const server = createServer((request, response) => {
    if (stopping) {
      response.writeHead(503, { connection: 'close' })
      response.end('Run finished; reconnect when the next run starts.')
      return
    }
    // Replay first, then subscribe the connection to new events; reconnecting clients may see duplicates.
    if (request.url === '/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      response.write('retry: 1000\n\n')
      for (const [index, event] of history.entries()) response.write(serialize(event, index))
      clients.add(response)
      response.on('close', () => clients.delete(response))
      return
    }

    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page)
      return
    }

    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  })

  return {
    publish,
    url: `http://localhost:${PORT}`,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(PORT, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
    },
    async stop() {
      stopping = true
      for (const client of clients) client.end()
      clients.clear()
      await new Promise<void>((resolve) => {
        // A reconnecting browser may hold an HTTP connection during shutdown.
        // Give final SSE bytes time to drain, then close any remaining sockets.
        const deadline = setTimeout(() => server.closeAllConnections(), 1000)
        deadline.unref()
        server.close(() => {
          clearTimeout(deadline)
          resolve()
        })
      })
    },
  }
}

/** Translate Codex item lifecycle events into the viewer's tool/message/status categories. */
function eventForCodex(event: { type: string; item?: Record<string, unknown> }): AgentEvent | null {
  if (!event.item) return { type: 'status', at: new Date().toISOString(), payload: event }
  const itemType = event.item.type
  if (itemType === 'mcp_tool_call') {
    const isComplete = event.type === 'item.completed'
    return {
      type: isComplete ? 'tool-result' : 'tool-call',
      at: new Date().toISOString(),
      payload: event.item,
    }
  }
  if (itemType === 'agent_message') {
    return { type: 'assistant', at: new Date().toISOString(), payload: event.item.text ?? event.item }
  }
  return { type: 'status', at: new Date().toISOString(), payload: event.item }
}

/** Execute one agent turn and return the last assistant answer plus thread/optional trace IDs. */
export async function runAgent({ identity, systemPrompt, prompt, tools, options = {} }: RunAgentInput): Promise<AgentRunResult> {
  // All agents share the same explicit model/effort defaults. Callers can still supply
  // intentional overrides for controlled comparisons rather than relying on CLI defaults.
  options = { model: 'gpt-6-luna', modelReasoningEffort: 'medium', ...options }
  const ontologyUrl = ontologyBaseUrl()
  const allowedTools = allowedToolNames(tools)
  const eventServer = startEventServer()
  await eventServer.start()
  console.info(`Ontology agent UI: ${eventServer.url}`)
  console.info(`Agent model: ${options.model}; reasoning effort: ${options.modelReasoningEffort}`)
  eventServer.publish({ type: 'status', at: new Date().toISOString(), payload: `Agent UI: ${eventServer.url}` })

  const restoreFetch = installOntologyIdentityInterceptor(identity, ontologyUrl)
  let codexHome: string | null = null
  let finalResponse = ''
  let threadId: string | null = null
  let completed = false
  const runTrace = createAgentRunTrace(identity, prompt)
  if (runTrace) console.info(`Langfuse trace ID: ${runTrace.traceId}`)

  try {
    codexHome = await createIsolatedCodexHome()
    // Load live catalog context before the turn so the agent can reason with current ontology API names.
    const schemaBlock = await buildSchemaBlock()
    const tracing = langfuseConfig(identity)
    // These instruction strings are concatenated into the turn text below; this is not a separate API role.
    const developerInstructions = [
      `<ontology-schema>\n${schemaBlock}\n</ontology-schema>`,
      `COURSE_NOW is an override date: ${process.env.COURSE_NOW ?? 'not configured'}. Treat it as the date to use for all time-relative reasoning about ontology data.`,
      systemPrompt,
    ].filter((instruction): instruction is string => Boolean(instruction)).join('\n\n')
    // Disable shell/web access and install only the isolated ontology MCP server for this run.
    const codex = new Codex({
      env: { ...tracing.env, CODEX_HOME: codexHome },
      config: {
        features: { shell_tool: false },
        mcp_servers: { ontology: ontologyMcpServer(identity, ontologyUrl, allowedTools) },
      },
      configOverrides: [
        'web_search="disabled"',
        ...tracing.overrides,
      ],
    })
    // The thread is read-only for filesystem work; supported business writes still happen through MCP tools.
    const thread = codex.startThread({
      ...options,
      workingDirectory: process.cwd(),
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      webSearchMode: 'disabled',
      webSearchEnabled: false,
    })
    const input = `${developerInstructions}\n\nUser request: ${prompt}`
    runTrace?.startTurn(input, options.model)
    const streamed = await thread.runStreamed([
      {
        type: 'text',
        text: input,
      },
    ])

    // One stream feeds telemetry, the browser, final-answer capture, and error detection.
    for await (const event of streamed.events) {
      runTrace?.onEvent(event)
      if (event.type === 'turn.completed') completed = true
      if (event.type === 'thread.started') threadId = event.thread_id
      const displayEvent = eventForCodex(event)
      if (displayEvent) eventServer.publish(displayEvent)
      if ('item' in event && event.item.type === 'agent_message') {
        finalResponse = event.item.text
      }
      if ('item' in event && event.item.type === 'error') {
        throw new Error(event.item.message)
      }
      if (event.type === 'turn.failed') {
        throw new Error(event.error.message)
      }
      if (event.type === 'error') {
        throw new Error(event.message)
      }
    }

    // A silent/truncated stream must not be reported as a successful agent answer.
    if (!completed || !finalResponse.trim()) throw new Error('Codex stream ended without a completed answer')
    runTrace?.finish(finalResponse)
    eventServer.publish({ type: 'final', at: new Date().toISOString(), payload: finalResponse })
    return { finalResponse, threadId, traceId: runTrace?.traceId }
  } catch (error) {
    runTrace?.finish(finalResponse, error)
    const message = error instanceof Error ? error.message : 'Agent run failed'
    eventServer.publish({ type: 'error', at: new Date().toISOString(), payload: message })
    throw error
  } finally {
    // Restore process-wide state and release resources even when schema loading or the model fails.
    restoreFetch()
    try {
      await runTrace?.shutdown()
    } finally {
      await eventServer.stop()
      if (codexHome) await rm(codexHome, { recursive: true, force: true })
    }
  }
}
