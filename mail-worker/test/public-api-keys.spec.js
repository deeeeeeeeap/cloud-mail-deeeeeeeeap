import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import KvConst from '../src/const/kv-const';
import apiKeyService from '../src/service/api-key-service';
import emailService from '../src/service/email-service';
import roleService from '../src/service/role-service';
import settingService from '../src/service/setting-service';
import cryptoUtils from '../src/utils/crypto-utils';
import { invalidateBootstrapStatusCache } from '../src/init/status';

const INIT_HEADERS = { 'X-Cloud-Mail-Init-Secret': 'your-jwt-secret' };
const ADMIN_PASSWORD = 'secure-admin-password';
const MEMBER_PASSWORD = 'member-password';

async function api(path, { method = 'GET', token, headers = {}, body } = {}) {
	const response = await SELF.fetch(`http://example.com/api${path}`, {
		method,
		headers: {
			...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
			...(token ? { Authorization: token } : {}),
			...headers
		},
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return { response, body: await response.json() };
}

async function login(email, password) {
	const { body } = await api('/login', { method: 'POST', body: { email, password } });
	expect(body.code).toBe(200);
	return body.data.token;
}

async function bootstrap() {
	const init = await SELF.fetch('http://example.com/api/init', { method: 'POST', headers: INIT_HEADERS });
	expect(await init.text()).toBe('success');
	await env.db.batch([
		env.db.prepare('DELETE FROM oauth'),
		env.db.prepare('DELETE FROM account'),
		env.db.prepare('DELETE FROM user'),
		env.db.prepare('UPDATE setting SET send = 0')
	]);
	invalidateBootstrapStatusCache(env.db);
	await settingService.refresh({ env });
	const admin = await SELF.fetch('http://example.com/api/init/admin', {
		method: 'POST',
		headers: { ...INIT_HEADERS, 'Content-Type': 'application/json' },
		body: JSON.stringify({ password: ADMIN_PASSWORD })
	});
	expect(await admin.text()).toBe('success');

	const member = await cryptoUtils.hashPassword(MEMBER_PASSWORD);
	await env.db.batch([
		env.db.prepare(`
			INSERT INTO user (user_id, email, type, password, salt, status, send_count, is_del)
			VALUES (100, 'member@example.com', 1, ?, ?, 0, 0, 0)
		`).bind(member.hash, member.salt),
		env.db.prepare(`
			INSERT INTO account (account_id, email, name, status, user_id, all_receive, sort, is_del)
			VALUES (200, 'member@example.com', 'member', 0, 100, 0, 0, 0)
		`)
	]);
}

async function resetMailboxes() {
	await apiKeyService.ensureSchema({ env });
	await env.db.batch([
		env.db.prepare('DELETE FROM attachments'),
		env.db.prepare('DELETE FROM star'),
		env.db.prepare('DELETE FROM email_search'),
		env.db.prepare('DELETE FROM delivery_attempt'),
		env.db.prepare('DELETE FROM email'),
		env.db.prepare('DELETE FROM api_key'),
		env.db.prepare('DELETE FROM api_key_usage'),
		env.db.prepare('DELETE FROM api_idempotency'),
		env.db.prepare('DELETE FROM public_send_rate_limit'),
		env.db.prepare('DELETE FROM account WHERE account_id BETWEEN 201 AND 299'),
		env.db.prepare('DELETE FROM user WHERE user_id BETWEEN 101 AND 199'),
		env.db.prepare("UPDATE role SET send_type = 'count', send_count = 0, avail_domain = '', ban_email = '' WHERE role_id = 1"),
		...[
			[101, 'sender@example.com'],
			[102, 'recipient@example.com'],
			[103, 'copy@example.com'],
			[104, 'hidden@example.com']
		].flatMap(([userId, address]) => [
			env.db.prepare(`
				INSERT INTO user (user_id, email, type, password, salt, status, send_count, is_del)
				VALUES (?, ?, 1, 'hash', 'salt', 0, 0, 0)
			`).bind(userId, address),
			env.db.prepare(`
				INSERT INTO account (account_id, email, name, status, user_id, all_receive, sort, is_del)
				VALUES (?, ?, ?, 0, ?, 0, 0, 0)
			`).bind(userId + 100, address, address.split('@')[0], userId)
		])
	]);
	await env.kv.delete(KvConst.PUBLIC_KEY);
	roleService.clearCache();
	apiKeyService.clearCache();
}

function sendPayload(overrides = {}) {
	return {
		sendEmail: 'sender@example.com',
		receiveEmail: ['recipient@example.com'],
		subject: 'Automated notice',
		text: 'Job finished',
		...overrides
	};
}

async function sendWith(key, payload = sendPayload(), headers = {}) {
	return api('/public/sendEmail', {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, ...headers },
		body: payload
	});
}

async function countEmails(type) {
	const row = await env.db.prepare('SELECT COUNT(*) AS total FROM email WHERE type = ?').bind(type).first();
	return row.total;
}

describe('API keys for the public automation API', () => {
	let adminToken;

	async function createKey(overrides = {}) {
		const { body } = await api('/apiKey/add', {
			method: 'POST',
			token: adminToken,
			body: { name: 'ci-bot', scopes: ['send'], ...overrides }
		});
		expect(body.code).toBe(200);
		return body.data;
	}

	beforeAll(async () => {
		await bootstrap();
		adminToken = await login('admin@example.com', ADMIN_PASSWORD);
	});

	beforeEach(async () => {
		await resetMailboxes();
	});

	it('returns the secret once, stores only its hash and invalidates it on rotation and deletion', async () => {
		const created = await createKey({ scopes: ['send', 'read'], allowedSenders: ['Sender@Example.com', '@example2.com'] });
		expect(created.key).toMatch(/^cmk_[A-Za-z0-9_-]{43}$/);
		expect(created.keyPrefix).toBe(created.key.slice(0, 12));
		expect(created.allowedSenders).toEqual(['sender@example.com', '*@example2.com']);

		const stored = await env.db.prepare('SELECT key_hash AS keyHash FROM api_key WHERE key_id = ?')
			.bind(created.keyId).first();
		expect(stored.keyHash).not.toContain(created.key);

		const { body: listBody } = await api('/apiKey/list', { token: adminToken });
		expect(listBody.code).toBe(200);
		expect(listBody.data.list).toHaveLength(1);
		expect(listBody.data.list[0]).toMatchObject({ keyId: created.keyId, scopes: ['send', 'read'] });
		expect(JSON.stringify(listBody.data)).not.toContain(created.key);

		expect((await sendWith(created.key)).body.code).toBe(200);

		const { body: rotated } = await api('/apiKey/rotate', {
			method: 'POST',
			token: adminToken,
			body: { keyId: created.keyId }
		});
		expect(rotated.code).toBe(200);
		expect(rotated.data.key).not.toBe(created.key);
		expect((await sendWith(created.key)).body.code).toBe(401);
		expect((await sendWith(rotated.data.key)).body.code).toBe(200);

		const { body: removed } = await api(`/apiKey/delete?keyId=${created.keyId}`, {
			method: 'DELETE',
			token: adminToken
		});
		expect(removed.code).toBe(200);
		expect((await sendWith(rotated.data.key)).body.code).toBe(401);
	});

	it('only lets the configured administrator manage API keys', async () => {
		const memberToken = await login('member@example.com', MEMBER_PASSWORD);
		const { body } = await api('/apiKey/list', { token: memberToken });
		expect(body.code).toBe(403);
		const { body: addBody } = await api('/apiKey/add', {
			method: 'POST',
			token: memberToken,
			body: { name: 'sneaky' }
		});
		expect(addBody.code).toBe(403);
	});

	it('accepts the key through Bearer, raw Authorization and X-API-Key headers', async () => {
		const { key } = await createKey();
		expect((await sendWith(key)).body.code).toBe(200);
		expect((await api('/public/sendEmail', {
			method: 'POST',
			headers: { Authorization: key },
			body: sendPayload()
		})).body.code).toBe(200);
		expect((await api('/public/sendEmail', {
			method: 'POST',
			headers: { 'X-API-Key': key },
			body: sendPayload()
		})).body.code).toBe(200);
	});

	it('enforces scopes per route', async () => {
		const readOnly = await createKey({ scopes: ['read'] });
		const sendOnly = await createKey({ scopes: ['send'] });

		const denied = await sendWith(readOnly.key);
		expect(denied.body).toMatchObject({ code: 403, message: 'API key is missing the "send" scope' });

		const list = await api('/public/emailList', {
			method: 'POST',
			headers: { Authorization: `Bearer ${sendOnly.key}` },
			body: {}
		});
		expect(list.body.code).toBe(403);

		const addUser = await api('/public/addUser', {
			method: 'POST',
			headers: { Authorization: `Bearer ${sendOnly.key}` },
			body: { list: [] }
		});
		expect(addUser.body.code).toBe(403);
	});

	it('restricts which mailboxes a key may send from', async () => {
		const otherDomain = await createKey({ allowedSenders: ['*@example2.com'] });
		const exact = await createKey({ allowedSenders: ['sender@example.com'] });

		const denied = await sendWith(otherDomain.key);
		expect(denied.body).toMatchObject({ code: 403, message: 'API key is not allowed to send from this address' });
		expect(await countEmails(1)).toBe(0);
		expect((await sendWith(exact.key)).body.code).toBe(200);
	});

	it('rejects disabled and expired keys', async () => {
		const disabled = await createKey();
		await api('/apiKey/set', { method: 'PUT', token: adminToken, body: { keyId: disabled.keyId, status: 1 } });
		expect((await sendWith(disabled.key)).body).toMatchObject({ code: 401, message: 'API key is disabled' });

		const expired = await createKey({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
		await env.db.prepare('UPDATE api_key SET expires_at = ? WHERE key_id = ?')
			.bind(new Date(Date.now() - 1000).toISOString(), expired.keyId).run();
		apiKeyService.clearCache();
		expect((await sendWith(expired.key)).body).toMatchObject({ code: 401, message: 'API key has expired' });
	});

	it('enforces the per-key hourly limit and gives the global reservation back', async () => {
		const { key } = await createKey({ hourlyLimit: 2 });

		const first = await sendWith(key);
		expect(first.body.code).toBe(200);
		expect(first.response.headers.get('X-RateLimit-Limit')).toBe('2');
		expect(first.response.headers.get('X-RateLimit-Remaining')).toBe('1');
		expect((await sendWith(key)).response.headers.get('X-RateLimit-Remaining')).toBe('0');

		const limited = await sendWith(key);
		expect(limited.body).toMatchObject({ code: 429, message: 'API key send rate limit exceeded' });
		expect(await countEmails(1)).toBe(2);
		expect(await env.db.prepare('SELECT count FROM public_send_rate_limit').first()).toMatchObject({ count: 2 });
	});

	it('replays idempotent requests instead of sending twice', async () => {
		const { key } = await createKey();
		const headers = { 'Idempotency-Key': 'order-1001' };

		const first = await sendWith(key, sendPayload(), headers);
		expect(first.body.code).toBe(200);
		const replay = await sendWith(key, sendPayload(), headers);
		expect(replay.body).toEqual(first.body);
		expect(replay.response.headers.get('Idempotent-Replayed')).toBe('true');
		expect(await countEmails(1)).toBe(1);

		const conflict = await sendWith(key, sendPayload({ subject: 'Different' }), headers);
		expect(conflict.body.code).toBe(422);
		expect(await countEmails(1)).toBe(1);
	});

	it('releases the idempotency key when the request fails before any mail is stored', async () => {
		const { key } = await createKey();
		const headers = { 'Idempotency-Key': 'retry-after-fix' };
		const payload = sendPayload({ sendEmail: 'late@example.com' });

		expect((await sendWith(key, payload, headers)).body.code).toBe(404);

		await env.db.batch([
			env.db.prepare(`
				INSERT INTO user (user_id, email, type, password, salt, status, send_count, is_del)
				VALUES (105, 'late@example.com', 1, 'hash', 'salt', 0, 0, 0)
			`),
			env.db.prepare(`
				INSERT INTO account (account_id, email, name, status, user_id, all_receive, sort, is_del)
				VALUES (205, 'late@example.com', 'late', 0, 105, 0, 0, 0)
			`)
		]);
		expect((await sendWith(key, payload, headers)).body.code).toBe(200);
	});

	it('releases the idempotency key after a definite provider rejection so a fixed retry can send', async () => {
		const { key } = await createKey();
		const headers = { 'Idempotency-Key': 'provider-rejected' };
		const payload = sendPayload({ receiveEmail: ['someone@example.net'] });
		const rejection = vi.spyOn(emailService, 'sendByCloudflareEmail').mockRejectedValueOnce(
			Object.assign(new Error('Sender is not verified'), { code: 'E_SENDER_NOT_VERIFIED' })
		);

		let first;
		try {
			first = await sendWith(key, payload, headers);
		} finally {
			rejection.mockRestore();
		}
		expect(first.body).toMatchObject({ message: 'Sender is not verified' });
		expect(await env.db.prepare('SELECT status FROM email WHERE type = 1').first()).toMatchObject({ status: 8 });

		const retry = await sendWith(key, payload, headers);
		expect(retry.body.code).toBe(200);
		expect(retry.response.headers.get('Idempotent-Replayed')).toBeNull();
		expect(await countEmails(1)).toBe(2);
	});

	it('caches an unknown delivery outcome so retries never resend', async () => {
		const { key } = await createKey();
		const headers = { 'Idempotency-Key': 'network-reset' };
		const payload = sendPayload({ receiveEmail: ['someone@example.net'] });
		const uncertain = vi.spyOn(emailService, 'sendByCloudflareEmail').mockRejectedValueOnce(new Error('network reset'));

		let first;
		try {
			first = await sendWith(key, payload, headers);
		} finally {
			uncertain.mockRestore();
		}
		expect(first.body).toMatchObject({ code: 502 });

		const retry = await sendWith(key, payload, headers);
		expect(retry.body).toEqual(first.body);
		expect(retry.response.status).toBe(502);
		expect(retry.response.headers.get('Idempotent-Replayed')).toBe('true');
		expect(await countEmails(1)).toBe(1);
	});

	it('delivers cc and bcc copies internally without exposing the bcc list', async () => {
		await env.db.prepare("UPDATE role SET send_count = 10 WHERE role_id = 1").run();
		roleService.clearCache();
		const { key } = await createKey();

		const { body } = await sendWith(key, sendPayload({
			cc: ['copy@example.com', 'recipient@example.com'],
			bcc: ['hidden@example.com']
		}));
		expect(body.code).toBe(200);
		expect(body.data[0]).not.toHaveProperty('content');

		const sent = await env.db.prepare('SELECT cc, bcc FROM email WHERE type = 1').first();
		expect(JSON.parse(sent.cc).map(item => item.address)).toEqual(['copy@example.com']);
		expect(JSON.parse(sent.bcc).map(item => item.address)).toEqual(['hidden@example.com']);

		const { results: copies } = await env.db.prepare(`
			SELECT to_email AS toEmail, user_id AS userId, bcc, status
			FROM email WHERE type = 0 ORDER BY to_email
		`).all();
		expect(copies.map(row => row.toEmail)).toEqual(['copy@example.com', 'hidden@example.com', 'recipient@example.com']);
		expect(copies.every(row => row.bcc === '[]' && row.status === 0)).toBe(true);
		expect(await env.db.prepare('SELECT send_count AS sendCount FROM user WHERE user_id = 101').first())
			.toMatchObject({ sendCount: 3 });
	});

	it('rejects multiple replyTo addresses for Cloudflare Email before storing anything', async () => {
		const { key } = await createKey();
		const { body } = await sendWith(key, sendPayload({
			receiveEmail: ['someone@example.net'],
			replyTo: ['a@example.com', 'b@example.com']
		}));
		expect(body).toMatchObject({ code: 400, message: 'Cloudflare Email supports only one replyTo address' });
		expect(await countEmails(1)).toBe(0);
		expect(await env.db.prepare('SELECT COUNT(*) AS total FROM public_send_rate_limit').first())
			.toMatchObject({ total: 0 });
	});

	it('renders text-only messages as escaped HTML and derives text from HTML-only messages', async () => {
		const { key } = await createKey();

		expect((await sendWith(key, sendPayload({ text: 'a < b\nline 2' }))).body.code).toBe(200);
		expect((await sendWith(key, sendPayload({
			subject: 'Rich',
			text: undefined,
			content: '<p>Hello <b>World</b></p>'
		}))).body.code).toBe(200);

		const { results } = await env.db.prepare(`
			SELECT subject, content, text FROM email WHERE type = 1 ORDER BY email_id
		`).all();
		expect(results[0].content).toBe('a &lt; b<br>line 2');
		expect(results[1].text).toContain('Hello World');
	});

	it('reports delivery status only for mail the key is allowed to see', async () => {
		const { key } = await createKey();
		const restricted = await createKey({ allowedSenders: ['*@example3.com'] });
		const { body } = await sendWith(key);
		const emailId = body.data[0].emailId;

		const status = await api(`/public/emailStatus?emailIds=${emailId},999999`, {
			headers: { Authorization: `Bearer ${key}` }
		});
		expect(status.body.code).toBe(200);
		expect(status.body.data.list[0]).toMatchObject({ emailId, statusName: 'delivered' });
		expect(status.body.data.notFound).toEqual([999999]);

		const hidden = await api('/public/emailStatus', {
			method: 'POST',
			headers: { Authorization: `Bearer ${restricted.key}` },
			body: { emailIds: [emailId] }
		});
		expect(hidden.body.data).toEqual({ list: [], notFound: [emailId] });
	});

	it('pages through mail with afterId and limits read access to the key address scope', async () => {
		const sender = await createKey();
		await sendWith(sender.key);
		await sendWith(sender.key, sendPayload({ receiveEmail: ['copy@example.com'] }));

		const reader = await createKey({ scopes: ['read'] });
		const all = await api('/public/emailList', {
			method: 'POST',
			headers: { Authorization: `Bearer ${reader.key}` },
			body: { afterId: 0, size: 50 }
		});
		const ids = all.body.data.map(row => row.emailId);
		expect(ids).toEqual([...ids].sort((a, b) => a - b));
		expect(ids).toHaveLength(4);

		const newer = await api('/public/emailList', {
			method: 'POST',
			headers: { Authorization: `Bearer ${reader.key}` },
			body: { afterId: ids[1] }
		});
		expect(newer.body.data.map(row => row.emailId)).toEqual(ids.slice(2));

		const scoped = await createKey({ scopes: ['read'], allowedSenders: ['copy@example.com'] });
		const scopedList = await api('/public/emailList', {
			method: 'POST',
			headers: { Authorization: `Bearer ${scoped.key}` },
			body: {}
		});
		expect(scopedList.body.data.map(row => row.toEmail)).toEqual(['copy@example.com']);
	});

	it('matches internal recipients case-insensitively', async () => {
		const { key } = await createKey();
		expect((await sendWith(key, sendPayload({ receiveEmail: ['Recipient@Example.com'] }))).body.code).toBe(200);
		const copy = await env.db.prepare('SELECT user_id AS userId, status FROM email WHERE type = 0').first();
		expect(copy).toMatchObject({ userId: 102, status: 0 });
	});

	it('keeps the legacy public token working until the administrator revokes it', async () => {
		await env.kv.put(KvConst.PUBLIC_KEY, 'legacy-token');
		expect((await api('/public/sendEmail', {
			method: 'POST',
			headers: { Authorization: 'legacy-token' },
			body: sendPayload()
		})).body.code).toBe(200);

		const { body: listBody } = await api('/apiKey/list', { token: adminToken });
		expect(listBody.data.legacyTokenActive).toBe(true);

		await api('/apiKey/legacyToken', { method: 'DELETE', token: adminToken });
		expect((await api('/public/sendEmail', {
			method: 'POST',
			headers: { Authorization: 'legacy-token' },
			body: sendPayload()
		})).body.code).toBe(401);
	});
});
