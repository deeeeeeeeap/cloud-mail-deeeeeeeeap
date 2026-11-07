import BizError from '../error/biz-error';
import verifyUtils from './verify-utils';
import { readBoundedJson } from './request-body-utils';

export const SEND_JSON_MAX_BYTES = 24 * 1024 * 1024;
export const SEND_MAX_RECIPIENTS = 10;
export const SEND_CONTENT_MAX_BYTES = 1024 * 1024;
export const SEND_MAX_ATTACHMENTS = 10;
export const SEND_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SEND_ATTACHMENTS_MAX_BYTES = 16 * 1024 * 1024;
export const SEND_MAX_REPLY_TO = 5;

const DEFAULT_ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';
const MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

export async function readBoundedSendJson(c, limitMessage = 'send JSON body exceeds 24 MiB') {
	return await readBoundedJson(c, SEND_JSON_MAX_BYTES, limitMessage);
}

export function normalizeSendRequest(params, { dedupeRecipients = false } = {}) {
	if (!params || typeof params !== 'object' || Array.isArray(params)) {
		throw new BizError('send request must be an object', 400);
	}

	const { receiveEmail, subject, content, text } = params;
	if (receiveEmail === undefined || receiveEmail === null) {
		throw new BizError('receiveEmail is required', 400);
	}
	if (!Array.isArray(receiveEmail)) {
		throw new BizError('receiveEmail must be an array', 400);
	}
	if (receiveEmail.length < 1 || receiveEmail.length > SEND_MAX_RECIPIENTS) {
		throw new BizError('receiveEmail must contain between 1 and 10 recipients', 400);
	}
	if (receiveEmail.some(email => typeof email !== 'string' || !verifyUtils.isEmail(email))) {
		throw new BizError('invalid recipient email', 400);
	}

	if (typeof subject !== 'string' || !subject.trim()) {
		throw new BizError('subject is required', 400);
	}
	if (subject.length > 998) {
		throw new BizError('subject exceeds 998 characters', 400);
	}
	if (content !== undefined && content !== null && typeof content !== 'string') {
		throw new BizError('content must be a string', 400);
	}
	if (text !== undefined && text !== null && typeof text !== 'string') {
		throw new BizError('text must be a string', 400);
	}

	const contentValue = content || '';
	const textValue = text || '';
	if (!contentValue.trim() && !textValue.trim()) {
		throw new BizError('content or text is required', 400);
	}
	const encoder = new TextEncoder();
	const contentSize = encoder.encode(contentValue).byteLength;
	if (contentSize > SEND_CONTENT_MAX_BYTES
		|| contentSize + encoder.encode(textValue).byteLength > SEND_CONTENT_MAX_BYTES) {
		throw new BizError('content exceeds 1MB', 400);
	}

	let normalizedTo = [...receiveEmail];
	let cc = normalizeRecipientList(params.cc, 'cc');
	let bcc = normalizeRecipientList(params.bcc, 'bcc');
	if (dedupeRecipients) {
		const seen = new Set();
		const keep = address => {
			const normalized = address.toLowerCase();
			if (seen.has(normalized)) return false;
			seen.add(normalized);
			return true;
		};
		normalizedTo = normalizedTo.filter(keep);
		cc = cc.filter(keep);
		bcc = bcc.filter(keep);
	}
	if (normalizedTo.length + cc.length + bcc.length > SEND_MAX_RECIPIENTS) {
		throw new BizError('receiveEmail, cc and bcc must contain no more than 10 recipients in total', 400);
	}

	return {
		...params,
		receiveEmail: normalizedTo,
		cc,
		bcc,
		replyTo: normalizeReplyTo(params.replyTo),
		subject,
		content: contentValue,
		text: textValue,
		attachments: normalizeSendAttachments(params.attachments)
	};
}

function normalizeRecipientList(value, field) {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new BizError(`${field} must be an array`, 400);
	}
	if (value.some(email => typeof email !== 'string' || !verifyUtils.isEmail(email))) {
		throw new BizError(`invalid ${field} email`, 400);
	}
	return [...value];
}

function normalizeReplyTo(value) {
	if (value === undefined || value === null || value === '') {
		return [];
	}
	const list = Array.isArray(value) ? value : [value];
	if (list.length > SEND_MAX_REPLY_TO) {
		throw new BizError(`replyTo must contain no more than ${SEND_MAX_REPLY_TO} addresses`, 400);
	}
	if (list.some(email => typeof email !== 'string' || !verifyUtils.isEmail(email))) {
		throw new BizError('invalid replyTo email', 400);
	}
	return [...new Set(list)];
}

export function normalizeSendAttachments(value) {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new BizError('attachments must be an array', 400);
	}
	if (value.length > SEND_MAX_ATTACHMENTS) {
		throw new BizError('attachments must contain no more than 10 items', 400);
	}

	let totalSize = 0;
	return value.map(attachment => {
		if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
			throw new BizError('attachment must be an object', 400);
		}

		const filename = normalizeAttachmentFilename(attachment.filename);
		const { content, dataContentType } = splitAttachmentContent(attachment.content);
		if (!isCanonicalBase64(content)) {
			throw new BizError('attachment content must be valid Base64', 400);
		}

		const size = decodedBase64Size(content);
		if (size === 0) {
			throw new BizError('attachment content must not be empty', 400);
		}
		if (size > SEND_ATTACHMENT_MAX_BYTES) {
			throw new BizError('attachment exceeds 10 MiB', 413);
		}

		totalSize += size;
		if (totalSize > SEND_ATTACHMENTS_MAX_BYTES) {
			throw new BizError('attachments exceed 16 MiB', 413);
		}

		const requestedContentType = normalizeAttachmentMimeType(attachment.contentType);
		const hasRequestedContentType = attachment.contentType !== undefined
			&& attachment.contentType !== null
			&& String(attachment.contentType).trim() !== '';

		return {
			filename,
			contentType: hasRequestedContentType
				? requestedContentType || DEFAULT_ATTACHMENT_CONTENT_TYPE
				: normalizeAttachmentMimeType(dataContentType) || DEFAULT_ATTACHMENT_CONTENT_TYPE,
			content,
			size
		};
	});
}

function normalizeAttachmentFilename(value) {
	if (typeof value !== 'string') {
		throw new BizError('attachment filename is required', 400);
	}

	const filename = value
		.split(/[\\/]/)
		.pop()
		.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
		.trim();

	if (!filename || filename === '.' || filename === '..') {
		throw new BizError('attachment filename is required', 400);
	}

	return filename;
}

function normalizeAttachmentMimeType(value) {
	if (typeof value !== 'string') {
		return '';
	}

	const normalized = value.trim().toLowerCase();
	return MIME_TYPE_PATTERN.test(normalized) ? normalized : '';
}

function splitAttachmentContent(value) {
	if (typeof value !== 'string') {
		throw new BizError('attachment content is required', 400);
	}

	const normalized = value.trim();
	if (!normalized) {
		throw new BizError('attachment content must not be empty', 400);
	}

	if (!/^data:/i.test(normalized)) {
		return { content: normalized, dataContentType: '' };
	}

	const commaIndex = normalized.indexOf(',');
	const metadata = commaIndex > -1 ? normalized.slice(5, commaIndex) : '';
	if (commaIndex < 0 || !/;base64$/i.test(metadata)) {
		throw new BizError('attachment content must be valid Base64', 400);
	}

	return {
		content: normalized.slice(commaIndex + 1),
		dataContentType: metadata.split(';')[0]
	};
}

function base64CharValue(code) {
	if (code >= 65 && code <= 90) return code - 65;
	if (code >= 97 && code <= 122) return code - 71;
	if (code >= 48 && code <= 57) return code + 4;
	if (code === 43) return 62;
	if (code === 47) return 63;
	return -1;
}

function isCanonicalBase64(value) {
	const length = value.length;
	if (length === 0 || length % 4 !== 0) {
		return false;
	}

	let padding = 0;
	if (value.charAt(length - 1) === '=') padding++;
	if (value.charAt(length - 2) === '=') padding++;
	const dataLength = length - padding;

	for (let index = 0; index < dataLength; index++) {
		if (base64CharValue(value.charCodeAt(index)) < 0) {
			return false;
		}
	}
	for (let index = dataLength; index < length; index++) {
		if (value.charAt(index) !== '=') {
			return false;
		}
	}

	if (padding === 2) {
		return base64CharValue(value.charCodeAt(dataLength - 1)) % 16 === 0;
	}
	if (padding === 1) {
		return base64CharValue(value.charCodeAt(dataLength - 1)) % 4 === 0;
	}

	return true;
}

function decodedBase64Size(value) {
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
	return value.length / 4 * 3 - padding;
}
