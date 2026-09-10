import app from '../hono/hono';

// Retain the legacy path only to fail closed. Private resources are exclusively
// served by authenticated /email/attachment and /allEmail/attachment endpoints.
app.get('/oss/*', c => new Response('Not found', {
  status: 404,
  headers: { 'Cache-Control': 'private, no-store' }
}));
