import orm from '../entity/orm';
import { att } from '../entity/att';
import { and, count, eq, isNull, inArray, desc, sql } from 'drizzle-orm';
import r2Service from './r2-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { attConst, emailConst } from '../const/entity-const';
import { parseHTML } from 'linkedom';
import { v4 as uuidv4 } from 'uuid';
import domainUtils from '../utils/domain-uitls';
import settingService from "./setting-service";
import BizError from '../error/biz-error';
import { chunkArray } from '../utils/sql-utils';

const NOT_FOUND_MESSAGE = 'Attachment not found';
// Leaves headroom below the Workers Free 50 external-subrequest limit when S3 is used.
const RECEIVE_RECOVERY_ATTACHMENT_LIMIT = 10;
// D1 每条语句最多 100 个绑定参数；attachments 表 16 列，5 行/块 = 至多 80 个绑定。
const ATT_INSERT_CHUNK_ROWS = 5;

function normalizeAttId(attId) {
	const id = Number(attId);
	return Number.isInteger(id) && id > 0 ? id : null;
}

function contentDisposition(filename) {
	const fallback = String(filename || 'attachment')
		.replace(/[\r\n"\\]/g, '_')
		.replace(/[^\x20-\x7E]/g, '_') || 'attachment';
	const encoded = encodeURIComponent(filename || 'attachment')
		.replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function attachmentMimeType(attachment) {
	return attachment.mimeType
		|| attachment.contentType
		|| attachment.type
		|| 'application/octet-stream';
}

function parentEmailReadyCondition() {
	return sql`EXISTS (
		SELECT 1
		FROM email e
		WHERE e.email_id = ${att.emailId}
		  AND e.status NOT IN (${emailConst.status.SAVING}, ${emailConst.status.FAILED})
	)`;
}

function attachmentStorageError(message, recoveryPending = false) {
	const error = new Error(message);
	error.code = recoveryPending
		? 'ATTACHMENT_STATE_UPDATE_FAILED'
		: 'ATTACHMENT_OBJECT_WRITE_FAILED';
	error.attachmentRecoveryPending = recoveryPending;
	return error;
}

function prepareRecoveryStatusUpdate(c, {
	emailId,
	keys,
	status,
	message,
	fromStatuses
}) {
	const keyPlaceholders = keys.map(() => '?').join(',');
	const statusPlaceholders = fromStatuses.map(() => '?').join(',');
	return c.env.db.prepare(`
		UPDATE attachments
		SET status = ?, message = ?
		WHERE email_id = ?
		  AND key IN (${keyPlaceholders})
		  AND status IN (${statusPlaceholders})
	`).bind(status, message, emailId, ...keys, ...fromStatuses);
}

async function updateRecoveryStatus(c, params) {
	if (params.keys.length === 0) {
		return;
	}
	await prepareRecoveryStatusUpdate(c, params).run();
}

async function updateAttachmentKeyStatus(c, attachments, key, status, message = null) {
	const emailIds = [...new Set(attachments
		.filter(item => item.key === key)
		.map(item => item.emailId))];

	for (const emailId of emailIds) {
		const result = await c.env.db.prepare(`
			UPDATE attachments
			SET status = ?, message = ?
			WHERE email_id = ? AND key = ? AND status = ?
		`).bind(
			status,
			message,
			emailId,
			key,
			attConst.status.PENDING
		).run();
		const changes = Number(result?.meta?.changes);
		if (Number.isFinite(changes) && changes === 0) {
			throw new Error('Attachment status transition did not update any rows');
		}
	}
}

async function failPendingAttachmentRows(c, attachments, message = 'BATCH_ABORTED') {
	const emailIds = [...new Set(attachments
		.map(item => item.emailId)
		.filter(emailId => emailId !== undefined && emailId !== null))];

	for (const emailId of emailIds) {
		await c.env.db.prepare(`
			UPDATE attachments
			SET status = ?, message = ?
			WHERE email_id = ? AND status = ?
		`).bind(
			attConst.status.FAILED,
			message,
			emailId,
			attConst.status.PENDING
		).run();
	}
}

// 批量把指定 key 的 PENDING 行置 FAILED；emailId 分组后一条语句处理同邮件多 key
async function failAttachmentKeys(c, attachments, failedKeys) {
	const keyList = [...new Set(failedKeys)];
	const keyPlaceholders = keyList.map(() => '?').join(',');
	const emailIds = [...new Set(attachments
		.filter(item => keyList.includes(item.key))
		.map(item => item.emailId))];

	for (const emailId of emailIds) {
		await c.env.db.prepare(`
			UPDATE attachments
			SET status = ?, message = ?
			WHERE email_id = ? AND key IN (${keyPlaceholders}) AND status = ?
		`).bind(
			attConst.status.FAILED,
			'OBJECT_WRITE_FAILED',
			emailId,
			...keyList,
			attConst.status.PENDING
		).run();
	}

	// 其余仍处 PENDING 的行也一并标失败，保持原有整批失败语义
	await failPendingAttachmentRows(c, attachments);
}

// 批量把全部 PENDING 行按 key 置 READY；emailId 去重分组（含 undefined 组），一次语句完成
async function markAttachmentKeysReady(c, attachments, keys) {
	if (keys.length === 0) {
		return;
	}
	const keyPlaceholders = keys.map(() => '?').join(',');
	const emailIds = [...new Set(attachments.map(item => item.emailId))];

	for (const emailId of emailIds) {
		const result = await c.env.db.prepare(`
			UPDATE attachments
			SET status = ?, message = NULL
			WHERE email_id = ? AND key IN (${keyPlaceholders}) AND status = ?
		`).bind(attConst.status.READY, emailId, ...keys, attConst.status.PENDING).run();
		const changes = Number(result?.meta?.changes);
		if (Number.isFinite(changes) && changes === 0) {
			throw new Error('Attachment status transition did not update any rows');
		}
	}
}
const attService = {

	async addAtt(c, attachments) {

		// 三段式：批量插行(状态 PENDING) -> 并行写对象 -> 一条 WHERE key IN 批量置 READY。
		// N 个附件从 2N 次串行往返降为 1 轮并行写 + 1 次批量状态更新
		const attachmentRows = attachments.map(attachment => ({
			...attachment,
			status: attConst.status.PENDING,
			type: attachment.type === attConst.type.EMBED
				? attConst.type.EMBED
				: attConst.type.ATT
		}));
		for (const rowChunk of chunkArray(attachmentRows, ATT_INSERT_CHUNK_ROWS)) {
			await orm(c).insert(att).values(rowChunk).run();
		}

		// 去重后并行写对象；任一失败则整批标 FAILED 并抛错（父邮件仍隐藏，行可被恢复任务处理）
		const uniqueAttachments = [];
		const seenKeys = new Set();
		for (const attachment of attachments) {
			if (!seenKeys.has(attachment.key)) {
				seenKeys.add(attachment.key);
				uniqueAttachments.push(attachment);
			}
		}

		const writeResults = await Promise.allSettled(uniqueAttachments.map(async attachment => {
			const metadata = {
				contentType: attachmentMimeType(attachment)
			};
			if (attachment.contentId) {
				metadata.contentDisposition = 'inline';
				metadata.cacheControl = `max-age=259200`;
			}
			await r2Service.putObj(c, attachment.key, attachment.content, metadata);
		}));

		const failedKeys = writeResults
			.map((result, index) => result.status === 'rejected' ? uniqueAttachments[index].key : null)
			.filter(Boolean);

		if (failedKeys.length > 0) {
			try {
				await failAttachmentKeys(c, attachments, failedKeys);
			} catch {
				// Leave PENDING rows for the recovery job when D1 is unavailable.
			}
			throw attachmentStorageError('Attachment object storage failed');
		}

		// 全部对象写入成功：一次批量置 READY
		try {
			await markAttachmentKeysReady(c, attachments, [...seenKeys]);
		} catch {
			throw attachmentStorageError('Attachment state update failed', true);
		}

	},

	list(c, params, userId) {
		const { emailId } = params;

		return orm(c).select().from(att).where(
			and(
				eq(att.emailId, emailId),
				eq(att.userId, userId),
				eq(att.type, attConst.type.ATT),
				eq(att.status, attConst.status.READY),
				parentEmailReadyCondition(),
				isNull(att.contentId)
			)
		).all();
	},

	async reconcileReceived(c, emailId) {
		const { results: rows = [] } = await c.env.db.prepare(`
			SELECT att_id AS attId, key, status, message
			FROM attachments
			WHERE email_id = ?
			ORDER BY att_id
			LIMIT ${RECEIVE_RECOVERY_ATTACHMENT_LIMIT + 1}
		`).bind(emailId).all();
		if (rows.length > RECEIVE_RECOVERY_ATTACHMENT_LIMIT) {
			return {
				total: rows.length,
				ready: 0,
				pending: 0,
				failed: 0,
				other: 0,
				overflow: true
			};
		}
		const rowsByKey = new Map();
		for (const row of rows) {
			const keyRows = rowsByKey.get(row.key) || [];
			keyRows.push(row);
			rowsByKey.set(row.key, keyRows);
		}
		const storageType = rowsByKey.size > 0
			? await r2Service.storageType(c)
			: null;
		const readyKeys = [];
		const failedKeys = [];
		const recheckKeys = [];

		for (const [key, keyRows] of rowsByKey) {
			const statuses = keyRows.map(row => Number(row.status));
			if (!statuses.some(status => (
				status === attConst.status.READY || status === attConst.status.PENDING
			))) {
				continue;
			}

			const exists = await r2Service.exists(c, key, {
				storageType,
				maxAttempts: 1
			});
			if (!exists) {
				const kvMissingAlreadyObserved = keyRows.every(row => (
					row.message === 'OBJECT_MISSING_RECHECK'
				));
				if (storageType === 'KV' && !kvMissingAlreadyObserved) {
					recheckKeys.push(key);
					continue;
				}
				failedKeys.push(key);
				continue;
			}

			if (statuses.includes(attConst.status.PENDING)) {
				readyKeys.push(key);
			}
		}

		await updateRecoveryStatus(c, {
			emailId,
			keys: readyKeys,
			status: attConst.status.READY,
			message: null,
			fromStatuses: [attConst.status.PENDING]
		});
		await updateRecoveryStatus(c, {
			emailId,
			keys: failedKeys,
			status: attConst.status.FAILED,
			message: 'OBJECT_MISSING',
			fromStatuses: [attConst.status.READY, attConst.status.PENDING]
		});
		if (recheckKeys.length > 0) {
			await c.env.db.batch([
				c.env.db.prepare(`
					UPDATE email
					SET recovery_after = datetime('now', '+5 minutes'), message = ?
					WHERE email_id = ? AND type = ? AND status = ?
				`).bind(
					'ATTACHMENT_RECOVERY_RETRY',
					emailId,
					emailConst.type.RECEIVE,
					emailConst.status.SAVING
				),
				prepareRecoveryStatusUpdate(c, {
					emailId,
					keys: recheckKeys,
					status: attConst.status.PENDING,
					message: 'OBJECT_MISSING_RECHECK',
					fromStatuses: [attConst.status.READY, attConst.status.PENDING]
				})
			]);
		}

		const summary = await c.env.db.prepare(`
			SELECT
				COUNT(*) AS total,
				SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS ready,
				SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS pending,
				SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS failed
			FROM attachments
			WHERE email_id = ?
		`).bind(
			attConst.status.READY,
			attConst.status.PENDING,
			attConst.status.FAILED,
			emailId
		).first();

		const total = Number(summary?.total || 0);
		const ready = Number(summary?.ready || 0);
		const pending = Number(summary?.pending || 0);
		const failed = Number(summary?.failed || 0);
		return {
			total,
			ready,
			pending,
			failed,
			other: Math.max(0, total - ready - pending - failed)
		};
	},

	async download(c, params, userId) {
		const attRow = await this.selectDownloadAtt(c, params.attId, userId);
		return await this.toDownloadResponse(c, attRow);
	},

	async downloadAny(c, params) {
		const attRow = await this.selectDownloadAtt(c, params.attId);
		return await this.toDownloadResponse(c, attRow);
	},

	async selectDownloadAtt(c, attId, userId) {
		const id = normalizeAttId(attId);
		if (!id) {
			throw new BizError(NOT_FOUND_MESSAGE, 404);
		}

		const filters = [
			'a.att_id = ?',
			'a.type = ?',
			'a.status = ?',
			'e.status NOT IN (?, ?)',
			'(a.content_id IS NULL OR a.content_id = \'\')'
		];
		const bindings = [
			id,
			attConst.type.ATT,
			attConst.status.READY,
			emailConst.status.SAVING,
			emailConst.status.FAILED
		];

		if (userId !== undefined && userId !== null) {
			filters.push('a.user_id = ?', 'e.user_id = ?', 'e.is_del = 0');
			bindings.push(userId, userId);
		}

		const attRow = await c.env.db.prepare(`
			SELECT a.att_id as attId,
			       a.user_id as userId,
			       a.email_id as emailId,
			       a.account_id as accountId,
			       a.key,
			       a.filename,
			       a.mime_type as mimeType,
			       a.size,
			       a.type,
			       a.content_id as contentId
			FROM attachments a
			JOIN email e ON e.email_id = a.email_id
			WHERE ${filters.join(' AND ')}
			LIMIT 1
		`).bind(...bindings).first();

		if (!attRow) {
			throw new BizError(NOT_FOUND_MESSAGE, 404);
		}

		return attRow;
	},

	async toDownloadResponse(c, attRow) {
		const obj = await r2Service.getObj(c, attRow.key);
		const responseHeaders = {
			'Content-Disposition': contentDisposition(attRow.filename),
			'Cache-Control': 'private, max-age=0, no-store',
			'Access-Control-Expose-Headers': 'Content-Disposition'
		};
		if (attRow.mimeType) {
			responseHeaders['Content-Type'] = attRow.mimeType;
		}

		const response = r2Service.toResponse(obj, responseHeaders);

		if (!response) {
			throw new BizError(NOT_FOUND_MESSAGE, 404);
		}

		return response;
	},

	async toImageUrlHtml(c, content, userId) {

		const { r2Domain } = await settingService.query(c);

		const { document } = parseHTML(content);

		const images = Array.from(document.querySelectorAll('img'));

		let imageDataList = [];

		for (const img of images) {

			//邮件正文base64图片转cid附件
			const src = img.getAttribute('src');
			if (src && src.startsWith('data:image')) {
				const file = fileUtils.base64ToFile(src);
				const buff = await file.arrayBuffer();
				const cid = uuidv4().replace(/-/g, '');
				const key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(buff) + fileUtils.getExtFileName(file.name);

				img.setAttribute('src', 'cid:' + cid);

				const attData = {};
				attData.key = key;
				attData.filename = file.name;
				attData.mimeType = file.type;
				attData.size = file.size;
				attData.buff = buff;
				attData.content = fileUtils.base64ToDataStr(src);
				attData.contentId = cid;

				imageDataList.push(attData);
			}

			//邮件正文站内图片转cid附件
			if (src && (src.startsWith(domainUtils.toOssDomain(r2Domain)) || src.startsWith('attachments/'))) {

				const cid = uuidv4().replace(/-/g, '')
				img.setAttribute('src', 'cid:' + cid);

				const attData = {};

				if (src.startsWith(domainUtils.toOssDomain(r2Domain))) {
					attData.key = src.replace(domainUtils.toOssDomain(r2Domain) + '/','');
				}

				if (src.startsWith('attachments/')) {
					attData.key = src;
				}

				attData.contentId = cid;
				attData.type = attConst.type.EMBED;
				imageDataList.push(attData);

			}

			const hasInlineWidth = img.hasAttribute('width');
			const style = img.getAttribute('style') || '';
			const hasStyleWidth = /(^|\s)width\s*:\s*[^;]+/.test(style);

			if (!hasInlineWidth && !hasStyleWidth) {
				const newStyle = (style ? style.trim().replace(/;$/, '') + '; ' : '') + 'max-width: 100%;';
				img.setAttribute('style', newStyle);
			}
		}

		//查询已有内嵌url图片信息
		const keys = [...new Set(imageDataList.filter(item => !item.content).map(item => item.key))];
		const dbImageList  = await this.selectOneByKeys(c, keys, userId);

		//设置给当前附件
		await Promise.all(imageDataList.map(async image => {
			if (image.content) {
				return;
			}

			const dbImage = dbImageList.find(dbImage => image.key === dbImage.key);
			if (!dbImage) {
				return;
			}

			image.size = dbImage.size;
			image.filename = dbImage.filename;
			image.mimeType = dbImage.mimeType;
			image.contentType = dbImage.mimeType;

			const obj = await r2Service.getObj(c, image.key);
			if (!obj) {
				return;
			}

			image.content = obj instanceof ArrayBuffer ? obj : await obj.arrayBuffer();
		}))

		imageDataList = imageDataList.filter(image => image.content);

		return { imageDataList, html: document.toString() };
	},

	async saveSendAtt(c, attList, userId, accountId, emailId) {

		const attDataList = [];
		const objectByKey = new Map();

		for (let att of attList) {
			att.buff = fileUtils.base64ToUint8Array(att.content);
			att.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(att.buff) + fileUtils.getExtFileName(att.filename);
			att.mimeType = attachmentMimeType(att);
			if (!objectByKey.has(att.key)) {
				objectByKey.set(att.key, att);
			}
			const attData = { userId, accountId, emailId };
			attData.key = att.key;
			attData.size = att.buff.length;
			attData.filename = att.filename;
			attData.mimeType = att.mimeType;
			attData.status = attConst.status.PENDING;
			attData.type = attConst.type.ATT;
			attDataList.push(attData);
		}

		for (const rowChunk of chunkArray(attDataList, ATT_INSERT_CHUNK_ROWS)) {
			await orm(c).insert(att).values(rowChunk).run();
		}

		try {
			for (const att of objectByKey.values()) {
				try {
					await r2Service.putObj(c, att.key, att.buff, {
						contentType: att.mimeType
					});
				} catch (error) {
					try {
						await updateAttachmentKeyStatus(
							c,
							attDataList,
							att.key,
							attConst.status.FAILED,
							'OBJECT_WRITE_FAILED'
						);
					} catch {
						// The parent email remains hidden/failed; maintenance can inspect PENDING rows.
					}
					try {
						await failPendingAttachmentRows(c, attDataList);
					} catch {
						// D1 is unavailable; the parent send path will remain failed and inaccessible.
					}
					throw error;
				}

				await updateAttachmentKeyStatus(
					c,
					attDataList,
					att.key,
					attConst.status.READY
				);
			}
		} finally {
			for (const att of attList) {
				delete att.buff;
			}
		}

	},

	async saveArticleAtt(c, attDataList, userId, accountId, emailId) {
		const objectByKey = new Map();

		for (const attData of attDataList) {
			attData.userId = userId;
			attData.emailId = emailId;
			attData.accountId = accountId;
			attData.type = attConst.type.EMBED;
			attData.status = attConst.status.PENDING;
			const current = objectByKey.get(attData.key);
			if (!current || (!current.buff && attData.buff)) {
				objectByKey.set(attData.key, attData);
			}
		}

		for (const rowChunk of chunkArray(attDataList, ATT_INSERT_CHUNK_ROWS)) {
			await orm(c).insert(att).values(rowChunk).run();
		}

		try {
			for (const attData of objectByKey.values()) {
				try {
					if (attData.buff) {
						await r2Service.putObj(c, attData.key, attData.buff, {
							contentType: attachmentMimeType(attData),
							cacheControl: `max-age=259200`,
							contentDisposition: 'inline'
						});
					} else if (!await r2Service.exists(c, attData.key)) {
						throw new Error('Attachment object not found');
					}
				} catch (error) {
					try {
						await updateAttachmentKeyStatus(
							c,
							attDataList,
							attData.key,
							attConst.status.FAILED,
							'OBJECT_WRITE_FAILED'
						);
					} catch {
						// The parent email is still SAVING/FAILED and these rows remain hidden.
					}
					try {
						await failPendingAttachmentRows(c, attDataList);
					} catch {
						// D1 is unavailable; the parent send path keeps these rows inaccessible.
					}
					throw error;
				}

				await updateAttachmentKeyStatus(
					c,
					attDataList,
					attData.key,
					attConst.status.READY
				);
			}
		} finally {
			for (const attData of attDataList) {
				delete attData.buff;
			}
		}

	},

	async removeByUserIds(c, userIds) {
		await this.removeAttByField(c, 'user_id', userIds);
	},

	async removeByEmailIds(c, emailIds) {
		await this.removeAttByField(c, 'email_id', emailIds);
	},

	async selectByEmailIds(c, emailIds, options = {}) {
		const rows = [];
		for (const chunk of chunkArray(emailIds)) {
			const conditions = [
				inArray(att.emailId, chunk),
				eq(att.type, attConst.type.ATT),
				eq(att.status, attConst.status.READY)
			];
			if (options.allowParentSaving !== true) {
				conditions.push(parentEmailReadyCondition());
			}
			rows.push(...await orm(c).select().from(att).where(
				and(...conditions))
				.all());
		}
		return rows;
	},

	async countByEmailIds(c, emailIds) {
		const rows = [];
		for (const chunk of chunkArray(emailIds)) {
			rows.push(...await orm(c).select({
				emailId: att.emailId,
				attCount: count(att.attId)
			}).from(att).where(and(
				inArray(att.emailId, chunk),
				eq(att.type, attConst.type.ATT),
				eq(att.status, attConst.status.READY),
				parentEmailReadyCondition()
			)).groupBy(att.emailId).all());
		}
		return rows;
	},

	async removeAttByField(c, fieldName, fieldValues) {

		//集合化：按 90 分块 IN 查询 + 删除，避免逐值全表 GROUP BY 聚合
		//SELECT 与 DELETE 在同一 batch 内按 chunk 交错执行，跨 chunk 共用 key 的引用计数依然正确
		const sqlList = [];

		for (const chunk of chunkArray(fieldValues)) {
			const placeholders = chunk.map(() => '?').join(',');

			sqlList.push(
				c.env.db.prepare(
					`SELECT a.key
						FROM attachments a
						WHERE a.${fieldName} IN (${placeholders})
						GROUP BY a.key
						HAVING COUNT(*) = (SELECT COUNT(*) FROM attachments t WHERE t.key = a.key);`
				).bind(...chunk)
			);

			sqlList.push(c.env.db.prepare(`DELETE FROM attachments WHERE ${fieldName} IN (${placeholders})`).bind(...chunk));
		}

		if (sqlList.length === 0) {
			return;
		}

		const attListResult = await c.env.db.batch(sqlList);

		const delKeyList = attListResult.flatMap(r => r.results ? r.results.map(row => row.key) : []);

		if (delKeyList.length > 0) {
			await this.batchDelete(c, delKeyList);
		}

	},

	async batchDelete(c, keys) {
		if (!keys.length) return;

		const BATCH_SIZE = 1000;

		for (let i = 0; i < keys.length; i += BATCH_SIZE) {
			const batch = keys.slice(i, i + BATCH_SIZE);
			await r2Service.delete(c, batch);
		}

	},

	async removeByAccountId(c, accountId) {
		await this.removeAttByField(c, "account_id", [accountId])
	},

	async selectOneByKeys(c, keys, userId) {
		const ownerId = Number(userId);
		if (!keys || keys.length === 0 || !Number.isInteger(ownerId) || ownerId <= 0) {
			return []
		}
		const rows = [];
		for (const chunk of chunkArray(keys)) {
			rows.push(...await orm(c).select().from(att).where(and(
				inArray(att.key, chunk),
				eq(att.userId, ownerId),
				eq(att.status, attConst.status.READY),
				parentEmailReadyCondition()
			)).orderBy(desc(att.attId)).groupBy(att.key).all());
		}
		return rows;
	}
};

export default attService;
