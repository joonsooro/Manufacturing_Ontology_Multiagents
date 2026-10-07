/**
 * Server startup: install the course clock, assemble routes, then begin listening.
 * Import app.ts directly in tests that should not open a listening socket.
 */
import { serve } from '@hono/node-server'
// This side-effect import must run before requests can observe or compare current time.
import './courseClock.ts'
import { app } from './app.ts'

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port })

console.log(`Ontology API listening on http://localhost:${port}`)
