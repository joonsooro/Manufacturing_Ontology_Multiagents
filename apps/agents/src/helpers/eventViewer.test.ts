/**
 * Exercise the embedded viewer script with small DOM/EventSource stubs.
 * The tests cover reconnecting across runs and suppressing duplicate replayed events.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { eventViewerScript } from './eventViewer.ts'

test('viewer stays subscribed across completed runs and connection errors; replay is deduplicated', () => {
  // Only the DOM operations used by the embedded script are implemented in these stubs.
  class Element {
    textContent = ''
    children: Element[] = []
    append(...children: Element[]) { this.children.push(...children) }
    remove() {}
  }
  const elements = { events: new Element(), empty: new Element(), connection: new Element() }
  let closed = false
  class EventSourceStub {
    static instance: EventSourceStub
    onopen = () => {}
    onerror = () => {}
    onmessage = (_event: { data: string; lastEventId: string }) => {}
    constructor() { EventSourceStub.instance = this }
    close() { closed = true }
  }
  runInNewContext(eventViewerScript, {
    EventSource: EventSourceStub,
    document: { getElementById: (id: keyof typeof elements) => elements[id], createElement: () => new Element(), body: { scrollHeight: 0 } },
    window: { scrollTo() {} },
  })
  const source = EventSourceStub.instance
  const emit = (id: string, type: string) => source.onmessage({ lastEventId: id, data: JSON.stringify({ type, at: 'now', payload: type }) })
  // Simulate run completion, reconnect/replay, then a different run on the same browser subscription.
  source.onopen()
  emit('run-1:0', 'tool-call')
  emit('run-1:1', 'final')
  source.onerror()
  assert.equal(closed, false, 'a completed run must not disable EventSource reconnection')
  assert.match(elements.connection.textContent, /reconnecting automatically/)
  source.onopen()
  emit('run-1:0', 'tool-call')
  emit('run-1:1', 'final')
  assert.equal(elements.events.children.length, 2, 'replayed events must not duplicate cards')
  source.onopen()
  emit('run-2:0', 'tool-call')
  assert.equal(elements.events.children.length, 3, 'a new run must appear in the existing tab')
  source.onerror()
  assert.equal(closed, false)
  assert.match(elements.connection.textContent, /retrying automatically/)
})
