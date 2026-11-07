import BizError from '../error/biz-error';
import apiKeyService, { hashSecret } from './api-key-service';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]+$/;

const idempotencyStatus = Object.freeze({
	PROCESSING: 0,
	COMPLETED: 1
});

export function readIdempotencyKey(c, params) {
	const headerValue = c.req?.header?.(IDEMPOTENCY_HEADER);
	const raw = typeof headerValue === 'string' && headerValue.trim()
		? headerValue
		: params?.idempotencyKey;
	if (raw === undefined || raw === null || raw === '') {
		return null;
	}
	if (typeof raw !== 'string') {
		throw new BizError('Idempotency-Key must be a string', 400);
	}
	const key = raw.trim();
	if (!key || key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
		throw new BizError('Idempotency-Key must be 1-255 visible ASCII characters', 400);
	}
	return key;
}

export class IdempotentReplay extends Error {
	constructor(httpStatus, body) {
		super('Idempotent replay');
		this.name = 'IdempotentReplay';
		this.httpStatus = httpStatus;
		this.body = body;
	}
}

const apiIdempotencyService = {

	async begin(c, { principal, key, requestHash }) {
		await apiKeyService.ensureSchema(c);
		const idemKey = `${principal.idempotencyScope}:${await hashSecret(key)}`;
		const now = Math.floor(Date.now() / 1000);
		const claimed = await c.env.db.prepare(`
			INSERT INTO api_idempotency (idem_key, request_hash, status, http_status, response, create_time, expires_at)
			VALUES (?, ?, ?, 0, NULL, ?, ?)
			ON CONFLICT(idem_key) DO UPDATE
			SET request_hash = excluded.request_hash,
				status = excluded.status,
				http_status = 0,
				response = NULL,
				create_time = excluded.create_time,
				expires_at = excluded.expires_at
			WHERE api_idempotency.expires_at < ?
			RETURNING idem_key AS idemKey
		`).bind(
			idemKey,
			requestHash,
			idempotencyStatus.PROCESSING,
			now,
			now + IDEMPOTENCY_TTL_SECONDS,
			now
		).first();

		if (claimed) {
			return { idemKey };
		}

		const existing = await c.env.db.prepare(`
			SELECT request_hash AS requestHash, status, http_status AS httpStatus, response
			FROM api_idempotency
			WHERE idem_key = ?
		`).bind(idemKey).first();

		if (!existing) {
			throw new BizError('Idempotency-Key could not be reserved, please retry', 409);
		}
		if (existing.requestHash !== requestHash) {
			throw new BizError('Idempotency-Key was already used with a different request', 422);
		}
		if (Number(existing.status) !== idempotencyStatus.COMPLETED) {
			throw new BizError('A request with this Idempotency-Key is still in progress or was interrupted; check emailStatus before retrying with a new key', 409);
		}

		let body = null;
		try {
			body = JSON.parse(existing.response || 'null');
		} catch {
			body = null;
		}
		throw new IdempotentReplay(Number(existing.httpStatus) || 200, body);
	},

	async complete(c, handle, httpStatus, body) {
		if (!handle) {
			return;
		}
		try {
			await c.env.db.prepare(`
				UPDATE api_idempotency
				SET status = ?, http_status = ?, response = ?
				WHERE idem_key = ? AND status = ?
			`).bind(
				idempotencyStatus.COMPLETED,
				httpStatus,
				JSON.stringify(body ?? null),
				handle.idemKey,
				idempotencyStatus.PROCESSING
			).run();
		} catch (e) {
			console.error('Failed to persist idempotent response:', e?.message || e);
		}
	},

	async release(c, handle) {
		if (!handle) {
			return;
		}
		try {
			await c.env.db.prepare(`
				DELETE FROM api_idempotency WHERE idem_key = ? AND status = ?
			`).bind(handle.idemKey, idempotencyStatus.PROCESSING).run();
		} catch (e) {
			console.error('Failed to release idempotency key:', e?.message || e);
		}
	}
};

export default apiIdempotencyService;
