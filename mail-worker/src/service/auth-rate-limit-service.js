import BizError from '../error/biz-error';
import reqUtils from '../utils/req-utils';
import { t } from '../i18n/i18n';

export const AUTH_FAILURE_LIMIT = 5;
export const AUTH_FAILURE_WINDOW_SECONDS = 10 * 60;
export const AUTH_LOCK_SECONDS = 5 * 60;
export const LOGIN_FAILURE_LIMIT = 15;
export const LOGIN_LOCK_SECONDS = 60;
export const AUTH_RESERVATION_SECONDS = 30;

const encoder = new TextEncoder();

function normalizeAccount(account) {
	return typeof account === 'string' ? account.trim().toLowerCase().slice(0, 320) : '';
}

function normalizeIp(c) {
	const value = String(reqUtils.getIp(c) || 'Unknown');
	return value.split(',')[0].trim().slice(0, 128) || 'Unknown';
}

async function identityHash(c, scope, account) {
	const secret = c.env.jwt_secret;
	if (typeof secret !== 'string' || secret.length === 0) {
		throw new Error('jwt_secret is required for authentication rate limiting');
	}
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		encoder.encode(`${scope}\u0000${normalizeAccount(account)}\u0000${normalizeIp(c)}`)
	);
	return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

function lockedError() {
	return new BizError(t('authTooManyFailures'), 429);
}

// 标记「疑似枚举或爆破」的失败。只有带此标记的失败计入失败次数，
// 配置与参数校验类失败一并计数会把正常访客锁在门外
export function markAuthAbuse(error) {
	error.authAbuse = true;
	return error;
}

const authRateLimitService = {
	async assertAllowed(c, scope, account) {
		const hash = await identityHash(c, scope, account);
		const now = Math.floor(Date.now() / 1000);
		const resetBefore = now - AUTH_FAILURE_WINDOW_SECONDS;
		const staleBefore = now - AUTH_RESERVATION_SECONDS;
		const candidateGeneration = crypto.randomUUID();
		const results = await c.env.db.batch([
			c.env.db.prepare(`
				INSERT OR IGNORE INTO auth_failure_limit (
					scope, identity_hash, fail_count, in_flight,
					window_started_at, in_flight_started_at,
					reservation_generation, lock_until, updated_at
				)
				VALUES (?, ?, 0, 0, ?, 0, '', 0, ?)
			`).bind(scope, hash, now, now),
			c.env.db.prepare(`
				WITH input(now, reset_before, stale_before, generation, max_attempts) AS (
					VALUES (?, ?, ?, ?, ?)
				)
				UPDATE auth_failure_limit
				SET fail_count = CASE
						WHEN updated_at < input.reset_before
							OR (lock_until > 0 AND lock_until <= input.now)
						THEN 0
						ELSE fail_count
					END,
					in_flight = CASE
						WHEN updated_at < input.reset_before
							OR (lock_until > 0 AND lock_until <= input.now)
							OR (in_flight > 0 AND in_flight_started_at <= input.stale_before)
						THEN 1
						ELSE in_flight + 1
					END,
					window_started_at = CASE
						WHEN updated_at < input.reset_before
							OR (lock_until > 0 AND lock_until <= input.now)
						THEN input.now
						ELSE window_started_at
					END,
					in_flight_started_at = CASE
						WHEN updated_at < input.reset_before
							OR (lock_until > 0 AND lock_until <= input.now)
							OR in_flight = 0
							OR (in_flight > 0 AND in_flight_started_at <= input.stale_before)
						THEN input.now
						ELSE in_flight_started_at
					END,
					reservation_generation = CASE
						WHEN updated_at < input.reset_before
							OR (lock_until > 0 AND lock_until <= input.now)
							OR in_flight = 0
							OR (in_flight > 0 AND in_flight_started_at <= input.stale_before)
						THEN input.generation
						ELSE reservation_generation
					END,
					lock_until = 0,
					updated_at = input.now
				FROM input
				WHERE scope = ?
				  AND identity_hash = ?
				  AND lock_until <= input.now
				  AND (
					CASE
						WHEN updated_at < input.reset_before
							OR (lock_until > 0 AND lock_until <= input.now)
						THEN 0
						ELSE fail_count
					END
					+
					CASE
						WHEN updated_at < input.reset_before
							OR (lock_until > 0 AND lock_until <= input.now)
							OR (in_flight > 0 AND in_flight_started_at <= input.stale_before)
						THEN 0
						ELSE in_flight
					END
				  ) < input.max_attempts
				RETURNING reservation_generation AS reservationGeneration
			`).bind(
				now,
				resetBefore,
				staleBefore,
				candidateGeneration,
				scope === 'login' ? LOGIN_FAILURE_LIMIT : AUTH_FAILURE_LIMIT,
				scope,
				hash
			)
		]);
		const reservation = results?.[1]?.results?.[0];
		if (!reservation?.reservationGeneration) {
			throw lockedError();
		}

		return {
			scope,
			identityHash: hash,
			reservationGeneration: reservation.reservationGeneration
		};
	},

	async recordFailure(c, identity) {
		const now = Math.floor(Date.now() / 1000);
		const results = await c.env.db.batch([
			c.env.db.prepare(`
				SELECT reservation_generation AS reservationGeneration
				FROM auth_failure_limit
				WHERE scope = ? AND identity_hash = ?
			`).bind(identity.scope, identity.identityHash),
			c.env.db.prepare(`
				UPDATE auth_failure_limit
				SET fail_count = fail_count + 1,
					in_flight = in_flight - 1,
					in_flight_started_at = CASE
						WHEN in_flight <= 1 THEN 0
						ELSE in_flight_started_at
					END,
					lock_until = CASE
						WHEN fail_count + 1 >= ? THEN ?
						ELSE 0
					END,
					updated_at = ?
				WHERE scope = ?
				  AND identity_hash = ?
				  AND reservation_generation = ?
				  AND in_flight > 0
				RETURNING fail_count AS failCount, lock_until AS lockUntil
			`).bind(
				identity.scope === 'login' ? LOGIN_FAILURE_LIMIT : AUTH_FAILURE_LIMIT,
				now + (identity.scope === 'login' ? LOGIN_LOCK_SECONDS : AUTH_LOCK_SECONDS),
				now,
				identity.scope,
				identity.identityHash,
				identity.reservationGeneration
			)
		]);
		const current = results?.[0]?.results?.[0];
		if (!current) {
			return;
		}
		if (current.reservationGeneration !== identity.reservationGeneration) {
			throw lockedError();
		}
		const row = results?.[1]?.results?.[0];
		if (!row) {
			throw lockedError();
		}

		if (Number(row?.lockUntil || 0) > now) {
			throw lockedError();
		}
	},

	// 归还并发名额但不计失败，也不清空既有失败次数：
	// 用 clear 归还会让攻击者靠一次无害失败抹掉之前的计数
	async releaseReservation(c, identity) {
		const now = Math.floor(Date.now() / 1000);
		await c.env.db.prepare(`
			UPDATE auth_failure_limit
			SET in_flight = in_flight - 1,
				in_flight_started_at = CASE
					WHEN in_flight <= 1 THEN 0
					ELSE in_flight_started_at
				END,
				updated_at = ?
			WHERE scope = ?
			  AND identity_hash = ?
			  AND reservation_generation = ?
			  AND in_flight > 0
		`).bind(
			now,
			identity.scope,
			identity.identityHash,
			identity.reservationGeneration
		).run();
	},

	async clear(c, identity) {
		const results = await c.env.db.batch([
			c.env.db.prepare(`
				SELECT reservation_generation AS reservationGeneration
				FROM auth_failure_limit
				WHERE scope = ? AND identity_hash = ?
			`).bind(identity.scope, identity.identityHash),
			c.env.db.prepare(`
				DELETE FROM auth_failure_limit
				WHERE scope = ?
				  AND identity_hash = ?
				  AND reservation_generation = ?
			`).bind(
				identity.scope,
				identity.identityHash,
				identity.reservationGeneration
			)
		]);
		const current = results?.[0]?.results?.[0];
		if (!current) {
			return;
		}
		if (current.reservationGeneration !== identity.reservationGeneration
			|| Number(results?.[1]?.meta?.changes || 0) !== 1) {
			throw lockedError();
		}
	},

	async clearExpired(c) {
		const now = Math.floor(Date.now() / 1000);
		await c.env.db.prepare(`
			DELETE FROM auth_failure_limit
			WHERE updated_at < ?
			  AND lock_until <= ?
		`).bind(now - AUTH_FAILURE_WINDOW_SECONDS, now).run();
	}
};

export default authRateLimitService;
