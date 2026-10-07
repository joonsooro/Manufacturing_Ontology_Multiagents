/**
 * HTTP application composition. Metadata, action invocation, and instance reads
 * share /api/objects; specific metadata routes are registered before generic :type routes.
 */
import { Hono } from 'hono'
import { actionRoutes } from './routes/actions.ts'
import { metaRoutes } from './routes/meta.ts'
import { objectRoutes } from './routes/objects.ts'

export const app = new Hono()

app.get('/health', (context) => context.json({ status: 'ok' }))
app.route('/api/objects', metaRoutes)
app.route('/api/objects', actionRoutes)
app.route('/api/objects', objectRoutes)
