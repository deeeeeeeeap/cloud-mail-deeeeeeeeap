import BizError from '../error/biz-error';
import orm from '../entity/orm';
import { v4 as uuidv4 } from 'uuid';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import emailUtils from '../utils/email-utils';
import roleService from './role-service';
import verifyUtils from '../utils/verify-utils';
import { t } from '../i18n/i18n';
import reqUtils from '../utils/req-utils';
import dayjs from 'dayjs';
import { emailConst, isDel, roleConst } from '../const/entity-const';
import email from '../entity/email';
import userService from './user-service';
import KvConst from '../const/kv-const';
import constant from '../const/constant';
import { truncateByBytes, LIKE_PATTERN_MAX_BYTES } from '../utils/sql-utils';
import accountService from './account-service';
import emailService from './email-service';
import { normalizeSendRequest } from '../utils/send-request-utils';
import authRateLimitService, { markAuthAbuse } from './auth-rate-limit-service';
import { isConfiguredDomain } from '../utils/domain-utils';
import { escapeHtml } from '../utils/html-sanitize';
import result from '../model/result';
import apiKeyService, { LEGACY_PRINCIPAL, hashSecret, isSenderAllowed, resolvePublicHourlyLimit } from './api-key-service';
import apiIdempotencyService, { readIdempotencyKey } from './api-idempotency-service';

const PUBLIC_PREVIEW_TEXT_LENGTH = 240;
const PUBLIC_STATUS_MAX_IDS = 50;

const EMAIL_STATUS_NAMES = Object.freeze({
	[emailConst.status.RECEIVE]: 'received',
	[emailConst.status.SENT]: 'sent',
	[emailConst.status.DELIVERED]: 'delivered',
	[emailConst.status.BOUNCED]: 'bounced',
	[emailConst.status.COMPLAINED]: 'complained',
	[emailConst.status.DELAYED]: 'delayed',
	[emailConst.status.SAVING]: 'pending',
	[emailConst.status.NOONE]: 'noone',
	[emailConst.status.FAILED]: 'failed'
});

function toBoolFlag(value) {
	return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
}

function principalOf(c) {
	return c.get?.('apiPrincipal') || LEGACY_PRINCIPAL;
}

function toHttpStatus(code) {
	return Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
}

async function storedEmailStatus(c, emailId) {
	try {
		const row = await c.env.db.prepare('SELECT status FROM email WHERE email_id = ?').bind(emailId).first();
		return row ? Number(row.status) : null;
	} catch {
		return null;
	}
}

export function emailStatusName(row) {
	const status = Number(row?.status);
	if (status === emailConst.status.SAVING && row?.message === 'DELIVERY_OUTCOME_UNKNOWN') {
		return 'unknown';
	}
	return EMAIL_STATUS_NAMES[status] || 'unknown';
}

export function textToHtml(text) {
	return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

function parseStoredMessage(value) {
	if (!value) {
		return '';
	}
	try {
		const parsed = JSON.parse(value);
		return typeof parsed?.message === 'string' ? parsed.message : String(value);
	} catch {
		return String(value);
	}
}

function toPublicSendResult(row) {
	return {
		emailId: row.emailId,
		status: row.status,
		statusName: emailStatusName(row),
		type: row.type,
		accountId: row.accountId,
		userId: row.userId,
		sendEmail: row.sendEmail,
		name: row.name,
		subject: row.subject,
		recipient: row.recipient,
		cc: row.cc,
		bcc: row.bcc,
		createTime: row.createTime,
		resendEmailId: row.resendEmailId || null,
		message: row.message || ''
	};
}

async function sendRequestFingerprint(params) {
	return await hashSecret(JSON.stringify({
		sendEmail: String(params.sendEmail || '').trim().toLowerCase(),
		receiveEmail: params.receiveEmail,
		cc: params.cc,
		bcc: params.bcc,
		replyTo: params.replyTo,
		name: params.name || '',
		subject: params.subject,
		content: params.content,
		text: params.text,
		attachments: (params.attachments || []).map(item => [
			item.filename,
			item.contentType,
			item.size,
			String(item.content || '').slice(0, 128)
		])
	}));
}

function addressScopeCondition(principal) {
	const patterns = principal?.allowedSenders || [];
	if (patterns.length === 0) {
		return null;
	}
	const exact = patterns.filter(item => !item.startsWith('*@'));
	const domains = patterns.filter(item => item.startsWith('*@')).map(item => item.slice(2));
	const parts = [];
	for (const column of [email.sendEmail, email.toEmail]) {
		if (exact.length > 0) {
			parts.push(sql`LOWER(${column}) IN (${sql.join(exact.map(item => sql`${item}`), sql`, `)})`);
		}
		// D1 拒绝超过 50 字节的 LIKE 模式，长域名无法安全地写成 LIKE，所以按后缀精确比较
		for (const domain of domains) {
			const suffix = `@${domain}`;
			parts.push(sql`LOWER(SUBSTR(${column}, ${-suffix.length})) = ${suffix}`);
		}
	}
	return sql`(${sql.join(parts, sql` OR `)})`;
}

function previewText(row) {
	const text = row.previewText || row.text || '';
	return text
		.replace(/[\u200B-\u200F\uFEFF\u034F\u00A0\u3000\u00AD]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function publicEmailSelect(includeContent) {
	const fields = {
		emailId: email.emailId,
		sendEmail: email.sendEmail,
		sendName: email.name,
		subject: email.subject,
		toEmail: email.toEmail,
		toName: email.toName,
		type: email.type,
		createTime: email.createTime,
		previewText: sql`SUBSTR(${email.text}, 1, ${PUBLIC_PREVIEW_TEXT_LENGTH})`,
		isDel: email.isDel,
	};

	if (includeContent) {
		fields.content = email.content;
		fields.text = email.text;
	}

	return fields;
}

const publicService = {

	async sendEmail(c, params) {
		params = params || {};
		const { sendEmail } = params;
		const principal = principalOf(c);

		if (typeof sendEmail !== 'string' || !sendEmail.trim()) {
			throw new BizError('sendEmail is required', 400);
		}

		params = normalizeSendRequest(params, { dedupeRecipients: true });
		const { receiveEmail, cc, bcc, replyTo, subject, attachments } = params;
		let { content, text } = params;
		if (!content.trim()) {
			content = textToHtml(text);
		} else if (!text.trim()) {
			text = emailUtils.htmlToText(content);
		}

		apiKeyService.assertSenderAllowed(principal, sendEmail);

		const idempotencyKey = readIdempotencyKey(c, params);
		const idempotency = idempotencyKey
			? await apiIdempotencyService.begin(c, {
				principal,
				key: idempotencyKey,
				requestHash: await sendRequestFingerprint(params)
			})
			: null;

		let persistedEmailId = null;
		try {
			const accountRow = await accountService.selectByEmailIncludeDel(c, sendEmail);
			if (!accountRow || accountRow.isDel !== isDel.NORMAL) {
				throw new BizError('sender account not found', 404);
			}

			const results = await emailService.send(c, {
				accountId: accountRow.accountId,
				name: params.name,
				receiveEmail,
				cc,
				bcc,
				replyTo,
				text,
				content,
				subject,
				attachments
			}, accountRow.userId, {
				accountRow,
				requireActiveOwner: true,
				beforePersist: () => this.reservePublicSend(c, principal),
				onPersisted: emailId => {
					persistedEmailId = emailId;
				}
			});

			const data = results.map(toPublicSendResult);
			await apiIdempotencyService.complete(c, idempotency, 200, result.ok(data));
			return data;
		} catch (e) {
			if (idempotency) {
				// 只有邮件已明确标记为 FAILED 时才能确认没有外发；其余落库后的失败一律缓存，保证同一个键最多发送一次
				const definitelyNotSent = !persistedEmailId
					|| await storedEmailStatus(c, persistedEmailId) === emailConst.status.FAILED;
				if (definitelyNotSent) {
					await apiIdempotencyService.release(c, idempotency);
				} else {
					const isBizError = e?.name === 'BizError';
					await apiIdempotencyService.complete(
						c,
						idempotency,
						isBizError ? toHttpStatus(e.code) : 500,
						isBizError ? result.fail(e.message, e.code) : result.fail('Internal Server Error', 500)
					);
				}
			}
			throw e;
		}
	},

	async reservePublicSend(c, principal) {
		await this.reserveHourlySend(c);
		try {
			const usage = await apiKeyService.reserveSend(c, principal);
			if (usage?.hourLimit) {
				c.set?.('apiRateLimit', {
					limit: usage.hourLimit,
					remaining: Math.max(0, usage.hourLimit - usage.hourCount)
				});
			}
		} catch (e) {
			await this.releaseHourlySend(c);
			throw e;
		}
	},

	async reserveHourlySend(c) {
		const limit = resolvePublicHourlyLimit(c);
		if (limit === 0) {
			return;
		}
		const windowHour = Math.floor(Date.now() / 3600000);
		const reservation = await c.env.db.prepare(`
			INSERT INTO public_send_rate_limit (window_hour, count)
			VALUES (?, 1)
			ON CONFLICT(window_hour) DO UPDATE
			SET count = public_send_rate_limit.count + 1
			WHERE public_send_rate_limit.count < ?
		`).bind(windowHour, limit).run();

		if (Number(reservation?.meta?.changes || 0) !== 1) {
			throw new BizError('send rate limit exceeded', 429);
		}
	},

	async releaseHourlySend(c) {
		if (resolvePublicHourlyLimit(c) === 0) {
			return;
		}
		try {
			await c.env.db.prepare(`
				UPDATE public_send_rate_limit
				SET count = count - 1
				WHERE window_hour = ? AND count > 0
			`).bind(Math.floor(Date.now() / 3600000)).run();
		} catch (e) {
			console.warn('Public send reservation release failed:', e?.message || e);
		}
	},

	async emailStatus(c, params) {
		params = params || {};
		const principal = principalOf(c);
		const rawIds = Array.isArray(params.emailIds)
			? params.emailIds
			: String(params.emailIds ?? params.emailId ?? '').split(',');
		const emailIds = [...new Set(rawIds
			.map(value => Number(String(value).trim()))
			.filter(value => Number.isInteger(value) && value > 0))];

		if (emailIds.length === 0) {
			throw new BizError('emailIds is required', 400);
		}
		if (emailIds.length > PUBLIC_STATUS_MAX_IDS) {
			throw new BizError(`emailIds must contain no more than ${PUBLIC_STATUS_MAX_IDS} items`, 400);
		}

		const placeholders = emailIds.map(() => '?').join(',');
		const { results = [] } = await c.env.db.prepare(`
			SELECT e.email_id AS emailId,
				e.send_email AS sendEmail,
				e.subject,
				e.recipient,
				e.status,
				e.message,
				e.resend_email_id AS resendEmailId,
				e.create_time AS createTime,
				da.provider AS deliveryProvider,
				da.status AS deliveryStatus,
				da.error_summary AS deliveryError,
				da.update_time AS deliveryUpdateTime
			FROM email e
			LEFT JOIN delivery_attempt da ON da.email_id = e.email_id
			WHERE e.email_id IN (${placeholders})
			  AND e.type = ?
		`).bind(...emailIds, emailConst.type.SEND).all();

		const list = results
			.filter(row => isSenderAllowed(principal, row.sendEmail))
			.map(row => ({
				emailId: row.emailId,
				status: row.status,
				statusName: emailStatusName(row),
				sendEmail: row.sendEmail,
				subject: row.subject,
				recipient: row.recipient,
				createTime: row.createTime,
				resendEmailId: row.resendEmailId || null,
				message: row.message === 'DELIVERY_OUTCOME_UNKNOWN' ? row.message : parseStoredMessage(row.message),
				delivery: row.deliveryStatus ? {
					provider: row.deliveryProvider,
					status: row.deliveryStatus,
					error: row.deliveryError || null,
					updateTime: row.deliveryUpdateTime
				} : null
			}));
		const found = new Set(list.map(item => item.emailId));
		return {
			list,
			notFound: emailIds.filter(id => !found.has(id))
		};
	},

	async emailList(c, params) {

		params = params || {};
		let { toEmail, content, subject, sendName, sendEmail, timeSort, num, size, type , isDel, includeContent, afterId } = params
		const withContent = toBoolFlag(includeContent);
		const principal = principalOf(c);

		const query = orm(c).select(publicEmailSelect(withContent)).from(email)
		if (isDel === undefined || isDel === null || isDel === '') {
			isDel = 0;
		}

		if (!size) {
			size = 20
		}

		if (!num) {
			num = 1
		}

		size = Number(size);
		num = Number(num);
		if (!Number.isInteger(size) || size < 1) {
			size = 20;
		}
		if (size > 50) {
			size = 50;
		}
		if (!Number.isInteger(num) || num < 1) {
			num = 1;
		}

		num = (num - 1) * size;

		let conditions = []

		//公共接口的 LIKE 模式由调用方拼接，按 D1 50 字节硬限截断防止报错
		if (toEmail) {
			conditions.push(sql`${email.toEmail} COLLATE NOCASE LIKE ${truncateByBytes(toEmail, LIKE_PATTERN_MAX_BYTES)}`)
		}

		if (sendEmail) {
			conditions.push(sql`${email.sendEmail} COLLATE NOCASE LIKE ${truncateByBytes(sendEmail, LIKE_PATTERN_MAX_BYTES)}`)
		}

		if (sendName) {
			conditions.push(sql`${email.name} COLLATE NOCASE LIKE ${truncateByBytes(sendName, LIKE_PATTERN_MAX_BYTES)}`)
		}

		if (subject) {
			conditions.push(sql`${email.subject} COLLATE NOCASE LIKE ${truncateByBytes(subject, LIKE_PATTERN_MAX_BYTES)}`)
		}

		if (content) {
			conditions.push(sql`${email.content} COLLATE NOCASE LIKE ${truncateByBytes(content, LIKE_PATTERN_MAX_BYTES)}`)
		}

		if (type || type === 0) {
			conditions.push(eq(email.type, type))
		}

		if (isDel || isDel === 0) {
			conditions.push(eq(email.isDel, Number(isDel)))
		}

		const scopeCondition = addressScopeCondition(principal);
		if (scopeCondition) {
			conditions.push(scopeCondition);
		}

		const cursorId = Number(afterId);
		const useCursor = afterId !== undefined && afterId !== null && afterId !== ''
			&& Number.isInteger(cursorId) && cursorId >= 0;
		if (useCursor) {
			conditions.push(gt(email.emailId, cursorId));
		}

		if (conditions.length === 1) {
			query.where(...conditions)
		} else if (conditions.length > 1) {
			query.where(and(...conditions))
		}

		if (useCursor || timeSort === 'asc') {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		const list = await (useCursor ? query.limit(size) : query.limit(size).offset(num));
		return list.map(item => ({
			...item,
			previewText: previewText(item)
		}));

	},

	async addUser(c, params) {
		const { list } = params;

		if (!Array.isArray(list)) {
			throw new BizError('list must be an array');
		}

		if (list.length === 0) return;

		if (list.length > 100) {
			throw new BizError('A maximum of 100 users can be imported at once');
		}

		for (const emailRow of list) {
			if (!emailRow || typeof emailRow !== 'object') {
				throw new BizError('list item must be an object');
			}

			if (!verifyUtils.isEmail(emailRow.email)) {
				throw new BizError(t('notEmail'));
			}
			if (emailUtils.isSameAddress(emailRow.email, c.env.admin)) {
				throw new BizError('Administrator account must be created through the initialization flow', 403);
			}

			if (!isConfiguredDomain(c.env.domain, emailUtils.getDomain(emailRow.email))) {
				throw new BizError(t('notEmailDomain'));
			}

			if (emailRow.password !== undefined
				&& emailRow.password !== null
				&& typeof emailRow.password !== 'string') {
				throw new BizError(t('pwdLengthLimit'));
			}

			if (emailRow.password && (emailRow.password.length < 6 || emailRow.password.length > 30)) {
				throw new BizError(t(emailRow.password.length < 6 ? 'pwdMinLength' : 'pwdLengthLimit'));
			}

			const { salt, hash } = await saltHashUtils.hashPassword(
				emailRow.password || cryptoUtils.genRandomPwd()
			);

			emailRow.salt = salt;
			emailRow.hash = hash;
		}


		const activeIp = reqUtils.getIp(c);
		const { os, browser, device } = reqUtils.getUserAgent(c);
		const activeTime = dayjs().format('YYYY-MM-DD HH:mm:ss');

		const roleList = await roleService.roleSelectUse(c);
		const defRole = roleList.find(roleRow => roleRow.isDefault === roleConst.isDefault.OPEN);

		const userList = [];

		for (const emailRow of list) {
			let { email, hash, salt, roleName } = emailRow;
			let type = defRole.roleId;

			if (roleName) {
				const roleRow = roleList.find(role => role.name === roleName);
				type = roleRow ? roleRow.roleId : type;
			}

			userList.push(c.env.db.prepare(`
				INSERT INTO user (email, password, salt, type, os, browser, active_ip, create_ip, device, active_time, create_time)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`).bind(email, hash, salt, type, os, browser, activeIp, activeIp, device, activeTime, activeTime));
			userList.push(c.env.db.prepare(`
				INSERT INTO account (email, name, user_id)
				SELECT ?, ?, user_id
				FROM user
				WHERE email = ?
				LIMIT 1
			`).bind(email, emailUtils.getName(email), email));

		}

		try {
			await c.env.db.batch(userList);
		} catch (e) {
			if(e.message.includes('SQLITE_CONSTRAINT')) {
				throw new BizError(t('emailExistDatabase'))
			} else {
				throw e
			}
		}

	},

	async genToken(c, params) {
		const rateIdentity = await authRateLimitService.assertAllowed(
			c,
			'public-gen-token',
			params?.email
		);
		let userRow;
		try {
			userRow = await this.verifyUser(c, params);
			const currentUserRow = await userService.upgradePasswordHash(c, userRow, params.password);
			if (!currentUserRow) throw markAuthAbuse(new BizError(t('loginFailed')));
			await authRateLimitService.clear(c, rateIdentity);
		} catch (e) {
			if (e?.authAbuse) {
				await authRateLimitService.recordFailure(c, rateIdentity);
			} else {
				try {
					await authRateLimitService.releaseReservation(c, rateIdentity);
				} catch {
					console.warn('public token rate-limit reservation release failed');
				}
			}
			throw e;
		}

		const uuid = uuidv4();

		await c.env.kv.put(KvConst.PUBLIC_KEY, uuid, { expirationTtl: constant.TOKEN_EXPIRE });

		return {token: uuid}
	},

	async verifyUser(c, params) {

		const { email, password } = params

		const userRow = await userService.selectByEmailIncludeDel(c, email);

		// 该接口无需登录即可调用，三种失败必须同文案同耗时：
		// 分开报错等于免费告诉攻击者哪个地址是管理员
		if (!emailUtils.isSameAddress(email, c.env.admin)
			|| !userRow
			|| userRow.isDel === isDel.DELETE) {
			await cryptoUtils.burnPasswordVerification(password);
			throw markAuthAbuse(new BizError(t('loginFailed')));
		}

		if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
			throw markAuthAbuse(new BizError(t('loginFailed')));
		}

		return userRow;
	}

}

export default publicService
