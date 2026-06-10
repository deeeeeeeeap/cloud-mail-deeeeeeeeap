import dayjs from 'dayjs';
import { emailConst, isDel } from '../const/entity-const';
import { truncateLikeTerm } from '../utils/sql-utils';

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
	return `%${truncateLikeTerm(String(value || '').trim().toLowerCase())}%`;
}

function normalizeStale(stale) {
	return ['fresh', 'stale', 'all'].includes(stale) ? stale : 'fresh';
}

function mapCodeRow(row) {
	const createTime = row.createTime || '';
	const ageMinutes = createTime ? dayjs().diff(dayjs(createTime), 'minute') : null;
	const normalizedAge = Number.isFinite(ageMinutes) ? Math.max(0, ageMinutes) : null;
	const isStale = normalizedAge !== null ? normalizedAge >= CODE_STALE_MINUTES : false;
	return {
		...row,
		code: isStale ? '' : row.code,
		codeHidden: isStale,
		isStale,
		ageMinutes: normalizedAge,
		expiresInMinutes: normalizedAge !== null ? Math.max(0, CODE_STALE_MINUTES - normalizedAge) : null
	};
}

function buildConditions(params, options = {}) {
	const stale = normalizeStale(params.stale);
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

	if (stale === 'fresh') {
		conditions.push(`datetime(e.create_time) >= datetime('now', '-${CODE_STALE_MINUTES} minutes')`);
	}

	if (stale === 'stale') {
		conditions.push(`datetime(e.create_time) < datetime('now', '-${CODE_STALE_MINUTES} minutes')`);
	}

	return {
		sql: conditions.join(' AND '),
		binds,
		order: timeSort ? 'ASC' : 'DESC'
	};
}

const codeService = {
	async list(c, params = {}, userId) {
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

	async allList(c, params = {}) {
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
