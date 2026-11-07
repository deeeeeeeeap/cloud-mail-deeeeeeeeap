import { dbInit } from '../init/init';
import emailSearchService from './email-search-service';
import kvConst from '../const/kv-const';
import { emailConst, isDel } from '../const/entity-const';
import BizError from '../error/biz-error';
import { extractCodeByPattern } from './ai-service';
import { CODE_STALE_MINUTES } from './code-service';
import { chunkArray, runBatch } from '../utils/sql-utils';
import deliveryAttemptService from './delivery-attempt-service';
import emailService, { RECEIVE_RECOVERY_EMAIL_LIMIT } from './email-service';

const EXPECTED_EMAIL_COLUMNS = [
	'email_id',
	'send_email',
	'name',
	'account_id',
	'user_id',
	'subject',
	'code',
	'text',
	'content',
	'to_email',
	'type',
	'status',
	'attachment_count',
	'recovery_after',
	'unread',
	'is_del'
];

const EXPECTED_ATTACHMENT_COLUMNS = [
	'att_id',
	'email_id',
	'status',
	'message'
];

const EXPECTED_DELIVERY_ATTEMPT_COLUMNS = [
	'attempt_id',
	'email_id',
	'provider',
	'attempt_key',
	'status',
	'provider_message_id',
	'error_summary',
	'create_time',
	'update_time'
];

const EXPECTED_RESEND_WEBHOOK_EVENT_COLUMNS = [
	'event_key',
	'svix_id',
	'body_sha256',
	'event_type',
	'provider_email_id',
	'status',
	'outcome',
	'received_at',
	'processed_at'
];

const EXPECTED_INDEXES = [
	'idx_email_user_account_type_del_id',
	'idx_email_user_type_del_id',
	'idx_email_type_status_id',
	'idx_attachments_email_type',
	'idx_star_user_email',
	'idx_email_user_code_id',
	'idx_email_code_id',
	'idx_attachments_key',
	'idx_attachments_user',
	'idx_attachments_account',
	'idx_account_user_del',
	'idx_email_resend_email_id',
	'idx_email_account',
	'idx_star_email',
	'idx_oauth_user',
	'idx_oauth_auth_state_expires_at',
	'idx_oauth_auth_state_initiator_expires_at',
	'idx_oauth_bind_challenge_expires_at',
	'idx_oauth_platform_user_unique',
	'idx_email_receive_recovery',
	'idx_email_receive_recovery_due',
	'idx_attachments_email_status_key',
	'idx_delivery_attempt_key',
	'idx_delivery_attempt_status_time',
	'idx_delivery_attempt_email',
	'idx_delivery_attempt_provider_message',
	'idx_resend_webhook_event_key',
	'idx_resend_webhook_event_status_time',
	'idx_resend_webhook_event_provider_email',
	'idx_verify_record_ip_type',
	'idx_email_type_create_time',
	'idx_user_create_time'
];

const EXPECTED_UNIQUE_INDEXES = [
	'idx_delivery_attempt_key',
	'idx_delivery_attempt_email',
	'idx_delivery_attempt_provider_message',
	'idx_resend_webhook_event_key'
];

const INDEX_SQL_LIST = [
	`CREATE INDEX IF NOT EXISTS idx_email_user_account_type_del_id ON email(user_id, account_id, type, is_del, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_user_type_del_id ON email(user_id, type, is_del, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_type_status_id ON email(type, status, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_attachments_email_type ON attachments(email_id, type);`,
	`CREATE INDEX IF NOT EXISTS idx_star_user_email ON star(user_id, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_user_code_id ON email(user_id, code, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_code_id ON email(code, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_attachments_key ON attachments(key);`,
	`CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);`,
	`CREATE INDEX IF NOT EXISTS idx_attachments_account ON attachments(account_id);`,
	`CREATE INDEX IF NOT EXISTS idx_account_user_del ON account(user_id, is_del);`,
	`CREATE INDEX IF NOT EXISTS idx_email_resend_email_id ON email(resend_email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_account ON email(account_id);`,
	`CREATE INDEX IF NOT EXISTS idx_star_email ON star(email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth(user_id);`,
	`CREATE INDEX IF NOT EXISTS idx_verify_record_ip_type ON verify_record(ip, type);`,
	`CREATE INDEX IF NOT EXISTS idx_email_receive_recovery ON email(type, status, create_time, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_receive_recovery_due ON email(type, status, recovery_after, create_time, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_attachments_email_status_key ON attachments(email_id, status, key);`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_attempt_key ON delivery_attempt(attempt_key);`,
	`CREATE INDEX IF NOT EXISTS idx_delivery_attempt_status_time ON delivery_attempt(status, update_time, attempt_id);`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_attempt_email ON delivery_attempt(email_id);`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_attempt_provider_message ON delivery_attempt(provider, provider_message_id) WHERE provider_message_id IS NOT NULL AND provider_message_id <> '';`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_resend_webhook_event_key ON resend_webhook_event(event_key);`,
	`CREATE INDEX IF NOT EXISTS idx_resend_webhook_event_status_time ON resend_webhook_event(status, received_at, event_key);`,
	`CREATE INDEX IF NOT EXISTS idx_resend_webhook_event_provider_email ON resend_webhook_event(provider_email_id, received_at);`,
	`CREATE INDEX IF NOT EXISTS idx_email_type_create_time ON email(type, create_time);`,
	`CREATE INDEX IF NOT EXISTS idx_user_create_time ON user(create_time);`,
	`DROP INDEX IF EXISTS idx_email_user_id_account_id;`
];

const SEARCH_TABLE_SQL_LIST = [
	`CREATE TABLE IF NOT EXISTS email_search (
		email_id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL DEFAULT 0,
		account_id INTEGER NOT NULL DEFAULT 0,
		name TEXT NOT NULL DEFAULT '',
		subject TEXT NOT NULL DEFAULT '',
		send_email TEXT NOT NULL DEFAULT '',
		to_email TEXT NOT NULL DEFAULT '',
		user_email TEXT NOT NULL DEFAULT '',
		search_text TEXT NOT NULL DEFAULT '',
		type INTEGER NOT NULL DEFAULT 0,
		status INTEGER NOT NULL DEFAULT 0,
		is_del INTEGER NOT NULL DEFAULT 0,
		create_time DATETIME DEFAULT CURRENT_TIMESTAMP
	);`,
	`CREATE INDEX IF NOT EXISTS idx_email_search_type_status_id ON email_search(type, status, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_search_del_id ON email_search(is_del, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_search_user_id ON email_search(user_id, email_id);`
];

const CODE_MAINTENANCE_BATCH_SIZE = 100;
const SEARCH_REBUILD_BATCH_SIZE = 500;

function normalizeStaleMinutes(value) {
	const minutes = Number(value);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		return CODE_STALE_MINUTES;
	}
	return Math.min(Math.floor(minutes), 24 * 60);
}

function isMissingTable(error, tableName) {
	return new RegExp(`no such table: ${tableName}`, 'i').test(error?.message || '');
}

function isMissingColumn(error) {
	return /no such column:/i.test(error?.message || '');
}


const maintenanceService = {
	async health(c) {
		const checks = [];
		const dbAvailable = !!c.env.db;
		const kvAvailable = !!c.env.kv;

		checks.push({
			key: 'd1',
			ok: dbAvailable,
			message: dbAvailable ? 'D1 binding is available' : 'D1 binding is missing'
		});
		checks.push({
			key: 'kv',
			ok: kvAvailable,
			message: kvAvailable ? 'KV binding is available' : 'KV binding is missing'
		});
		checks.push({
			key: 'r2',
			ok: true,
			message: c.env.r2 ? 'R2 binding is available' : 'R2 binding is not configured (optional)'
		});
		checks.push({
			key: 'cloudflareEmail',
			ok: true,
			message: c.env.email ? 'Cloudflare Email binding is available' : 'Cloudflare Email binding is not configured (optional)'
		});

		const details = {
			emailColumns: [],
			missingEmailColumns: EXPECTED_EMAIL_COLUMNS,
			attachmentColumns: [],
			missingAttachmentColumns: EXPECTED_ATTACHMENT_COLUMNS,
			deliveryAttemptColumns: [],
			missingDeliveryAttemptColumns: EXPECTED_DELIVERY_ATTEMPT_COLUMNS,
			resendWebhookEventColumns: [],
			missingResendWebhookEventColumns: EXPECTED_RESEND_WEBHOOK_EVENT_COLUMNS,
			indexes: [],
			missingIndexes: EXPECTED_INDEXES,
			emailSearchRows: 0,
			emailTotal: 0,
			deliveryAttemptTable: false,
			resendWebhookEventTable: false,
			deliveryAttempts: {
				total: 0,
				unresolved: 0,
				counts: {}
			},
			settingsInKv: false,
			queryPlan: '',
			usesIndex: false,
			durationMs: 0
		};

		if (dbAvailable) {
			const start = Date.now();
			const [
				columnRows,
				attachmentColumnRows,
				deliveryAttemptColumnRows,
				resendWebhookEventColumnRows,
				indexRows,
				deliveryAttemptIndexRows,
				resendWebhookEventIndexRows,
				searchTable,
				deliveryAttemptTable,
				resendWebhookEventTable,
				emailCount,
				searchCount,
				queryPlan,
				deliveryAttempts
			] = await Promise.all([
				c.env.db.prepare(`PRAGMA table_info(email)`).all(),
				c.env.db.prepare(`PRAGMA table_info(attachments)`).all(),
				c.env.db.prepare(`PRAGMA table_info(delivery_attempt)`).all(),
				c.env.db.prepare(`PRAGMA table_info(resend_webhook_event)`).all(),
				c.env.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all(),
				c.env.db.prepare(`PRAGMA index_list(delivery_attempt)`).all(),
				c.env.db.prepare(`PRAGMA index_list(resend_webhook_event)`).all(),
				c.env.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'email_search'`).first(),
				c.env.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'delivery_attempt'`).first(),
				c.env.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resend_webhook_event'`).first(),
				c.env.db.prepare(`SELECT COUNT(*) AS total FROM email`).first().catch(error => {
					if (isMissingTable(error, 'email')) {
						return { total: 0 };
					}
					throw error;
				}),
				c.env.db.prepare(`SELECT COUNT(*) AS total FROM email_search`).first().catch(error => {
					if (isMissingTable(error, 'email_search')) {
						return { total: 0 };
					}
					throw error;
				}),
				c.env.db.prepare(`
					EXPLAIN QUERY PLAN
					SELECT email_id
					FROM email
					WHERE user_id = ? AND code != ? AND status != ? AND is_del = ?
					ORDER BY email_id DESC
					LIMIT 30
				`).bind(0, '', emailConst.status.SAVING, isDel.NORMAL).all().catch(error => {
					if (isMissingTable(error, 'email')) {
						return { results: [] };
					}
					throw error;
				}),
				deliveryAttemptService.health(c).catch(error => {
					if (isMissingTable(error, 'delivery_attempt') || isMissingColumn(error)) {
						return { total: 0, unresolved: 0, counts: {} };
					}
					throw error;
				})
			]);

			details.durationMs = Date.now() - start;
			details.emailColumns = (columnRows.results || []).map(row => row.name);
			details.missingEmailColumns = EXPECTED_EMAIL_COLUMNS.filter(name => !details.emailColumns.includes(name));
			details.attachmentColumns = (attachmentColumnRows.results || []).map(row => row.name);
			details.missingAttachmentColumns = EXPECTED_ATTACHMENT_COLUMNS
				.filter(name => !details.attachmentColumns.includes(name));
			details.deliveryAttemptColumns = (deliveryAttemptColumnRows.results || [])
				.map(row => row.name);
			details.missingDeliveryAttemptColumns = EXPECTED_DELIVERY_ATTEMPT_COLUMNS
				.filter(name => !details.deliveryAttemptColumns.includes(name));
			details.resendWebhookEventColumns = (resendWebhookEventColumnRows.results || [])
				.map(row => row.name);
			details.missingResendWebhookEventColumns = EXPECTED_RESEND_WEBHOOK_EVENT_COLUMNS
				.filter(name => !details.resendWebhookEventColumns.includes(name));
			details.indexes = (indexRows.results || []).map(row => row.name);
			const uniqueIndexNames = new Set([
				...(deliveryAttemptIndexRows.results || []),
				...(resendWebhookEventIndexRows.results || [])
			].filter(row => Number(row.unique) === 1).map(row => row.name));
			details.missingIndexes = [...new Set([
				...EXPECTED_INDEXES.filter(name => !details.indexes.includes(name)),
				...EXPECTED_UNIQUE_INDEXES.filter(name => (
					details.indexes.includes(name) && !uniqueIndexNames.has(name)
				))
			])];
			details.emailTotal = emailCount.total;
			details.emailSearchTable = !!searchTable;
			details.deliveryAttemptTable = !!deliveryAttemptTable;
			details.resendWebhookEventTable = !!resendWebhookEventTable;
			details.deliveryAttempts = deliveryAttempts;
			details.emailSearchRows = searchCount.total;
			details.queryPlan = (queryPlan.results || []).map(row => row.detail || '').join(' | ');
			details.usesIndex = /USING .*INDEX/i.test(details.queryPlan);

			checks.push({
				key: 'schema',
				ok: details.missingEmailColumns.length === 0
					&& details.missingAttachmentColumns.length === 0
					&& details.missingDeliveryAttemptColumns.length === 0
					&& details.missingResendWebhookEventColumns.length === 0
					&& details.deliveryAttemptTable
					&& details.resendWebhookEventTable,
				message: details.missingEmailColumns.length === 0
					&& details.missingAttachmentColumns.length === 0
					&& details.missingDeliveryAttemptColumns.length === 0
					&& details.missingResendWebhookEventColumns.length === 0
					&& details.deliveryAttemptTable
					&& details.resendWebhookEventTable
					? 'Email, attachment, delivery attempt, and webhook schema is complete'
					: `Missing columns: ${[
						...details.missingEmailColumns.map(name => `email.${name}`),
						...details.missingAttachmentColumns.map(name => `attachments.${name}`),
						...details.missingDeliveryAttemptColumns.map(name => `delivery_attempt.${name}`),
						...details.missingResendWebhookEventColumns.map(name => `resend_webhook_event.${name}`),
						...(!details.deliveryAttemptTable ? ['table.delivery_attempt'] : []),
						...(!details.resendWebhookEventTable ? ['table.resend_webhook_event'] : [])
					].join(', ')}`
			});
			checks.push({
				key: 'indexes',
				ok: details.missingIndexes.length === 0,
				message: details.missingIndexes.length === 0
					? 'Required indexes are present'
					: `Missing indexes: ${details.missingIndexes.join(', ')}`
			});
			checks.push({
				key: 'emailSearch',
				ok: details.emailSearchTable && details.indexes.includes('idx_email_search_type_status_id'),
				message: details.emailSearchTable && details.indexes.includes('idx_email_search_type_status_id')
					? 'Email search table is available'
					: 'Email search table or indexes are missing'
			});
			checks.push({
				key: 'deliveryAttempts',
				ok: details.deliveryAttemptTable && details.deliveryAttempts.unresolved === 0,
				message: !details.deliveryAttemptTable
					? 'Delivery attempt table is missing'
					: details.deliveryAttempts.unresolved === 0
						? 'No unresolved external delivery attempts'
						: `${details.deliveryAttempts.unresolved} external delivery attempts require review`
			});
		}

		if (kvAvailable) {
			details.settingsInKv = !!await c.env.kv.get(kvConst.SETTING);
			checks.push({
				key: 'settingCache',
				ok: details.settingsInKv,
				message: details.settingsInKv ? 'Settings cache is available' : 'Settings cache is missing'
			});
		}

		return {
			ok: checks.every(item => item.ok),
			checks,
			details,
			repairActions: [
				{ key: 'schema', label: 'Repair schema' },
				{ key: 'indexes', label: 'Repair indexes' },
				{ key: 'delivery-reconcile', label: 'Reconcile delivery attempts' },
				{ key: 'search', label: 'Rebuild search table' },
				{ key: 'codes-rescan', label: 'Rescan verification codes' },
				{ key: 'codes-clean', label: 'Clean false positive codes' },
				{ key: 'codes-clear-stale', label: 'Clear expired codes' }
			]
		};
	},

	async repair(c, action) {
		if (!c.env.db) {
			throw new BizError('D1 binding is missing', 400);
		}

		if (action === 'schema') {
			dbInit.invalidateBootstrapStatus(c);
			await dbInit.runMigrationSteps([
				['maintenance-v3.0', () => dbInit.v3_0DB(c)],
				['maintenance-v3.1', () => dbInit.v3_1DB(c)],
				['maintenance-v3.2', () => dbInit.v3_2DB(c)],
				['maintenance-v3.3', () => dbInit.v3_3DB(c)],
				['maintenance-v3.4', () => dbInit.v3_4DB(c)],
				['maintenance-v3.5', () => dbInit.v3_5DB(c)],
				['maintenance-v3.6', () => dbInit.v3_6DB(c)],
				['maintenance-v3.7', () => dbInit.v3_7DB(c)],
				['maintenance-v3.8', () => dbInit.v3_8DB(c)],
				['maintenance-v3.9', () => dbInit.v3_9DB(c)]
			]);
			dbInit.invalidateBootstrapStatus(c);
			await dbInit.assertBootstrapReady(c);
			return this.health(c);
		}

		if (action === 'indexes') {
			dbInit.invalidateBootstrapStatus(c);
			await dbInit.runMigrationSteps([
				['maintenance-v3.4', () => dbInit.v3_4DB(c)],
				['maintenance-v3.5', () => dbInit.v3_5DB(c)],
				['maintenance-v3.6', () => dbInit.v3_6DB(c)],
				['maintenance-v3.7', () => dbInit.v3_7DB(c)],
				['maintenance-v3.8', () => dbInit.v3_8DB(c)],
				['maintenance-indexes', () => dbInit.runOptionalSqlList(c, INDEX_SQL_LIST)]
			]);
			dbInit.invalidateBootstrapStatus(c);
			await dbInit.assertBootstrapReady(c);
			return this.health(c);
		}

		if (action === 'delivery-reconcile') {
			const reconcileResult = await deliveryAttemptService.reconcile(c);
			return this.withMaintenanceResult(c, {
				action: 'delivery-reconcile',
				...reconcileResult
			});
		}

		if (action === 'receive-recover') {
			const pendingBefore = await this.countPendingReceive(c);
			const recoverResult = await emailService.completeReceiveAll(c);
			const pendingAfter = await this.countPendingReceive(c);
			return this.withMaintenanceResult(c, {
				action: 'receive-recover',
				batch: recoverResult?.batch ?? RECEIVE_RECOVERY_EMAIL_LIMIT,
				scanned: recoverResult?.scanned ?? 0,
				resolved: recoverResult?.resolved ?? 0,
				before: pendingBefore,
				after: pendingAfter
			});
		}

		if (action === 'delivery-ack-unknown' || action === 'delivery-fail-unknown') {
			const outcome = action === 'delivery-ack-unknown' ? 'accepted' : 'failed';
			const resolveResult = await deliveryAttemptService.resolveUnknown(c, { outcome });
			return this.withMaintenanceResult(c, {
				action,
				...resolveResult
			});
		}

		if (action === 'search') {
			await dbInit.runOptionalSqlList(c, SEARCH_TABLE_SQL_LIST);
			await c.env.db.prepare(`DELETE FROM email_search`).run();

			//游标分页重建，避免一次性把全表 email_id 载入内存
			let cursorEmailId = 0;
			while (true) {
				const ids = await c.env.db.prepare(`
					SELECT email_id AS emailId
					FROM email
					WHERE email_id > ?
					ORDER BY email_id ASC
					LIMIT ?
				`).bind(cursorEmailId, SEARCH_REBUILD_BATCH_SIZE).all();

				const emailIds = (ids.results || []).map(row => row.emailId);
				if (emailIds.length === 0) {
					break;
				}

				cursorEmailId = emailIds[emailIds.length - 1];
				await emailSearchService.syncEmailIds(c, emailIds);
			}

			return this.health(c);
		}

		if (action === 'codes-rescan') {
			return this.withMaintenanceResult(c, await this.rescanCodes(c, { existingOnly: false }));
		}

		if (action === 'codes-clean') {
			return this.withMaintenanceResult(c, await this.rescanCodes(c, { existingOnly: true }));
		}

		if (action === 'codes-clear-stale') {
			return this.withMaintenanceResult(c, await this.clearStaleCodes(c));
		}

		throw new BizError('Unknown maintenance action', 400);
	},

	async countPendingReceive(c) {
		const row = await c.env.db.prepare(`
			SELECT COUNT(*) AS pending
			FROM email
			WHERE status = ? AND type = ?
			  AND create_time <= datetime('now', '-10 minutes')
			  AND (recovery_after IS NULL OR recovery_after <= CURRENT_TIMESTAMP)
		`).bind(emailConst.status.SAVING, emailConst.type.RECEIVE).first();
		return Number(row?.pending || 0);
	},

	async withMaintenanceResult(c, result) {
		const health = await this.health(c);
		return {
			...health,
			lastAction: result
		};
	},

	async rescanCodes(c, options = {}) {
		const existingOnly = options.existingOnly === true;
		let cursorEmailId = 0;
		let scanned = 0;
		let updated = 0;
		let cleared = 0;
		let backfilled = 0;
		const changedIds = [];

		while (true) {
			const conditions = [
				`email_id > ?`,
				`type = ?`,
				`status != ?`,
				`is_del = ?`
			];
			const binds = [
				cursorEmailId,
				emailConst.type.RECEIVE,
				emailConst.status.SAVING,
				isDel.NORMAL
			];

			if (existingOnly) {
				conditions.push(`code != ?`);
				binds.push('');
			}

			const rows = await c.env.db.prepare(`
				SELECT
					email_id AS emailId,
					code,
					subject,
					text,
					content AS html
				FROM email
				WHERE ${conditions.join(' AND ')}
				ORDER BY email_id ASC
				LIMIT ?
			`).bind(...binds, CODE_MAINTENANCE_BATCH_SIZE).all();

			const list = rows.results || [];
			if (list.length === 0) {
				break;
			}

			cursorEmailId = list[list.length - 1].emailId;
			const statements = [];

			for (const row of list) {
				scanned++;
				const currentCode = row.code || '';
				const nextCode = extractCodeByPattern(row);

				if (currentCode === nextCode) {
					continue;
				}

				if (!currentCode) {
					statements.push(
						c.env.db.prepare(`UPDATE email SET code = ? WHERE email_id = ? AND code = ''`).bind(nextCode, row.emailId)
					);
				} else {
					statements.push(
						c.env.db.prepare(`UPDATE email SET code = ? WHERE email_id = ? AND code = ?`).bind(nextCode, row.emailId, currentCode)
					);
				}
				changedIds.push(row.emailId);
				updated++;

				if (!currentCode && nextCode) {
					backfilled++;
				}

				if (currentCode && !nextCode) {
					cleared++;
				}
			}

			await runBatch(c, statements);
		}

		await emailSearchService.syncEmailIds(c, changedIds);

		return {
			action: existingOnly ? 'codes-clean' : 'codes-rescan',
			scanned,
			updated,
			backfilled,
			cleared
		};
	},

	async clearStaleCodes(c, options = {}) {
		const staleMinutes = normalizeStaleMinutes(options.staleMinutes ?? c.env?.code_stale_minutes);
		const staleWindow = `-${staleMinutes} minutes`;
		const dryRun = options.dryRun === true;
		let cleared = 0;
		const changedIds = [];

		if (dryRun) {
			const ids = await c.env.db.prepare(`
				SELECT email_id AS emailId
				FROM email
				WHERE code != ?
					AND status != ?
					AND is_del = ?
					AND datetime(create_time) < datetime('now', ?)
				ORDER BY email_id ASC
				LIMIT ?
			`).bind('', emailConst.status.SAVING, isDel.NORMAL, staleWindow, CODE_MAINTENANCE_BATCH_SIZE).all();

			return {
				action: 'codes-clear-stale',
				scanned: (ids.results || []).length,
				updated: 0,
				backfilled: 0,
				cleared: 0,
				dryRun: true,
				staleMinutes
			};
		}

		while (true) {
			const ids = await c.env.db.prepare(`
				SELECT email_id AS emailId
				FROM email
				WHERE code != ?
					AND status != ?
					AND is_del = ?
					AND datetime(create_time) < datetime('now', ?)
				ORDER BY email_id ASC
				LIMIT ?
			`).bind('', emailConst.status.SAVING, isDel.NORMAL, staleWindow, CODE_MAINTENANCE_BATCH_SIZE).all();

			const emailIds = (ids.results || []).map(row => row.emailId);
			if (emailIds.length === 0) {
				break;
			}

			const statements = chunkArray(emailIds).map(chunk => {
				const placeholders = chunk.map(() => '?').join(',');
				return c.env.db.prepare(`
				UPDATE email
				SET code = ?
				WHERE email_id IN (${placeholders})
					AND code != ?
					AND status != ?
					AND is_del = ?
					AND datetime(create_time) < datetime('now', ?)
			`).bind('', ...chunk, '', emailConst.status.SAVING, isDel.NORMAL, staleWindow);
			});
			await runBatch(c, statements);
			changedIds.push(...emailIds);
			cleared += emailIds.length;
		}

		await emailSearchService.syncEmailIds(c, changedIds);

		return {
			action: 'codes-clear-stale',
			scanned: cleared,
			updated: cleared,
			backfilled: 0,
			cleared,
			dryRun: false,
			staleMinutes
		};
	}
};

export default maintenanceService;
