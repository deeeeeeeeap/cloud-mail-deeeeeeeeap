import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/init/init', () => ({
	dbInit: {
		v3_0DB: vi.fn(),
		v3_1DB: vi.fn(),
		v3_2DB: vi.fn(),
		v3_3DB: vi.fn(),
		v3_4DB: vi.fn(),
		v3_5DB: vi.fn(),
		v3_6DB: vi.fn(),
		v3_7DB: vi.fn(),
		v3_8DB: vi.fn(),
		v3_9DB: vi.fn(),
		invalidateBootstrapStatus: vi.fn(),
		runOptionalSqlList: vi.fn(),
		runMigrationSteps: vi.fn(async steps => {
			for (const [, operation] of steps) await operation();
		}),
		assertBootstrapReady: vi.fn(async () => ({ ready: true }))
	}
}));

vi.mock('../src/service/delivery-attempt-service', () => ({
	default: {
		health: vi.fn(),
		reconcile: vi.fn(),
		resolveUnknown: vi.fn()
	}
}));

vi.mock('../src/service/email-service', () => ({
	RECEIVE_RECOVERY_EMAIL_LIMIT: 2,
	default: {
		completeReceiveAll: vi.fn()
	}
}));

vi.mock('../src/service/email-search-service', () => ({
	default: {
		syncEmailIds: vi.fn()
	}
}));

const { dbInit } = await import('../src/init/init');
const { default: emailSearchService } = await import('../src/service/email-search-service');
const { default: deliveryAttemptService } = await import('../src/service/delivery-attempt-service');
const { default: emailService } = await import('../src/service/email-service');
const { default: maintenanceService } = await import('../src/service/maintenance-service');

function createMaintenanceDb(selectBatches = []) {
	const statements = [];
	const batched = [];
	const queue = [...selectBatches];
	return {
		statements,
		batched,
		db: {
			prepare(sql) {
				const statement = {
					sql,
					bindings: [],
					bind(...args) {
						this.bindings = args;
						return this;
					},
					async all() {
						if (sql.includes('FROM email')) {
							return { results: queue.length > 0 ? queue.shift() : [] };
						}
						return { results: [] };
					},
					async run() {
						return { success: true };
					}
				};
				statements.push(statement);
				return statement;
			},
			async batch(items) {
				batched.push(...items);
				return items.map(() => ({ success: true }));
			}
		}
	};
}

describe('maintenance service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
		deliveryAttemptService.health.mockResolvedValue({
			total: 0,
			unresolved: 0,
			counts: {}
		});
	});

	it('reports missing bindings without exposing secrets', async () => {
		const result = await maintenanceService.health({ env: {} });

		expect(result.ok).toBe(false);
		expect(result.checks.find(item => item.key === 'd1').ok).toBe(false);
		expect(JSON.stringify(result)).not.toMatch(/token|secret|password/i);
	});

	it('keeps health usable when the search table has not been created yet', async () => {
		const c = {
			env: {
				db: {
					prepare(sql) {
						return {
							bind() {
								return this;
							},
							async all() {
								if (sql.includes('PRAGMA table_info(email)')) {
									return { results: [{ name: 'email_id' }] };
								}
								if (sql.includes("type = 'index'")) {
									return { results: [] };
								}
								if (sql.includes('EXPLAIN QUERY PLAN')) {
									return { results: [] };
								}
								return { results: [] };
							},
							async first() {
								if (sql.includes("name = 'email_search'")) {
									return null;
								}
								if (sql.includes('COUNT(*) AS total FROM email_search')) {
									throw new Error('no such table: email_search');
								}
								if (sql.includes('COUNT(*) AS total FROM email')) {
									return { total: 7 };
								}
								return null;
							}
						};
					}
				}
			}
		};

		const result = await maintenanceService.health(c);

		expect(result.details.emailTotal).toBe(7);
		expect(result.details.emailSearchRows).toBe(0);
		expect(result.checks.find(item => item.key === 'emailSearch').ok).toBe(false);
	});

	it('reports incoming recovery attachment columns as part of schema health', async () => {
		const emailColumns = [
			'email_id', 'send_email', 'name', 'account_id', 'user_id', 'subject', 'code',
			'text', 'content', 'to_email', 'type', 'status', 'attachment_count', 'recovery_after', 'unread', 'is_del'
		];
		const c = {
			env: {
				db: {
					prepare(sql) {
						return {
							bind() {
								return this;
							},
							async all() {
								if (sql.includes('PRAGMA table_info(email)')) {
									return { results: emailColumns.map(name => ({ name })) };
								}
								if (sql.includes('PRAGMA table_info(attachments)')) {
									return { results: [{ name: 'att_id' }, { name: 'status' }] };
								}
								return { results: [] };
							},
							async first() {
								return { total: 0 };
							}
						};
					}
				}
			}
		};

		const result = await maintenanceService.health(c);

		expect(result.checks.find(item => item.key === 'schema').ok).toBe(false);
		expect(result.details.missingAttachmentColumns).toContain('message');
	});

	it('reports unresolved delivery attempts in maintenance health', async () => {
		deliveryAttemptService.health.mockResolvedValue({
			total: 3,
			unresolved: 2,
			counts: {
				ACCEPTED: 1,
				UNKNOWN: 1,
				PENDING_ACK: 1
			}
		});
		const c = {
			env: {
				db: {
					prepare(sql) {
						return {
							bind() {
								return this;
							},
							async all() {
								return { results: [] };
							},
							async first() {
								return sql.includes('COUNT(*)') ? { total: 0 } : null;
							}
						};
					}
				}
			}
		};

		const result = await maintenanceService.health(c);

		expect(result.details.deliveryAttempts).toMatchObject({
			total: 3,
			unresolved: 2,
			counts: {
				UNKNOWN: 1,
				PENDING_ACK: 1
			}
		});
		expect(result.checks.find(item => item.key === 'deliveryAttempts')).toMatchObject({
			ok: false
		});
		expect(result.details.resendWebhookEventTable).toBe(false);
		expect(result.details.missingResendWebhookEventColumns).toContain('status');
	});

	it('keeps maintenance health usable when delivery_attempt exists but is missing columns', async () => {
		deliveryAttemptService.health.mockRejectedValue(new Error('no such column: status'));
		const c = {
			env: {
				db: {
					prepare(sql) {
						return {
							bind() {
								return this;
							},
							async all() {
								if (sql.includes('PRAGMA table_info(delivery_attempt)')) {
									return { results: [{ name: 'attempt_id' }] };
								}
								return { results: [] };
							},
							async first() {
								if (sql.includes("name = 'delivery_attempt'")) {
									return { name: 'delivery_attempt' };
								}
								return sql.includes('COUNT(*)') ? { total: 0 } : null;
							}
						};
					}
				}
			}
		};

		const result = await maintenanceService.health(c);

		expect(result.checks.find(item => item.key === 'schema').ok).toBe(false);
		expect(result.details.deliveryAttempts).toEqual({
			total: 0,
			unresolved: 0,
			counts: {}
		});
	});

	it('reports named durable identity indexes as missing when they are not unique', async () => {
		const c = {
			env: {
				db: {
					prepare(sql) {
						return {
							bind() {
								return this;
							},
							async all() {
								if (sql.includes("type = 'index'")) {
									return {
										results: [
											{ name: 'idx_delivery_attempt_email' },
											{ name: 'idx_delivery_attempt_provider_message' },
											{ name: 'idx_resend_webhook_event_key' }
										]
									};
								}
								if (sql.includes('PRAGMA index_list(delivery_attempt)')) {
									return {
										results: [
											{ name: 'idx_delivery_attempt_email', unique: 0 },
											{ name: 'idx_delivery_attempt_provider_message', unique: 0 }
										]
									};
								}
								if (sql.includes('PRAGMA index_list(resend_webhook_event)')) {
									return {
										results: [{ name: 'idx_resend_webhook_event_key', unique: 0 }]
									};
								}
								return { results: [] };
							},
							async first() {
								return sql.includes('COUNT(*)') ? { total: 0 } : null;
							}
						};
					}
				}
			}
		};

		const result = await maintenanceService.health(c);

		expect(result.details.missingIndexes).toEqual(expect.arrayContaining([
			'idx_delivery_attempt_email',
			'idx_delivery_attempt_provider_message',
			'idx_resend_webhook_event_key'
		]));
	});

	it('rejects repair requests when D1 is not configured', async () => {
		await expect(maintenanceService.repair({ env: {} }, 'indexes')).rejects.toThrow('D1 binding is missing');
	});

	it('rejects unknown repair actions', async () => {
		const c = { env: { db: { prepare: vi.fn() } } };

		await expect(maintenanceService.repair(c, 'unknown')).rejects.toThrow('Unknown maintenance action');
	});

	it('reconciles delivery attempts without calling an external provider', async () => {
		const c = { env: { db: { prepare: vi.fn() } } };
		deliveryAttemptService.reconcile.mockResolvedValue({
			scanned: 4,
			repaired: 2,
			unknown: 1,
			failed: 1
		});
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		const result = await maintenanceService.repair(c, 'delivery-reconcile');

		expect(deliveryAttemptService.reconcile).toHaveBeenCalledWith(c);
		expect(result.lastAction).toEqual({
			action: 'delivery-reconcile',
			scanned: 4,
			repaired: 2,
			unknown: 1,
			failed: 1
		});
	});

	it('drains stuck inbound emails through the receive-recover action', async () => {
		const c = { env: { db: { prepare: vi.fn() } } };
		const countSpy = vi.spyOn(maintenanceService, 'countPendingReceive')
			.mockResolvedValueOnce(5)
			.mockResolvedValueOnce(2);
		emailService.completeReceiveAll.mockResolvedValue({ scanned: 2, resolved: 1, batch: 2 });
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		const result = await maintenanceService.repair(c, 'receive-recover');

		expect(emailService.completeReceiveAll).toHaveBeenCalledWith(c);
		expect(countSpy).toHaveBeenCalledTimes(2);
		expect(result.lastAction).toEqual({
			action: 'receive-recover',
			batch: 2,
			scanned: 2,
			resolved: 1,
			before: 5,
			after: 2
		});
	});

	it('acknowledges UNKNOWN delivery attempts through the manual ack action', async () => {
		const c = { env: { db: { prepare: vi.fn() } } };
		deliveryAttemptService.resolveUnknown.mockResolvedValue({
			outcome: 'accepted',
			scanned: 3,
			resolved: 3
		});
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		const result = await maintenanceService.repair(c, 'delivery-ack-unknown');

		expect(deliveryAttemptService.resolveUnknown).toHaveBeenCalledWith(c, { outcome: 'accepted' });
		expect(result.lastAction).toEqual({
			action: 'delivery-ack-unknown',
			outcome: 'accepted',
			scanned: 3,
			resolved: 3
		});
	});

	it('fails UNKNOWN delivery attempts through the manual fail action', async () => {
		const c = { env: { db: { prepare: vi.fn() } } };
		deliveryAttemptService.resolveUnknown.mockResolvedValue({
			outcome: 'failed',
			scanned: 2,
			resolved: 1
		});
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		const result = await maintenanceService.repair(c, 'delivery-fail-unknown');

		expect(deliveryAttemptService.resolveUnknown).toHaveBeenCalledWith(c, { outcome: 'failed' });
		expect(result.lastAction).toEqual({
			action: 'delivery-fail-unknown',
			outcome: 'failed',
			scanned: 2,
			resolved: 1
		});
	});

	it('repairs the webhook event schema through the protected schema action', async () => {
		const c = { env: { db: { prepare: vi.fn() } } };
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		await maintenanceService.repair(c, 'schema');

		expect(dbInit.v3_7DB).toHaveBeenCalledWith(c);
		expect(dbInit.v3_8DB).toHaveBeenCalledWith(c);
		expect(dbInit.v3_9DB).toHaveBeenCalledWith(c);
		expect(dbInit.assertBootstrapReady).toHaveBeenCalledWith(c);
		expect(dbInit.invalidateBootstrapStatus).toHaveBeenCalledTimes(2);
	});

	it('rebuilds search table in cursor batches without loading every id at once', async () => {
		const statements = [];
		const selectBatches = [[{ emailId: 1 }, { emailId: 2 }], []];
		const c = {
			env: {
				db: {
					prepare(sql) {
						statements.push(sql);
						const statement = {
							bindings: [],
							bind(...args) {
								statement.bindings = args;
								return statement;
							},
							async run() {},
							async all() {
								return { results: selectBatches.shift() || [] };
							}
						};
						return statement;
					}
				}
			}
		};
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		await maintenanceService.repair(c, 'search');

		expect(dbInit.runOptionalSqlList).toHaveBeenCalled();
		expect(statements).toContain('DELETE FROM email_search');
		expect(statements.some(sql => sql.includes('WHERE email_id > ?'))).toBe(true);
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledTimes(1);
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [1, 2]);
	});

	it('repairs code indexes with the expected index statements', async () => {
		const c = { env: { db: { prepare: vi.fn() } } };
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		await maintenanceService.repair(c, 'indexes');

		expect(dbInit.v3_4DB).toHaveBeenCalledWith(c);
		const sqlList = dbInit.runOptionalSqlList.mock.calls[0][1].join('\n');
		expect(sqlList).toContain('idx_email_user_account_type_del_id');
		expect(sqlList).toContain('idx_email_user_type_del_id');
		expect(sqlList).toContain('idx_email_type_status_id');
		expect(sqlList).toContain('idx_attachments_email_type');
		expect(sqlList).toContain('idx_star_user_email');
		expect(sqlList).toContain('idx_email_user_code_id');
		expect(sqlList).toContain('idx_email_code_id');
		expect(sqlList).toContain('idx_verify_record_ip_type');
		expect(dbInit.invalidateBootstrapStatus).toHaveBeenCalledTimes(2);
	});

	it('cleans false positive verification codes by rescanning existing code rows', async () => {
		const recorder = createMaintenanceDb([
			[
				{
					emailId: 1,
					code: '20260518',
					subject: 'Security alert: new login from Windows',
					text: 'We noticed a sign-in from IP 192.168.1.18 on 2026-05-18 using Chrome 126.0.0.1.',
					html: ''
				},
				{
					emailId: 2,
					code: '922951',
					subject: 'Your login code',
					text: '922951',
					html: ''
				}
			],
			[]
		]);
		const c = { env: { db: recorder.db } };
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		const result = await maintenanceService.repair(c, 'codes-clean');

		expect(result.lastAction).toMatchObject({
			action: 'codes-clean',
			scanned: 2,
			updated: 1,
			cleared: 1,
			backfilled: 0
		});
		expect(recorder.batched).toHaveLength(1);
		expect(recorder.batched[0].sql).toContain('WHERE email_id = ? AND code = ?');
		expect(recorder.batched[0].bindings).toEqual(['', 1, '20260518']);
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [1]);
	});

	it('rescans all received emails and backfills missed alphanumeric codes', async () => {
		const recorder = createMaintenanceDb([
			[
				{
					emailId: 3,
					code: '',
					subject: 'Your sign-in verification code',
					text: 'Enter verification code AB12CD to continue.',
					html: ''
				}
			],
			[]
		]);
		const c = { env: { db: recorder.db } };
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		const result = await maintenanceService.repair(c, 'codes-rescan');

		expect(result.lastAction).toMatchObject({
			action: 'codes-rescan',
			scanned: 1,
			updated: 1,
			cleared: 0,
			backfilled: 1
		});
		expect(recorder.batched).toHaveLength(1);
		expect(recorder.batched[0].sql).toContain("WHERE email_id = ? AND code = ''");
		expect(recorder.batched[0].bindings).toEqual(['AB12CD', 3]);
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [3]);
	});

	it('clears all expired site-wide verification codes in safe batches', async () => {
		const recorder = createMaintenanceDb([
			[{ emailId: 7 }, { emailId: 8 }],
			[]
		]);
		const c = { env: { db: recorder.db } };
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		const result = await maintenanceService.repair(c, 'codes-clear-stale');

		expect(result.lastAction).toMatchObject({
			action: 'codes-clear-stale',
			scanned: 2,
			updated: 2,
			cleared: 2,
			backfilled: 0
		});
		const update = recorder.statements.find(item => item.sql.includes('UPDATE email') && item.sql.includes('SET code'));
		expect(update.sql).toContain('AND code != ?');
		expect(update.sql).toContain("datetime(create_time) < datetime('now', ?)");
		expect(update.bindings).toEqual(['', 7, 8, '', 6, 0, '-15 minutes']);
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [7, 8]);
	});

	it('clears expired codes in chunks that respect the D1 bind limit', async () => {
		const rows = Array.from({ length: 100 }, (_, index) => ({ emailId: index + 1 }));
		const recorder = createMaintenanceDb([rows, []]);
		const c = { env: { db: recorder.db } };
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		const result = await maintenanceService.repair(c, 'codes-clear-stale');

		expect(result.lastAction).toMatchObject({
			action: 'codes-clear-stale',
			cleared: 100
		});

		const updates = recorder.batched.filter(item => item.sql.includes('UPDATE email') && item.sql.includes('SET code'));
		expect(updates).toHaveLength(2);
		expect(updates[0].bindings).toHaveLength(95);
		expect(updates[1].bindings).toHaveLength(15);
		updates.forEach(update => {
			expect(update.bindings.length).toBeLessThanOrEqual(100);
		});
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, rows.map(row => row.emailId));
	});

	it('can dry-run expired code clearing without updating rows', async () => {
		const recorder = createMaintenanceDb([
			[{ emailId: 9 }, { emailId: 10 }]
		]);
		const c = { env: { db: recorder.db, code_stale_minutes: '30' } };

		const result = await maintenanceService.clearStaleCodes(c, { dryRun: true });

		expect(result).toMatchObject({
			action: 'codes-clear-stale',
			scanned: 2,
			updated: 0,
			cleared: 0,
			dryRun: true,
			staleMinutes: 30
		});
		expect(recorder.statements.some(item => item.sql.includes('UPDATE email') && item.sql.includes('SET code'))).toBe(false);
		expect(emailSearchService.syncEmailIds).not.toHaveBeenCalled();
	});
});
