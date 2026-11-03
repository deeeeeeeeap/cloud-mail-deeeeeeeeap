import { describe, expect, it } from 'vitest';
import {
	BOOTSTRAP_STATUS_CACHE_TTL_MS,
	getBootstrapStatus,
	invalidateBootstrapStatusCache
} from '../src/init/status';

const TABLES = [
	'email_search', 'public_send_rate_limit', 'auth_failure_limit', 'oauth_auth_state',
	'oauth_bind_challenge', 'oauth', 'setting', 'verify_record', 'reg_key', 'user',
	'account', 'role', 'perm', 'role_perm', 'email', 'star', 'attachments',
	'delivery_attempt', 'resend_webhook_event'
];

const INDEXES = [
	'idx_oauth_platform_user_unique', 'idx_oauth_auth_state_initiator_expires_at',
	'idx_email_receive_recovery', 'idx_email_receive_recovery_due',
	'idx_attachments_email_status_key', 'idx_delivery_attempt_key',
	'idx_delivery_attempt_status_time', 'idx_delivery_attempt_email',
	'idx_delivery_attempt_provider_message', 'idx_resend_webhook_event_key',
	'idx_resend_webhook_event_status_time', 'idx_resend_webhook_event_provider_email',
	'idx_verify_record_ip_type'
];

function createReadyDb({ batchGate, ready = true, failBatch = false } = {}) {
	const metrics = { batchCalls: 0, allCalls: 0, firstCalls: 0 };

	function allResult(sql) {
		if (sql.includes("type = 'table'")) return { results: TABLES.map(name => ({ name })) };
		if (sql.includes("type = 'index'")) return { results: INDEXES.map(name => ({ name })) };
		if (sql.includes('PRAGMA table_info(email)')) {
			return { results: ['attachment_count', 'recovery_after'].map(name => ({ name })) };
		}
		if (sql.includes('PRAGMA table_info(attachments)')) {
			return { results: ['status', 'message'].map(name => ({ name })) };
		}
		if (sql.includes('PRAGMA table_info(delivery_attempt)')) {
			return { results: [
				'attempt_id', 'email_id', 'provider', 'attempt_key', 'status',
				'provider_message_id', 'error_summary', 'create_time', 'update_time'
			].map(name => ({ name })) };
		}
		if (sql.includes('PRAGMA table_info(resend_webhook_event)')) {
			return { results: [
				'event_key', 'svix_id', 'body_sha256', 'event_type', 'provider_email_id',
				'status', 'outcome', 'received_at', 'processed_at'
			].map(name => ({ name })) };
		}
		if (sql.includes('PRAGMA index_list(delivery_attempt)')) {
			return { results: [
				'idx_delivery_attempt_key', 'idx_delivery_attempt_email',
				'idx_delivery_attempt_provider_message'
			].map(name => ({ name, unique: 1 })) };
		}
		if (sql.includes('PRAGMA index_list(resend_webhook_event)')) {
			return { results: [{ name: 'idx_resend_webhook_event_key', unique: 1 }] };
		}
		return { results: [] };
	}

	const db = {
		metrics,
		prepare(sql) {
			return {
				sql,
				bind() { return this; },
				async all() {
					metrics.allCalls++;
					return allResult(sql);
				},
				async first() {
					metrics.firstCalls++;
					if (sql.includes('AS initialized') && sql.includes('AS adminCreated')) {
						return ready
							? { initialized: 1, adminCreated: 1 }
							: { initialized: 0, adminCreated: 0 };
					}
					return sql.includes('FROM setting')
						? { initialized: 1 }
						: { created: 1 };
				}
			};
		},
		async batch(statements) {
			metrics.batchCalls++;
			if (batchGate) await batchGate;
			if (failBatch) throw new Error('schema query failed');
			return statements.map(statement => allResult(statement.sql));
		}
	};
	return db;
}

function context(db) {
	return {
		env: {
			db,
			kv: {},
			assets: {},
			domain: ['example.com'],
			admin: 'admin@example.com',
			jwt_secret: 'configured'
		}
	};
}

describe('bootstrap readiness performance', () => {
	it('uses one schema batch and one combined readiness query', async () => {
		const db = createReadyDb();

		const status = await getBootstrapStatus(context(db));

		expect(status.ready).toBe(true);
		expect(db.metrics).toEqual({ batchCalls: 1, allCalls: 0, firstCalls: 1 });
	});

	it('coalesces concurrent checks in the same isolate', async () => {
		let releaseBatch;
		const batchGate = new Promise(resolve => { releaseBatch = resolve; });
		const db = createReadyDb({ batchGate });

		const checks = [
			getBootstrapStatus(context(db)),
			getBootstrapStatus(context(db)),
			getBootstrapStatus(context(db))
		];
		await Promise.resolve();

		expect(db.metrics.batchCalls).toBe(1);
		releaseBatch();
		expect((await Promise.all(checks)).every(status => status.ready)).toBe(true);
		expect(db.metrics).toEqual({ batchCalls: 1, allCalls: 0, firstCalls: 1 });
	});

	it('caches only within the ready TTL and rechecks for a new check version', async () => {
		const db = createReadyDb();
		let time = 1_000;
		const options = { now: () => time };

		await getBootstrapStatus(context(db), options);
		await getBootstrapStatus(context(db), options);
		expect(db.metrics).toEqual({ batchCalls: 1, allCalls: 0, firstCalls: 1 });

		time += BOOTSTRAP_STATUS_CACHE_TTL_MS + 1;
		await getBootstrapStatus(context(db), options);
		expect(db.metrics).toEqual({ batchCalls: 2, allCalls: 0, firstCalls: 2 });

		await getBootstrapStatus(context(db), { ...options, version: 'next-check-version' });
		expect(db.metrics).toEqual({ batchCalls: 3, allCalls: 0, firstCalls: 3 });
	});

	it('does not cache an uninitialized or failed readiness result', async () => {
		const notReadyDb = createReadyDb({ ready: false });
		const notReadyContext = context(notReadyDb);
		const first = await getBootstrapStatus(notReadyContext);
		const second = await getBootstrapStatus(notReadyContext);
		expect(first.ready).toBe(false);
		expect(second.ready).toBe(false);
		expect(notReadyDb.metrics.batchCalls).toBe(2);

		const failedDb = createReadyDb({ failBatch: true });
		const failedContext = context(failedDb);
		await expect(getBootstrapStatus(failedContext)).rejects.toMatchObject({ code: 503 });
		await expect(getBootstrapStatus(failedContext)).rejects.toMatchObject({ code: 503 });
		expect(failedDb.metrics.batchCalls).toBe(2);
	});

	it('retries a failed check even when pending-status caching is requested', async () => {
		const db = createReadyDb();
		const batch = db.batch;
		let failed = false;
		db.batch = async function (statements) {
			if (!failed) { failed = true; throw new Error('temporary failure'); }
			return batch.call(this, statements);
		};
		await expect(getBootstrapStatus(context(db), { cachePending: true })).rejects.toMatchObject({ code: 503 });
		expect((await getBootstrapStatus(context(db), { cachePending: true })).ready).toBe(true);
	});

	it('explicit invalidation forces the next ready check back to D1', async () => {
		const db = createReadyDb();
		await getBootstrapStatus(context(db));
		await getBootstrapStatus(context(db));
		expect(db.metrics.batchCalls).toBe(1);

		invalidateBootstrapStatusCache(db);
		await getBootstrapStatus(context(db));
		expect(db.metrics.batchCalls).toBe(2);
	});

	it('an invalidated in-flight check cannot repopulate the ready cache', async () => {
		let releaseBatch;
		const db = createReadyDb({
			batchGate: new Promise(resolve => { releaseBatch = resolve; })
		});
		const staleCheck = getBootstrapStatus(context(db));
		await Promise.resolve();

		invalidateBootstrapStatusCache(db);
		releaseBatch();
		await staleCheck;
		await getBootstrapStatus(context(db));

		expect(db.metrics.batchCalls).toBe(2);
	});
});
