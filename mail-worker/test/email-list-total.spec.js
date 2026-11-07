import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import emailService from '../src/service/email-service';

const USER_ID = 7;

function emails(accountId, userId, type, isDel, count) {
	return Array.from({ length: count }, () => env.db.prepare(`
		INSERT INTO email (account_id, user_id, type, status, is_del, subject)
		VALUES (?, ?, ?, 0, ?, 'seed')
	`).bind(accountId, userId, type, isDel));
}

function list(params) {
	return emailService.list({ env }, {
		emailId: 0,
		size: 50,
		timeSort: 0,
		lite: 1,
		...params
	}, USER_ID);
}

describe('mailbox totals on D1', () => {
	beforeAll(async () => {
		const response = await SELF.fetch('http://example.com/api/init', {
			method: 'POST',
			headers: { 'X-Cloud-Mail-Init-Secret': 'your-jwt-secret' }
		});
		expect(response.status).toBe(200);

		await env.db.batch([
			env.db.prepare('DELETE FROM email'),
			env.db.prepare('DELETE FROM account'),
			env.db.prepare(`
				INSERT INTO account (account_id, email, name, status, user_id, all_receive, sort, is_del) VALUES
				(301, 'a@example.com', 'a', 0, ${USER_ID}, 1, 0, 0),
				(302, 'b@example.com', 'b', 0, ${USER_ID}, 0, 0, 0),
				(303, 'gone@example.com', 'gone', 0, ${USER_ID}, 0, 0, 1),
				(304, 'other@example.com', 'other', 0, 8, 0, 0, 0)
			`),
			...emails(301, USER_ID, 0, 0, 3),
			...emails(301, USER_ID, 0, 1, 1),
			...emails(301, USER_ID, 1, 0, 2),
			...emails(302, USER_ID, 0, 0, 2),
			...emails(303, USER_ID, 0, 0, 4),
			...emails(304, 8, 0, 0, 5)
		]);
	});

	it.each([
		['all accounts, receive', { allReceive: 1, accountId: 301, type: 0 }, 5],
		['all accounts, receive, query-string params', { allReceive: '1', accountId: '301', type: '0' }, 5],
		['all accounts, send', { allReceive: 1, accountId: 301, type: 1 }, 2],
		['single account', { allReceive: 0, accountId: 301, type: 0 }, 3],
		['deleted account', { allReceive: 0, accountId: 303, type: 0 }, 0]
	])('counts exactly the listed mail: %s', async (_name, params, expected) => {
		const result = await list(params);

		expect(result.total).toBe(expected);
		expect(result.list).toHaveLength(expected);
	});
});
