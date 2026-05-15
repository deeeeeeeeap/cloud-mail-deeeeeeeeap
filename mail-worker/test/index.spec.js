import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('cloud-mail worker', () => {
	it('routes API requests through the worker (unit style)', async () => {
		const request = new Request('http://example.com/api/init/wrong-secret');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('JWT secret mismatch');
	});

	it('routes API requests through the worker (integration style)', async () => {
		const response = await SELF.fetch('http://example.com/api/init/wrong-secret');
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('JWT secret mismatch');
	});
});
