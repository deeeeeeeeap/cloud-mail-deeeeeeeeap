import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src';

describe('telegram email view API', () => {
	it('does not allow public immutable caching for tokenized email views', async () => {
		const request = new Request('http://example.com/api/telegram/getEmail/not-a-token');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, no-store');
		expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		expect(await response.text()).toContain('Access denied');
	});
});
