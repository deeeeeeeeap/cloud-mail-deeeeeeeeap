import { describe, expect, it, vi } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src';
import { dbInit } from '../src/init/init';
import resendService from '../src/service/resend-service';

const encoder = new TextEncoder();

describe('security hardening', () => {
	it('blocks cross-origin API requests by default', async () => {
		const request = new Request('http://example.com/api/init/wrong-secret', {
			headers: { Origin: 'https://evil.example' }
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(403);
	});

	it('allows same-origin API requests and sets CORS headers', async () => {
		const request = new Request('http://example.com/api/init/wrong-secret', {
			headers: { Origin: 'http://example.com' }
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://example.com');
	});

	it('allows configured CORS origins', async () => {
		const request = new Request('http://example.com/api/init/wrong-secret', {
			headers: { Origin: 'https://allowed.example' }
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {
			...env,
			cors_origins: '["https://allowed.example"]'
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
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
								if (sql.includes('duplicate')) {
									throw new Error('duplicate column name');
								}
							}
						};
					}
				}
			}
		};

		await dbInit.runOptionalSqlList(c, ['ALTER TABLE test ADD COLUMN ok TEXT', 'duplicate']);

		expect(calls).toHaveLength(2);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
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
