import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import cryptoUtils from '../src/utils/crypto-utils';
import KvConst from '../src/const/kv-const';
import authRateLimitService from '../src/service/auth-rate-limit-service';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'rate-limit-admin-password';

async function initializeDatabase() {
	const response = await SELF.fetch('http://example.com/api/init', {
		method: 'POST',
		headers: { 'X-Cloud-Mail-Init-Secret': 'your-jwt-secret' }
	});
	expect(response.status).toBe(200);
}

async function post(path, password, ip, email = ADMIN_EMAIL) {
	const response = await SELF.fetch(`http://example.com/api${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'CF-Connecting-IP': ip
		},
		body: JSON.stringify({ email, password })
	});
	return response.json();
}

describe('authentication failure rate limits', () => {
	let credentials;

	beforeAll(async () => {
		await initializeDatabase();
		credentials = await cryptoUtils.hashPassword(ADMIN_PASSWORD);
	});

	beforeEach(async () => {
		try {
			await env.db.prepare('DELETE FROM auth_failure_limit').run();
		} catch (error) {
			if (!String(error?.message || error).includes('no such table')) throw error;
		}
		await env.db.batch([
			env.db.prepare('DELETE FROM account'),
			env.db.prepare('DELETE FROM user'),
			env.db.prepare(`
				INSERT INTO user (user_id, email, type, password, salt, status, is_del)
				VALUES (701, ?, 1, ?, ?, 0, 0)
			`).bind(ADMIN_EMAIL, credentials.hash, credentials.salt),
			env.db.prepare(`
				INSERT INTO account (account_id, email, name, user_id, is_del)
				VALUES (801, ?, 'Admin', 701, 0)
			`).bind(ADMIN_EMAIL)
		]);
		await env.kv.delete(KvConst.AUTH_INFO + 701);
		await env.kv.delete(KvConst.PUBLIC_KEY);
	});

	it('atomically locks concurrent login failures after fifteen attempts for one minute', async () => {
		const ip = '203.0.113.10';
		const bodies = await Promise.all(Array.from({ length: 20 }, () => (
			post('/login', 'wrong-password', ip, 'ADMIN@example.com')
		)));

		expect(bodies.filter(body => body.code === 429)).toHaveLength(6);
		const row = await env.db.prepare(`
			SELECT scope,
			       identity_hash AS identityHash,
			       fail_count AS failCount,
			       lock_until AS lockUntil, updated_at AS updatedAt
			FROM auth_failure_limit
			WHERE scope = 'login'
		`).first();
		expect(row.failCount).toBe(15);
		expect(row.lockUntil - row.updatedAt).toBe(60);
		expect(row.lockUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
		expect(JSON.stringify(row)).not.toContain(ip);
	});

	it('does not count registration failures caused by configuration or input validation', async () => {
		const ip = '203.0.113.20';
		const bodies = [];
		for (let attempt = 0; attempt < 8; attempt += 1) {
			bodies.push(await post('/register', 'short', ip, 'probe@example.com'));
		}

		expect(bodies.filter(body => body.code === 429)).toHaveLength(0);
		expect(await env.db.prepare(`
			SELECT fail_count AS failCount,
			       in_flight AS inFlight,
			       lock_until AS lockUntil
			FROM auth_failure_limit
			WHERE scope = 'register'
		`).first()).toMatchObject({ failCount: 0, inFlight: 0, lockUntil: 0 });
	});

	it('locks registration attempts that probe whether an account already exists', async () => {
		const ip = '203.0.113.21';
		const existingEmail = 'existing@example.com';
		await env.db.batch([
			env.db.prepare(`
				INSERT INTO user (user_id, email, type, password, salt, status, is_del)
				VALUES (702, ?, 1, ?, ?, 0, 0)
			`).bind(existingEmail, credentials.hash, credentials.salt),
			env.db.prepare(`
				INSERT INTO account (account_id, email, name, user_id, is_del)
				VALUES (802, ?, 'Existing', 702, 0)
			`).bind(existingEmail)
		]);

		const bodies = [];
		for (let attempt = 0; attempt < 8; attempt += 1) {
			bodies.push(await post('/register', 'registration-probe-password', ip, existingEmail));
		}

		expect(bodies.filter(body => body.code === 429).length).toBeGreaterThan(0);
		const row = await env.db.prepare(`
			SELECT fail_count AS failCount,
			       in_flight AS inFlight,
			       lock_until AS lockUntil
			FROM auth_failure_limit
			WHERE scope = 'register'
		`).first();
		expect(row).toMatchObject({ failCount: 5, inFlight: 0 });
		expect(row.lockUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	it('rejects oversized authentication JSON before creating rate-limit state', async () => {
		const body = JSON.stringify({
			email: ADMIN_EMAIL,
			password: 'wrong-password',
			padding: 'x'.repeat(33 * 1024)
		});
		for (const path of ['/login', '/public/genToken']) {
			const response = await SELF.fetch(`http://example.com/api${path}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'CF-Connecting-IP': '203.0.113.17'
				},
				body
			});
			expect((await response.json()).code).toBe(413);
		}
		expect(await env.db.prepare('SELECT 1 FROM auth_failure_limit LIMIT 1').first()).toBeNull();
	});

	it('reserves at most five concurrent password checks before verification', async () => {
		const ip = '203.0.113.15';
		const c = {
			env,
			req: {
				header: name => name.toLowerCase() === 'cf-connecting-ip' ? ip : undefined
			}
		};
		const reservations = await Promise.allSettled(Array.from({ length: 12 }, () => (
			authRateLimitService.assertAllowed(c, 'reservation-test', ADMIN_EMAIL)
		)));
		const allowed = reservations.filter(result => result.status === 'fulfilled');
		const rejected = reservations.filter(result => result.status === 'rejected');

		expect(allowed).toHaveLength(5);
		expect(rejected).toHaveLength(7);
		expect(rejected.every(result => result.reason?.code === 429)).toBe(true);

		const failures = await Promise.allSettled(allowed.map(result => (
			authRateLimitService.recordFailure(c, result.value)
		)));
		expect(failures.filter(result => result.status === 'rejected')).toHaveLength(1);
		const row = await env.db.prepare(`
			SELECT fail_count AS failCount,
			       in_flight AS inFlight,
			       lock_until AS lockUntil
			FROM auth_failure_limit
			WHERE scope = 'reservation-test'
		`).first();
		expect(row).toMatchObject({ failCount: 5, inFlight: 0 });
		expect(row.lockUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
	});

	it('recovers abandoned reservations without letting an old request clear new state', async () => {
		const ip = '203.0.113.16';
		const c = {
			env,
			req: {
				header: name => name.toLowerCase() === 'cf-connecting-ip' ? ip : undefined
			}
		};
		const oldReservations = [];
		for (let index = 0; index < 5; index++) {
			oldReservations.push(await authRateLimitService.assertAllowed(
				c,
				'abandoned-reservation-test',
				ADMIN_EMAIL
			));
		}
		await expect(authRateLimitService.assertAllowed(
			c,
			'abandoned-reservation-test',
			ADMIN_EMAIL
		)).rejects.toMatchObject({ code: 429 });
		await env.db.prepare(`
			UPDATE auth_failure_limit
			SET in_flight_started_at = ?
			WHERE scope = 'abandoned-reservation-test'
		`).bind(Math.floor(Date.now() / 1000) - 31).run();

		const currentReservation = await authRateLimitService.assertAllowed(
			c,
			'abandoned-reservation-test',
			ADMIN_EMAIL
		);
		expect(currentReservation.reservationGeneration)
			.not.toBe(oldReservations[0].reservationGeneration);
		await expect(authRateLimitService.clear(c, oldReservations[0]))
			.rejects.toMatchObject({ code: 429 });
		expect(await env.db.prepare(`
			SELECT 1
			FROM auth_failure_limit
			WHERE scope = 'abandoned-reservation-test'
		`).first()).not.toBeNull();

		await authRateLimitService.clear(c, currentReservation);
		expect(await env.db.prepare(`
			SELECT 1
			FROM auth_failure_limit
			WHERE scope = 'abandoned-reservation-test'
		`).first()).toBeNull();
	});

	it('clears prior failures after a successful login', async () => {
		const ip = '203.0.113.11';
		for (let index = 0; index < 4; index++) {
			expect((await post('/login', 'wrong-password', ip)).code).not.toBe(429);
		}

		expect((await post('/login', ADMIN_PASSWORD, ip)).code).toBe(200);
		expect(await env.db.prepare(`
			SELECT 1
			FROM auth_failure_limit
			WHERE scope = 'login'
		`).first()).toBeNull();
	});

	it('applies an independent lock to public token generation', async () => {
		const ip = '203.0.113.12';
		let body;
		for (let index = 0; index < 5; index++) {
			body = await post('/public/genToken', 'wrong-password', ip);
		}

		expect(body.code).toBe(429);
		const publicLimit = await env.db.prepare("SELECT lock_until - updated_at AS duration FROM auth_failure_limit WHERE scope = 'public-gen-token'").first();
		expect(publicLimit.duration).toBe(300);
		expect((await post('/public/genToken', ADMIN_PASSWORD, ip)).code).toBe(429);
		expect((await post('/login', ADMIN_PASSWORD, ip)).code).toBe(200);
		expect(await env.kv.get(KvConst.PUBLIC_KEY)).toBeNull();
	});

	it('clears public token failures after successful administrator verification', async () => {
		const ip = '203.0.113.14';
		for (let index = 0; index < 4; index++) {
			expect((await post('/public/genToken', 'wrong-password', ip)).code).not.toBe(429);
		}

		expect((await post('/public/genToken', ADMIN_PASSWORD, ip)).code).toBe(200);
		expect(await env.db.prepare(`
			SELECT 1
			FROM auth_failure_limit
			WHERE scope = 'public-gen-token'
		`).first()).toBeNull();
		expect(await env.kv.get(KvConst.PUBLIC_KEY)).not.toBeNull();
	});

	it('allows authentication again after a temporary lock expires', async () => {
		const ip = '203.0.113.13';
		for (let index = 0; index < 15; index++) {
			await post('/login', 'wrong-password', ip);
		}
		await env.db.prepare(`
			UPDATE auth_failure_limit
			SET lock_until = ?, updated_at = ?
			WHERE scope = 'login'
		`).bind(
			Math.floor(Date.now() / 1000) - 1,
			Math.floor(Date.now() / 1000) - 1
		).run();

		expect((await post('/login', ADMIN_PASSWORD, ip)).code).toBe(200);
		expect(await env.db.prepare(`
			SELECT 1 FROM auth_failure_limit WHERE scope = 'login'
		`).first()).toBeNull();
	});

	it('fails closed with a clear configuration error when the HMAC secret is missing', async () => {
		const c = {
			env: { jwt_secret: '' },
			req: { header: () => '203.0.113.20' }
		};

		await expect(authRateLimitService.assertAllowed(c, 'login', ADMIN_EMAIL))
			.rejects.toThrow('jwt_secret is required for authentication rate limiting');
	});

	it('removes only expired inactive rate-limit identities', async () => {
		const now = Math.floor(Date.now() / 1000);
		await env.db.batch([
			env.db.prepare(`
				INSERT INTO auth_failure_limit
				(scope, identity_hash, fail_count, window_started_at, lock_until, updated_at)
				VALUES ('cleanup', 'stale', 1, ?, 0, ?)
			`).bind(now - 1200, now - 1200),
			env.db.prepare(`
				INSERT INTO auth_failure_limit
				(scope, identity_hash, fail_count, window_started_at, lock_until, updated_at)
				VALUES ('cleanup', 'active', 1, ?, 0, ?)
			`).bind(now - 60, now - 60),
			env.db.prepare(`
				INSERT INTO auth_failure_limit
				(scope, identity_hash, fail_count, window_started_at, lock_until, updated_at)
				VALUES ('cleanup', 'locked', 5, ?, ?, ?)
			`).bind(now - 1200, now + 60, now - 1200)
		]);

		await authRateLimitService.clearExpired({ env });
		const { results } = await env.db.prepare(`
			SELECT identity_hash AS identityHash
			FROM auth_failure_limit
			WHERE scope = 'cleanup'
			ORDER BY identity_hash
		`).all();
		expect(results.map(row => row.identityHash)).toEqual(['active', 'locked']);
	});
});
