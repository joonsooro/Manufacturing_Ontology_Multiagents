/**
 * In-memory tracing tests: verify span parentage, captured outputs, and failure cleanup
 * without sending telemetry to Langfuse.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { AgentRunTrace } from './agentTracing.ts'

test('run, generation, tool result and assistant output share one named trace', async () => {
  // Keep telemetry local and inspect completed spans rather than relying on an external tracing service.
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const run = new AgentRunTrace(provider, 'analytics-agent', 'Which batches?')
  run.startTurn('Schema + question')
  const item = { id: 'tool-1', type: 'mcp_tool_call' as const, server: 'ontology', tool: 'query_objects', arguments: { type: 'batch' }, status: 'in_progress' as const }
  run.onEvent({ type: 'item.started', item })
  run.onEvent({ type: 'item.completed', item: { ...item, status: 'completed', result: { content: [], structured_content: [{ id: 'B-2105' }] } } })
  run.onEvent({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'B-2105 is behind target.' } })
  run.finish('B-2105 is behind target.')
  await provider.forceFlush()
  // Inspect the emitted parent/child structure and payloads after flushing the provider.
  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 4)
  assert.ok(spans.every(span => span.spanContext().traceId === run.traceId && span.attributes['langfuse.trace.name'] === 'analytics-agent'))
  const root = spans.find(span => span.name === 'analytics-agent')!
  const generation = spans.find(span => span.name === 'Codex turn')!
  const tool = spans.find(span => span.name === 'ontology.query_objects')!
  assert.equal(generation.parentSpanContext?.spanId, root.spanContext().spanId)
  assert.equal(tool.parentSpanContext?.spanId, generation.spanContext().spanId)
  assert.match(String(tool.attributes['langfuse.observation.output']), /B-2105/)
  assert.equal(root.attributes['langfuse.observation.output'], JSON.stringify('B-2105 is behind target.'))
  await run.shutdown()
})

test('failure closes pending tool spans and records the error, once', async () => {
  // Keep telemetry local and inspect completed spans rather than relying on an external tracing service.
  const exporter = new InMemorySpanExporter()
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  const run = new AgentRunTrace(provider, 'analytics-agent', 'Question')
  run.startTurn('Question')
  run.onEvent({ type: 'item.started', item: { id: 'pending', type: 'mcp_tool_call', server: 'ontology', tool: 'get_object', arguments: {}, status: 'in_progress' } })
  run.finish('', new Error('Connection lost'))
  run.finish('Should not overwrite')
  await provider.forceFlush()
  // Inspect the emitted parent/child structure and payloads after flushing the provider.
  const spans = exporter.getFinishedSpans()
  assert.equal(spans.length, 3)
  assert.ok(spans.every(span => span.status.code === 2))
  assert.equal(spans.find(span => span.name === 'analytics-agent')?.status.message, 'Connection lost')
  await run.shutdown()
})
