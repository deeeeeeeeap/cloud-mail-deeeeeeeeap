import BizError from '../error/biz-error';
import orm from '../entity/orm';
import { v4 as uuidv4 } from 'uuid';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import emailUtils from '../utils/email-utils';
import roleService from './role-service';
import verifyUtils from '../utils/verify-utils';
import { t } from '../i18n/i18n';
import reqUtils from '../utils/req-utils';
import dayjs from 'dayjs';
import { isDel, roleConst } from '../const/entity-const';
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

const PUBLIC_PREVIEW_TEXT_LENGTH = 240;
const PUBLIC_SEND_HOURLY_LIMIT = 100;

function toBoolFlag(value) {
	return value === true || value === 1 || value === '1' || String(value || '').toLowerCase() === 'true';
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

		if (typeof sendEmail !== 'string' || !sendEmail.trim()) {
			throw new BizError('sendEmail is required', 400);
		}

		params = normalizeSendRequest(params, { dedupeRecipients: true });
		const { receiveEmail, subject, content, text, attachments } = params;

		const accountRow = await accountService.selectByEmailIncludeDel(c, sendEmail);
		if (!accountRow || accountRow.isDel !== isDel.NORMAL) {
			throw new BizError('sender account not found', 404);
		}

		return emailService.send(c, {
			accountId: accountRow.accountId,
			name: params.name,
			receiveEmail,
			text,
			content: content || text,
			subject,
			attachments
		}, accountRow.userId, {
			beforePersist: () => this.reserveHourlySend(c)
		});
	},

	async reserveHourlySend(c) {
		const windowHour = Math.floor(Date.now() / 3600000);
		const result = await c.env.db.prepare(`
			INSERT INTO public_send_rate_limit (window_hour, count)
			VALUES (?, 1)
			ON CONFLICT(window_hour) DO UPDATE
			SET count = public_send_rate_limit.count + 1
			WHERE public_send_rate_limit.count < ?
		`).bind(windowHour, PUBLIC_SEND_HOURLY_LIMIT).run();

		if (Number(result?.meta?.changes || 0) !== 1) {
			throw new BizError('send rate limit exceeded', 429);
		}
	},

	async emailList(c, params) {

		params = params || {};
		let { toEmail, content, subject, sendName, sendEmail, timeSort, num, size, type , isDel, includeContent } = params
		const withContent = toBoolFlag(includeContent);

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

		if (conditions.length === 1) {
			query.where(...conditions)
		} else if (conditions.length > 1) {
			query.where(and(...conditions))
		}

		if (timeSort === 'asc') {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		const list = await query.limit(size).offset(num);
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
