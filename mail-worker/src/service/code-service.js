import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { emailConst, isDel } from '../const/entity-const';
import { truncateLikeTerm } from '../utils/sql-utils';

export const CODE_STALE_MINUTES = 15;
dayjs.extend(utc);

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
	const createdAt = createTime ? dayjs.utc(createTime).valueOf() : NaN;
	const ageMs = Number.isFinite(createdAt) ? Math.max(0, Date.now() - createdAt) : null;
	const expiresInSeconds = ageMs === null ? 0 : Math.max(0, CODE_STALE_MINUTES * 60 - ageMs / 1000);
	const isStale = expiresInSeconds <= 0;
	return {
		...row,
		code: isStale ? '' : row.code,
		codeHidden: isStale,
		isStale,
		ageMinutes: ageMs === null ? null : Math.floor(ageMs / 60000),
		expiresInMinutes: Math.ceil(expiresInSeconds / 60),
		expiresInSeconds
	};
}

function buildConditions(params, options = {}) {
	const stale = normalizeStale(params.stale);
	const timeSort = Number(params.timeSort) === 1;
	const cursorEmailId = normalizeCursor(params.emailId, timeSort);
	// type = 0 收件：发信/站内副本的 code 恒为空，加此条件不改变结果集，
	// 但能让用户维度查询命中 idx_email_user_type_del_id 的 (user_id, type, is_del, email_id) 前缀有序扫描
	const conditions = [
		`e.code IS NOT NULL`,
		`e.code != ''`,
		`e.type = ?`,
		`e.status != ?`,
		`e.is_del = ?`,
		timeSort ? `e.email_id > ?` : `e.email_id < ?`
	];
	const binds = [emailConst.type.RECEIVE, emailConst.status.SAVING, isDel.NORMAL, cursorEmailId];

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
		conditions.push(`datetime(e.create_time) > datetime('now', '-${CODE_STALE_MINUTES} minutes')`);
		// datetime() 包裹后无法约束索引范围；用时间窗内第一封收件的 email_id 作下界（走 idx_email_type_create_time），
		// 否则新鲜验证码不足一页时会把该用户的全部收件扫完
		conditions.push(`e.email_id >= (
			SELECT COALESCE(MIN(w.email_id), 9223372036854775807)
			FROM email w
			WHERE w.type = ? AND w.create_time > datetime('now', '-${CODE_STALE_MINUTES} minutes')
		)`);
		binds.push(emailConst.type.RECEIVE);
	}

	if (stale === 'stale') {
		conditions.push(`datetime(e.create_time) <= datetime('now', '-${CODE_STALE_MINUTES} minutes')`);
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
			FROM email e NOT INDEXED
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
