import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext, env as testEnv } from 'cloudflare:test';
import { attConst, emailConst } from '../src/const/entity-const';

vi.mock('../src/service/r2-service', async () => {
	const actual = await vi.importActual('../src/service/r2-service');
	return {
		default: {
			...actual.default,
			getObj: vi.fn(),
			putObj: vi.fn()
		}
	};
});

const { default: r2Service } = await import('../src/service/r2-service');
const { default: actualR2Service } = await vi.importActual('../src/service/r2-service');
const { default: s3Service } = await import('../src/service/s3-service');
const { default: settingService } = await import('../src/service/setting-service');
const { default: kvObjService } = await import('../src/service/kv-obj-service');
const { default: attService } = await import('../src/service/att-service');
const { default: worker } = await import('../src/index');

function createDbStub({
	attachmentRows = [],
	downloadRow = null,
	publicLookupError = null,
	parentStatus = emailConst.status.RECEIVE
} = {}) {
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
							if (sql.includes('WHERE key = ?') || sql.includes('WHERE a.key = ?')) {
								if (publicLookupError) throw publicLookupError;
								if (sql.includes('JOIN email') && [
									emailConst.status.SAVING,
									emailConst.status.FAILED
								].includes(parentStatus)) return null;
								const [key, embedType, readyStatus] = call.bindings;
								const row = attachmentRows.find(item => item.key === key && (
									item.type === embedType
								) && (
									!sql.includes('status = ?') || (item.status ?? 0) === readyStatus
								));
								return row ? { att_id: row.attId || 1 } : null;
							}

							if (sql.includes('WHERE att_id = ?') || sql.includes('a.att_id = ?')) {
								const hasStatusFilter = sql.includes('status = ?');
								const [attId, type] = call.bindings;
								const readyStatus = hasStatusFilter ? call.bindings[2] : undefined;
								const userId = call.bindings[hasStatusFilter
									? (sql.includes('JOIN email') ? 5 : 3)
									: 2];
								if (!downloadRow) return null;
								if (sql.includes('JOIN email') && [
									emailConst.status.SAVING,
									emailConst.status.FAILED
								].includes(parentStatus)) return null;
								if (downloadRow.attId !== attId) return null;
								if (downloadRow.type !== type) return null;
								if (hasStatusFilter && (downloadRow.status ?? 0) !== readyStatus) return null;
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

function createInsertDbStub(operationLog = []) {
	return {
		operationLog,
		db: {
			prepare(sql) {
				return {
					bindings: [],
					bind(...args) {
						this.bindings = args;
						return this;
					},
						async run() {
							const type = /^\s*update\b/i.test(sql) ? 'update' : 'insert';
							operationLog.push({ type, sql, bindings: this.bindings });
							return { success: true, meta: {}, results: [] };
						}
				};
			}
		}
	};
}

function createAttachmentOwnerLookupDbStub(attachmentRows = []) {
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
					async raw() {
						const keys = call.bindings.filter(value => (
							typeof value === 'string' && value.startsWith('attachments/')
						));
						const requestedUserId = call.bindings.find(value => Number.isInteger(value));
						return attachmentRows
							.filter(row => keys.includes(row.key)
								&& (requestedUserId === undefined || row.user_id === requestedUserId))
							.map(row => [
								row.att_id,
								row.user_id,
								row.email_id,
								row.account_id,
								row.key,
								row.filename,
								row.mime_type,
								row.size,
								row.status,
								row.type,
								row.disposition,
								row.related,
								row.content_id,
								row.encoding,
								row.create_time
							]);
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

function createMissingKvStub() {
	return {
		async getWithMetadata() {
			return {
				value: null,
				metadata: null
			};
		}
	};
}

describe('attachment access control', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('blocks registered normal attachment direct links from worker static routing', async () => {
		const recorder = createDbStub({
			attachmentRows: [{
				key: 'attachments/private.txt',
				type: attConst.type.ATT,
				contentId: null
			}]
		});
		const request = new Request('http://example.com/attachments/private.txt');
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, { ...testEnv, db: recorder.db }, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(recorder.calls).toEqual([]);
		expect(r2Service.getObj).not.toHaveBeenCalled();
	});

	it('blocks registered normal attachment direct links from /api/oss', async () => {
		const recorder = createDbStub({
			attachmentRows: [{
				key: 'attachments/private.txt',
				type: attConst.type.ATT,
				contentId: null
			}]
		});
		const request = new Request('http://example.com/api/oss/attachments/private.txt');
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, { ...testEnv, db: recorder.db }, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(recorder.calls).toEqual([]);
		expect(r2Service.getObj).not.toHaveBeenCalled();
	});

	it('denies ready inline attachments from both anonymous routes without touching storage', async () => {
		const recorder = createDbStub({
			attachmentRows: [{
				key: 'attachments/inline-image.png',
				type: attConst.type.EMBED,
				contentId: 'cid-1'
			}]
		});
		r2Service.getObj.mockImplementation(async () => new Response('inline', {
			headers: { 'Content-Type': 'image/png' }
		}));

		const directResponse = await worker.fetch(
			new Request('http://example.com/attachments/inline-image.png'),
			{ ...testEnv, db: recorder.db },
			createExecutionContext()
		);
		const apiResponse = await worker.fetch(
			new Request('http://example.com/api/oss/attachments/inline-image.png'),
			{ ...testEnv, db: recorder.db },
			createExecutionContext()
		);

		expect(directResponse.status).toBe(404);
		expect(apiResponse.status).toBe(404);
		expect(directResponse.headers.get('Cache-Control')).toContain('no-store');
		expect(apiResponse.headers.get('Cache-Control')).toContain('no-store');
		expect(r2Service.getObj).not.toHaveBeenCalled();
		expect(recorder.calls).toEqual([]);
	});

	it('does not serve a pending inline attachment even when the object exists', async () => {
		const recorder = createDbStub({
			attachmentRows: [{
				key: 'attachments/pending-inline.png',
				type: attConst.type.EMBED,
				status: 2,
				contentId: 'cid-pending'
			}]
		});
		r2Service.getObj.mockResolvedValue(new Response('must-not-leak'));

		const response = await worker.fetch(
			new Request('http://example.com/attachments/pending-inline.png'),
			{ ...testEnv, db: recorder.db },
			createExecutionContext()
		);

		expect(response.status).toBe(404);
		expect(r2Service.getObj).not.toHaveBeenCalled();
	});

	it('does not expose a ready inline row while its parent email is still saving', async () => {
		const recorder = createDbStub({
			parentStatus: emailConst.status.SAVING,
			attachmentRows: [{
				key: 'attachments/partial-inline.png',
				type: attConst.type.EMBED,
				status: attConst.status.READY,
				contentId: 'cid-partial'
			}]
		});
		r2Service.getObj.mockResolvedValue(new Response('must-not-leak'));

		const response = await worker.fetch(
			new Request('http://example.com/attachments/partial-inline.png'),
			{ ...testEnv, db: recorder.db },
			createExecutionContext()
		);

		expect(response.status).toBe(404);
		expect(r2Service.getObj).not.toHaveBeenCalled();
	});

	it('does not treat a content ID alone as public-inline authorization', async () => {
		const recorder = createDbStub({
			attachmentRows: [{
				key: 'attachments/legacy-inline.png',
				type: attConst.type.ATT,
				contentId: 'legacy-cid'
			}]
		});
		r2Service.getObj.mockResolvedValue(new Response('must-not-leak'));

		const response = await worker.fetch(
			new Request('http://example.com/attachments/legacy-inline.png'),
			{ ...testEnv, db: recorder.db },
			createExecutionContext()
		);

		expect(response.status).toBe(404);
		expect(r2Service.getObj).not.toHaveBeenCalled();
	});

	it('blocks orphan attachment objects while keeping static object links compatible', async () => {
		const recorder = createDbStub();
		const ctx = createExecutionContext();
		r2Service.getObj.mockImplementation(async (c, key) => new Response(
			key.includes('inline-image') ? 'inline' : 'static',
			{ headers: { 'Content-Type': 'text/plain' } }
		));

		const inlineResponse = await worker.fetch(
			new Request('http://example.com/attachments/inline-image.png'),
			{ ...testEnv, db: recorder.db },
			ctx
		);
		const apiInlineResponse = await worker.fetch(
			new Request('http://example.com/api/oss/attachments/inline-image.png'),
			{ ...testEnv, db: recorder.db },
			ctx
		);
		const staticResponse = await worker.fetch(
			new Request('http://example.com/static/background/bg.png'),
			{ ...testEnv, db: recorder.db },
			ctx
		);
		const apiStaticResponse = await worker.fetch(
			new Request('http://example.com/api/oss/static/background/bg.png'),
			{ ...testEnv, db: recorder.db },
			ctx
		);
		await waitOnExecutionContext(ctx);

		expect(inlineResponse.status).toBe(404);
		expect(apiInlineResponse.status).toBe(404);
		expect(staticResponse.status).toBe(200);
		expect(await staticResponse.text()).toBe('static');
		expect(apiStaticResponse.status).toBe(404);
		expect(r2Service.getObj).not.toHaveBeenCalledWith(
			expect.anything(),
			'attachments/inline-image.png'
		);
		expect(r2Service.getObj).toHaveBeenCalledWith(
			expect.objectContaining({ env: expect.objectContaining({ db: recorder.db }) }),
			'static/background/bg.png'
		);
		expect(r2Service.getObj).toHaveBeenCalledTimes(1);
	});

	it('fails closed when the D1 public-attachment lookup is unavailable', async () => {
		const recorder = createDbStub({ publicLookupError: new Error('D1 unavailable') });
		r2Service.getObj.mockResolvedValue(new Response('must-not-leak'));

		const missingBindingResponse = await worker.fetch(
			new Request('http://example.com/attachments/inline-image.png'),
			{ ...testEnv, db: undefined },
			createExecutionContext()
		);
		const lookupErrorResponse = await worker.fetch(
			new Request('http://example.com/api/oss/attachments/inline-image.png'),
			{ ...testEnv, db: recorder.db },
			createExecutionContext()
		);

		expect(missingBindingResponse.status).toBe(404);
		expect(lookupErrorResponse.status).toBe(404);
		expect(r2Service.getObj).not.toHaveBeenCalled();
	});

	it('returns 404 response for missing static objects', async () => {
		const request = new Request('http://example.com/static/background/missing.jpeg');
		const ctx = createExecutionContext();
		r2Service.getObj.mockResolvedValue(null);

		const response = await worker.fetch(request, { ...testEnv }, ctx);
		await waitOnExecutionContext(ctx);

		expect(response).toBeInstanceOf(Response);
		expect(response.status).toBe(404);
	});

	it('does not serialize missing object metadata as null headers', async () => {
		const response = await kvObjService.getObj({
			env: {
				kv: {
					async getWithMetadata() {
						return {
							value: new TextEncoder().encode('object').buffer,
							metadata: { contentType: 'text/plain' }
						};
					}
				}
			}
		}, 'static/object.txt');

		expect(response.headers.get('Content-Type')).toBe('text/plain');
		expect(response.headers.get('Content-Disposition')).toBeNull();
		expect(response.headers.get('Cache-Control')).toBeNull();
	});

	it('keeps browser-safe inline KV metadata', async () => {
		const response = await kvObjService.getObj({
			env: {
				kv: {
					async getWithMetadata() {
						return {
							value: new ReadableStream({
								start(controller) {
									controller.enqueue(new TextEncoder().encode('image'));
									controller.close();
								}
							}),
							metadata: {
								contentType: 'image/png',
								contentDisposition: 'inline',
								cacheControl: 'max-age=259200'
							}
						};
					}
				}
			}
		}, 'attachments/inline.png');

		expect(response.headers.get('Content-Type')).toBe('image/png');
		expect(response.headers.get('Content-Disposition')).toBe('inline');
		expect(response.headers.get('Cache-Control')).toBe('max-age=259200');
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
			headers: { 'Content-Type': 'application/octet-stream' }
		}));

		const response = await attService.download({ env: { db: recorder.db } }, { attId: '10' }, 7);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('secret');
		expect(response.headers.get('Content-Disposition')).toContain('private.txt');
		expect(response.headers.get('Content-Type')).toBe('text/plain');
		expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, no-store');
		expect(r2Service.getObj).toHaveBeenCalledWith({ env: { db: recorder.db } }, 'attachments/private.txt');
	});

	it('rejects an authenticated download while the attachment is pending', async () => {
		const recorder = createDbStub({
			downloadRow: {
				attId: 11,
				userId: 7,
				emailId: 20,
				accountId: 30,
				key: 'attachments/pending.txt',
				filename: 'pending.txt',
				mimeType: 'text/plain',
				status: attConst.status.PENDING,
				type: attConst.type.ATT,
				contentId: null
			}
		});
		r2Service.getObj.mockResolvedValue(new Response('must-not-leak'));

		await expect(attService.download({ env: { db: recorder.db } }, { attId: '11' }, 7))
			.rejects.toMatchObject({ code: 404 });
		expect(r2Service.getObj).not.toHaveBeenCalled();
	});

	it('rejects a ready attachment download while its parent email is failed', async () => {
		const recorder = createDbStub({
			parentStatus: emailConst.status.FAILED,
			downloadRow: {
				attId: 12,
				userId: 7,
				emailId: 20,
				accountId: 30,
				key: 'attachments/partial.txt',
				filename: 'partial.txt',
				mimeType: 'text/plain',
				status: attConst.status.READY,
				type: attConst.type.ATT,
				contentId: null
			}
		});
		r2Service.getObj.mockResolvedValue(new Response('must-not-leak'));

		await expect(attService.download({ env: { db: recorder.db } }, { attId: '12' }, 7))
			.rejects.toMatchObject({ code: 404 });
		expect(r2Service.getObj).not.toHaveBeenCalled();
	});

	it('does not let another user promote a private attachment key to public inline content', async () => {
		const recorder = createAttachmentOwnerLookupDbStub([{
			att_id: 10,
			user_id: 7,
			email_id: 20,
			account_id: 30,
			key: 'attachments/victim-private.png',
			filename: 'victim-private.png',
			mime_type: 'image/png',
			size: 6,
			status: 0,
			type: attConst.type.ATT,
			content_id: null,
			create_time: '2026-07-17 00:00:00'
		}]);
		const settingSpy = vi.spyOn(settingService, 'query').mockResolvedValue({
			r2Domain: 'https://objects.example.com'
		});
		r2Service.getObj.mockResolvedValue(new Response('secret'));

		try {
			const result = await attService.toImageUrlHtml(
				{ env: { db: recorder.db } },
				'<img src="attachments/victim-private.png">',
				8
			);

			expect(result.imageDataList).toEqual([]);
			expect(r2Service.getObj).not.toHaveBeenCalled();
			expect(recorder.calls.some(call => call.bindings.includes(8))).toBe(true);
		} finally {
			settingSpy.mockRestore();
		}
	});

	it('streams KV object bodies without changing their contents', async () => {
		let readOptions;
		const response = await kvObjService.getObj({
			env: {
				kv: {
					async getWithMetadata(key, options) {
						readOptions = options;
						return {
							value: new ReadableStream({
								start(controller) {
									controller.enqueue(new TextEncoder().encode('streamed'));
									controller.close();
								}
							}),
							metadata: { contentType: 'text/plain' }
						};
					}
				}
			}
		}, 'attachments/streamed.txt');

		expect(readOptions).toEqual({ type: 'stream' });
		expect(await response.text()).toBe('streamed');
	});

	it('checks KV object existence by cancelling the stream without buffering it', async () => {
		const cancel = vi.fn(async () => {});
		const exists = await kvObjService.exists({
			env: {
				kv: {
					async getWithMetadata(key, options) {
						expect(key).toBe('attachments/exists.pdf');
						expect(options).toEqual({ type: 'stream' });
						return { value: { cancel }, metadata: null };
					}
				}
			}
		}, 'attachments/exists.pdf');

		expect(exists).toBe(true);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('uses R2 head metadata for existence checks instead of reading the object body', async () => {
		const head = vi.fn(async () => ({ key: 'attachments/exists.pdf', size: 10 }));
		const settingSpy = vi.spyOn(settingService, 'query').mockResolvedValue({});

		try {
			const exists = await actualR2Service.exists({ env: { r2: { head } } }, 'attachments/exists.pdf');

			expect(exists).toBe(true);
			expect(head).toHaveBeenCalledWith('attachments/exists.pdf');
		} finally {
			settingSpy.mockRestore();
		}
	});

	it('configures recovery S3 clients with a single request attempt', async () => {
		const settingSpy = vi.spyOn(settingService, 'query').mockResolvedValue({
			region: 'auto',
			endpoint: 'https://s3.example.com',
			s3AccessKey: 'test-access-key',
			s3SecretKey: 'test-secret-key',
			forcePathStyle: 0
		});

		try {
			const client = await s3Service.client({ env: {} }, { maxAttempts: 1 });
			expect(await client.config.maxAttempts()).toBe(1);
			client.destroy();
		} finally {
			settingSpy.mockRestore();
		}
	});

	it('uses the frontend contentType when saving sent attachments', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockImplementation(async (...args) => {
			recorder.operationLog.push({ type: 'put', args });
		});

		await attService.saveSendAtt({ env: { db: recorder.db } }, [{
			content: 'cGRm',
			filename: 'report.pdf',
			contentType: 'application/pdf'
		}], 7, 30, 20);

		expect(r2Service.putObj).toHaveBeenCalledWith(
			expect.anything(),
			expect.stringMatching(/^attachments\//),
			expect.any(Uint8Array),
			{ contentType: 'application/pdf' }
		);
		expect(recorder.operationLog.map(operation => operation.type)).toEqual(['insert', 'put', 'update']);
		expect(recorder.operationLog[0].bindings).toContain('application/pdf');
	});

	it('keeps sent attachment rows pending until their objects are stored', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockImplementation(async (...args) => {
			recorder.operationLog.push({ type: 'put', args });
		});

		await attService.saveSendAtt({ env: { db: recorder.db } }, [{
			content: 'cGRm',
			filename: 'stateful.pdf',
			contentType: 'application/pdf'
		}], 71, 301, 201);

		expect(recorder.operationLog.map(operation => operation.type))
			.toEqual(['insert', 'put', 'update']);
		expect(recorder.operationLog[0].bindings).toContain(attConst.status.PENDING);
		expect(recorder.operationLog[2].bindings).toContain(attConst.status.READY);
	});

	it('protects sent attachment keys even when object upload fails', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockRejectedValue(new Error('object upload failed'));

		await expect(attService.saveSendAtt({ env: { db: recorder.db } }, [{
			content: 'cGRm',
			filename: 'report.pdf',
			contentType: 'application/pdf'
		}], 7, 30, 20)).rejects.toThrow('object upload failed');

		expect(recorder.operationLog.map(operation => operation.type)).toEqual(['insert', 'update', 'update']);
		expect(recorder.operationLog[1].bindings).toContain(attConst.status.FAILED);
		expect(recorder.operationLog[2].bindings).toContain('BATCH_ABORTED');
	});

	it('marks unattempted sent attachments failed when an upload batch aborts', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj
			.mockImplementationOnce(async (...args) => {
				recorder.operationLog.push({ type: 'put', args });
			})
			.mockRejectedValueOnce(new Error('second object upload failed'));

		await expect(attService.saveSendAtt({ env: { db: recorder.db } }, [
			{ content: 'YQ==', filename: 'first.txt', contentType: 'text/plain' },
			{ content: 'Yg==', filename: 'second.txt', contentType: 'text/plain' },
			{ content: 'Yw==', filename: 'unattempted.txt', contentType: 'text/plain' }
		], 7, 30, 20)).rejects.toThrow('second object upload failed');

		expect(r2Service.putObj).toHaveBeenCalledTimes(2);
		expect(recorder.operationLog.some(operation => (
			operation.type === 'update'
			&& operation.bindings.includes(attConst.status.FAILED)
			&& operation.bindings.includes('BATCH_ABORTED')
			&& operation.bindings.includes(attConst.status.PENDING)
		))).toBe(true);
	});

	it('uploads duplicate sent attachment objects once while keeping both rows', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockResolvedValue();

		await attService.saveSendAtt({ env: { db: recorder.db } }, [
			{
				content: 'cGRm',
				filename: 'first.pdf',
				contentType: 'application/pdf'
			},
			{
				content: 'cGRm',
				filename: 'second.pdf',
				contentType: 'application/pdf'
			}
		], 7, 30, 20);

		expect(r2Service.putObj).toHaveBeenCalledTimes(1);
		expect(recorder.operationLog.map(operation => operation.type)).toEqual(['insert', 'update']);
		expect(recorder.operationLog[0].bindings.filter(value => value === 'application/pdf')).toHaveLength(2);
		expect(recorder.operationLog[0].bindings).toEqual(expect.arrayContaining(['first.pdf', 'second.pdf']));
	});

	it('stores received object disposition without persisting filenames', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockImplementation(async (...args) => {
			recorder.operationLog.push({ type: 'put', args });
		});

		await attService.addAtt({ env: { db: recorder.db } }, [
			{
				key: 'attachments/normal.pdf',
				content: new Uint8Array([1]),
				filename: '普通附件.pdf',
				mimeType: 'application/pdf',
				contentId: null
			},
			{
				key: 'attachments/inline.png',
				content: new Uint8Array([2]),
				filename: '内嵌图片.png',
				mimeType: 'image/png',
				contentId: 'cid-1',
				type: attConst.type.EMBED
			}
		]);

		expect(r2Service.putObj.mock.calls[0][3]).toEqual({ contentType: 'application/pdf' });
		expect(r2Service.putObj.mock.calls[1][3]).toEqual({
			contentType: 'image/png',
			contentDisposition: 'inline',
			cacheControl: 'max-age=259200'
		});
		// 并行写对象后一次批量置 READY：insert -> put/put(并行) -> update
		expect(recorder.operationLog.map(operation => operation.type))
			.toEqual(['insert', 'put', 'put', 'update']);
		expect(recorder.operationLog[0].bindings).toContain(attConst.type.EMBED);
	});

	it('persists received attachments as pending before upload and marks them ready afterwards', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockImplementation(async (...args) => {
			recorder.operationLog.push({ type: 'put', args });
		});

		await attService.addAtt({ env: { db: recorder.db } }, [{
			userId: 71,
			emailId: 201,
			accountId: 301,
			key: 'attachments/stateful.pdf',
			content: new Uint8Array([1]),
			filename: 'stateful.pdf',
			mimeType: 'application/pdf'
		}]);

		expect(recorder.operationLog.map(operation => operation.type))
			.toEqual(['insert', 'put', 'update']);
		expect(recorder.operationLog[0].bindings).toContain(2);
		expect(recorder.operationLog[2].bindings).toContain(0);
	});

	it('marks received attachment rows failed with a bounded safe reason when object storage fails', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockRejectedValue(new Error(`provider secret ${'x'.repeat(500)}`));

		await expect(attService.addAtt({ env: { db: recorder.db } }, [{
			userId: 71,
			emailId: 202,
			accountId: 301,
			key: 'attachments/failed.pdf',
			content: new Uint8Array([1]),
			filename: 'failed.pdf',
			mimeType: 'application/pdf'
		}])).rejects.toThrow('Attachment object storage failed');

		expect(recorder.operationLog.map(operation => operation.type)).toEqual(['insert', 'update', 'update']);
		expect(recorder.operationLog[1].bindings).toContain(3);
		expect(recorder.operationLog[1].bindings).toContain('OBJECT_WRITE_FAILED');
		expect(recorder.operationLog[2].bindings).toContain('BATCH_ABORTED');
		expect(recorder.operationLog[1].bindings.join(' ')).not.toContain('provider secret');
	});

	it('marks all received attachments failed when any parallel upload aborts', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj
			.mockImplementationOnce(async (...args) => {
				recorder.operationLog.push({ type: 'put', args });
			})
			.mockRejectedValueOnce(new Error('second object upload failed'));

		await expect(attService.addAtt({ env: { db: recorder.db } }, [
			{
				userId: 71,
				emailId: 203,
				accountId: 301,
				key: 'attachments/first.pdf',
				content: new Uint8Array([1]),
				filename: 'first.pdf',
				mimeType: 'application/pdf'
			},
			{
				userId: 71,
				emailId: 203,
				accountId: 301,
				key: 'attachments/second.pdf',
				content: new Uint8Array([2]),
				filename: 'second.pdf',
				mimeType: 'application/pdf'
			},
			{
				userId: 71,
				emailId: 203,
				accountId: 301,
				key: 'attachments/unattempted.pdf',
				content: new Uint8Array([3]),
				filename: 'unattempted.pdf',
				mimeType: 'application/pdf'
			}
		])).rejects.toThrow('Attachment object storage failed');

		// 三段式并行写：3 个对象都会被尝试（不再有"未尝试项"）
		expect(r2Service.putObj).toHaveBeenCalledTimes(3);
		expect(recorder.operationLog.some(operation => (
			operation.type === 'update'
			&& operation.bindings.includes(attConst.status.FAILED)
			&& operation.bindings.includes('OBJECT_WRITE_FAILED')
			&& operation.bindings.includes(attConst.status.PENDING)
		))).toBe(true);
		expect(recorder.operationLog.some(operation => (
			operation.type === 'update'
			&& operation.bindings.includes('BATCH_ABORTED')
		))).toBe(true);
	});

	it('uploads duplicate received attachment objects once', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockResolvedValue();

		await attService.addAtt({ env: { db: recorder.db } }, [
			{
				key: 'attachments/same.pdf',
				content: new Uint8Array([1]),
				filename: 'first.pdf',
				mimeType: 'application/pdf',
				contentId: null
			},
			{
				key: 'attachments/same.pdf',
				content: new Uint8Array([1]),
				filename: 'second.pdf',
				mimeType: 'application/pdf',
				contentId: null
			}
		]);

		expect(r2Service.putObj).toHaveBeenCalledTimes(1);
		expect(recorder.operationLog.map(operation => operation.type)).toEqual(['insert', 'update']);
		expect(recorder.operationLog[0].bindings).toEqual(expect.arrayContaining(['first.pdf', 'second.pdf']));
	});

	it('stores sent inline disposition without persisting filenames', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockResolvedValue();

		await attService.saveArticleAtt({ env: { db: recorder.db } }, [{
			key: 'attachments/inline.png',
			buff: new Uint8Array([1]),
			filename: '正文图片.png',
			mimeType: 'image/png',
			contentId: 'cid-1'
		}], 7, 30, 20);

		expect(r2Service.putObj.mock.calls[0][3]).toEqual({
			contentType: 'image/png',
			contentDisposition: 'inline',
			cacheControl: 'max-age=259200'
		});
	});

	it('keeps sent inline rows pending until their objects are confirmed', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockImplementation(async (...args) => {
			recorder.operationLog.push({ type: 'put', args });
		});

		await attService.saveArticleAtt({ env: { db: recorder.db } }, [{
			key: 'attachments/stateful-inline.png',
			buff: new Uint8Array([1]),
			filename: 'stateful-inline.png',
			mimeType: 'image/png',
			contentId: 'cid-stateful'
		}], 71, 301, 201);

		expect(recorder.operationLog.map(operation => operation.type))
			.toEqual(['insert', 'put', 'update']);
		expect(recorder.operationLog[0].bindings).toContain(attConst.status.PENDING);
		expect(recorder.operationLog[2].bindings).toContain(attConst.status.READY);
	});

	it('marks unattempted inline attachments failed when an upload batch aborts', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj
			.mockImplementationOnce(async (...args) => {
				recorder.operationLog.push({ type: 'put', args });
			})
			.mockRejectedValueOnce(new Error('second inline upload failed'));

		await expect(attService.saveArticleAtt({ env: { db: recorder.db } }, [
			{
				key: 'attachments/first.png',
				buff: new Uint8Array([1]),
				filename: 'first.png',
				mimeType: 'image/png',
				contentId: 'cid-first'
			},
			{
				key: 'attachments/second.png',
				buff: new Uint8Array([2]),
				filename: 'second.png',
				mimeType: 'image/png',
				contentId: 'cid-second'
			},
			{
				key: 'attachments/unattempted.png',
				buff: new Uint8Array([3]),
				filename: 'unattempted.png',
				mimeType: 'image/png',
				contentId: 'cid-unattempted'
			}
		], 7, 30, 20)).rejects.toThrow('second inline upload failed');

		expect(r2Service.putObj).toHaveBeenCalledTimes(2);
		expect(recorder.operationLog.some(operation => (
			operation.type === 'update'
			&& operation.bindings.includes(attConst.status.FAILED)
			&& operation.bindings.includes('BATCH_ABORTED')
			&& operation.bindings.includes(attConst.status.PENDING)
		))).toBe(true);
	});

	it('uploads duplicate sent inline attachment objects once', async () => {
		const recorder = createInsertDbStub();
		r2Service.putObj.mockResolvedValue();

		await attService.saveArticleAtt({ env: { db: recorder.db } }, [
			{
				key: 'attachments/same.png',
				buff: new Uint8Array([1]),
				filename: 'first.png',
				mimeType: 'image/png',
				contentId: 'cid-1'
			},
			{
				key: 'attachments/same.png',
				buff: new Uint8Array([1]),
				filename: 'second.png',
				mimeType: 'image/png',
				contentId: 'cid-2'
			}
		], 7, 30, 20);

		expect(r2Service.putObj).toHaveBeenCalledTimes(1);
		expect(recorder.operationLog.map(operation => operation.type)).toEqual(['insert', 'update']);
		expect(recorder.operationLog[0].bindings).toEqual(expect.arrayContaining(['cid-1', 'cid-2']));
	});

	it('uses a buffered duplicate when the first inline row only references an existing key', async () => {
		const recorder = createInsertDbStub();
		const existsSpy = vi.spyOn(r2Service, 'exists');
		r2Service.putObj.mockResolvedValue();

		try {
			await attService.saveArticleAtt({ env: { db: recorder.db } }, [
				{
					key: 'attachments/mixed.png',
					filename: 'reference.png',
					mimeType: 'image/png',
					contentId: 'cid-reference'
				},
				{
					key: 'attachments/mixed.png',
					buff: new Uint8Array([9]),
					filename: 'buffered.png',
					mimeType: 'image/png',
					contentId: 'cid-buffered'
				}
			], 7, 30, 20);

			expect(r2Service.putObj).toHaveBeenCalledTimes(1);
			expect(r2Service.putObj.mock.calls[0][2]).toEqual(new Uint8Array([9]));
			expect(existsSpy).not.toHaveBeenCalled();
		} finally {
			existsSpy.mockRestore();
		}
	});

	it('omits legacy non-ASCII Content-Disposition metadata from KV responses', async () => {
		const filename = '工程全过程造价咨询服务方案工程全过程投标技术方案(最全).pdf';
		const size = 3_392_297;
		let readOptions;
		const response = await kvObjService.getObj({
			env: {
				kv: {
					async getWithMetadata(key, options) {
						readOptions = options;
						return {
							value: new ReadableStream({
								start(controller) {
									controller.enqueue(new Uint8Array(size));
									controller.close();
								}
							}),
							metadata: {
								contentType: 'application/pdf',
								contentDisposition: `attachment;filename=${filename}`
							}
						};
					}
				}
			}
		}, 'attachments/legacy-chinese-name.pdf');

		expect(readOptions).toEqual({ type: 'stream' });
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/pdf');
		expect(response.headers.get('Content-Disposition')).toBeNull();
		expect((await response.arrayBuffer()).byteLength).toBe(size);
	});

	it('omits legacy non-ASCII Content-Disposition metadata from R2 responses', async () => {
		const response = r2Service.toResponse({
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('pdf'));
					controller.close();
				}
			}),
			httpMetadata: {
				contentType: 'application/pdf',
				contentDisposition: 'attachment;filename=工程方案.pdf'
			},
			writeHttpMetadata() {
				throw new Error('unsafe metadata path should not be used');
			}
		});

		expect(response.headers.get('Content-Type')).toBe('application/pdf');
		expect(response.headers.get('Content-Disposition')).toBeNull();
		expect(await response.text()).toBe('pdf');
	});

	it('rethrows unexpected R2 metadata writer failures', () => {
		expect(() => r2Service.toResponse({
			body: new ReadableStream({
				start(controller) {
					controller.close();
				}
			}),
			writeHttpMetadata() {
				throw new Error('metadata writer failed');
			}
		})).toThrow('metadata writer failed');
	});

	it('does not write non-ASCII HTTP metadata to object storage', async () => {
		const put = vi.fn();
		const settingSpy = vi.spyOn(settingService, 'query').mockResolvedValue({});

		try {
			await actualR2Service.putObj({ env: { r2: { put } } }, 'attachments/file.pdf', new Uint8Array([1]), {
				contentType: 'application/pdf',
				contentDisposition: 'attachment;filename=工程方案.pdf'
			});

			expect(put).toHaveBeenCalledWith(
				'attachments/file.pdf',
				expect.any(Uint8Array),
				{ httpMetadata: { contentType: 'application/pdf' } }
			);
		} finally {
			settingSpy.mockRestore();
		}
	});

	it('omits legacy non-ASCII Content-Disposition metadata from S3 responses', async () => {
		const clientSpy = vi.spyOn(s3Service, 'client').mockResolvedValue({
			async send() {
				return {
					Body: new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('pdf'));
							controller.close();
						}
					}),
					ContentType: 'application/pdf',
					ContentDisposition: 'attachment;filename=工程方案.pdf'
				};
			}
		});
		const settingSpy = vi.spyOn(settingService, 'query').mockResolvedValue({ bucket: 'bucket' });

		try {
			const response = await s3Service.getObj({ env: {} }, 'attachments/file.pdf');

			expect(response.headers.get('Content-Type')).toBe('application/pdf');
			expect(response.headers.get('Content-Disposition')).toBeNull();
			expect(await response.text()).toBe('pdf');
		} finally {
			clientSpy.mockRestore();
			settingSpy.mockRestore();
		}
	});

	it('uses an S3 HEAD request for object existence checks', async () => {
		const send = vi.fn(async command => {
			expect(command.constructor.name).toBe('HeadObjectCommand');
			return {};
		});
		const clientSpy = vi.spyOn(s3Service, 'client').mockResolvedValue({ send });
		const settingSpy = vi.spyOn(settingService, 'query').mockResolvedValue({ bucket: 'bucket' });

		try {
			expect(await s3Service.exists({ env: {} }, 'attachments/file.pdf')).toBe(true);
			expect(send).toHaveBeenCalledOnce();
		} finally {
			clientSpy.mockRestore();
			settingSpy.mockRestore();
		}
	});

	it('uses an ASCII RFC 5987 download header for non-ASCII filenames', async () => {
		const filename = '工程全过程造价咨询服务方案.pdf';
		const recorder = createDbStub({
			downloadRow: {
				attId: 57,
				userId: 7,
				emailId: 20,
				accountId: 30,
				key: 'attachments/legacy-chinese-name.pdf',
				filename,
				mimeType: 'application/pdf',
				size: 3_392_297,
				type: attConst.type.ATT,
				contentId: null
			}
		});
		r2Service.getObj.mockResolvedValue(new Response('pdf', {
			headers: { 'Content-Type': 'application/pdf' }
		}));

		const response = await attService.download({ env: { db: recorder.db } }, { attId: '57' }, 7);
		const header = response.headers.get('Content-Disposition');

		expect(header).toContain(`filename*=UTF-8''${encodeURIComponent(filename)}`);
		expect(header).not.toMatch(/[^\x00-\x7F]/);
	});

	it('RFC 5987-encodes reserved filename characters', async () => {
		const filename = "O'Reilly (final)*.pdf";
		const recorder = createDbStub({
			downloadRow: {
				attId: 58,
				userId: 7,
				key: 'attachments/file.pdf',
				filename,
				mimeType: 'application/pdf',
				type: attConst.type.ATT,
				contentId: null
			}
		});
		r2Service.getObj.mockResolvedValue(new Response('pdf'));

		const response = await attService.download({ env: { db: recorder.db } }, { attId: '58' }, 7);

		expect(response.headers.get('Content-Disposition'))
			.toContain("filename*=UTF-8''O%27Reilly%20%28final%29%2A.pdf");
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
		expect(recorder.calls[0].bindings).toEqual([
			10,
			attConst.type.ATT,
			attConst.status.READY,
			emailConst.status.SAVING,
			emailConst.status.FAILED
		]);
	});
});
