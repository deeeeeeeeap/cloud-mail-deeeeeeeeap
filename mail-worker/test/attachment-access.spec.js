import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext, env as testEnv } from 'cloudflare:test';
import { attConst } from '../src/const/entity-const';

vi.mock('../src/service/r2-service', async () => {
	const actual = await vi.importActual('../src/service/r2-service');
	return {
		default: {
			...actual.default,
			getObj: vi.fn()
		}
	};
});

const { default: r2Service } = await import('../src/service/r2-service');
const { default: attService } = await import('../src/service/att-service');
const { default: worker } = await import('../src/index');

function createDbStub({ protectedKey = null, downloadRow = null } = {}) {
	const calls = [];

	return {
		calls,
		db: {
			prepare(sql) {
				const call = { sql, bindings: [] };
				calls.push(call);
				return {
					bind(...args) {
						call.bindings = args;
						return this;
					},
					async first() {
						if (sql.includes('WHERE key = ?')) {
							return call.bindings[0] === protectedKey ? { att_id: 1 } : null;
						}

						if (sql.includes('WHERE att_id = ?')) {
							const [attId, type, userId] = call.bindings;
							if (!downloadRow) return null;
							if (downloadRow.attId !== attId) return null;
							if (downloadRow.type !== type) return null;
							if (userId !== undefined && downloadRow.userId !== userId) return null;
							return downloadRow;
						}

						return null;
					}
				};
			}
		}
	};
}

function createKvStub(body = 'ok') {
	return {
		async getWithMetadata() {
			return {
				value: new TextEncoder().encode(body).buffer,
				metadata: {
					contentType: 'text/plain',
					contentDisposition: 'inline'
				}
			};
		}
	};
}

describe('attachment access control', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('blocks registered normal attachment direct links from worker static routing', async () => {
		const recorder = createDbStub({ protectedKey: 'attachments/private.txt' });
		const request = new Request('http://example.com/attachments/private.txt');
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, { ...testEnv, db: recorder.db }, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(recorder.calls[0].bindings).toEqual(['attachments/private.txt', attConst.type.ATT]);
	});

	it('blocks registered normal attachment direct links from /api/oss', async () => {
		const recorder = createDbStub({ protectedKey: 'attachments/private.txt' });
		const request = new Request('http://example.com/api/oss/attachments/private.txt');
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, { ...testEnv, db: recorder.db }, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(recorder.calls[0].bindings).toEqual(['attachments/private.txt', attConst.type.ATT]);
	});

	it('keeps unregistered inline attachment and static object links compatible', async () => {
		const recorder = createDbStub();
		const ctx = createExecutionContext();

		const inlineResponse = await worker.fetch(
			new Request('http://example.com/attachments/inline-image.png'),
			{ ...testEnv, db: recorder.db, kv: createKvStub('inline') },
			ctx
		);
		const staticResponse = await worker.fetch(
			new Request('http://example.com/static/background/bg.png'),
			{ ...testEnv, db: recorder.db, kv: createKvStub('static') },
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect(inlineResponse.status).toBe(200);
		expect(await inlineResponse.text()).toBe('inline');
		expect(staticResponse.status).toBe(200);
		expect(await staticResponse.text()).toBe('static');
	});

	it('downloads an owned normal attachment through the authenticated service path', async () => {
		const recorder = createDbStub({
			downloadRow: {
				attId: 10,
				userId: 7,
				emailId: 20,
				accountId: 30,
				key: 'attachments/private.txt',
				filename: 'private.txt',
				mimeType: 'text/plain',
				size: 6,
				type: attConst.type.ATT,
				contentId: null
			}
		});
		r2Service.getObj.mockResolvedValue(new Response('secret', {
			headers: { 'Content-Type': 'text/plain' }
		}));

		const response = await attService.download({ env: { db: recorder.db } }, { attId: '10' }, 7);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('secret');
		expect(response.headers.get('Content-Disposition')).toContain('private.txt');
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, no-store');
		expect(r2Service.getObj).toHaveBeenCalledWith({ env: { db: recorder.db } }, 'attachments/private.txt');
	});

	it('does not download another user normal attachment', async () => {
		const recorder = createDbStub({
			downloadRow: {
				attId: 10,
				userId: 7,
				key: 'attachments/private.txt',
				filename: 'private.txt',
				type: attConst.type.ATT,
				contentId: null
			}
		});

		await expect(attService.download({ env: { db: recorder.db } }, { attId: '10' }, 8))
			.rejects.toMatchObject({ code: 404 });
		expect(r2Service.getObj).not.toHaveBeenCalled();
	});

	it('allows all-email attachment download checks to omit the owner filter', async () => {
		const recorder = createDbStub({
			downloadRow: {
				attId: 10,
				userId: 7,
				emailId: 20,
				accountId: 30,
				key: 'attachments/private.txt',
				filename: 'private.txt',
				mimeType: 'text/plain',
				size: 6,
				type: attConst.type.ATT,
				contentId: null
			}
		});
		r2Service.getObj.mockResolvedValue(new Response('secret', {
			headers: { 'Content-Type': 'text/plain' }
		}));

		const response = await attService.downloadAny({ env: { db: recorder.db } }, { attId: '10' });

		expect(response.status).toBe(200);
		expect(recorder.calls[0].bindings).toEqual([10, attConst.type.ATT]);
	});
});
