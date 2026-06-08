import { dbInit } from '../init/init';
import emailSearchService from './email-search-service';
import kvConst from '../const/kv-const';
import { emailConst, isDel } from '../const/entity-const';
import BizError from '../error/biz-error';
import { extractCodeByPattern } from './ai-service';
import { CODE_STALE_MINUTES } from './code-service';

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
	'unread',
	'is_del'
];

const EXPECTED_INDEXES = [
	'idx_email_user_account_type_del_id',
	'idx_email_user_type_del_id',
	'idx_email_type_status_id',
	'idx_attachments_email_type',
	'idx_star_user_email',
	'idx_email_user_code_id',
	'idx_email_code_id'
];

const INDEX_SQL_LIST = [
	`CREATE INDEX IF NOT EXISTS idx_email_user_account_type_del_id ON email(user_id, account_id, type, is_del, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_user_type_del_id ON email(user_id, type, is_del, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_type_status_id ON email(type, status, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_attachments_email_type ON attachments(email_id, type);`,
	`CREATE INDEX IF NOT EXISTS idx_star_user_email ON star(user_id, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_user_code_id ON email(user_id, code, email_id);`,
	`CREATE INDEX IF NOT EXISTS idx_email_code_id ON email(code, email_id);`
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

async function runStatements(c, statements) {
	if (statements.length === 0) {
		return;
	}

	if (c.env.db.batch) {
		await c.env.db.batch(statements);
		return;
	}

	await Promise.all(statements.map(statement => statement.run()));
}

async function syncChangedEmailIds(c, emailIds) {
	for (let i = 0; i < emailIds.length; i += CODE_MAINTENANCE_BATCH_SIZE) {
		await emailSearchService.syncEmailIds(c, emailIds.slice(i, i + CODE_MAINTENANCE_BATCH_SIZE));
	}
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
			indexes: [],
			missingIndexes: EXPECTED_INDEXES,
			emailSearchRows: 0,
			emailTotal: 0,
			settingsInKv: false,
			queryPlan: '',
			usesIndex: false,
			durationMs: 0
		};

		if (dbAvailable) {
			const start = Date.now();
			const [columnRows, indexRows, searchTable, emailCount, searchCount, queryPlan] = await Promise.all([
				c.env.db.prepare(`PRAGMA table_info(email)`).all(),
				c.env.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all(),
				c.env.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'email_search'`).first(),
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
				})
			]);

			details.durationMs = Date.now() - start;
			details.emailColumns = (columnRows.results || []).map(row => row.name);
			details.missingEmailColumns = EXPECTED_EMAIL_COLUMNS.filter(name => !details.emailColumns.includes(name));
			details.indexes = (indexRows.results || []).map(row => row.name);
			details.missingIndexes = EXPECTED_INDEXES.filter(name => !details.indexes.includes(name));
			details.emailTotal = emailCount.total;
			details.emailSearchTable = !!searchTable;
			details.emailSearchRows = searchCount.total;
			details.queryPlan = (queryPlan.results || []).map(row => row.detail || '').join(' | ');
			details.usesIndex = /USING .*INDEX/i.test(details.queryPlan);

			checks.push({
				key: 'schema',
				ok: details.missingEmailColumns.length === 0,
				message: details.missingEmailColumns.length === 0
					? 'Email schema is complete'
					: `Missing columns: ${details.missingEmailColumns.join(', ')}`
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
			await dbInit.v3_0DB(c);
			return this.health(c);
		}

		if (action === 'indexes') {
			await dbInit.runOptionalSqlList(c, INDEX_SQL_LIST);
			return this.health(c);
		}

		if (action === 'search') {
			await dbInit.runOptionalSqlList(c, SEARCH_TABLE_SQL_LIST);
			await c.env.db.prepare(`DELETE FROM email_search`).run();
			const ids = await c.env.db.prepare(`SELECT email_id AS emailId FROM email`).all();
			await emailSearchService.syncEmailIds(c, (ids.results || []).map(row => row.emailId));
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

			await runStatements(c, statements);
		}

		await syncChangedEmailIds(c, changedIds);

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

			const placeholders = emailIds.map(() => '?').join(',');
			await c.env.db.prepare(`
				UPDATE email
				SET code = ?
				WHERE email_id IN (${placeholders})
					AND code != ?
					AND status != ?
					AND is_del = ?
					AND datetime(create_time) < datetime('now', ?)
			`).bind('', ...emailIds, '', emailConst.status.SAVING, isDel.NORMAL, staleWindow).run();
			changedIds.push(...emailIds);
			cleared += emailIds.length;
		}

		await syncChangedEmailIds(c, changedIds);

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
