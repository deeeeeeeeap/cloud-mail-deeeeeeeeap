import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import KvConst from '../src/const/kv-const';
import BizError from '../src/error/biz-error';
import settingService from '../src/service/setting-service';
import publicService from '../src/service/public-service';
import roleService from '../src/service/role-service';
import emailService from '../src/service/email-service';

const PUBLIC_TOKEN = 'public-send-test-token';
const PDF_BASE64 = 'JVBERi0xLjQK';

function base64ForDecodedSize(size) {
	const padding = (3 - size % 3) % 3;
	return 'A'.repeat(Math.ceil(size / 3) * 4 - padding) + '='.repeat(padding);
}

function validPayload(overrides = {}) {
	return {
		sendEmail: 'sender@example.com',
		receiveEmail: ['recipient@example.com'],
		subject: 'Test subject',
		text: 'Test body',
		...overrides
	};
}

async function initializeDatabase() {
	const response = await SELF.fetch('http://example.com/api/init', {
		method: 'POST',
		headers: { 'X-Cloud-Mail-Init-Secret': 'your-jwt-secret' }
	});

	expect(response.status).toBe(200);
	expect(await response.text()).toBe('success');
}

async function seedInternalAccounts() {
	await env.db.batch([
		env.db.prepare('DELETE FROM attachments'),
		env.db.prepare('DELETE FROM star'),
		env.db.prepare('DELETE FROM email_search'),
		env.db.prepare('DELETE FROM email'),
		env.db.prepare('DELETE FROM account'),
		env.db.prepare('DELETE FROM user'),
		env.db.prepare("UPDATE role SET send_type = 'count', send_count = 0, avail_domain = '', ban_email = '' WHERE role_id = 1"),
		env.db.prepare(`
			INSERT INTO user (user_id, email, type, password, salt, status, send_count, is_del)
			VALUES (101, 'sender@example.com', 1, 'hash', 'salt', 0, 0, 0)
		`),
		env.db.prepare(`
			INSERT INTO user (user_id, email, type, password, salt, status, send_count, is_del)
			VALUES (102, 'recipient@example.com', 1, 'hash', 'salt', 0, 0, 0)
		`),
		env.db.prepare(`
			INSERT INTO account (account_id, email, name, status, user_id, all_receive, sort, is_del)
			VALUES (201, 'sender@example.com', 'Sender', 0, 101, 0, 0, 0)
		`),
		env.db.prepare(`
			INSERT INTO account (account_id, email, name, status, user_id, all_receive, sort, is_del)
			VALUES (202, 'recipient@example.com', 'Recipient', 0, 102, 0, 0, 0)
		`)
	]);
	roleService.clearCache();
}

async function setSendStatus(value) {
	await env.db.prepare('UPDATE setting SET send = ?').bind(value).run();
	await settingService.refresh({ env });
}

async function sendEmail(payload, token = PUBLIC_TOKEN) {
	const headers = {
		'Content-Type': 'application/json'
	};
	if (token !== null) {
		headers.Authorization = token;
	}

	return SELF.fetch('http://example.com/api/public/sendEmail', {
		method: 'POST',
		headers,
		body: JSON.stringify(payload)
	});
}

describe('public send email API', () => {
	beforeAll(async () => {
		await initializeDatabase();
	});

	beforeEach(async () => {
		await env.kv.put(KvConst.PUBLIC_KEY, PUBLIC_TOKEN);
		await env.db.prepare('DELETE FROM public_send_rate_limit').run();
	});

	it.each([
		[{}, 'sendEmail is required'],
		[{ sendEmail: 'sender@example.com' }, 'receiveEmail is required'],
		[{
			sendEmail: 'sender@example.com',
			receiveEmail: ['recipient@example.com']
		}, 'subject is required']
	])('rejects missing required fields', async (payload, message) => {
		const response = await sendEmail(payload);
		const body = await response.json();

		expect(body).toMatchObject({
			code: 400,
			message
		});
	});

	it.each([null, 'wrong-token'])('requires the configured public token', async (token) => {
		const response = await sendEmail({}, token);
		const body = await response.json();

		expect(body.code).toBe(401);
	});

	it.each([
		['recipient@example.com', 'receiveEmail must be an array'],
		[[], 'receiveEmail must contain between 1 and 10 recipients'],
		[Array.from({ length: 11 }, (_, index) => `recipient-${index}@example.com`), 'receiveEmail must contain between 1 and 10 recipients'],
		[['not-an-email'], 'invalid recipient email']
	])('validates recipient constraints', async (receiveEmail, message) => {
		const response = await sendEmail(validPayload({ receiveEmail }));
		const body = await response.json();

		expect(body).toMatchObject({ code: 400, message });
	});

	it.each([
		[{ content: '', text: '' }, 'content or text is required'],
		[{ subject: 's'.repeat(999) }, 'subject exceeds 998 characters'],
		[{ content: 'x'.repeat(1024 * 1024 + 1), text: '' }, 'content exceeds 1MB']
	])('validates message content limits', async (overrides, message) => {
		const response = await sendEmail(validPayload(overrides));
		const body = await response.json();

		expect(body).toMatchObject({ code: 400, message });
	});

	it('returns not found when the sender account does not exist', async () => {
		const response = await sendEmail(validPayload({ sendEmail: 'missing@example.com' }));
		const body = await response.json();

		expect(body).toMatchObject({
			code: 404,
			message: 'sender account not found'
		});
	});

	it('rejects a deleted sender account', async () => {
		await env.db.prepare('DELETE FROM account').run();
		await env.db.prepare(`
			INSERT INTO account (account_id, email, name, status, user_id, all_receive, sort, is_del)
			VALUES (301, 'deleted@example.com', 'Deleted', 0, 999, 0, 0, 1)
		`).run();

		const response = await sendEmail(validPayload({ sendEmail: 'deleted@example.com' }));
		const body = await response.json();

		expect(body).toMatchObject({
			code: 404,
			message: 'sender account not found'
		});
	});

	it('rejects a sender after the hourly public limit is reached', async () => {
		await seedInternalAccounts();
		await env.db.prepare(`
			INSERT INTO public_send_rate_limit (window_hour, count)
			VALUES (?, 100)
		`).bind(Math.floor(Date.now() / 3600000)).run();

		const response = await sendEmail(validPayload());
		const body = await response.json();

		expect(body).toMatchObject({
			code: 429,
			message: 'send rate limit exceeded'
		});
	});

	it('atomically caps concurrent hourly reservations at 100', async () => {
		const results = await Promise.all(Array.from({ length: 120 }, () => (
			publicService.reserveHourlySend({ env })
				.then(() => 200)
				.catch(error => error.code)
		)));

		expect(results.filter(code => code === 200)).toHaveLength(100);
		expect(results.filter(code => code === 429)).toHaveLength(20);
		expect(await env.db.prepare(`
			SELECT count
			FROM public_send_rate_limit
			WHERE window_hour = ?
		`).bind(Math.floor(Date.now() / 3600000)).first()).toMatchObject({ count: 100 });
	});

	it.each([
		['not-an-array', 'attachments must be an array'],
		[Array.from({ length: 11 }, (_, index) => ({
			filename: `file-${index}.txt`,
			content: 'YQ=='
		})), 'attachments must contain no more than 10 items'],
		[[{ content: 'YQ==' }], 'attachment filename is required'],
		[[{ filename: 'empty.txt' }], 'attachment content is required'],
		[[{ filename: 'invalid.txt', content: 'abc' }], 'attachment content must be valid Base64'],
		[[{ filename: 'empty.txt', content: '' }], 'attachment content must not be empty']
	])('validates public attachment input', async (attachments, message) => {
		const response = await sendEmail(validPayload({ attachments }));
		const body = await response.json();

		expect(body).toMatchObject({ code: 400, message });
	});

	it('rejects synchronous JSON bodies over 24 MiB before parsing or writing data', async () => {
		await seedInternalAccounts();
		const response = await sendEmail(validPayload({
			padding: 'x'.repeat(24 * 1024 * 1024)
		}));
		const body = await response.json();

		expect(body).toMatchObject({
			code: 413,
			message: 'public send JSON body exceeds 24 MiB'
		});
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM email').first()).toMatchObject({ count: 0 });
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM attachments').first()).toMatchObject({ count: 0 });
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM public_send_rate_limit').first())
			.toMatchObject({ count: 0 });
	});

	it('keeps requests without attachments backward compatible', async () => {
		await seedInternalAccounts();
		await setSendStatus(0);

		const response = await sendEmail(validPayload());
		const body = await response.json();

		expect(body.code).toBe(200);
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM attachments').first())
			.toMatchObject({ count: 0 });
	});

	it('rejects an attachment larger than 10 MiB before writing mail data', async () => {
		await seedInternalAccounts();
		const beforeObjects = await env.kv.list({ prefix: 'attachments/' });
		const content = base64ForDecodedSize(10 * 1024 * 1024 + 1);

		await expect(publicService.sendEmail({ env }, validPayload({
			attachments: [{ filename: 'too-large.bin', content }]
		}))).rejects.toMatchObject({
			code: 413,
			message: 'attachment exceeds 10 MiB'
		});

		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM email').first()).toMatchObject({ count: 0 });
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM attachments').first()).toMatchObject({ count: 0 });
		expect((await env.kv.list({ prefix: 'attachments/' })).keys).toEqual(beforeObjects.keys);
	});

	it('accepts a 10 MiB attachment through the bounded JSON path', async () => {
		await seedInternalAccounts();
		const content = base64ForDecodedSize(10 * 1024 * 1024);

		const response = await sendEmail(validPayload({
			attachments: [{ filename: 'maximum.bin', content }]
		}));
		const body = await response.json();

		expect(body.code).toBe(200);
		const { results: rows } = await env.db.prepare(`
			SELECT key, size
			FROM attachments
			ORDER BY att_id
		`).all();
		expect(rows).toHaveLength(2);
		expect(rows.every(row => row.size === 10 * 1024 * 1024)).toBe(true);
		const object = await env.kv.get(rows[0].key, { type: 'arrayBuffer' });
		expect(object.byteLength).toBe(10 * 1024 * 1024);
		await env.kv.delete(rows[0].key);
	}, 20000);

	it('rejects decoded attachments totaling more than 16 MiB before writing mail data', async () => {
		await seedInternalAccounts();
		const beforeObjects = await env.kv.list({ prefix: 'attachments/' });
		const content = base64ForDecodedSize(4 * 1024 * 1024 + 1);

		await expect(publicService.sendEmail({ env }, validPayload({
			attachments: Array.from({ length: 4 }, (_, index) => ({
				filename: `part-${index}.bin`,
				content
			}))
		}))).rejects.toMatchObject({
			code: 413,
			message: 'attachments exceed 16 MiB'
		});

		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM email').first()).toMatchObject({ count: 0 });
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM attachments').first()).toMatchObject({ count: 0 });
		expect((await env.kv.list({ prefix: 'attachments/' })).keys).toEqual(beforeObjects.keys);
	});

	it('sends to an internal recipient through the existing mail pipeline', async () => {
		await seedInternalAccounts();
		await setSendStatus(0);

		const response = await sendEmail(validPayload({
			receiveEmail: ['recipient@example.com', 'recipient@example.com'],
			content: '<p>Internal message</p>',
			attachments: [{
				filename: 'report.pdf',
				contentType: 'application/pdf',
				content: PDF_BASE64
			}],
			sendType: 'reply',
			emailId: 99999
		}));
		const body = await response.json();

		expect(body.code).toBe(200);
		expect(body.data).toHaveLength(1);
		expect(await env.db.prepare(`
			SELECT count
			FROM public_send_rate_limit
			WHERE window_hour = ?
		`).bind(Math.floor(Date.now() / 3600000)).first()).toMatchObject({ count: 1 });

		const { results: rows } = await env.db.prepare(`
			SELECT email_id AS emailId,
			       type,
			       user_id AS userId,
			       account_id AS accountId,
			       send_email AS sendEmail,
			       to_email AS toEmail,
			       in_reply_to AS inReplyTo
			FROM email
			ORDER BY email_id
		`).all();

		expect(rows).toHaveLength(2);
		expect(rows.find(row => row.type === 1)).toMatchObject({
			userId: 101,
			accountId: 201,
			sendEmail: 'sender@example.com'
		});
		expect(rows.find(row => row.type === 0)).toMatchObject({
			userId: 102,
			accountId: 202,
			toEmail: 'recipient@example.com'
		});
		expect(rows.find(row => row.type === 1).inReplyTo || '').toBe('');

		const { results: attachmentRows } = await env.db.prepare(`
			SELECT a.email_id AS emailId,
			       a.user_id AS userId,
			       a.account_id AS accountId,
			       a.key,
			       a.filename,
			       a.mime_type AS mimeType,
			       a.size,
			       e.type AS emailType
			FROM attachments a
			JOIN email e ON e.email_id = a.email_id
			ORDER BY a.att_id
		`).all();

		expect(attachmentRows).toHaveLength(2);
		expect(attachmentRows.find(row => row.emailType === 1)).toMatchObject({
			userId: 101,
			accountId: 201,
			filename: 'report.pdf',
			mimeType: 'application/pdf',
			size: 9
		});
		expect(attachmentRows.find(row => row.emailType === 0)).toMatchObject({
			userId: 102,
			accountId: 202,
			filename: 'report.pdf',
			mimeType: 'application/pdf',
			size: 9
		});
		expect(new Uint8Array(await env.kv.get(attachmentRows[0].key, { type: 'arrayBuffer' })))
			.toEqual(new TextEncoder().encode('%PDF-1.4\n'));
	});

	it('atomically caps concurrent sends at the role recipient quota', async () => {
		await seedInternalAccounts();
		await setSendStatus(0);
		await env.db.prepare(`
			UPDATE role
			SET send_type = 'count', send_count = 3
			WHERE role_id = 1
		`).run();
		roleService.clearCache();

		const responses = await Promise.all(Array.from({ length: 8 }, (_, index) => (
			sendEmail(validPayload({ subject: `Concurrent send ${index}` }))
		)));
		const bodies = await Promise.all(responses.map(response => response.json()));

		expect(bodies.filter(body => body.code === 200)).toHaveLength(3);
		expect(bodies.filter(body => body.code === 403)).toHaveLength(5);
		expect(await env.db.prepare(`
			SELECT send_count AS sendCount
			FROM user
			WHERE user_id = 101
		`).first()).toMatchObject({ sendCount: 3 });
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM email').first())
			.toMatchObject({ count: 6 });
	});

	it('does not reserve public or user quota when provider size preflight fails', async () => {
		await seedInternalAccounts();
		await setSendStatus(0);
		await env.db.prepare(`
			UPDATE role
			SET send_type = 'count', send_count = 3
			WHERE role_id = 1
		`).run();
		roleService.clearCache();
		// 接口层的附件上限让真实邮件到不了 25 MiB 的通道上限，这里直接让预检失败，只验证额度不被预留
		const preflight = vi.spyOn(emailService, 'assertProviderMessageSize').mockImplementation(() => {
			throw new BizError('Cloudflare Email message exceeds 25 MiB limit', 413);
		});

		let body;
		try {
			const response = await sendEmail(validPayload({
				receiveEmail: ['outside@example.net'],
				attachments: [{
					filename: 'provider-too-large.bin',
					content: base64ForDecodedSize(4 * 1024 * 1024)
				}]
			}));
			body = await response.json();
		} finally {
			preflight.mockRestore();
		}

		expect(body).toMatchObject({
			code: 413,
			message: 'Cloudflare Email message exceeds 25 MiB limit'
		});
		expect(await env.db.prepare(`
			SELECT send_count AS sendCount
			FROM user
			WHERE user_id = 101
		`).first()).toMatchObject({ sendCount: 0 });
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM public_send_rate_limit').first())
			.toMatchObject({ count: 0 });
		expect(await env.db.prepare('SELECT COUNT(*) AS count FROM email').first())
			.toMatchObject({ count: 0 });
	}, 20000);

	it('normalizes data URL attachments and ignores privileged fields', async () => {
		await seedInternalAccounts();
		await setSendStatus(0);

		const response = await sendEmail(validPayload({
			attachments: [{
				filename: 'C:\\fakepath\\..\\report.pdf\u0000',
				contentType: 'not a mime type',
				content: `data:application/pdf;base64,${PDF_BASE64}`,
				path: 'https://attacker.example/private.pdf',
				url: 'https://attacker.example/private.pdf',
				key: 'attachments/private.pdf',
				contentId: 'forged-inline',
				disposition: 'inline',
				size: 999999
			}]
		}));
		const body = await response.json();

		expect(body.code).toBe(200);
		const { results: rows } = await env.db.prepare(`
			SELECT key,
			       filename,
			       mime_type AS mimeType,
			       size,
			       content_id AS contentId,
			       disposition
			FROM attachments
			ORDER BY att_id
		`).all();

		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			filename: 'report.pdf',
			mimeType: 'application/octet-stream',
			size: 9,
			contentId: null,
			disposition: null
		});
		expect(rows[0].key).not.toBe('attachments/private.pdf');
		expect(new Uint8Array(await env.kv.get(rows[0].key, { type: 'arrayBuffer' })))
			.toEqual(new TextEncoder().encode('%PDF-1.4\n'));
	});

	it('honors the existing global send switch', async () => {
		await seedInternalAccounts();
		await setSendStatus(1);

		try {
			const response = await sendEmail(validPayload());
			const body = await response.json();

			expect(body.code).toBe(403);
			const emailCount = await env.db.prepare('SELECT COUNT(*) AS count FROM email').first();
			expect(emailCount.count).toBe(0);
		} finally {
			await setSendStatus(0);
		}
	});
});
