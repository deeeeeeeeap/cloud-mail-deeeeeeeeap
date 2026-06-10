import { emailConst, isDel } from '../const/entity-const';
import { chunkArray, runBatch, truncateLikeTerm } from '../utils/sql-utils';

export const EMAIL_SEARCH_BODY_LIMIT = 4000;

function hasSearchParams(params) {
	return !!(params.userEmail || params.accountEmail || params.name || params.subject || params.searchText);
}

function isMissingSearchTable(error) {
	return /no such table: email_search/i.test(error?.message || '');
}

function normalizeLike(value) {
	return `%${truncateLikeTerm(String(value || '').trim().toLowerCase())}%`;
}

function listColumns() {
	return `
		e.email_id AS emailId,
		e.send_email AS sendEmail,
		e.name AS name,
		e.account_id AS accountId,
		e.user_id AS userId,
		e.subject AS subject,
		e.code AS code,
		SUBSTR(e.text, 1, 240) AS text,
		e.cc AS cc,
		e.bcc AS bcc,
		e.recipient AS recipient,
		e.to_email AS toEmail,
		e.to_name AS toName,
		e.in_reply_to AS inReplyTo,
		e.relation AS relation,
		e.message_id AS messageId,
		e.type AS type,
		e.status AS status,
		e.resend_email_id AS resendEmailId,
		e.message AS message,
		e.unread AS unread,
		e.create_time AS createTime,
		e.is_del AS isDel,
		u.email AS userEmail
	`;
}

function buildConditions(params, cursorEmailId, timeSort) {
	const conditions = [`s.status != ?`];
	const binds = [emailConst.status.SAVING];

	if (params.type === 'send') {
		conditions.push(`s.type = ?`);
		binds.push(emailConst.type.SEND);
	}

	if (params.type === 'receive') {
		conditions.push(`s.type = ?`);
		binds.push(emailConst.type.RECEIVE);
	}

	if (params.type === 'delete') {
		conditions.push(`s.is_del = ?`);
		binds.push(isDel.DELETE);
	}

	if (params.type === 'noone') {
		conditions.push(`s.status = ?`);
		binds.push(emailConst.status.NOONE);
	}

	if (params.userEmail) {
		conditions.push(`LOWER(s.user_email) LIKE ?`);
		binds.push(normalizeLike(params.userEmail));
	}

	if (params.accountEmail) {
		conditions.push(`(LOWER(s.to_email) LIKE ? OR LOWER(s.send_email) LIKE ?)`);
		const likeValue = normalizeLike(params.accountEmail);
		binds.push(likeValue, likeValue);
	}

	if (params.name) {
		conditions.push(`LOWER(s.name) LIKE ?`);
		binds.push(normalizeLike(params.name));
	}

	if (params.subject) {
		conditions.push(`LOWER(s.subject) LIKE ?`);
		binds.push(normalizeLike(params.subject));
	}

	if (params.searchText) {
		conditions.push(`LOWER(s.search_text) LIKE ?`);
		binds.push(normalizeLike(params.searchText));
	}

	const count = {
		sql: conditions.join(' AND '),
		binds: [...binds]
	};

	if (cursorEmailId) {
		conditions.push(timeSort ? `s.email_id > ?` : `s.email_id < ?`);
		binds.push(cursorEmailId);
	}

	return {
		sql: conditions.join(' AND '),
		binds,
		count
	};
}

const emailSearchService = {
	hasSearchParams,

	async allList(c, params, options) {
		const { size, emailId, timeSort, withTotal } = options;
		const conditions = buildConditions(params, emailId, timeSort);
		const order = timeSort ? 'ASC' : 'DESC';

		try {
			const listPromise = c.env.db.prepare(`
				SELECT ${listColumns()}
				FROM email_search s
				JOIN email e ON e.email_id = s.email_id
				LEFT JOIN user u ON u.user_id = e.user_id
				WHERE ${conditions.sql}
				ORDER BY s.email_id ${order}
				LIMIT ?
			`).bind(...conditions.binds, size + 1).all();

			const totalPromise = withTotal
				? c.env.db.prepare(`SELECT COUNT(*) AS total FROM email_search s WHERE ${conditions.count.sql}`).bind(...conditions.count.binds).first()
				: Promise.resolve({ total: 0 });

			const latestPromise = c.env.db.prepare(`
				SELECT email_id AS emailId, account_id AS accountId, user_id AS userId
				FROM email
				WHERE type = ? AND status != ?
				ORDER BY email_id DESC
				LIMIT 1
			`).bind(emailConst.type.RECEIVE, emailConst.status.SAVING).first();

			const [listResult, totalRow, latestEmail] = await Promise.all([listPromise, totalPromise, latestPromise]);
			let list = listResult.results || [];
			const hasMore = list.length > size;
			list = hasMore ? list.slice(0, size) : list;

			return {
				list,
				totalRow,
				latestEmail,
				hasMore
			};
		} catch (error) {
			if (isMissingSearchTable(error)) {
				return null;
			}
			throw error;
		}
	},

	async syncEmailIds(c, emailIds) {
		const ids = [...new Set(emailIds || [])];
		if (ids.length === 0) {
			return;
		}

		try {
			const statements = chunkArray(ids).map(chunk => {
				const placeholders = chunk.map(() => '?').join(',');
				return c.env.db.prepare(`
				INSERT OR REPLACE INTO email_search (
					email_id, user_id, account_id, name, subject, send_email, to_email, user_email,
					search_text, type, status, is_del, create_time
				)
				SELECT
					e.email_id,
					e.user_id,
					e.account_id,
					COALESCE(e.name, ''),
					COALESCE(e.subject, ''),
					COALESCE(e.send_email, ''),
					COALESCE(e.to_email, ''),
					COALESCE(u.email, ''),
					LOWER(
						COALESCE(e.name, '') || ' ' ||
						COALESCE(e.subject, '') || ' ' ||
						COALESCE(e.send_email, '') || ' ' ||
						COALESCE(e.to_email, '') || ' ' ||
						COALESCE(u.email, '') || ' ' ||
						SUBSTR(COALESCE(e.text, ''), 1, ${EMAIL_SEARCH_BODY_LIMIT})
					),
					e.type,
					e.status,
					e.is_del,
					e.create_time
				FROM email e
				LEFT JOIN user u ON u.user_id = e.user_id
				WHERE e.email_id IN (${placeholders})
			`).bind(...chunk);
			});
			await runBatch(c, statements);
		} catch (error) {
			if (!isMissingSearchTable(error)) {
				throw error;
			}
		}
	},

	async removeEmailIds(c, emailIds) {
		const ids = [...new Set(emailIds || [])];
		if (ids.length === 0) {
			return;
		}

		try {
			const statements = chunkArray(ids).map(chunk => {
				const placeholders = chunk.map(() => '?').join(',');
				return c.env.db.prepare(`DELETE FROM email_search WHERE email_id IN (${placeholders})`).bind(...chunk);
			});
			await runBatch(c, statements);
		} catch (error) {
			if (!isMissingSearchTable(error)) {
				throw error;
			}
		}
	}
};

export default emailSearchService;
