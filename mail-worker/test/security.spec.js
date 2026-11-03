import { describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src';
import { dbInit } from '../src/init/init';
import resendService from '../src/service/resend-service';
import KvConst from '../src/const/kv-const';
import app from '../src/hono/hono';
import BizError from '../src/error/biz-error';

const encoder = new TextEncoder();

app.get('/login/test-unknown-error', () => {
	throw new Error('sensitive internal failure details');
});
app.get('/login/test-business-error', () => {
	throw new BizError('Delivery outcome is unknown; do not retry automatically', 502);
});

describe('security hardening', () => {
	it('marks deliberate business errors for the frontend without marking unknown failures', async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request('http://example.com/api/login/test-business-error', {
			headers: { Origin: 'http://example.com' }
		}), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(502);
		expect(response.headers.get('X-Cloud-Mail-Error')).toBe('business');
		expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Cloud-Mail-Error');
	});
	it('blocks cross-origin API requests by default', async () => {
		const request = new Request('http://example.com/api/init', {
			method: 'POST',
			headers: { Origin: 'https://evil.example' }
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
	});

	it('allows same-origin API requests and sets CORS headers', async () => {
		const request = new Request('http://example.com/api/init', {
			method: 'POST',
			headers: {
				Origin: 'http://example.com',
				'X-Cloud-Mail-Init-Secret': 'wrong-secret'
			}
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://example.com');
	});

	it('allows configured CORS origins', async () => {
		const request = new Request('http://example.com/api/init', {
			method: 'POST',
			headers: {
				Origin: 'https://allowed.example',
				'X-Cloud-Mail-Init-Secret': 'wrong-secret'
			}
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {
			...env,
			cors_origins: '["https://allowed.example"]'
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
	});

	it('adds CSP and browser security headers without allowing inline scripts', async () => {
		const request = new Request('http://example.com/api/init/status');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {}, ctx);
		await waitOnExecutionContext(ctx);

		const csp = response.headers.get('Content-Security-Policy');
		const directives = Object.fromEntries(csp.split(';').map(part => {
			const [name, ...values] = part.trim().split(/\s+/);
			return [name, values];
		}));

		expect(directives['script-src']).toContain("'self'");
		expect(directives['script-src']).toContain('https://challenges.cloudflare.com');
		expect(directives['script-src']).not.toContain("'unsafe-inline'");
		expect(directives['style-src']).toContain("'unsafe-inline'");
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
		expect(response.headers.get('Permissions-Policy')).toContain('camera=()');
	});

	it('rejects unsigned webhook requests at the public API boundary by default', async () => {
		const request = new Request('http://example.com/api/webhooks', {
			method: 'POST',
			body: '{"type":"email.delivered","data":{"email_id":"email_test"}}'
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {
			...env,
			resend_webhook_secret: '',
			resend_webhook_allow_unsigned: ''
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(await response.text()).toContain('Resend webhook secret is not configured');
	});

	it('rejects oversized webhook bodies before signature verification', async () => {
		const request = new Request('http://example.com/api/webhooks', {
			method: 'POST',
			body: 'x'.repeat(256 * 1024 + 1)
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {
			...env,
			resend_webhook_secret: '',
			resend_webhook_allow_unsigned: ''
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(413);
		expect(await response.text()).toContain('Resend webhook body exceeds 256 KiB');
	});

	it('rejects oversized public import JSON before the service runs', async () => {
		const request = new Request('http://example.com/api/public/addUser', {
			method: 'POST',
			headers: {
				Authorization: 'public-test-token',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ padding: 'x'.repeat(512 * 1024) })
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {
			...env,
			kv: {
				async get(key) {
					return key === KvConst.PUBLIC_KEY ? 'public-test-token' : null;
				}
			}
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ code: 413 });
	});

	it('rejects oversized administrator bootstrap JSON before database access', async () => {
		const request = new Request('http://example.com/api/init/admin', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Cloud-Mail-Init-Secret': 'test-init-secret'
			},
			body: JSON.stringify({ password: 'x'.repeat(32 * 1024) })
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {
			jwt_secret: 'test-init-secret'
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ code: 413 });
	});

	it('keeps optional migrations idempotent', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const calls = [];
		const c = {
			env: {
				db: {
					prepare(sql) {
						calls.push(sql);
						return {
							async run() {
								if (sql.includes('ADD COLUMN duplicate')) {
									throw new Error('duplicate column name: duplicate');
								}
							}
						};
					}
				}
			}
		};

		await dbInit.runOptionalSqlList(c, [
			'ALTER TABLE test ADD COLUMN ok TEXT',
			'ALTER TABLE test ADD COLUMN duplicate TEXT'
		]);

		expect(calls).toHaveLength(2);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('does not swallow non-idempotent migration failures', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const c = {
			env: {
				db: {
					prepare() {
						return {
							async run() {
								throw new Error('database unavailable');
							}
						};
					}
				}
			}
		};

		await expect(dbInit.runOptionalSqlList(c, [
			'ALTER TABLE test ADD COLUMN value TEXT'
		])).rejects.toThrow('database unavailable');
		warn.mockRestore();
	});

	it('preserves explicit migration conflict status and context', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(dbInit.runMigrationSteps([
			['v3.4', async () => {
				throw new BizError('Duplicate OAuth identities require manual review', 409);
			}]
		])).rejects.toMatchObject({
			code: 409,
			message: 'Database migration failed at v3.4: Duplicate OAuth identities require manual review'
		});
		error.mockRestore();
	});

	it('returns a safe HTTP 500 response for unknown failures', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const request = new Request('http://example.com/api/login/test-unknown-error');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(response.headers.has('X-Cloud-Mail-Error')).toBe(false);
		expect(await response.json()).toEqual({
			code: 500,
			message: 'Internal Server Error'
		});
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it('reports a safe migration step when database initialization fails', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const request = new Request('http://example.com/api/init', {
			method: 'POST',
			headers: { 'X-Cloud-Mail-Init-Secret': 'test-init-secret' }
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {
			jwt_secret: 'test-init-secret',
			db: {
				prepare() {
					return {
						async run() {
							throw new Error('sensitive migration failure details');
						}
					};
				}
			}
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			code: 500,
			message: 'Database migration failed at base-schema'
		});
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});

	it('rejects unsigned Resend webhooks when no secret is configured by default', async () => {
		const body = '{"type":"email.delivered","data":{"email_id":"email_test"}}';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const c = {
			env: {},
			req: {
				header() {
					return null;
				}
			}
		};

		await expect(resendService.verifyWebhook(c, body)).rejects.toThrow('Resend webhook secret is not configured');
		warn.mockRestore();
	});

	it('allows unsigned Resend webhooks only when the legacy compatibility flag is explicit', async () => {
		const body = '{"type":"email.delivered","data":{"email_id":"email_test"}}';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const c = {
			env: { resend_webhook_allow_unsigned: 'true' },
			req: {
				header() {
					return null;
				}
			}
		};

		await expect(resendService.verifyWebhook(c, body)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('verifies Resend Svix webhook signatures when configured', async () => {
		const secretBytes = crypto.getRandomValues(new Uint8Array(32));
		const secret = `whsec_${btoa(String.fromCharCode(...secretBytes))}`;
		const id = 'msg_test';
		const timestamp = String(Math.floor(Date.now() / 1000));
		const body = '{"type":"email.delivered","data":{"email_id":"email_test"}}';
		const signedPayload = `${id}.${timestamp}.${body}`;
		const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload)))));
		const c = {
			env: { resend_webhook_secret: secret },
			req: {
				header(name) {
					return {
						'svix-id': id,
						'svix-timestamp': timestamp,
						'svix-signature': `v1,${signature}`
					}[name];
				}
			}
		};

		await expect(resendService.verifyWebhook(c, body)).resolves.toBeUndefined();

		c.req.header = (name) => ({
			'svix-id': id,
			'svix-timestamp': timestamp,
			'svix-signature': 'v1,invalid'
		})[name];

		await expect(resendService.verifyWebhook(c, body)).rejects.toThrow('Invalid webhook signature');
	});
});
