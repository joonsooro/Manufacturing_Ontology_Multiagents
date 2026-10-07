/**
 * Optional Langfuse tracing adapter for Codex stream events.
 * An agent run contains a generation span, tool spans, and assistant message spans.
 */
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api'
import type { Span } from '@opentelemetry/api'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { ThreadEvent } from '@openai/codex-sdk'

/** Normalize supported environment aliases to one telemetry service URL. */
export function langfuseBaseUrl(): string {
  return (process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST ?? process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com').replace(/\/$/, '')
}

/** Explicit contexts avoid registering global providers or mixing concurrent runs. */
export class AgentRunTrace {
  private readonly provider: NodeTracerProvider
  private readonly identity: string
  private readonly tracer
  private readonly root: Span
  private generation: Span | undefined
  // Stream events repeat the same tool ID through its lifecycle; keep one open span per call.
  private readonly tools = new Map<string, Span>()
  // Record completed assistant messages once even if their events are replayed.
  private readonly messages = new Set<string>()
  private finished = false
  readonly traceId: string

  /** Start an independent root span for this run, rather than inheriting ambient global context. */
  constructor(provider: NodeTracerProvider, identity: string, prompt: string) {
    this.provider = provider
    this.identity = identity
    this.tracer = provider.getTracer('ontology-agent')
    this.root = this.tracer.startSpan(identity, { attributes: {
      'langfuse.trace.name': identity,
      'langfuse.trace.input': JSON.stringify(prompt),
      'langfuse.observation.type': 'agent',
      'langfuse.observation.input': JSON.stringify(prompt),
    } }, ROOT_CONTEXT)
    this.traceId = this.root.spanContext().traceId
  }

  /** Model input/reasoning work is represented by a generation child of the run. */
  startTurn(input: string, model?: string) {
    this.generation = this.child('Codex turn', 'generation', this.root)
    this.generation.setAttribute('langfuse.observation.input', JSON.stringify(input))
    if (model) this.generation.setAttribute('langfuse.observation.model.name', model)
  }

  /** Explicit parent context keeps tool/message spans attached to this run's generation. */
  private child(name: string, type: string, parent = this.generation ?? this.root): Span {
    return this.tracer.startSpan(name, { attributes: {
      'langfuse.trace.name': this.identity,
      'langfuse.observation.type': type,
    } }, trace.setSpan(ROOT_CONTEXT, parent))
  }

  /** Capture IDs, usage, and tool/message outcomes from the Codex event stream. */
  onEvent(event: ThreadEvent) {
    if (event.type === 'thread.started') {
      this.root.setAttribute('langfuse.session.id', event.thread_id)
      this.root.setAttribute('langfuse.trace.metadata.codexThreadId', event.thread_id)
    }
    if (event.type === 'turn.completed') {
      this.generation?.setAttribute('langfuse.observation.usage_details', JSON.stringify({
        input: event.usage.input_tokens,
        output: event.usage.output_tokens,
        input_cached: event.usage.cached_input_tokens,
      }))
    }
    if (!('item' in event)) return
    const item = event.item
    if (item.type === 'mcp_tool_call') {
      // Either a start/update or completion can be the first observed event for a tool call.
      let span = this.tools.get(item.id)
      if (!span) {
        span = this.child(`${item.server}.${item.tool}`, 'tool')
        span.setAttribute('langfuse.observation.input', JSON.stringify(item.arguments))
        this.tools.set(item.id, span)
      }
      if (event.type === 'item.completed') {
        span.setAttribute('langfuse.observation.output', JSON.stringify(item.result ?? item.error ?? null))
        if (item.status === 'failed' || item.error) this.markError(span, item.error?.message ?? 'Tool call failed')
        span.end()
        this.tools.delete(item.id)
      }
    }
    if (item.type === 'agent_message' && event.type === 'item.completed' && !this.messages.has(item.id)) {
      const span = this.child('Assistant message', 'event')
      span.setAttribute('langfuse.observation.output', JSON.stringify(item.text))
      span.end()
      this.messages.add(item.id)
    }
  }

  /** Keep OpenTelemetry status and Langfuse-specific error fields consistent. */
  private markError(span: Span, message: string) {
    span.setStatus({ code: SpanStatusCode.ERROR, message })
    span.setAttribute('langfuse.observation.level', 'ERROR')
    span.setAttribute('langfuse.observation.status_message', message)
  }

  /** Idempotently close the run; unfinished tools receive an explicit failure rather than hanging spans. */
  finish(output: string, error?: unknown) {
    if (this.finished) return
    this.finished = true
    for (const span of this.tools.values()) {
      this.markError(span, 'Run ended before tool completion')
      span.end()
    }
    this.tools.clear()
    for (const span of [this.generation, this.root]) {
      if (!span) continue
      span.setAttribute('langfuse.observation.output', JSON.stringify(output))
      if (error !== undefined) this.markError(span, error instanceof Error ? error.message : String(error))
      span.end()
    }
  }

  /** Flush queued observations before disposing the provider so the last result is not lost. */
  async shutdown() {
    try {
      await this.provider.forceFlush()
    } finally {
      await this.provider.shutdown()
    }
  }
}

/** Tracing is optional; missing Langfuse credentials leave agent execution available. */
export function createAgentRunTrace(identity: string, prompt: string): AgentRunTrace | undefined {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  if (!publicKey || !secretKey) {
    console.warn('Langfuse tracing disabled: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required.')
    return undefined
  }
  const processor = new LangfuseSpanProcessor({
    publicKey, secretKey, baseUrl: langfuseBaseUrl(),
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.LANGFUSE_ENVIRONMENT,
    // Export this adapter's observations only, excluding unrelated instrumentation from the process.
    shouldExportSpan: ({ otelSpan }) => otelSpan.instrumentationScope.name === 'ontology-agent',
    mediaUploadEnabled: false,
  })
  return new AgentRunTrace(new NodeTracerProvider({ spanProcessors: [processor] }), identity, prompt)
}
