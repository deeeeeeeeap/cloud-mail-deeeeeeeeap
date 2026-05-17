import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';

app.use('*', async (c, next) => {
	const origin = c.req.header('Origin');
	const allowedOrigin = getAllowedOrigin(c, origin);

	if (origin && !allowedOrigin) {
		return c.text('CORS origin not allowed', 403);
	}

	if (allowedOrigin) {
		setCorsHeaders(c, allowedOrigin);
	}

	if (c.req.method === 'OPTIONS') {
		return c.body(null, 204);
	}

	await next();

	if (allowedOrigin) {
		setCorsHeaders(c, allowedOrigin);
	}
});

app.onError((err, c) => {
	if (err.name === 'BizError') {
		console.warn(err.message);
	} else {
		console.error(err);
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定 D1 database not bound',502));
	}

	return c.json(result.fail(err.message, err.code));
});

export default app;

function getAllowedOrigin(c, origin) {
	if (!origin) {
		return null;
	}

	const requestOrigin = new URL(c.req.url).origin;
	if (origin === requestOrigin) {
		return origin;
	}

	const extraOrigins = parseCorsOrigins(c.env.cors_origins);
	return extraOrigins.includes(origin) ? origin : null;
}

function parseCorsOrigins(value) {
	if (!value) {
		return [];
	}

	if (Array.isArray(value)) {
		return value;
	}

	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch (e) {
		console.warn(`Invalid cors_origins: ${e.message}`);
		return [];
	}
}

function setCorsHeaders(c, origin) {
	c.header('Access-Control-Allow-Origin', origin);
	c.header('Access-Control-Allow-Credentials', 'true');
	c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept-Language');
	c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	c.header('Access-Control-Max-Age', '86400');
	c.header('Vary', 'Origin');
}
