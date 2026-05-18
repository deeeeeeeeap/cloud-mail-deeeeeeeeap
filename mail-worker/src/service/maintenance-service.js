import { dbInit } from '../init/init';
import emailSearchService from './email-search-service';
import kvConst from '../const/kv-const';
import { emailConst, isDel } from '../const/entity-const';
import BizError from '../error/biz-error';

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

const CODE_INDEX_SQL_LIST = [
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

function isMissingTable(error, tableName) {
	return new RegExp(`no such table: ${tableName}`, 'i').test(error?.message || '');
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
				{ key: 'search', label: 'Rebuild search table' }
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
			await dbInit.runOptionalSqlList(c, CODE_INDEX_SQL_LIST);
			return this.health(c);
		}

		if (action === 'search') {
			await dbInit.runOptionalSqlList(c, SEARCH_TABLE_SQL_LIST);
			await c.env.db.prepare(`DELETE FROM email_search`).run();
			const ids = await c.env.db.prepare(`SELECT email_id AS emailId FROM email`).all();
			await emailSearchService.syncEmailIds(c, (ids.results || []).map(row => row.emailId));
			return this.health(c);
		}

		throw new BizError('Unknown maintenance action', 400);
	}
};

export default maintenanceService;
