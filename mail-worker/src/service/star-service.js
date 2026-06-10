import orm from '../entity/orm';
import { star } from '../entity/star';
import emailService from './email-service';
import BizError from '../error/biz-error';
import { and, desc, eq, lt, sql, inArray } from 'drizzle-orm';
import email from '../entity/email';
import { isDel } from '../const/entity-const';
import attService from "./att-service";
import { t } from '../i18n/i18n'
import { chunkArray } from '../utils/sql-utils';

const starEmailListSelect = {
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

function isLite(value) {
	return value === true || value === '1' || value === 1 || value === 'true';
}

function previewText(row) {
	const text = row.text || '';
	return text
		.replace(/[\u200B-\u200F\uFEFF\u034F\u00A0\u3000\u00AD]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

const starService = {

	async add(c, params, userId) {
		const { emailId } = params;
		const email = await emailService.selectById(c, emailId);
		if (!email) {
			throw new BizError(t('starNotExistEmail'));
		}
		if (email.userId !== userId) {
			throw new BizError(t('starNotExistEmail'));
		}
		const exist = await orm(c).select().from(star).where(
			and(
				eq(star.userId, userId),
				eq(star.emailId, emailId)))
			.get()

		if (exist) {
			return
		}

		await orm(c).insert(star).values({ userId, emailId }).run();
	},

	async cancel(c, params, userId) {
		const { emailId } = params;
		await orm(c).delete(star).where(
			and(
				eq(star.userId, userId),
				eq(star.emailId, emailId)))
			.run();
	},

	async list(c, params, userId) {
		let { emailId, size } = params;
		const lite = isLite(params.lite);
		emailId = Number(emailId);
		size = Number(size);
		if (!Number.isFinite(size) || size <= 0) {
			size = 50;
		}
		size = Math.min(size, 50);

		if (!emailId) {
			emailId = 9999999999;
		}

		const list = await orm(c).select({
			isStar: sql`1`.as('isStar'),
			starId: star.starId,
			...(lite ? starEmailListSelect : email)
		}).from(star)
			.leftJoin(email, eq(email.emailId, star.emailId))
			.where(
				and(
					eq(star.userId, userId),
					eq(email.isDel, isDel.NORMAL),
					lt(star.emailId, emailId)))
			.orderBy(desc(star.emailId))
			.limit(size)
			.all();

		const emailIds = list.map(item => item.emailId);
		const attsList = await attService.selectByEmailIds(c, emailIds);
		const attMap = new Map();

		attsList.forEach(attRow => {
			const atts = attMap.get(attRow.emailId) || [];
			atts.push(attRow);
			attMap.set(attRow.emailId, atts);
		});

		list.forEach(emailRow => {
			const atts = attMap.get(emailRow.emailId) || [];
			emailRow.attList = atts;
			emailRow.attCount = atts.length;
			emailRow.previewText = previewText(emailRow);
		});

		return { list };
	},
	async removeByEmailIds(c, emailIds) {
		for (const chunk of chunkArray(emailIds)) {
			await orm(c).delete(star).where(inArray(star.emailId, chunk)).run();
		}
	}
};

export default starService;
