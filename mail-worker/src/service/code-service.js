import dayjs from 'dayjs';
import { emailConst, isDel } from '../const/entity-const';
import { extractCodeByPattern } from './ai-service';
import emailSearchService from './email-search-service';

export const CODE_STALE_MINUTES = 15;

function normalizePageSize(size) {
	const pageSize = Number(size);
	if (!Number.isFinite(pageSize) || pageSize <= 0) {
		return 30;
	}
	return Math.min(pageSize, 50);
}

function normalizeCursor(emailId, timeSort) {
	const cursor = Number(emailId);
	if (Number.isFinite(cursor) && cursor > 0) {
		return cursor;
	}
	return timeSort ? 0 : 9999999999;
}

function likeValue(value) {
	return `%${String(value || '').trim().toLowerCase()}%`;
}

function mapCodeRow(row) {
	const createTime = row.createTime || '';
	return {
		...row,
		isStale: createTime ? dayjs().diff(dayjs(createTime), 'minute') >= CODE_STALE_MINUTES : false
	};
}

function buildConditions(params, options = {}) {
	const timeSort = Number(params.timeSort) === 1;
	const cursorEmailId = normalizeCursor(params.emailId, timeSort);
	const conditions = [
		`e.code IS NOT NULL`,
		`e.code != ''`,
		`e.status != ?`,
		`e.is_del = ?`,
		timeSort ? `e.email_id > ?` : `e.email_id < ?`
	];
	const binds = [emailConst.status.SAVING, isDel.NORMAL, cursorEmailId];

	if (options.userId !== undefined && options.userId !== null) {
		conditions.push(`e.user_id = ?`);
		binds.push(options.userId);
	}

	if (params.query) {
		conditions.push(`(
			LOWER(e.code) LIKE ?
			OR LOWER(e.subject) LIKE ?
			OR LOWER(e.name) LIKE ?
			OR LOWER(e.send_email) LIKE ?
			OR LOWER(e.to_email) LIKE ?
		)`);
		const value = likeValue(params.query);
		binds.push(value, value, value, value, value);
	}

	if (params.accountEmail) {
		conditions.push(`LOWER(e.to_email) LIKE ?`);
		binds.push(likeValue(params.accountEmail));
	}

	if (params.sender) {
		conditions.push(`(LOWER(e.name) LIKE ? OR LOWER(e.send_email) LIKE ?)`);
		const value = likeValue(params.sender);
		binds.push(value, value);
	}

	if (params.subject) {
		conditions.push(`LOWER(e.subject) LIKE ?`);
		binds.push(likeValue(params.subject));
	}

	if (params.stale === 'fresh') {
		conditions.push(`datetime(e.create_time) >= datetime('now', '-${CODE_STALE_MINUTES} minutes')`);
	}

	if (params.stale === 'stale') {
		conditions.push(`datetime(e.create_time) < datetime('now', '-${CODE_STALE_MINUTES} minutes')`);
	}

	return {
		sql: conditions.join(' AND '),
		binds,
		order: timeSort ? 'ASC' : 'DESC'
	};
}

async function backfillRecentCodes(c, userId) {
	const conditions = [
		`e.code = ''`,
		`e.type = ?`,
		`e.status != ?`,
		`e.is_del = ?`,
		`datetime(e.create_time) >= datetime('now', '-2 days')`
	];
	const binds = [emailConst.type.RECEIVE, emailConst.status.SAVING, isDel.NORMAL];

	if (userId !== undefined && userId !== null) {
		conditions.push(`e.user_id = ?`);
		binds.push(userId);
	}

	const result = await c.env.db.prepare(`
		SELECT
			e.email_id AS emailId,
			e.subject AS subject,
			e.text AS text,
			e.content AS html
		FROM email e
		WHERE ${conditions.join(' AND ')}
		ORDER BY e.email_id DESC
		LIMIT 30
	`).bind(...binds).all();

	const updatedIds = [];
	for (const row of result.results || []) {
		const code = extractCodeByPattern(row);
		if (!code) {
			continue;
		}
		await c.env.db.prepare(`UPDATE email SET code = ? WHERE email_id = ?`).bind(code, row.emailId).run();
		updatedIds.push(row.emailId);
	}

	if (updatedIds.length > 0) {
		await emailSearchService.syncEmailIds(c, updatedIds);
	}
}

const codeService = {
	async list(c, params, userId) {
		await backfillRecentCodes(c, userId);

		const size = normalizePageSize(params.size);
		const conditions = buildConditions(params, { userId });

		const result = await c.env.db.prepare(`
			SELECT
				e.email_id AS emailId,
				e.code AS code,
				e.subject AS subject,
				e.name AS name,
				e.send_email AS sendEmail,
				e.to_email AS toEmail,
				e.create_time AS createTime
			FROM email e
			WHERE ${conditions.sql}
			ORDER BY e.email_id ${conditions.order}
			LIMIT ?
		`).bind(...conditions.binds, size + 1).all();

		let list = result.results || [];
		const hasMore = list.length > size;
		list = hasMore ? list.slice(0, size) : list;

		return {
			list: list.map(mapCodeRow),
			hasMore
		};
	},

	async allList(c, params) {
		await backfillRecentCodes(c);

		const size = normalizePageSize(params.size);
		const conditions = buildConditions(params);

		const result = await c.env.db.prepare(`
			SELECT
				e.email_id AS emailId,
				e.code AS code,
				e.subject AS subject,
				e.name AS name,
				e.send_email AS sendEmail,
				e.to_email AS toEmail,
				e.create_time AS createTime,
				u.email AS userEmail
			FROM email e
			LEFT JOIN user u ON u.user_id = e.user_id
			WHERE ${conditions.sql}
			ORDER BY e.email_id ${conditions.order}
			LIMIT ?
		`).bind(...conditions.binds, size + 1).all();

		let list = result.results || [];
		const hasMore = list.length > size;
		list = hasMore ? list.slice(0, size) : list;

		return {
			list: list.map(mapCodeRow),
			hasMore
		};
	}
};

export default codeService;
