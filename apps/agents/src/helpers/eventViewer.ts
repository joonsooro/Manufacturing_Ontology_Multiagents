/**
 * Browser-side script embedded in the agent event page.
 * It renders SSE events safely as text and stays subscribed so later runs can reuse the tab.
 */
// EventSource reconnects automatically, including across separate agent processes.
// Keep that connection alive after a final event; the server still exits normally.
/**
 * The embedded script opens /events, skips seen run/index IDs, and appends a card.
 * textContent renders tool results as text rather than interpreting them as HTML.
 * A final/error event changes the label but does not close EventSource: automatic
 * reconnection lets the same tab follow the next agent process on the same port.
 */
export const eventViewerScript = `
const events = document.getElementById('events');
const empty = document.getElementById('empty');
const connection = document.getElementById('connection');
const seen = new Set();
let finished = false;
const source = new EventSource('/events');
source.onopen = () => {
  finished = false;
  connection.textContent = 'Connected — streaming live';
};
source.onmessage = ({ data, lastEventId }) => {
  if (lastEventId && seen.has(lastEventId)) return;
  if (lastEventId) seen.add(lastEventId);
  empty?.remove();
  const event = JSON.parse(data);
  const card = document.createElement('article');
  card.className = 'event ' + event.type;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = event.type + ' · ' + event.at;
  const body = document.createElement('pre');
  body.textContent = typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload, null, 2);
  card.append(meta, body);
  events.append(card);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  if (event.type === 'final' || event.type === 'error') {
    finished = true;
    connection.textContent = 'Run finished — waiting for the next run';
  }
};
source.onerror = () => {
  connection.textContent = finished
    ? 'Run finished — reconnecting automatically for the next run'
    : 'Disconnected — retrying automatically';
};
`
