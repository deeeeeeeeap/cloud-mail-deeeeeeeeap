import orm from '../entity/orm';
import email from '../entity/email';
import { attConst, emailConst, isDel, settingConst, userConst } from '../const/entity-const';
import { and, desc, eq, gt, inArray, lt, count, asc, sql, ne, or, like, lte, gte } from 'drizzle-orm';
import { star } from '../entity/star';
import settingService from './setting-service';
import accountService from './account-service';
import BizError from '../error/biz-error';
import { isConfiguredDomain } from '../utils/domain-utils';
import emailUtils from '../utils/email-utils';
import fileUtils from '../utils/file-utils';
import attService from './att-service';
import userService from './user-service';
import roleService from './role-service';
import user from '../entity/user';
import starService from './star-service';
import { t } from '../i18n/i18n'
import domainUtils from '../utils/domain-uitls';
import account from "../entity/account";
import { att } from '../entity/att';
import telegramService from './telegram-service';
import emailSearchService from './email-search-service';
import { chunkArray, truncateLikeTerm, utf8ByteLength, LIKE_PATTERN_MAX_BYTES } from '../utils/sql-utils';
import deliveryAttemptService, { deliveryAttemptConst } from './delivery-attempt-service';

const CLOUDFLARE_EMAIL_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const RESEND_MAX_MESSAGE_BYTES = 40 * 1000 * 1000;
const PROVIDER_MESSAGE_OVERHEAD_BYTES = 2 * 1024;
const PROVIDER_ATTACHMENT_OVERHEAD_BYTES = 1024;
export const RECEIVE_RECOVERY_EMAIL_LIMIT = 2;
const CLOUDFLARE_EMAIL_EXPLICIT_ERROR_CODES = new Set([
	'E_VALIDATION_ERROR',
	'E_FIELD_MISSING',
	'E_TOO_MANY_RECIPIENTS',
	'E_TOO_MANY_ATTACHMENTS',
	'E_SENDER_NOT_VERIFIED',
	'E_RECIPIENT_NOT_ALLOWED',
	'E_RECIPIENT_SUPPRESSED',
	'E_SENDER_DOMAIN_NOT_AVAILABLE',
	'E_CONTENT_TOO_LARGE',
	'E_DELIVERY_FAILED',
	'E_RATE_LIMIT_EXCEEDED',
	'E_DAILY_LIMIT_EXCEEDED',
	'E_HEADER_NOT_ALLOWED',
	'E_HEADER_USE_API_FIELD',
	'E_HEADER_VALUE_INVALID',
	'E_HEADER_VALUE_TOO_LONG',
	'E_HEADER_NAME_INVALID',
	'E_HEADERS_TOO_LARGE',
	'E_HEADERS_TOO_MANY',
	'E_ACCOUNT_SUSPENDED'
]);
const RECEIVE_FAILURE_CODES = new Set([
	'ATTACHMENT_STORAGE_FAILED',
	'ATTACHMENT_OBJECT_WRITE_FAILED',
	'ATTACHMENT_METADATA_MISSING',
	'ATTACHMENT_COUNT_MISMATCH',
	'ATTACHMENT_RECOVERY_FAILED',
	'ATTACHMENT_STATE_INVALID',
	'ATTACHMENT_RECOVERY_LIMIT_EXCEEDED'
]);

function normalizeReceiveFailureCode(value) {
	return RECEIVE_FAILURE_CODES.has(value) ? value : 'RECEIVE_FAILED';
}

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const RESEND_NETWORK_ERROR = Object.freeze({
	name: 'application_error',
	statusCode: null,
	message: 'Unable to fetch data. The request could not be resolved.'
});

// 返回结构与 Resend SDK 一致：请求未送达或已受理却读不出响应时 statusCode 为 null（结果未知）；
// 非 2xx 透传 API 的 JSON 错误，无法解析时回退为 application_error + HTTP 状态码。
async function requestResend(resendToken, body, idempotencyKey) {
	let response;
	try {
		response = await fetch(RESEND_EMAILS_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${resendToken}`,
				'Content-Type': 'application/json',
				'User-Agent': 'cloud-mail',
				...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
			},
			body: JSON.stringify(body)
		});
	} catch {
		return { data: null, error: { ...RESEND_NETWORK_ERROR } };
	}

	if (!response.ok) {
		const fallback = {
			name: 'application_error',
			statusCode: response.status,
			message: response.statusText || `Resend API returned HTTP ${response.status}`
		};
		try {
			const parsed = JSON.parse(await response.text());
			return { data: null, error: parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback };
		} catch {
			return { data: null, error: fallback };
		}
	}

	try {
		return { data: await response.json(), error: null };
	} catch {
		return { data: null, error: { ...RESEND_NETWORK_ERROR } };
	}
}

function isUncertainResendError(error) {
	if (!error || typeof error !== 'object') {
		return false;
	}
	if (String(error.name || '').toLowerCase() === 'concurrent_idempotent_requests') {
		return true;
	}

	if (error.statusCode === null) {
		return true;
	}

	const statusCode = Number(error.statusCode);
	return Number.isInteger(statusCode) && (statusCode === 429 || statusCode >= 500);
}

function isExplicitCloudflareEmailError(error) {
	return CLOUDFLARE_EMAIL_EXPLICIT_ERROR_CODES.has(String(error?.code || '').toUpperCase());
}

function base64PayloadLength(content) {
	if (typeof content !== 'string') {
		return null;
	}

	let start = 0;
	if (/^data:/i.test(content)) {
		const commaIndex = content.indexOf(',');
		start = commaIndex > -1 ? commaIndex + 1 : 0;
	}

	let length = 0;
	for (let index = start; index < content.length; index++) {
		const code = content.charCodeAt(index);
		if (code !== 9 && code !== 10 && code !== 12 && code !== 13 && code !== 32) {
			length++;
		}
	}
	return length;
}

function attachmentProviderBytes(attachment) {
	const content = attachment?.content;
	const encodedLength = base64PayloadLength(content);
	if (encodedLength !== null) {
		return encodedLength;
	}

	let rawSize = 0;
	if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
		rawSize = content.byteLength;
	} else if (typeof Blob !== 'undefined' && content instanceof Blob) {
		rawSize = content.size;
	}

	return Math.ceil(rawSize / 3) * 4;
}

function estimateProviderMessageBytes(params) {
	let total = PROVIDER_MESSAGE_OVERHEAD_BYTES;
	for (const value of [
		params.name,
		params.accountEmail,
		params.subject,
		params.text,
		params.html,
		params.messageId
	]) {
		total += utf8ByteLength(value);
	}
	for (const recipient of params.receiveEmail || []) {
		total += utf8ByteLength(recipient) + 16;
	}
	for (const attachment of params.attachments || []) {
		total += PROVIDER_ATTACHMENT_OVERHEAD_BYTES;
		total += utf8ByteLength(attachment.filename);
		total += utf8ByteLength(attachment.contentType || attachment.mimeType || attachment.type);
		total += utf8ByteLength(attachment.contentId);
		total += attachmentProviderBytes(attachment);
	}
	return total;
}

const emailListSelect = {
	emailId: email.emailId,
	sendEmail: email.sendEmail,
	name: email.name,
	accountId: email.accountId,
	userId: email.userId,
	subject: email.subject,
	code: email.code,
	text: sql`SUBSTR(${email.text}, 1, 240)`,
	cc: email.cc,
	bcc: email.bcc,
	recipient: email.recipient,
	toEmail: email.toEmail,
	toName: email.toName,
	inReplyTo: email.inReplyTo,
	relation: email.relation,
	messageId: email.messageId,
	type: email.type,
	status: email.status,
	resendEmailId: email.resendEmailId,
	message: email.message,
	unread: email.unread,
	createTime: email.createTime,
	isDel: email.isDel
};

const allEmailListSelect = {
	...emailListSelect,
	userEmail: user.email
};

function toBoolFlag(value, defaultValue = false) {
	if (value === undefined || value === null || value === '') {
		return defaultValue;
	}
	return value === true || value === '1' || value === 1 || value === 'true';
}

function normalizePageSize(size) {
	const pageSize = Number(size);
	if (!Number.isFinite(pageSize) || pageSize <= 0) {
		return 50;
	}
	return Math.min(pageSize, 50);
}

function previewText(row) {
	const text = row.text || '';
	return text
		.replace(/[\u200B-\u200F\uFEFF\u034F\u00A0\u3000\u00AD]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

// 通过 waitUntil 把非关键任务移出请求主链；无执行上下文时(如测试、scheduled)回退为直接执行
function runInBackground(c, task) {
	const promise = Promise.resolve()
		.then(task)
		.catch(e => console.error('Background task failed:', e?.message || e));

	let ctx;
	try {
		ctx = c.executionCtx;
	} catch (e) {
		ctx = undefined;
	}

	if (ctx?.waitUntil) {
		ctx.waitUntil(promise);
		return;
	}

	return promise;
}

const emailService = {

	async list(c, params, userId) {

		let { emailId, type, accountId, size, timeSort, allReceive } = params;
		const lite = toBoolFlag(params.lite);
		const withTotal = toBoolFlag(params.withTotal, true);
		const withLatest = toBoolFlag(params.withLatest, true);

		size = normalizePageSize(size);
		emailId = Number(emailId);
		timeSort = Number(timeSort);
		accountId = Number(accountId);
		allReceive = Number(allReceive);

		if (!emailId) {

			if (timeSort) {
				emailId = 0;
			} else {
				emailId = 9999999999;
			}

		}

		if (isNaN(allReceive)) {
			let accountRow = await accountService.selectById(c, accountId);
			allReceive = accountRow.allReceive;
		}

		const query = orm(c)
			.select({
				...(lite ? emailListSelect : email),
				starId: star.starId
			})
			.from(email)
			.leftJoin(
				star,
				and(
					eq(star.emailId, email.emailId),
					eq(star.userId, userId)
				)
			).leftJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(
				and(
					allReceive ? eq(1,1) : eq(email.accountId, accountId),
					eq(email.userId, userId),
					timeSort ? gt(email.emailId, emailId) : lt(email.emailId, emailId),
					eq(email.type, type),
					eq(email.isDel, isDel.NORMAL),
					eq(account.isDel, isDel.NORMAL)
				)
			);

		if (timeSort) {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		let totalQuery = null;
		if (withTotal && allReceive) {
			// 按账号在覆盖索引上计数再求和，避免逐封邮件回表查账号。
			// 单表 select 里的列插值不带表名，外层列必须写成 "account"."…"，否则相关条件会变成恒真。
			totalQuery = orm(c).select({
				total: sql`COALESCE(SUM((
					SELECT COUNT(*) FROM email e
					WHERE e.user_id = "account"."user_id"
					  AND e.account_id = "account"."account_id"
					  AND e.type = ${type}
					  AND e.is_del = ${isDel.NORMAL}
				)), 0)`
			}).from(account).where(and(
				eq(account.userId, userId),
				eq(account.isDel, isDel.NORMAL)
			));
		} else if (withTotal) {
			totalQuery = orm(c).select({ total: count() }).from(email)
				.leftJoin(
					account,
					eq(account.accountId, email.accountId)
				)
				.where(
					and(
						eq(email.accountId, accountId),
						eq(email.userId, userId),
						eq(email.type, type),
						eq(email.isDel, isDel.NORMAL),
						eq(account.isDel, isDel.NORMAL)
				)
			);
		}

		const latestEmailQuery = withLatest ? orm(c).select({
			emailId: email.emailId,
			accountId: email.accountId,
			userId: email.userId
		}).from(email).where(
			and(
				allReceive ? eq(1,1) : eq(email.accountId, accountId),
				eq(email.userId, userId),
				eq(email.type, type),
				eq(email.isDel, isDel.NORMAL)
			))
			.orderBy(desc(email.emailId)).limit(1) : null;

		// list/total/latest 合并一次 D1 batch，省 2 个 RTT
		const db = orm(c);
		const batchStmts = [query.limit(size + 1)];
		if (totalQuery) batchStmts.push(totalQuery);
		if (latestEmailQuery) batchStmts.push(latestEmailQuery);
		const batchResults = await db.batch(batchStmts);
		let list = batchResults[0];
		let resultIdx = 1;
		const totalRow = withTotal ? batchResults[resultIdx++][0] : { total: 0 };
		let latestEmail = withLatest ? batchResults[resultIdx][0] : null;

		const hasMore = list.length > size;
		list = hasMore ? list.slice(0, size) : list;

		list = list.map(item => ({
			...item,
			isStar: item.starId != null ? 1 : 0,
			previewText: previewText(item)
		}));


		await this.emailAddAtt(c, list, { lite });

		if (withLatest && !latestEmail) {
			latestEmail = {
				emailId: 0,
				accountId: accountId,
				userId: userId,
			}
		}

		const result = { list, total: totalRow.total, hasMore };
		if (withLatest) result.latestEmail = latestEmail;
		return result;
	},

	async delete(c, params, userId) {
		const { emailIds } = params;
		const emailIdList = emailIds.split(',').map(Number);
		for (const chunk of chunkArray(emailIdList)) {
			await orm(c).update(email).set({ isDel: isDel.DELETE }).where(
				and(
					eq(email.userId, userId),
					inArray(email.emailId, chunk)))
				.run();
		}
		await emailSearchService.syncEmailIds(c, emailIdList);
	},

	async receive(c, params, cidAttList, r2domain) {
		params.content = await this.imgReplace(params.content, cidAttList, r2domain)
		return orm(c).insert(email).values({ ...params }).returning().get();
	},

	//邮件发送
	async send(c, params, userId, options = {}) {

		let {
			accountId, //发送账号id
			name, //发件人名字
			sendType, //发件类型
			emailId, //邮件id，如果是回复邮件会带
			receiveEmail, //收件人邮箱
			text, //邮件纯文本
			content, //邮件内容
			subject, //邮件标题
			attachments = [] //附件
		} = params;
		const cc = Array.isArray(params.cc) ? params.cc : [];
		const bcc = Array.isArray(params.bcc) ? params.bcc : [];
		const replyTo = Array.isArray(params.replyTo) ? params.replyTo : [];
		const allRecipients = [...receiveEmail, ...cc, ...bcc];

		const { resendTokens, r2Domain, send, domainList } = await settingService.query(c);

		//判断是否关闭发件功能
		if (send === settingConst.send.CLOSE) {
			throw new BizError(t('disabledSend'), 403);
		}

		const presetAccount = options.accountRow && Number(options.accountRow.accountId) === Number(accountId)
			? options.accountRow
			: null;
		const [parsedContent, userRow, accountRow] = await Promise.all([
			attService.toImageUrlHtml(c, content, userId),
			userService.selectById(c, userId),
			presetAccount || accountService.selectById(c, accountId)
		]);
		let { imageDataList, html } = parsedContent;

		if (!userRow) {
			throw new BizError(t('senderAccountNotExist'), 404);
		}
		if (options.requireActiveOwner && userRow.status !== userConst.status.NORMAL) {
			throw new BizError(t('isBanUser'), 403);
		}

		const roleRow = await roleService.selectById(c, userRow.type);

		//判断接收方是不是全部为站内邮箱
		const allInternal = allRecipients.every(email => (
			isConfiguredDomain(domainList, emailUtils.getDomain(email))
		));

		if (!emailUtils.isSameAddress(userRow.email, c.env.admin)) {

			//发件被禁用
			if (roleRow.sendType === 'ban') {
				throw new BizError(t('bannedSend'), 403);
			}

			//发件被禁用
			if (roleRow.sendType === 'internal' && !allInternal) {
				throw new BizError(t('onlyInternalSend'), 403);
			}

		}

		//如果不是管理员，权限设置了发送次数
		if (!emailUtils.isSameAddress(userRow.email, c.env.admin) && roleRow.sendCount) {

			if (userRow.sendCount >= roleRow.sendCount) {
				if (roleRow.sendType === 'day') throw new BizError(t('daySendLimit'), 403);
				if (roleRow.sendType === 'count') throw new BizError(t('totalSendLimit'), 403);
			}

			if (userRow.sendCount + allRecipients.length > roleRow.sendCount) {
				if (roleRow.sendType === 'day') throw new BizError(t('daySendLack'), 403);
				if (roleRow.sendType === 'count') throw new BizError(t('totalSendLack'), 403);
			}

		}

		if (!accountRow) {
			throw new BizError(t('senderAccountNotExist'));
		}

		if (accountRow.userId !== userId) {
			throw new BizError(t('sendEmailNotCurUser'));
		}

		if (!emailUtils.isSameAddress(userRow.email, c.env.admin)) {
			//用户没有这个域名的使用权限
			if(!roleService.hasAvailDomainPerm(roleRow.availDomain, accountRow.email)) {
				throw new BizError(t('noDomainPermSend'),403)
			}

		}

		const domain = emailUtils.getDomain(accountRow.email);
		const resendToken = resendTokens[domain];
		const useCloudflareEmail = !!c.env.email;

		//如果接收方存在站外邮箱，又没有发信服务
		if (!useCloudflareEmail && !resendToken && !allInternal) {
			throw new BizError(t('noSendProvider'));
		}

		if (!allInternal && useCloudflareEmail && replyTo.length > 1) {
			throw new BizError('Cloudflare Email supports only one replyTo address', 400);
		}

		//没有发件人名字自动截取
		if (!name) {
			name = emailUtils.getName(accountRow.email);
		}

		let emailRow = {
			messageId: null
		};

		//如果是回复邮件
		if (sendType === 'reply') {

			emailRow = await this.selectReplyTarget(c, emailId, userId);

			if (!emailRow) {
				throw new BizError(t('notExistEmailReply'));
			}

		}

		attachments = Array.isArray(attachments) ? attachments : [];

		if (imageDataList.length > 10) {
			throw new BizError(t('imageAttLimit'));
		}

		if (attachments.length > 10) {
			throw new BizError(t('attLimit'));
		}

		const providerAttachments = [
			...imageDataList.map(item => ({ ...item })),
			...attachments.map(item => ({ ...item }))
		];
		const providerHtml = html;

		if (!allInternal) {
			this.assertProviderMessageSize({
				useCloudflareEmail,
				name,
				accountEmail: accountRow.email,
				receiveEmail: [...allRecipients, ...replyTo],
				subject,
				text,
				html: providerHtml,
				attachments: providerAttachments,
				messageId: emailRow.messageId
			});
		}

		if (typeof options.beforePersist === 'function') {
			await options.beforePersist();
		}

		await this.reserveSendQuota(c, { userRow, roleRow, quantity: allRecipients.length });

		imageDataList = imageDataList.map(item => ({...item, contentId: `<${item.contentId}>`}))

		//把图片标签cid标签切换会通用url
		html = await this.imgReplace(html, imageDataList, r2Domain);

		//封装数据保存到数据库
		const emailData = {};
		emailData.sendEmail = accountRow.email;
		emailData.name = name;
		emailData.subject = subject;
		emailData.content = html;
		emailData.text = text;
		emailData.accountId = accountId;
		emailData.status = emailConst.status.SAVING;
		emailData.type = emailConst.type.SEND;
		emailData.userId = userId;
		emailData.resendEmailId = null;

		const recipient = [];

		receiveEmail.forEach(item => {
			recipient.push({ address: item, name: '' });
		});

		emailData.recipient = JSON.stringify(recipient);
		if (cc.length > 0) {
			emailData.cc = JSON.stringify(cc.map(address => ({ address, name: '' })));
		}
		if (bcc.length > 0) {
			emailData.bcc = JSON.stringify(bcc.map(address => ({ address, name: '' })));
		}

		if (sendType === 'reply') {
			emailData.inReplyTo = emailRow.messageId;
			emailData.relation = emailRow.messageId;
		}

		//保存到数据库并返回结果
		const emailResult = await orm(c).insert(email).values(emailData).returning().get();
		options.onPersisted?.(emailResult.emailId);
		// 不同步搜索表：SAVING 状态行被搜索端排除，终态更新时会再同步
		let attList = [];
		try {
			//保存内嵌附件
			if (imageDataList.length > 0) {
				await attService.saveArticleAtt(c, imageDataList, userId, accountId, emailResult.emailId);
			}

			//保存普通附件
			if (attachments?.length > 0) {
				await attService.saveSendAtt(c, attachments, userId, accountId, emailResult.emailId);
			}

			if (imageDataList.length > 0 || attachments.length > 0) {
				attList = await attService.selectByEmailIds(
					c,
					[emailResult.emailId],
					{ allowParentSaving: true }
				);
			}
		} catch (e) {
			await this.markSendFailed(c, emailResult.emailId, e?.message || String(e));
			throw e;
		}
		emailResult.attList = attList;

		if (!allInternal) {
			const sendResult = await this.sendExternalProvider(c, {
				useCloudflareEmail,
				resendToken,
				name,
				accountEmail: accountRow.email,
				receiveEmail,
				cc,
				bcc,
				replyTo,
				subject,
				text,
				html: providerHtml,
				attachments: providerAttachments,
				sendType,
				messageId: emailRow.messageId,
				emailId: emailResult.emailId
			});

			const finalizedStatus = Number(sendResult.emailRow?.status);
			emailResult.status = Number.isInteger(finalizedStatus)
				? finalizedStatus
				: (useCloudflareEmail ? emailConst.status.DELIVERED : emailConst.status.SENT);
			emailResult.resendEmailId = sendResult.emailRow?.resendEmailId || sendResult.data?.id;
		}

		//如果全是站内接收方，直接写入数据库
		if (allInternal) {
			await this.HandleOnSiteEmail(c, allRecipients, emailResult, attList);
		}

		return [ emailResult ];
	},

	assertProviderMessageSize(params) {
		const estimatedBytes = estimateProviderMessageBytes(params);
		if (params.useCloudflareEmail && estimatedBytes > CLOUDFLARE_EMAIL_MAX_MESSAGE_BYTES) {
			throw new BizError('Cloudflare Email message exceeds 25 MiB limit', 413);
		}
		if (!params.useCloudflareEmail && estimatedBytes > RESEND_MAX_MESSAGE_BYTES) {
			throw new BizError('Resend message exceeds 40 MB limit', 413);
		}
	},

	async reserveSendQuota(c, { userRow, roleRow, quantity }) {
		if (emailUtils.isSameAddress(userRow.email, c.env.admin)
			|| !roleRow.sendCount
			|| !['day', 'count'].includes(roleRow.sendType)) {
			return;
		}

		const result = await c.env.db.prepare(`
			UPDATE user
			SET send_count = COALESCE(CAST(send_count AS INTEGER), 0) + ?
			WHERE user_id = ?
			  AND is_del = ?
			  AND type = ?
			  AND EXISTS (
				SELECT 1
				FROM role
				WHERE role.role_id = user.type
				  AND role.role_id = ?
				  AND role.send_type = ?
				  AND CAST(role.send_count AS INTEGER) = ?
				  AND CAST(role.send_count AS INTEGER) > 0
				  AND COALESCE(CAST(user.send_count AS INTEGER), 0) + ?
					<= CAST(role.send_count AS INTEGER)
			  )
		`).bind(
			quantity,
			userRow.userId,
			isDel.NORMAL,
			roleRow.roleId,
			roleRow.roleId,
			roleRow.sendType,
			roleRow.sendCount,
			quantity
		).run();

		if (Number(result?.meta?.changes || 0) === 1) {
			return;
		}

		if (roleRow.sendType === 'day') {
			throw new BizError(t(quantity > 1 ? 'daySendLack' : 'daySendLimit'), 403);
		}
		throw new BizError(t(quantity > 1 ? 'totalSendLack' : 'totalSendLimit'), 403);
	},

	async sendExternalProvider(c, params) {
		let sendResult = {};
		const provider = params.useCloudflareEmail
			? deliveryAttemptConst.provider.CLOUDFLARE_EMAIL
			: deliveryAttemptConst.provider.RESEND;
		const attempt = await deliveryAttemptService.prepare(c, {
			emailId: params.emailId,
			provider
		});

		// 附件编码等确定性本地工作在进入网络 I/O 之前完成；
		// 这里的异常属于本地失败，判 FAILED 允许用户重发，而不是 UNKNOWN。
		try {
			params.preparedAttachments = params.useCloudflareEmail
				? await this.toCloudflareAttachments(params.attachments)
				: await this.toResendAttachments(params.attachments);
		} catch (e) {
			try {
				await deliveryAttemptService.markPreparationFailed(c, attempt.attemptId);
			} catch {
				// The email row below still records the local preparation failure.
			}
			await this.markSendFailed(c, params.emailId, 'LOCAL_PREPARATION_FAILED');
			throw new BizError(e?.message || 'Failed to prepare outbound message');
		}

		await deliveryAttemptService.markInFlight(c, attempt.attemptId);

		try {
			if (params.useCloudflareEmail) {
				sendResult = await this.sendByCloudflareEmail(c, params);
			} else {
				sendResult = await this.sendByResend(
					params.resendToken,
					params,
					attempt.attemptKey
				);
			}
		} catch (e) {
			if (params.useCloudflareEmail && isExplicitCloudflareEmailError(e)) {
				try {
					await deliveryAttemptService.markFailed(
						c,
						attempt.attemptId,
						'PROVIDER_REJECTED'
					);
				} catch {
					// The email row still records the explicit provider rejection below.
				}
				await this.markSendFailed(c, params.emailId, 'DELIVERY_PROVIDER_REJECTED');
				throw new BizError(e?.message || 'Email provider rejected the message');
			}
			try {
				await deliveryAttemptService.markUnknown(
					c,
					attempt.attemptId,
					'PROVIDER_CALL_UNCERTAIN'
				);
			} catch {
				// A stale IN_FLIGHT row is reconciled to UNKNOWN without calling the provider again.
			}
			await this.markSendUnknown(c, params.emailId);
			throw new BizError('Delivery outcome is unknown; do not retry automatically', 502);
		}

		const { data, error } = sendResult;

		if (error) {
			if (!params.useCloudflareEmail && isUncertainResendError(error)) {
				try {
					await deliveryAttemptService.markUnknown(
						c,
						attempt.attemptId,
						'PROVIDER_CALL_UNCERTAIN'
					);
				} catch {
					// A stale IN_FLIGHT row is reconciled to UNKNOWN without calling the provider again.
				}
				await this.markSendUnknown(c, params.emailId);
				throw new BizError('Delivery outcome is unknown; do not retry automatically', 502);
			}
			await deliveryAttemptService.markFailed(
				c,
				attempt.attemptId,
				'PROVIDER_REJECTED'
			);
			await this.markSendFailed(c, params.emailId, 'DELIVERY_PROVIDER_REJECTED');
			throw new BizError(error.message);
		}
		try {
			await deliveryAttemptService.markAccepted(c, attempt.attemptId, data?.id || null);
		} catch {
			try {
				await deliveryAttemptService.markPendingAck(c, attempt.attemptId, data?.id || null);
			} catch {
				// A stale IN_FLIGHT attempt will become UNKNOWN rather than being resent.
			}
		}

		const status = params.useCloudflareEmail ? emailConst.status.DELIVERED : emailConst.status.SENT;
		const updateData = { status, message: '' };
		if (data?.id) {
			updateData.resendEmailId = data.id;
		}

		let finalizedEmail = null;
		try {
			const updateResult = await orm(c).update(email).set(updateData).where(and(
				eq(email.emailId, params.emailId),
				eq(email.type, emailConst.type.SEND),
				eq(email.status, emailConst.status.SAVING)
			)).run();
			if (Number(updateResult?.meta?.changes) === 0 && c.env?.db) {
				finalizedEmail = await c.env.db.prepare(`
					SELECT status, resend_email_id AS resendEmailId
					FROM email
					WHERE email_id = ? AND type = ?
				`).bind(params.emailId, emailConst.type.SEND).first();
			}
			await emailSearchService.syncEmailIds(c, [params.emailId]);
		} catch (e) {
			console.error(`Post-send status update failed for email ${params.emailId}:`, e?.message || e);
		}

		return { data: data || {}, emailRow: finalizedEmail };
	},

	async markSendFailed(c, emailId, message) {
		try {
			await orm(c).update(email).set({
				status: emailConst.status.FAILED,
				message
			}).where(eq(email.emailId, emailId)).run();
			await emailSearchService.syncEmailIds(c, [emailId]);
		} catch (e) {
			console.error(`Failed to mark outbound email ${emailId} as failed:`, e?.message || e);
		}
	},

	async markSendUnknown(c, emailId) {
		try {
			await orm(c).update(email).set({
				status: emailConst.status.SAVING,
				message: 'DELIVERY_OUTCOME_UNKNOWN'
			}).where(and(
				eq(email.emailId, emailId),
				eq(email.type, emailConst.type.SEND),
				eq(email.status, emailConst.status.SAVING)
			)).run();
		} catch (e) {
			console.error(`Failed to persist unknown delivery state for email ${emailId}`);
		}
	},

	async sendByCloudflareEmail(c, params) {
		const sendForm = {
			from: { email: params.accountEmail, name: params.name },
			to: [...params.receiveEmail],
			subject: params.subject
		};

		if (params.cc?.length) {
			sendForm.cc = [...params.cc];
		}

		if (params.bcc?.length) {
			sendForm.bcc = [...params.bcc];
		}

		if (params.replyTo?.length) {
			sendForm.replyTo = params.replyTo[0];
		}

		if (params.text) {
			sendForm.text = params.text;
		}

		if (params.html) {
			sendForm.html = params.html;
		}

		const attachments = params.preparedAttachments ?? await this.toCloudflareAttachments(params.attachments);
		if (attachments.length > 0) {
			sendForm.attachments = attachments;
		}

		if (params.sendType === 'reply' && params.messageId) {
			sendForm.headers = {
				'in-reply-to': params.messageId,
				'references': params.messageId
			};
		}

		const result = await c.env.email.send(sendForm);

		return {
			data: {
				id: result.messageId
			}
		};
	},

	async sendByResend(resendToken, params, idempotencyKey) {
		const attachments = params.preparedAttachments ?? await this.toResendAttachments(params.attachments);

		const sendForm = {
			from: `${params.name} <${params.accountEmail}>`,
			to: [...params.receiveEmail],
			subject: params.subject,
			text: params.text,
			html: params.html,
			attachments: attachments.map(attachment => ({
				content: attachment.content,
				filename: attachment.filename,
				path: attachment.path,
				content_type: attachment.contentType,
				content_id: attachment.contentId
			}))
		};

		if (params.cc?.length) {
			sendForm.cc = [...params.cc];
		}

		if (params.bcc?.length) {
			sendForm.bcc = [...params.bcc];
		}

		if (params.replyTo?.length) {
			sendForm.reply_to = [...params.replyTo];
		}

		if (params.sendType === 'reply') {
			sendForm.headers = {
				'in-reply-to': params.messageId,
				'references': params.messageId
			};
		}

		return await requestResend(resendToken, sendForm, idempotencyKey);
	},

	async toCloudflareAttachments(attachments) {
		const arrayBufferAttachments = await this.toArrayBufferAttachments(attachments);

		return arrayBufferAttachments.map(attachment => {
			const item = {
				content: attachment.content,
				filename: attachment.filename,
				type: attachment.mimeType || attachment.contentType || attachment.type || 'application/octet-stream',
				disposition: attachment.contentId ? 'inline' : 'attachment'
			};

			if (attachment.contentId) {
				item.contentId = attachment.contentId.replace(/^<|>$/g, '');
			}

			return item;
		});
	},

	async toResendAttachments(attachments = []) {
		const result = [];

		for (const attachment of attachments) {
			const content = await this.toAttachmentBase64(attachment);
			if (!content) {
				continue;
			}

			result.push({
				...attachment,
				content,
				contentType: attachment.contentType || attachment.mimeType || attachment.type || 'application/octet-stream'
			});
		}

		return result;
	},

	async toArrayBufferAttachments(attachments = []) {
		const result = [];

		for (const attachment of attachments) {
			const content = await this.toAttachmentArrayBuffer(attachment);
			if (!content) {
				continue;
			}

			result.push({ ...attachment, content });
		}

		return result;
	},

	async toAttachmentBase64(attachment) {
		let content = attachment.content;

		if (!content) {
			return null;
		}

		if (typeof content === 'string') {
			if (content.startsWith('data:')) {
				content = content.split(',')[1] || content;
			}
			return content.replace(/\s+/g, '');
		}

		const arrayBuffer = await this.toAttachmentArrayBuffer(attachment);
		if (!arrayBuffer) {
			return null;
		}

		const bytes = new Uint8Array(arrayBuffer);
		let binary = '';

		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}

		return btoa(binary);
	},

	async toAttachmentArrayBuffer(attachment) {
		let content = attachment.content;

		if (!content) {
			return null;
		}

		if (content instanceof ArrayBuffer) {
			return content;
		}

		if (content instanceof Uint8Array) {
			return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
		}

		if (typeof content === 'string') {
			if (content.startsWith('data:')) {
				content = content.split(',')[1] || content;
			}
			return fileUtils.base64ToUint8Array(content.replace(/\s+/g, '')).buffer;
		}

		return content;
	},

	//处理站内邮件发送
	async HandleOnSiteEmail(c, receiveEmail, sendEmailData, attList) {

		const { noRecipient, tgBotStatus, tgChatId, ruleType, ruleEmail } = await settingService.query(c);

		//查询所有收件人账号信息（与 idx_account_email_nocase 对齐，地址大小写不同也要命中同一账号）
		const accountList = [];
		for (const chunk of chunkArray(receiveEmail)) {
			accountList.push(...await orm(c).select().from(account).where(
				sql`${account.email} COLLATE NOCASE IN (${sql.join(chunk.map(address => sql`${address}`), sql`, `)})`
			).all());
		}

		//查询所有收件人权限身份
		const userIds = accountList.map(accountRow => accountRow.userId);
		let roleList = await roleService.selectByUserIds(c, userIds);

		//封装数据库准备保存到数据库
		const emailDataList = [];

		for (const email of receiveEmail) {

			//把发件人邮件改成收件
			const emailValues = {...sendEmailData}
			emailValues.status = emailConst.status.RECEIVE;
			emailValues.type = emailConst.type.RECEIVE;
			emailValues.toEmail = email;
			emailValues.toName = emailUtils.getName(email);
			emailValues.emailId = null;
			// 密送名单只属于发件人，收件副本一律不带
			emailValues.bcc = '[]';

			const accountRow = accountList.find(accountRow => emailUtils.isSameAddress(accountRow.email, email));

			//如果收件人存在就把邮件信息改成收件人的
			if (accountRow) {

				//设置给收件人保存
				emailValues.userId = accountRow.userId;
				emailValues.accountId = accountRow.accountId;
				emailValues.type = emailConst.type.RECEIVE;
				emailValues.status = emailConst.status.RECEIVE;

				const roleRow = roleList.find(roleRow => roleRow.userId === accountRow.userId);

				let { banEmail, availDomain } = roleRow;

				//如果收件人没有这个域名的使用权限和有邮件拦截，就把邮件改为拒收状态
				if (!emailUtils.isSameAddress(email, c.env.admin)) {

					if (!roleService.hasAvailDomainPerm(availDomain, email)) {
						emailValues.status = emailConst.status.BOUNCED;
						emailValues.message = `The recipient <${email}> is not authorized to use this domain.`;
					} else if(roleService.isBanEmail(banEmail, sendEmailData.sendEmail)) {
						emailValues.status = emailConst.status.BOUNCED;
						emailValues.message = `The recipient <${email}> is disabled from receiving emails.`;
					}

				}

				emailDataList.push(emailValues);

			} else {

				//设置无收件人邮件信息
				emailValues.userId = 0;
				emailValues.accountId = 0;
				emailValues.type = emailConst.type.RECEIVE;
				emailValues.status = emailConst.status.NOONE;

				//如果无人收件关闭改为拒收
				if (noRecipient === settingConst.noRecipient.CLOSE) {
					emailValues.status = emailConst.status.BOUNCED;
					emailValues.message = `Recipient not found: <${email}>`;
				}

				emailDataList.push(emailValues);

			}

		}

		//保存邮件：批量 INSERT 一次往返，替代逐收件人逐附件串行写入
		const receiveEmailList = emailDataList.filter(emailRow => emailRow.status === emailConst.status.RECEIVE || emailRow.status === emailConst.status.NOONE);

		const insertedEmailRows = [];
		const tgPushEnabled = tgBotStatus === settingConst.tgBotStatus.OPEN && !!tgChatId;
		// TG 推送需要整行（正文预览）；不推送时只取回写附件和同步搜索要用的列，避免每个收件人回传一份正文
		const insertedColumns = tgPushEnabled ? undefined : {
			emailId: email.emailId,
			accountId: email.accountId,
			userId: email.userId,
			toEmail: email.toEmail
		};

		if (receiveEmailList.length > 0) {

			const db = orm(c);
			const insertResults = await db.batch(receiveEmailList.map(emailData => db.insert(email).values(emailData).returning(insertedColumns)));

			for (const rows of insertResults) {
				const emailRow = Array.isArray(rows) ? rows[0] : rows;
				if (emailRow) {
					insertedEmailRows.push(emailRow);
				}
			}

			//附件批量保存
			if (attList.length > 0 && insertedEmailRows.length > 0) {
				const attValuesList = [];
				for (const emailRow of insertedEmailRows) {
					for (const attRow of attList) {
						attValuesList.push({
							...attRow,
							emailId: emailRow.emailId,
							accountId: emailRow.accountId,
							userId: emailRow.userId,
							attId: null
						});
					}
				}
				await db.batch(attValuesList.map(attValues => db.insert(att).values(attValues)));
			}

			await emailSearchService.syncEmailIds(c, insertedEmailRows.map(row => row.emailId));
		}

		//站内收信同样触发TG推送，走后台不阻塞发信主链
		if (tgPushEnabled && insertedEmailRows.length > 0) {
			const ruleEmails = ruleType === settingConst.ruleType.RULE ? (ruleEmail || '').split(',') : null;
			const pushRows = insertedEmailRows.filter(emailRow => !ruleEmails || ruleEmails.includes(emailRow.toEmail));
			if (pushRows.length > 0) {
				runInBackground(c, () => Promise.all(pushRows.map(emailRow => telegramService.sendEmailToBot(c, emailRow))));
			}
		}

		const bouncedEmail = emailDataList.find(emailRow => emailRow.status === emailConst.status.BOUNCED);


		let status = emailConst.status.DELIVERED;
		let message = ''
		//如果有拒收邮件，就把发件人的邮件改成拒收
		if (bouncedEmail) {
			const messageJson = { message: bouncedEmail.message };
			message = JSON.stringify(messageJson);
			status = emailConst.status.BOUNCED;
		}

		await orm(c).update(email).set({ status, message: message }).where(eq(email.emailId, sendEmailData.emailId)).run();
		await emailSearchService.syncEmailIds(c, [sendEmailData.emailId]);

	},

	async imgReplace(content, cidAttList, r2domain) {

		if (!content) {
			return ''
		}

		const ossDomain = domainUtils.toOssDomain(r2domain);
		const hasCid = !!(cidAttList && cidAttList.length) && content.includes('cid:');
		const hasOssUrl = !!ossDomain && content.includes(ossDomain + '/');

		//正文里没有可替换目标时直接返回，跳过 HTML 改写
		if (!hasCid && !hasOssUrl) {
			return content;
		}

		const cidAttMap = new Map();
		for (const cidAtt of hasCid ? cidAttList : []) {
			const cid = String(cidAtt?.contentId || '').replace(/^<|>$/g, '');
			if (cid && !cidAttMap.has(cid)) {
				cidAttMap.set(cid, cidAtt);
			}
		}

		// HTMLRewriter 流式改写，只改命中的 src，其余字节原样保留，不再重建并序列化整份 DOM
		const rewriter = new HTMLRewriter().on('img[src]', {
			element(img) {
				const src = img.getAttribute('src');
				if (hasCid && src.startsWith('cid:')) {
					const cidAtt = cidAttMap.get(src.slice(4));
					if (cidAtt) {
						img.setAttribute('src', '{{domain}}' + cidAtt.key);
						cidAtt.type = attConst.type.EMBED;
					}
					return;
				}
				if (hasOssUrl && src.startsWith(ossDomain + '/')) {
					img.setAttribute('src', src.replace(ossDomain + '/', '{{domain}}'));
				}
			}
		});

		return rewriter.transform(new Response(content, {
			headers: { 'Content-Type': 'text/html; charset=utf-8' }
		})).text();
	},

	selectById(c, emailId) {
		return orm(c).select().from(email).where(
			and(eq(email.emailId, emailId),
				eq(email.isDel, isDel.NORMAL)))
			.get();
	},

	selectReplyTarget(c, emailId, userId) {
		return orm(c).select({ messageId: email.messageId }).from(email).where(
			and(
				eq(email.emailId, emailId),
				eq(email.userId, userId),
				eq(email.isDel, isDel.NORMAL)
			)
		).get();
	},

	async detail(c, params, userId, includeDeleted = false) {
		const emailId = Number(params.emailId);

		if (!Number.isFinite(emailId) || emailId <= 0) {
			throw new BizError(t('notExistEmailReply'));
		}

		const conditions = [eq(email.emailId, emailId)];

		if (userId !== null && userId !== undefined) {
			conditions.push(eq(email.userId, userId));
		}

		if (!includeDeleted) {
			conditions.push(eq(email.isDel, isDel.NORMAL));
		}

		const emailRow = await orm(c).select().from(email).where(and(...conditions)).get();

		if (!emailRow) {
			throw new BizError(t('notExistEmailReply'));
		}

		await this.emailAddAtt(c, [emailRow]);
		emailRow.previewText = previewText(emailRow);
		return emailRow;
	},

	async latest(c, params, userId) {
		let { emailId, accountId, allReceive } = params;
		const lite = toBoolFlag(params.lite);
		allReceive = Number(allReceive);

		if (isNaN(allReceive)) {
			let accountRow = await accountService.selectById(c, accountId);
			allReceive = accountRow.allReceive;
		}

		let list = await orm(c).select(lite ? emailListSelect : {...email}).from(email)
			.leftJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(
				and(
					gt(email.emailId, emailId),
					eq(email.userId, userId),
					eq(email.isDel, isDel.NORMAL),
					eq(account.isDel, isDel.NORMAL),
					allReceive ? eq(1,1) : eq(email.accountId, accountId),
					eq(email.type, emailConst.type.RECEIVE)
				))
			.orderBy(desc(email.emailId))
			.limit(20);

		await this.emailAddAtt(c, list, { lite });
		list = list.map(item => ({
			...item,
			previewText: previewText(item)
		}));

		return list;
	},

	async physicsDelete(c, params) {
		let { emailIds } = params;
		emailIds = emailIds.split(',').map(Number);
		await attService.removeByEmailIds(c, emailIds);
		await starService.removeByEmailIds(c, emailIds);
		await emailSearchService.removeEmailIds(c, emailIds);
		for (const chunk of chunkArray(emailIds)) {
			await orm(c).delete(email).where(inArray(email.emailId, chunk)).run();
		}
	},

	async physicsDeleteUserIds(c, userIds) {
		await attService.removeByUserIds(c, userIds);
		for (const chunk of chunkArray(userIds)) {
			const emailIds = await orm(c).select({ emailId: email.emailId }).from(email).where(inArray(email.userId, chunk)).all();
			await emailSearchService.removeEmailIds(c, emailIds.map(row => row.emailId));
			await orm(c).delete(email).where(inArray(email.userId, chunk)).run();
		}
	},

	async transitionExternalEmailStatus(c, params) {
		const resendEmailId = typeof params.resendEmailId === 'string'
			? params.resendEmailId.trim()
			: '';
		const status = Number(params.status);
		const allowedStatuses = [...new Set(
			(Array.isArray(params.allowedStatuses) ? params.allowedStatuses : [])
				.map(Number)
				.filter(Number.isInteger)
		)];
		if (!resendEmailId || resendEmailId.length > 256
			|| !Number.isInteger(status)
			|| allowedStatuses.length === 0) {
			throw new BizError('Invalid external email status transition', 400);
		}
		const message = typeof params.message === 'string'
			? params.message.slice(0, 512)
			: null;
		const transitionStatuses = [...new Set([status, ...allowedStatuses])];
		const statusPlaceholders = transitionStatuses.map(() => '?').join(',');
		const emailRow = await c.env.db.prepare(`
			UPDATE email
			SET status = ?, message = ?
			WHERE email_id = COALESCE(
				(
					SELECT email_id
					FROM email
					WHERE type = ? AND resend_email_id = ?
					ORDER BY email_id
					LIMIT 1
				),
				(
					SELECT da.email_id
					FROM delivery_attempt da
					JOIN email target ON target.email_id = da.email_id
					WHERE da.provider = ?
					  AND da.provider_message_id = ?
					  AND target.type = ?
					ORDER BY da.attempt_id DESC
					LIMIT 1
				)
			  )
			  AND type = ?
			  AND status IN (${statusPlaceholders})
			RETURNING email_id AS emailId, status
		`).bind(
			status,
			message,
			emailConst.type.SEND,
			resendEmailId,
			deliveryAttemptConst.provider.RESEND,
			resendEmailId,
			emailConst.type.SEND,
			emailConst.type.SEND,
			...transitionStatuses
		).first();
		if (!emailRow) {
			return null;
		}
		try {
			await emailSearchService.syncEmailIds(c, [emailRow.emailId]);
		} catch {
			// The authoritative email row is updated; search can be rebuilt separately.
		}
		return emailRow;
	},

	async selectUserEmailCountList(c, userIds, type, del = isDel.NORMAL) {
		const result = await orm(c)
			.select({
				userId: email.userId,
				count: count(email.emailId)
			})
			.from(email)
			.where(and(
				inArray(email.userId, userIds),
				eq(email.type, type),
				eq(email.isDel, del),
				ne(email.status, emailConst.status.SAVING),
			))
			.groupBy(email.userId);
		return result;
	},
	// 用户管理页统计：一条 GROUP BY 查询同时给出 收/发 x 正常/删除 四类计数（原 4 条查询合并为 1 条）
	async selectUserEmailStatList(c, userIds) {
		return orm(c)
			.select({
				userId: email.userId,
				type: email.type,
				isDel: email.isDel,
				count: count(email.emailId)
			})
			.from(email)
			.where(and(
				inArray(email.userId, userIds),
				ne(email.status, emailConst.status.SAVING),
			))
			.groupBy(email.userId, email.type, email.isDel);
	},

	async allList(c, params) {

		let { emailId, size, name, subject, accountEmail, userEmail, searchText, type, timeSort } = params;
		const lite = toBoolFlag(params.lite);
		const withTotal = toBoolFlag(params.withTotal, true);
		const withLatest = toBoolFlag(params.withLatest, true);

		size = normalizePageSize(size);

		emailId = Number(emailId);
		timeSort = Number(timeSort);

		if (!emailId) {

			if (timeSort) {
				emailId = 0;
			} else {
				emailId = 9999999999;
			}

		}

		if (emailSearchService.hasSearchParams(params)) {
			const searchData = await emailSearchService.allList(c, params, { size, emailId, timeSort, withTotal, withLatest });
			if (searchData) {
				let { list, totalRow, latestEmail, hasMore } = searchData;

				await this.emailAddAtt(c, list, { lite });
				list = list.map(item => ({
					...item,
					previewText: previewText(item)
				}));

				if (withLatest && !latestEmail) {
					latestEmail = {
						emailId: 0,
						accountId: 0,
						userId: 0,
					}
				}

				const result = { list, total: totalRow.total, hasMore };
				if (withLatest) result.latestEmail = latestEmail;
				return result;
			}
		}

		const conditions = [];
		const typeValue = type === 'send'
			? emailConst.type.SEND
			: (type === 'receive' ? emailConst.type.RECEIVE : null);

		if (type === 'delete') {
			conditions.push(eq(email.isDel, isDel.DELETE));
		}

		if (type === 'noone') {
			conditions.push(eq(email.status, emailConst.status.NOONE));
		}

		if (userEmail) {
			conditions.push(sql`${user.email} COLLATE NOCASE LIKE ${'%'+ truncateLikeTerm(userEmail) + '%'}`);
		}

		if (accountEmail) {
			const accountEmailTerm = truncateLikeTerm(accountEmail);
			conditions.push(
				or(
					sql`${email.toEmail} COLLATE NOCASE LIKE ${'%'+ accountEmailTerm + '%'}`,
					sql`${email.sendEmail} COLLATE NOCASE LIKE ${'%'+ accountEmailTerm + '%'}`,
				)
			)
		}

		if (name) {
			conditions.push(sql`${email.name} COLLATE NOCASE LIKE ${'%'+ truncateLikeTerm(name) + '%'}`);
		}

		if (subject) {
			conditions.push(sql`${email.subject} COLLATE NOCASE LIKE ${'%'+ truncateLikeTerm(subject) + '%'}`);
		}

		if (searchText) {
			conditions.push(sql`${email.text} COLLATE NOCASE LIKE ${'%'+ truncateLikeTerm(searchText) + '%'}`);
		}

		conditions.push(ne(email.status, emailConst.status.SAVING));

		const countConditions = [...conditions];
		if (typeValue !== null) {
			countConditions.unshift(eq(email.type, typeValue));
			// 一元 + 让 type 不参与索引选择：没有 sqlite_stat1 时 SQLite 会选 type 索引再把该类型全部排序，列表必须沿 rowid 范围扫描
			conditions.unshift(sql`+${email.type} = ${typeValue}`);
		}

		if (timeSort) {
			conditions.unshift(gt(email.emailId, emailId));
		} else {
			conditions.unshift(lt(email.emailId, emailId));
		}

		const query = orm(c).select(lite ? allEmailListSelect : { ...email, userEmail: user.email })
			.from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(and(...conditions));

		if (timeSort) {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		let queryCountStmt = null;
		if (withTotal) {
			// 只有按用户邮箱筛选时才需要关联 user，否则 LEFT JOIN 不改变计数却让读取翻倍
			queryCountStmt = userEmail
				? orm(c).select({ total: count() }).from(email).leftJoin(user, eq(email.userId, user.userId))
				: orm(c).select({ total: count() }).from(email);
			queryCountStmt = queryCountStmt.where(and(...countConditions));
		}

		const latestEmailQuery = withLatest ? orm(c).select({
			emailId: email.emailId,
			accountId: email.accountId,
			userId: email.userId
		}).from(email)
			.where(and(
				sql`+${email.type} = ${emailConst.type.RECEIVE}`,
				ne(email.status, emailConst.status.SAVING)
			))
			.orderBy(desc(email.emailId)).limit(1) : null;

		// list/total/latest 合并一次 D1 batch，省 2 个 RTT
		const db = orm(c);
		const batchStmts = [query.limit(size + 1)];
		if (queryCountStmt) batchStmts.push(queryCountStmt);
		if (latestEmailQuery) batchStmts.push(latestEmailQuery);
		const batchResults = await db.batch(batchStmts);
		let list = batchResults[0];
		let resultIdx = 1;
		const totalRow = withTotal ? batchResults[resultIdx++][0] : { total: 0 };
		let latestEmail = withLatest ? batchResults[resultIdx][0] : null;

		const hasMore = list.length > size;
		list = hasMore ? list.slice(0, size) : list;

		await this.emailAddAtt(c, list, { lite });
		list = list.map(item => ({
			...item,
			previewText: previewText(item)
		}));

		if (withLatest && !latestEmail) {
			latestEmail = {
				emailId: 0,
				accountId: 0,
				userId: 0,
			}
		}

		const result = { list, total: totalRow.total, hasMore };
		if (withLatest) result.latestEmail = latestEmail;
		return result;
	},

	async allEmailLatest(c, params) {

		const { emailId } = params;
		const lite = toBoolFlag(params.lite);

		let list = await orm(c).select(lite ? allEmailListSelect : {...email, userEmail: user.email}).from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(
				and(
					gt(email.emailId, emailId),
					sql`+${email.type} = ${emailConst.type.RECEIVE}`,
					ne(email.status, emailConst.status.SAVING)
				))
			.orderBy(desc(email.emailId))
			.limit(20);

		await this.emailAddAtt(c, list, { lite });
		list = list.map(item => ({
			...item,
			previewText: previewText(item)
		}));

		return list;
	},

	async emailAddAtt(c, list, { lite = false } = {}) {

		const emailIds = list.map(item => item.emailId);

		if (emailIds.length > 0) {
			if (lite) {
				const countRows = await attService.countByEmailIds(c, emailIds);
				const countMap = new Map(countRows.map(row => [row.emailId, Number(row.attCount) || 0]));
				list.forEach(emailRow => {
					emailRow.attList = [];
					emailRow.attCount = countMap.get(emailRow.emailId) || 0;
				});
				return;
			}

			const attList = await attService.selectByEmailIds(c, emailIds);

			const attMap = new Map();
			attList.forEach(attRow => {
				const atts = attMap.get(attRow.emailId) || [];
				atts.push(attRow);
				attMap.set(attRow.emailId, atts);
			});

			list.forEach(emailRow => {
				const atts = attMap.get(emailRow.emailId) || [];
				emailRow.attList = atts;
				emailRow.attCount = atts.length;
			});
		} else {
			list.forEach(emailRow => {
				emailRow.attList = [];
				emailRow.attCount = 0;
			});
		}
	},

	async restoreByUserId(c, userId) {
		await orm(c).update(email).set({ isDel: isDel.NORMAL }).where(eq(email.userId, userId)).run();
		const emailIds = await orm(c).select({ emailId: email.emailId }).from(email).where(eq(email.userId, userId)).all();
		await emailSearchService.syncEmailIds(c, emailIds.map(row => row.emailId));
	},

	async completeReceive(c, status, emailId) {
		const emailRow = await orm(c).update(email).set({
			isDel: isDel.NORMAL,
			status: status,
			message: null,
			recoveryAfter: null
		}).where(and(
			eq(email.emailId, emailId),
			eq(email.type, emailConst.type.RECEIVE),
			eq(email.status, emailConst.status.SAVING),
			sql`${email.attachmentCount} IS NOT NULL`,
			sql`(
				SELECT COUNT(*)
				FROM attachments a
				WHERE a.email_id = ${email.emailId}
				  AND a.status = ${attConst.status.READY}
			) = ${email.attachmentCount}`,
			sql`NOT EXISTS (
				SELECT 1
				FROM attachments a
				WHERE a.email_id = ${email.emailId}
				  AND a.status != ${attConst.status.READY}
			)`
		)).returning().get();
		if (!emailRow) {
			const completedRow = await orm(c).select().from(email).where(and(
				eq(email.emailId, emailId),
				eq(email.type, emailConst.type.RECEIVE),
				inArray(email.status, [emailConst.status.RECEIVE, emailConst.status.NOONE]),
				eq(email.isDel, isDel.NORMAL)
			)).get();
			if (completedRow) {
				await emailSearchService.syncEmailIds(c, [emailId]);
				return completedRow;
			}
			const error = new Error('Incoming email attachments are not ready');
			error.code = 'INCOMING_ATTACHMENTS_NOT_READY';
			throw error;
		}
		await emailSearchService.syncEmailIds(c, [emailId]);
		return emailRow;
	},

	async failReceive(c, emailId, message) {
		// 收信行插入时是 is_del=DELETE，只有 completeReceive 会翻回 NORMAL。失败时若不一起翻回，
		// 这封信 status=FAILED 所以恢复扫描（只扫 SAVING）永远捞不到，is_del=DELETE 所以列表也看不见，
		// 而 Cloudflare 早已 250 接收、发件人不会重投 —— 一次 R2 抖动就静默吞掉一封信。
		// 正文与发件人在插入时已落库，翻出来至少让收件人知道信到过；残缺附件仍被
		// parentEmailReadyCondition 按 status 挡在下载之外，可见性放开不影响访问控制。
		const result = await orm(c).update(email).set({
			isDel: isDel.NORMAL,
			status: emailConst.status.FAILED,
			message: normalizeReceiveFailureCode(message),
			recoveryAfter: null
		}).where(and(
			eq(email.emailId, emailId),
			eq(email.type, emailConst.type.RECEIVE),
			eq(email.status, emailConst.status.SAVING)
		)).run();

		if (!result?.meta || result.meta.changes > 0) {
			try {
				await emailSearchService.syncEmailIds(c, [emailId]);
			} catch (e) {
				// 这里本就在处理失败，搜索表补录再失败不该盖掉已经生效的可见性修正
				console.warn('failReceive search sync failed');
			}
		}
	},

	async deferReceiveRecovery(c, emailId) {
		await c.env.db.prepare(`
			UPDATE email
			SET recovery_after = datetime('now', '+1 hour'),
				message = ?
			WHERE email_id = ? AND type = ? AND status = ?
		`).bind(
			'ATTACHMENT_RECOVERY_RETRY',
			emailId,
			emailConst.type.RECEIVE,
			emailConst.status.SAVING
		).run();
	},

	async completeReceiveAll(c, { limit = RECEIVE_RECOVERY_EMAIL_LIMIT } = {}) {
		const requestedLimit = Number(limit);
		const batchLimit = Math.max(1, Math.min(
			Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : RECEIVE_RECOVERY_EMAIL_LIMIT,
			RECEIVE_RECOVERY_EMAIL_LIMIT
		));
		const { results: pendingRows = [] } = await c.env.db.prepare(`
			SELECT
				e.email_id AS emailId,
				e.attachment_count AS attachmentCount,
				EXISTS (
					SELECT 1 FROM account a WHERE a.account_id = e.account_id
				) AS recipientExists
			FROM email e
			WHERE e.status = ?
			  AND e.type = ?
			  AND e.create_time <= datetime('now', '-10 minutes')
			  AND (e.recovery_after IS NULL OR e.recovery_after <= CURRENT_TIMESTAMP)
			ORDER BY COALESCE(e.recovery_after, e.create_time), e.email_id
			LIMIT ${batchLimit}
		`).bind(emailConst.status.SAVING, emailConst.type.RECEIVE).all();

		// scanned 只统计真正抢到的行，resolved 统计被推离 SAVING 的行；
		// 调用方据此告诉管理员本次实际处理了多少，而不是报批次上限
		let scanned = 0;
		let resolved = 0;

		for (const pendingRow of pendingRows) {
			const claimed = await c.env.db.prepare(`
				UPDATE email
				SET recovery_after = datetime('now', '+5 minutes')
				WHERE email_id = ?
				  AND type = ?
				  AND status = ?
				  AND (recovery_after IS NULL OR recovery_after <= CURRENT_TIMESTAMP)
				RETURNING email_id AS emailId
			`).bind(
				pendingRow.emailId,
				emailConst.type.RECEIVE,
				emailConst.status.SAVING
			).first();
			if (!claimed) {
				continue;
			}
			scanned += 1;
			let summary;
			try {
				summary = await attService.reconcileReceived(c, pendingRow.emailId);
			} catch {
				// Storage or D1 is temporarily unavailable. Keep SAVING for a later retry.
				try {
					await this.deferReceiveRecovery(c, pendingRow.emailId);
				} catch {
					// If D1 itself is unavailable, the next cron run can retry this row.
				}
				continue;
			}

			const expectedCount = Number(pendingRow.attachmentCount);
			if (pendingRow.attachmentCount === null || !Number.isInteger(expectedCount) || expectedCount < 0) {
				await this.failReceive(c, pendingRow.emailId, 'ATTACHMENT_METADATA_MISSING');
				resolved += 1;
				continue;
			}

			if (summary.overflow) {
				await this.failReceive(c, pendingRow.emailId, 'ATTACHMENT_RECOVERY_LIMIT_EXCEEDED');
				resolved += 1;
				continue;
			}

			if (summary.total !== expectedCount) {
				await this.failReceive(c, pendingRow.emailId, 'ATTACHMENT_COUNT_MISMATCH');
				resolved += 1;
				continue;
			}

			if (summary.failed > 0) {
				await this.failReceive(c, pendingRow.emailId, 'ATTACHMENT_RECOVERY_FAILED');
				resolved += 1;
				continue;
			}

			if (summary.other > 0) {
				await this.failReceive(c, pendingRow.emailId, 'ATTACHMENT_STATE_INVALID');
				resolved += 1;
				continue;
			}

			if (summary.pending > 0 || summary.ready !== expectedCount) {
				continue;
			}

			try {
				await this.completeReceive(
					c,
					pendingRow.recipientExists ? emailConst.status.RECEIVE : emailConst.status.NOONE,
					pendingRow.emailId
				);
				resolved += 1;
			} catch (error) {
				if (error?.code !== 'INCOMING_ATTACHMENTS_NOT_READY') {
					throw error;
				}
				// Another recovery runner changed this email first. Continue the bounded batch.
			}
		}

		return { scanned, resolved, batch: batchLimit };
	},

	async updateCode(c, emailId, code) {
		const result = await c.env.db.prepare(`
			UPDATE email
			SET code = ?
			WHERE email_id = ? AND code = ''
		`).bind(code, emailId).run();
		if (result?.meta && result.meta.changes === 0) {
			return;
		}
		await emailSearchService.syncEmailIds(c, [emailId]);
	},

	async batchDelete(c, params) {
		let { sendName, sendEmail, toEmail, subject, startTime, endTime, type  } = params

		let right = type === 'left' || type === 'include'
		let left = type === 'include'

		//删除条件截断会扩大匹配范围，超出 D1 LIKE 50 字节硬限直接报错
		const wildcardBytes = (left ? 1 : 0) + (right ? 1 : 0);
		for (const term of [sendName, sendEmail, toEmail, subject]) {
			if (term && utf8ByteLength(term) + wildcardBytes > LIKE_PATTERN_MAX_BYTES) {
				throw new BizError(t('searchTermTooLong'), 400);
			}
		}

		const conditions = []

		if (sendName) {
			conditions.push(like(email.name,`${left ? '%' : ''}${sendName}${right ? '%' : ''}`))
		}

		if (subject) {
			conditions.push(like(email.subject,`${left ? '%' : ''}${subject}${right ? '%' : ''}`))
		}

		if (sendEmail) {
			conditions.push(like(email.sendEmail,`${left ? '%' : ''}${sendEmail}${right ? '%' : ''}`))
		}

		if (toEmail) {
			conditions.push(like(email.toEmail,`${left ? '%' : ''}${toEmail}${right ? '%' : ''}`))
		}

		if (startTime && endTime) {
			conditions.push(gte(email.createTime,`${startTime}`))
			conditions.push(lte(email.createTime,`${endTime}`))
		}

		if (conditions.length === 0) {
			return;
		}

		const emailIdsRow = await orm(c).select({emailId: email.emailId}).from(email).where(conditions.length > 1 ? and(...conditions) : conditions[0]).all();

		const emailIds = emailIdsRow.map(row => row.emailId);

		if (emailIds.length === 0){
			return;
		}

		await attService.removeByEmailIds(c, emailIds);

		await emailSearchService.removeEmailIds(c, emailIds);
		await orm(c).delete(email).where(conditions.length > 1 ? and(...conditions) : conditions[0]).run();
	},

	async physicsDeleteByAccountId(c, accountId) {
		await attService.removeByAccountId(c, accountId);
		const emailIds = await orm(c).select({ emailId: email.emailId }).from(email).where(eq(email.accountId, accountId)).all();
		await emailSearchService.removeEmailIds(c, emailIds.map(row => row.emailId));
		await orm(c).delete(email).where(eq(email.accountId, accountId)).run();
	},

	async read(c, params, userId) {
		const { emailIds } = params;
		for (const chunk of chunkArray(emailIds)) {
			await orm(c).update(email).set({ unread: emailConst.unread.READ }).where(and(eq(email.userId, userId), inArray(email.emailId, chunk)));
		}
	}
};

export default emailService;
