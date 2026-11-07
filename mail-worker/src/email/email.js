import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, settingConst, userConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import roleService from '../service/role-service';
import userService from '../service/user-service';
import telegramService from '../service/telegram-service';
import aiService from '../service/ai-service';

const INCOMING_ATTACHMENT_LIMIT = 10;

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain,
			noRecipient,
			blackSubject,
			blackContent,
			blackFrom,
			aiCode,
			aiCodeFilter
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			message.setReject('Service suspended');
			return;
		}

		// 解析原始邮件与账号查询互不依赖，并行执行缩短收信主链
		const [parsedEmail, accountRow] = await Promise.all([
			PostalMime.parse(message.raw),
			accountService.selectByEmailIncludeDel({ env: env }, message.to)
		]);
		const email = parsedEmail;
		const incomingAttachments = Array.isArray(email.attachments) ? email.attachments : [];
		if (incomingAttachments.length > INCOMING_ATTACHMENT_LIMIT) {
			message.setReject('Too many attachments');
			return;
		}


		const blockFlag = checkBlock(blackSubject, blackContent, blackFrom, email);

		if (blockFlag) {
			message.setReject('Message rejected');
			return;
		}

		let account = accountRow;
		let userRow = null;

		if (account?.isDel !== isDel.NORMAL) {
			account = null;
		}

		if (account) {
			userRow = await userService.selectByIdIncludeDel({ env: env }, account.userId);
			if (!userRow
				|| userRow.isDel !== isDel.NORMAL
				|| userRow.status !== userConst.status.NORMAL) {
				account = null;
			}
		}

		if (!account && noRecipient === settingConst.noRecipient.CLOSE) {
			message.setReject('Recipient not found');
			return;
		}

		if (account && !emailUtils.isSameAddress(userRow.email, env.admin)) {

			let { banEmail, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if (!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				message.setReject('The recipient is not authorized to use this domain.');
				return;
			}

			if(roleService.isBanEmail(banEmail, email.from.address)) {
				message.setReject('The recipient is disabled from receiving emails.');
				return;
			}

		}


		if (!email.to) {
			email.to = [{ address: message.to, name: emailUtils.getName(message.to)}]
		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';
		const patternCode = aiService.extractCodeByPattern(email);
		const shouldExtractCode = aiService.shouldExtractCode(aiCode, aiCodeFilter, email);

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			code: patternCode,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of incomingAttachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		params.attachmentCount = attachments.length;

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		if (attachments.length > 0) {
			try {
				await attService.addAtt({ env }, attachments);
			} catch (e) {
				if (!e?.attachmentRecoveryPending) {
					const failureCode = e?.code === 'ATTACHMENT_OBJECT_WRITE_FAILED'
						? e.code
						: 'ATTACHMENT_STORAGE_FAILED';
					await emailService.failReceive({ env }, emailRow.emailId, failureCode);
				}
				throw e;
			}
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);

		if (shouldExtractCode && !patternCode) {
			const codeTask = (async () => {
				const code = await aiService.extractCode({ env }, email, { aiCode, aiCodeFilter, patternChecked: true });
				if (code) {
					await emailService.updateCode({ env }, emailRow.emailId, code);
				}
			})();
			if (ctx?.waitUntil) {
				ctx.waitUntil(codeTask);
			} else {
				await codeTask;
			}
		}


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}

		//转发到TG，走后台不阻塞收信主链
		if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {
			const pushTask = telegramService.sendEmailToBot({ env }, emailRow)
				.catch(e => console.error('TG push failed:', e?.message || e));
			if (ctx?.waitUntil) {
				ctx.waitUntil(pushTask);
			} else {
				await pushTask;
			}
		}

		//转发到其他邮箱，与 TG 推送一样走后台不阻塞收信主链
		if (forwardStatus === settingConst.forwardStatus.OPEN && forwardEmail) {

			const emails = forwardEmail.split(',');

			const forwardTask = Promise.all(emails.map(async email => {

				try {
					await message.forward(email);
				} catch (e) {
					console.error(`转发邮箱 ${email} 失败：`, e);
				}

			}));

			if (ctx?.waitUntil) {
				ctx.waitUntil(forwardTask);
			} else {
				await forwardTask;
			}

		}

	} catch (e) {
		console.error('Incoming email failed:', e?.code || e?.name || 'Error');
		throw e
	}
}

function blockList(value) {
	if (typeof value !== 'string') {
		return [];
	}

	return value.split(',').map(item => item.trim()).filter(Boolean);
}

function checkBlock(blackSubjectStr, blackContentStr, blackFromStr, email) {

	const blackFromList = blockList(blackFromStr);
	const blackContentList = blockList(blackContentStr);
	const blackSubjectList = blockList(blackSubjectStr);

	for (const blackSubject of blackSubjectList) {
		if (email.subject?.includes(blackSubject)) {
			return true
		}
	}

	for (const blackContent of blackContentList) {
		if (email.html?.includes(blackContent) || email.text?.includes(blackContent)) {
			return true
		}
	}

	for (const blackFrom of blackFromList) {
		if (email.from.address === blackFrom || emailUtils.getDomain(email.from.address) === blackFrom) {
			return true
		}
	}

	return false

}
