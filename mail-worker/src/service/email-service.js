import orm from '../entity/orm';
import email from '../entity/email';
import { attConst, emailConst, isDel, settingConst } from '../const/entity-const';
import { and, desc, eq, gt, inArray, lt, count, asc, sql, ne, or, like, lte, gte } from 'drizzle-orm';
import { star } from '../entity/star';
import settingService from './setting-service';
import accountService from './account-service';
import BizError from '../error/biz-error';
import emailUtils from '../utils/email-utils';
import fileUtils from '../utils/file-utils';
import { Resend } from 'resend';
import attService from './att-service';
import { parseHTML } from 'linkedom';
import userService from './user-service';
import roleService from './role-service';
import user from '../entity/user';
import starService from './star-service';
import dayjs from 'dayjs';
import kvConst from '../const/kv-const';
import { t } from '../i18n/i18n'
import domainUtils from '../utils/domain-uitls';
import account from "../entity/account";
import { att } from '../entity/att';
import telegramService from './telegram-service';
import emailSearchService from './email-search-service';

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

const emailService = {

	async list(c, params, userId) {

		let { emailId, type, accountId, size, timeSort, allReceive } = params;
		const lite = toBoolFlag(params.lite);
		const withTotal = toBoolFlag(params.withTotal, true);

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

		const listQuery = query.limit(size + 1).all();

		const totalQuery = withTotal ? orm(c).select({ total: count() }).from(email)
			.leftJoin(
				account,
				eq(account.accountId, email.accountId)
			)
			.where(
				and(
					allReceive ? eq(1,1) : eq(email.accountId, accountId),
					eq(email.userId, userId),
					eq(email.type, type),
					eq(email.isDel, isDel.NORMAL),
					eq(account.isDel, isDel.NORMAL)
				)
		).get() : Promise.resolve({ total: 0 });

		const latestEmailQuery = orm(c).select({
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
			.orderBy(desc(email.emailId)).limit(1).get();

		let [list, totalRow, latestEmail] = await Promise.all([listQuery, totalQuery, latestEmailQuery]);

		const hasMore = list.length > size;
		list = hasMore ? list.slice(0, size) : list;

		list = list.map(item => ({
			...item,
			isStar: item.starId != null ? 1 : 0,
			previewText: previewText(item)
		}));


		await this.emailAddAtt(c, list);

		if (!latestEmail) {
			latestEmail = {
				emailId: 0,
				accountId: accountId,
				userId: userId,
			}
		}

		return { list, total: totalRow.total, latestEmail, hasMore };
	},

	async delete(c, params, userId) {
		const { emailIds } = params;
		const emailIdList = emailIds.split(',').map(Number);
		await orm(c).update(email).set({ isDel: isDel.DELETE }).where(
			and(
				eq(email.userId, userId),
				inArray(email.emailId, emailIdList)))
			.run();
		await emailSearchService.syncEmailIds(c, emailIdList);
	},

	receive(c, params, cidAttList, r2domain) {
		params.content = this.imgReplace(params.content, cidAttList, r2domain)
		return orm(c).insert(email).values({ ...params }).returning().get();
	},

	//邮件发送
	async send(c, params, userId) {

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

		const { resendTokens, r2Domain, send, domainList } = await settingService.query(c);

		let { imageDataList, html } = await attService.toImageUrlHtml(c, content);

		//判断是否关闭发件功能
		if (send === settingConst.send.CLOSE) {
			throw new BizError(t('disabledSend'), 403);
		}

		const userRow = await userService.selectById(c, userId);
		const roleRow = await roleService.selectById(c, userRow.type);

		//判断接收方是不是全部为站内邮箱
		const allInternal = receiveEmail.every(email => {
			const domain = '@' + emailUtils.getDomain(email);
			return domainList.includes(domain);
		});

		if (c.env.admin !== userRow.email) {

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
		if (c.env.admin !== userRow.email && roleRow.sendCount) {

			if (userRow.sendCount >= roleRow.sendCount) {
				if (roleRow.sendType === 'day') throw new BizError(t('daySendLimit'), 403);
				if (roleRow.sendType === 'count') throw new BizError(t('totalSendLimit'), 403);
			}

			if (userRow.sendCount + receiveEmail.length > roleRow.sendCount) {
				if (roleRow.sendType === 'day') throw new BizError(t('daySendLack'), 403);
				if (roleRow.sendType === 'count') throw new BizError(t('totalSendLack'), 403);
			}

		}

		const accountRow = await accountService.selectById(c, accountId);

		if (!accountRow) {
			throw new BizError(t('senderAccountNotExist'));
		}

		if (accountRow.userId !== userId) {
			throw new BizError(t('sendEmailNotCurUser'));
		}

		if (c.env.admin !== userRow.email) {
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

		//没有发件人名字自动截取
		if (!name) {
			name = emailUtils.getName(accountRow.email);
		}

		let emailRow = {
			messageId: null
		};

		//如果是回复邮件
		if (sendType === 'reply') {

			emailRow = await this.selectById(c, emailId);

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

		imageDataList = imageDataList.map(item => ({...item, contentId: `<${item.contentId}>`}))

		//把图片标签cid标签切换会通用url
		html = this.imgReplace(html, imageDataList, r2Domain);

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

		if (sendType === 'reply') {
			emailData.inReplyTo = emailRow.messageId;
			emailData.relation = emailRow.messageId;
		}

		//保存到数据库并返回结果
		const emailResult = await orm(c).insert(email).values(emailData).returning().get();
		await emailSearchService.syncEmailIds(c, [emailResult.emailId]);

		//保存内嵌附件
		if (imageDataList.length > 0) {
			await attService.saveArticleAtt(c, imageDataList, userId, accountId, emailResult.emailId);
		}

		//保存普通附件
		if (attachments?.length > 0) {
			await attService.saveSendAtt(c, attachments, userId, accountId, emailResult.emailId);
		}

		const attList = await attService.selectByEmailIds(c, [emailResult.emailId]);
		emailResult.attList = attList;

		if (!allInternal) {
			const sendResult = await this.sendExternalProvider(c, {
				useCloudflareEmail,
				resendToken,
				name,
				accountEmail: accountRow.email,
				receiveEmail,
				subject,
				text,
				html: providerHtml,
				attachments: providerAttachments,
				sendType,
				messageId: emailRow.messageId,
				emailId: emailResult.emailId
			});

			emailResult.status = useCloudflareEmail ? emailConst.status.DELIVERED : emailConst.status.SENT;
			emailResult.resendEmailId = sendResult.data?.id;
		}

		//如果全是站内接收方，直接写入数据库
		if (allInternal) {
			await this.HandleOnSiteEmail(c, receiveEmail, emailResult, attList);
		}

		await this.recordSendMetrics(c, { roleRow, receiveEmail, userId });

		return [ emailResult ];
	},

	async sendExternalProvider(c, params) {
		let sendResult = {};

		try {
			if (params.useCloudflareEmail) {
				sendResult = await this.sendByCloudflareEmail(c, params);
			} else {
				sendResult = await this.sendByResend(params.resendToken, params);
			}
		} catch (e) {
			await this.markSendFailed(c, params.emailId, e?.message || String(e));
			throw e instanceof BizError ? e : new BizError(e?.message || String(e));
		}

		const { data, error } = sendResult;

		if (error) {
			await this.markSendFailed(c, params.emailId, error.message);
			throw new BizError(error.message);
		}

		const status = params.useCloudflareEmail ? emailConst.status.DELIVERED : emailConst.status.SENT;
		const updateData = { status, message: '' };
		if (data?.id) {
			updateData.resendEmailId = data.id;
		}

		try {
			await orm(c).update(email).set(updateData).where(eq(email.emailId, params.emailId)).run();
			await emailSearchService.syncEmailIds(c, [params.emailId]);
		} catch (e) {
			console.error(`Post-send status update failed for email ${params.emailId}:`, e?.message || e);
		}

		return { data: data || {} };
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

	async recordSendMetrics(c, { roleRow, receiveEmail, userId }) {
		try {
			if (roleRow.sendCount && roleRow.sendType !== 'internal') {
				await userService.incrUserSendCount(c, receiveEmail.length, userId);
			}

			const dateStr = dayjs().format('YYYY-MM-DD');
			let daySendTotal = await c.env.kv.get(kvConst.SEND_DAY_COUNT + dateStr);

			if (!daySendTotal) {
				await c.env.kv.put(kvConst.SEND_DAY_COUNT + dateStr, JSON.stringify(receiveEmail.length), { expirationTtl: 60 * 60 * 24 });
			} else  {
				daySendTotal = Number(daySendTotal) + receiveEmail.length
				await c.env.kv.put(kvConst.SEND_DAY_COUNT + dateStr, JSON.stringify(daySendTotal), { expirationTtl: 60 * 60 * 24 });
			}
		} catch (e) {
			console.error('Post-send metrics update failed:', e?.message || e);
		}
	},

	async sendByCloudflareEmail(c, params) {
		const sendForm = {
			from: { email: params.accountEmail, name: params.name },
			to: [...params.receiveEmail],
			subject: params.subject
		};

		if (params.text) {
			sendForm.text = params.text;
		}

		if (params.html) {
			sendForm.html = params.html;
		}

		const attachments = await this.toCloudflareAttachments(params.attachments);
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

	async sendByResend(resendToken, params) {
		const resend = new Resend(resendToken);

		const sendForm = {
			from: `${params.name} <${params.accountEmail}>`,
			to: [...params.receiveEmail],
			subject: params.subject,
			text: params.text,
			html: params.html,
			attachments: await this.toResendAttachments(params.attachments)
		};

		if (params.sendType === 'reply') {
			sendForm.headers = {
				'in-reply-to': params.messageId,
				'references': params.messageId
			};
		}

		return await resend.emails.send(sendForm);
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

		const { noRecipient  } = await settingService.query(c);

		//查询所有收件人账号信息
		let accountList = await orm(c).select().from(account).where(inArray(account.email, receiveEmail)).all();

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

			const accountRow = accountList.find(accountRow => accountRow.email === email);

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
				if (email !== c.env.admin) {

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

		//保存邮件
		const receiveEmailList = emailDataList.filter(emailRow => emailRow.status === emailConst.status.RECEIVE || emailRow.status === emailConst.status.NOONE);

		for (const emailData of receiveEmailList) {

			const emailRow = await orm(c).insert(email).values(emailData).returning().get();
			await emailSearchService.syncEmailIds(c, [emailRow.emailId]);

			//设置附件保存
			for (const attRow of attList) {
				const attValues = {...attRow};
				attValues.emailId = emailRow.emailId;
				attValues.accountId = emailRow.accountId;
				attValues.userId = emailRow.userId;
				attValues.attId = null;
				await orm(c).insert(att).values(attValues).run();
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

	imgReplace(content, cidAttList, r2domain) {

		if (!content) {
			return ''
		}

		const { document } = parseHTML(content);

		const images = Array.from(document.querySelectorAll('img'));

		const useAtts = []

		for (const img of images) {

			const src = img.getAttribute('src');
			if (src && src.startsWith('cid:') && cidAttList) {

				const cid = src.replace(/^cid:/, '');
				const attCidIndex = cidAttList.findIndex(cidAtt => cidAtt.contentId.replace(/^<|>$/g, '') === cid);

				if (attCidIndex > -1) {
					const cidAtt = cidAttList[attCidIndex];
					img.setAttribute('src', '{{domain}}' + cidAtt.key);
					useAtts.push(cidAtt)
				}

			}

			r2domain = domainUtils.toOssDomain(r2domain)

			if (src && src.startsWith(r2domain + '/')) {
				img.setAttribute('src', src.replace(r2domain + '/', '{{domain}}'));
			}

		}

		useAtts.forEach(att => {
			att.type = attConst.type.EMBED
		})

		return document.toString();
	},

	selectById(c, emailId) {
		return orm(c).select().from(email).where(
			and(eq(email.emailId, emailId),
				eq(email.isDel, isDel.NORMAL)))
			.get();
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

		await this.emailAddAtt(c, list);
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
		await orm(c).delete(email).where(inArray(email.emailId, emailIds)).run();
	},

	async physicsDeleteUserIds(c, userIds) {
		await attService.removeByUserIds(c, userIds);
		const emailIds = await orm(c).select({ emailId: email.emailId }).from(email).where(inArray(email.userId, userIds)).all();
		await emailSearchService.removeEmailIds(c, emailIds.map(row => row.emailId));
		await orm(c).delete(email).where(inArray(email.userId, userIds)).run();
	},

	async updateEmailStatus(c, params) {
		const { status, resendEmailId, message } = params;
		const emailRow = await orm(c).update(email).set({
			status: status,
			message: message
		}).where(eq(email.resendEmailId, resendEmailId)).returning().get();
		if (emailRow) {
			await emailSearchService.syncEmailIds(c, [emailRow.emailId]);
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

	async allList(c, params) {

		let { emailId, size, name, subject, accountEmail, userEmail, searchText, type, timeSort } = params;
		const lite = toBoolFlag(params.lite);
		const withTotal = toBoolFlag(params.withTotal, true);

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
			const searchData = await emailSearchService.allList(c, params, { size, emailId, timeSort, withTotal });
			if (searchData) {
				let { list, totalRow, latestEmail, hasMore } = searchData;

				await this.emailAddAtt(c, list);
				list = list.map(item => ({
					...item,
					previewText: previewText(item)
				}));

				if (!latestEmail) {
					latestEmail = {
						emailId: 0,
						accountId: 0,
						userId: 0,
					}
				}

				return { list: list, total: totalRow.total, latestEmail, hasMore };
			}
		}

		const conditions = [];

		if (type === 'send') {
			conditions.push(eq(email.type, emailConst.type.SEND));
		}

		if (type === 'receive') {
			conditions.push(eq(email.type, emailConst.type.RECEIVE));
		}

		if (type === 'delete') {
			conditions.push(eq(email.isDel, isDel.DELETE));
		}

		if (type === 'noone') {
			conditions.push(eq(email.status, emailConst.status.NOONE));
		}

		if (userEmail) {
			conditions.push(sql`${user.email} COLLATE NOCASE LIKE ${'%'+ userEmail + '%'}`);
		}

		if (accountEmail) {
			conditions.push(
				or(
					sql`${email.toEmail} COLLATE NOCASE LIKE ${'%'+ accountEmail + '%'}`,
					sql`${email.sendEmail} COLLATE NOCASE LIKE ${'%'+ accountEmail + '%'}`,
				)
			)
		}

		if (name) {
			conditions.push(sql`${email.name} COLLATE NOCASE LIKE ${'%'+ name + '%'}`);
		}

		if (subject) {
			conditions.push(sql`${email.subject} COLLATE NOCASE LIKE ${'%'+ subject + '%'}`);
		}

		if (searchText) {
			conditions.push(sql`${email.text} COLLATE NOCASE LIKE ${'%'+ searchText + '%'}`);
		}

		conditions.push(ne(email.status, emailConst.status.SAVING));

		const countConditions = [...conditions];

		if (timeSort) {
			conditions.unshift(gt(email.emailId, emailId));
		} else {
			conditions.unshift(lt(email.emailId, emailId));
		}

		const query = orm(c).select(lite ? allEmailListSelect : { ...email, userEmail: user.email })
			.from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(and(...conditions));

		const queryCount = withTotal ? orm(c).select({ total: count() })
			.from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(and(...countConditions)) : Promise.resolve({ total: 0 });

		if (timeSort) {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		const listQuery = query.limit(size + 1).all();
		const totalQuery = withTotal ? queryCount.get() : queryCount;
		const latestEmailQuery = orm(c).select({
			emailId: email.emailId,
			accountId: email.accountId,
			userId: email.userId
		}).from(email)
			.where(and(
				eq(email.type, emailConst.type.RECEIVE),
				ne(email.status, emailConst.status.SAVING)
			))
			.orderBy(desc(email.emailId)).limit(1).get();

		let [list, totalRow, latestEmail] = await Promise.all([listQuery, totalQuery, latestEmailQuery]);

		const hasMore = list.length > size;
		list = hasMore ? list.slice(0, size) : list;

		await this.emailAddAtt(c, list);
		list = list.map(item => ({
			...item,
			previewText: previewText(item)
		}));

		if (!latestEmail) {
			latestEmail = {
				emailId: 0,
				accountId: 0,
				userId: 0,
			}
		}

		return { list: list, total: totalRow.total, latestEmail, hasMore };
	},

	async allEmailLatest(c, params) {

		const { emailId } = params;
		const lite = toBoolFlag(params.lite);

		let list = await orm(c).select(lite ? allEmailListSelect : {...email, userEmail: user.email}).from(email)
			.leftJoin(user, eq(email.userId, user.userId))
			.where(
				and(
					gt(email.emailId, emailId),
					eq(email.type, emailConst.type.RECEIVE),
					ne(email.status, emailConst.status.SAVING)
				))
			.orderBy(desc(email.emailId))
			.limit(20);

		await this.emailAddAtt(c, list);
		list = list.map(item => ({
			...item,
			previewText: previewText(item)
		}));

		return list;
	},

	async emailAddAtt(c, list) {

		const emailIds = list.map(item => item.emailId);

		if (emailIds.length > 0) {

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
			status: status
		}).where(eq(email.emailId, emailId)).returning().get();
		await emailSearchService.syncEmailIds(c, [emailId]);
		return emailRow;
	},

	async completeReceiveAll(c) {
		const { results: pendingRows = [] } = await c.env.db.prepare(`
			SELECT email_id AS emailId
			FROM email
			WHERE status = ? AND is_del = ? AND type = ?
		`).bind(emailConst.status.SAVING, isDel.NORMAL, emailConst.type.RECEIVE).all();
		await c.env.db.prepare(`
			UPDATE email as e
			SET status = ?
			WHERE status = ? AND is_del = ? AND type = ? AND EXISTS (SELECT 1 FROM account WHERE account_id = e.account_id)
		`).bind(emailConst.status.RECEIVE, emailConst.status.SAVING, isDel.NORMAL, emailConst.type.RECEIVE).run();
		await c.env.db.prepare(`
			UPDATE email as e
			SET status = ?
			WHERE status = ? AND is_del = ? AND type = ? AND NOT EXISTS (SELECT 1 FROM account WHERE account_id = e.account_id)
		`).bind(emailConst.status.NOONE, emailConst.status.SAVING, isDel.NORMAL, emailConst.type.RECEIVE).run();
		await emailSearchService.syncEmailIds(c, pendingRows.map(row => row.emailId));
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
		await orm(c).update(email).set({ unread: emailConst.unread.READ }).where(and(eq(email.userId, userId), inArray(email.emailId, emailIds)));
	}
};

export default emailService;
