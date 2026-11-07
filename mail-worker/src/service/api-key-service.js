import BizError from '../error/biz-error';
import KvConst from '../const/kv-const';
import constant from '../const/constant';
import secretUtils from '../utils/secret-utils';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import { randomBase64Url, sha256Base64Url } from '../utils/oauth-crypto-utils';
import { t } from '../i18n/i18n';

export const API_KEY_PREFIX = 'cmk_';
export const API_KEY_DISPLAY_LENGTH = 12;
export const API_KEY_MAX_COUNT = 50;
export const API_KEY_MAX_SENDERS = 50;
export const API_KEY_MAX_LIMIT = 1_000_000;
export const DEFAULT_PUBLIC_SEND_HOURLY_LIMIT = 100;

export const apiKeyConst = Object.freeze({
	scope: Object.freeze({
		SEND: 'send',
		READ: 'read',
		USERS: 'users'
	}),
	status: Object.freeze({
		ACTIVE: 0,
		DISABLED: 1
	}),
	principal: Object.freeze({
		LEGACY: 'legacy',
		API_KEY: 'api_key'
	})
});

const ALL_SCOPES = Object.freeze(Object.values(apiKeyConst.scope));
const ROUTE_SCOPES = Object.freeze({
	'/public/sendEmail': apiKeyConst.scope.SEND,
	'/public/emailStatus': apiKeyConst.scope.SEND,
	'/public/emailList': apiKeyConst.scope.READ,
	'/public/addUser': apiKeyConst.scope.USERS
});
const AUTH_CACHE_TTL = 15 * 1000;
const AUTH_CACHE_MAX_ENTRIES = 200;
const LAST_USED_WRITE_INTERVAL = 60 * 1000;
const USAGE_RETENTION_SECONDS = 8 * 24 * 3600;
const NAME_MAX_LENGTH = 64;

export const API_SCHEMA_SQL = Object.freeze([
	`CREATE TABLE IF NOT EXISTS api_key (
		key_id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL DEFAULT '',
		key_prefix TEXT NOT NULL DEFAULT '',
		key_hash TEXT NOT NULL,
		scopes TEXT NOT NULL DEFAULT 'send',
		allowed_senders TEXT NOT NULL DEFAULT '[]',
		hourly_limit INTEGER NOT NULL DEFAULT 0 CHECK (hourly_limit >= 0),
		daily_limit INTEGER NOT NULL DEFAULT 0 CHECK (daily_limit >= 0),
		status INTEGER NOT NULL DEFAULT 0,
		expires_at TEXT,
		last_used_at TEXT,
		create_user_id INTEGER NOT NULL DEFAULT 0,
		create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		update_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_hash ON api_key(key_hash)`,
	`CREATE TABLE IF NOT EXISTS api_key_usage (
		key_id INTEGER NOT NULL,
		bucket TEXT NOT NULL,
		bucket_time INTEGER NOT NULL,
		count INTEGER NOT NULL DEFAULT 0,
		cap INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (key_id, bucket),
		CHECK (count >= 0),
		CHECK (cap = 0 OR count <= cap)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_api_key_usage_time ON api_key_usage(bucket_time)`,
	`CREATE TABLE IF NOT EXISTS api_idempotency (
		idem_key TEXT PRIMARY KEY,
		request_hash TEXT NOT NULL,
		status INTEGER NOT NULL DEFAULT 0,
		http_status INTEGER NOT NULL DEFAULT 0,
		response TEXT,
		create_time INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_api_idempotency_expires ON api_idempotency(expires_at)`
]);

export const LEGACY_PRINCIPAL = Object.freeze({
	type: apiKeyConst.principal.LEGACY,
	keyId: 0,
	name: 'legacy',
	scopes: ALL_SCOPES,
	allowedSenders: Object.freeze([]),
	hourlyLimit: 0,
	dailyLimit: 0,
	idempotencyScope: 'legacy'
});

const schemaReadyByDb = new WeakMap();
const authCache = new Map();
const lastUsedWrites = new Map();

export function hashSecret(value) {
	return sha256Base64Url(String(value));
}

function generateApiKey() {
	return API_KEY_PREFIX + randomBase64Url(32);
}

function parseJsonArray(value) {
	if (Array.isArray(value)) {
		return value;
	}
	try {
		const parsed = JSON.parse(value || '[]');
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function parseScopes(value) {
	const scopes = String(value || '')
		.split(',')
		.map(item => item.trim())
		.filter(item => ALL_SCOPES.includes(item));
	return [...new Set(scopes)];
}

function toRecord(row) {
	if (!row) {
		return null;
	}
	return {
		keyId: row.keyId,
		name: row.name,
		keyPrefix: row.keyPrefix,
		scopes: parseScopes(row.scopes),
		allowedSenders: parseJsonArray(row.allowedSenders).filter(item => typeof item === 'string'),
		hourlyLimit: Number(row.hourlyLimit) || 0,
		dailyLimit: Number(row.dailyLimit) || 0,
		status: Number(row.status) || 0,
		expiresAt: row.expiresAt || null,
		lastUsedAt: row.lastUsedAt || null,
		createTime: row.createTime || null,
		updateTime: row.updateTime || null
	};
}

function toPrincipal(record) {
	return Object.freeze({
		type: apiKeyConst.principal.API_KEY,
		keyId: record.keyId,
		name: record.name,
		scopes: Object.freeze([...record.scopes]),
		allowedSenders: Object.freeze([...record.allowedSenders]),
		hourlyLimit: record.hourlyLimit,
		dailyLimit: record.dailyLimit,
		status: record.status,
		expiresAt: record.expiresAt,
		idempotencyScope: `key:${record.keyId}`
	});
}

const RECORD_COLUMNS = `
	key_id AS keyId,
	name,
	key_prefix AS keyPrefix,
	scopes,
	allowed_senders AS allowedSenders,
	hourly_limit AS hourlyLimit,
	daily_limit AS dailyLimit,
	status,
	expires_at AS expiresAt,
	last_used_at AS lastUsedAt,
	create_time AS createTime,
	update_time AS updateTime
`;

function normalizeName(value) {
	if (typeof value !== 'string' || !value.trim()) {
		throw new BizError('API key name is required', 400);
	}
	const name = value.trim();
	if (name.length > NAME_MAX_LENGTH) {
		throw new BizError(`API key name must not exceed ${NAME_MAX_LENGTH} characters`, 400);
	}
	return name;
}

function normalizeScopes(value) {
	if (value === undefined || value === null) {
		return [apiKeyConst.scope.SEND];
	}
	if (!Array.isArray(value)) {
		throw new BizError('scopes must be an array', 400);
	}
	if (value.some(scope => !ALL_SCOPES.includes(scope))) {
		throw new BizError(`scopes may only contain ${ALL_SCOPES.join(', ')}`, 400);
	}
	const scopes = ALL_SCOPES.filter(scope => value.includes(scope));
	if (scopes.length === 0) {
		throw new BizError('At least one scope is required', 400);
	}
	return scopes;
}

export function normalizeSenderPattern(value) {
	if (typeof value !== 'string') {
		return null;
	}
	const pattern = value.trim().toLowerCase();
	if (!pattern) {
		return null;
	}
	const domainMatch = /^\*?@(.+)$/.exec(pattern);
	if (domainMatch) {
		return verifyUtils.isDomain(domainMatch[1]) ? `*@${domainMatch[1]}` : null;
	}
	return verifyUtils.isEmail(pattern) ? pattern : null;
}

function normalizeAllowedSenders(value) {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new BizError('allowedSenders must be an array', 400);
	}
	if (value.length > API_KEY_MAX_SENDERS) {
		throw new BizError(`allowedSenders must contain no more than ${API_KEY_MAX_SENDERS} items`, 400);
	}
	const senders = [];
	for (const item of value) {
		const pattern = normalizeSenderPattern(item);
		if (!pattern) {
			throw new BizError(`Invalid sender pattern: ${String(item).slice(0, 100)}`, 400);
		}
		if (!senders.includes(pattern)) {
			senders.push(pattern);
		}
	}
	return senders;
}

function normalizeLimit(value, field) {
	if (value === undefined || value === null || value === '') {
		return 0;
	}
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 0 || limit > API_KEY_MAX_LIMIT) {
		throw new BizError(`${field} must be an integer between 0 and ${API_KEY_MAX_LIMIT}`, 400);
	}
	return limit;
}

function normalizeExpiresAt(value, { requireFuture = true } = {}) {
	if (value === undefined || value === null || value === '') {
		return null;
	}
	const time = typeof value === 'number' ? value : Date.parse(String(value));
	if (!Number.isFinite(time)) {
		throw new BizError('expiresAt must be an ISO 8601 date', 400);
	}
	if (requireFuture && time <= Date.now()) {
		throw new BizError('expiresAt must be in the future', 400);
	}
	return new Date(time).toISOString();
}

function normalizeStatus(value) {
	const status = Number(value);
	if (status !== apiKeyConst.status.ACTIVE && status !== apiKeyConst.status.DISABLED) {
		throw new BizError('status must be 0 (active) or 1 (disabled)', 400);
	}
	return status;
}

function normalizeKeyId(value) {
	const keyId = Number(value);
	if (!Number.isInteger(keyId) || keyId <= 0) {
		throw new BizError('Invalid API key id', 400);
	}
	return keyId;
}

function readCache(hash) {
	const item = authCache.get(hash);
	if (!item) {
		return null;
	}
	if (item.expiresAt <= Date.now()) {
		authCache.delete(hash);
		return null;
	}
	return item.principal;
}

function writeCache(hash, principal) {
	if (authCache.size >= AUTH_CACHE_MAX_ENTRIES) {
		authCache.delete(authCache.keys().next().value);
	}
	authCache.set(hash, { principal, expiresAt: Date.now() + AUTH_CACHE_TTL });
}

function runInBackground(c, task) {
	const promise = Promise.resolve().then(task).catch(e => {
		console.warn('API key background task failed:', e?.message || e);
	});
	let ctx;
	try {
		ctx = c.executionCtx;
	} catch {
		ctx = undefined;
	}
	if (ctx?.waitUntil) {
		ctx.waitUntil(promise);
		return undefined;
	}
	return promise;
}

export function extractApiToken(c) {
	const apiKeyHeader = c.req.header('X-API-Key');
	if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim()) {
		return apiKeyHeader.trim();
	}
	const authorization = c.req.header(constant.TOKEN_HEADER);
	if (typeof authorization !== 'string') {
		return '';
	}
	const value = authorization.trim();
	const bearer = /^Bearer\s+(.+)$/i.exec(value);
	return bearer ? bearer[1].trim() : value;
}

export function resolvePublicHourlyLimit(c) {
	const raw = c.env?.public_send_hourly_limit;
	if (raw === undefined || raw === null || raw === '') {
		return DEFAULT_PUBLIC_SEND_HOURLY_LIMIT;
	}
	const limit = Number(raw);
	return Number.isInteger(limit) && limit >= 0 ? limit : DEFAULT_PUBLIC_SEND_HOURLY_LIMIT;
}

export function isSenderAllowed(principal, senderEmail) {
	const patterns = principal?.allowedSenders || [];
	if (patterns.length === 0) {
		return true;
	}
	const sender = String(senderEmail || '').trim().toLowerCase();
	const domain = emailUtils.getDomain(sender);
	return patterns.some(pattern => pattern === sender || (domain && pattern === `*@${domain}`));
}

const apiKeyService = {

	async ensureSchema(c) {
		const db = c.env.db;
		let ready = schemaReadyByDb.get(db);
		if (!ready) {
			ready = db.batch(API_SCHEMA_SQL.map(sql => db.prepare(sql))).then(() => true);
			schemaReadyByDb.set(db, ready);
			ready.catch(() => schemaReadyByDb.delete(db));
		}
		return ready;
	},

	clearCache() {
		authCache.clear();
		lastUsedWrites.clear();
	},

	routeScope(path) {
		return ROUTE_SCOPES[path] || null;
	},

	async authenticate(c) {
		const token = extractApiToken(c);
		if (!token) {
			throw new BizError(t('publicTokenFail'), 401);
		}
		if (token.startsWith(API_KEY_PREFIX)) {
			return await this.authenticateApiKey(c, token);
		}

		const legacyToken = await c.env.kv.get(KvConst.PUBLIC_KEY);
		if (!legacyToken || !await secretUtils.timingSafeEqual(token, legacyToken)) {
			throw new BizError(t('publicTokenFail'), 401);
		}
		return LEGACY_PRINCIPAL;
	},

	async authenticateApiKey(c, token) {
		const hash = await hashSecret(token);
		let principal = readCache(hash);
		if (!principal) {
			await this.ensureSchema(c);
			const row = await c.env.db.prepare(`
				SELECT ${RECORD_COLUMNS}
				FROM api_key
				WHERE key_hash = ?
			`).bind(hash).first();
			if (!row) {
				throw new BizError(t('publicTokenFail'), 401);
			}
			principal = toPrincipal(toRecord(row));
			writeCache(hash, principal);
		}

		if (principal.status !== apiKeyConst.status.ACTIVE) {
			throw new BizError('API key is disabled', 401);
		}
		if (principal.expiresAt && Date.parse(principal.expiresAt) <= Date.now()) {
			throw new BizError('API key has expired', 401);
		}

		this.touchLastUsed(c, principal.keyId);
		return principal;
	},

	assertScope(principal, scope) {
		if (!scope) {
			return;
		}
		if (!principal?.scopes?.includes(scope)) {
			throw new BizError(`API key is missing the "${scope}" scope`, 403);
		}
	},

	assertSenderAllowed(principal, senderEmail) {
		if (!isSenderAllowed(principal, senderEmail)) {
			throw new BizError('API key is not allowed to send from this address', 403);
		}
	},

	touchLastUsed(c, keyId) {
		const now = Date.now();
		const previous = lastUsedWrites.get(keyId) || 0;
		if (now - previous < LAST_USED_WRITE_INTERVAL) {
			return;
		}
		lastUsedWrites.set(keyId, now);
		runInBackground(c, () => c.env.db.prepare(`
			UPDATE api_key SET last_used_at = ? WHERE key_id = ?
		`).bind(new Date(now).toISOString(), keyId).run());
	},

	async reserveSend(c, principal) {
		if (principal?.type !== apiKeyConst.principal.API_KEY) {
			return null;
		}
		await this.ensureSchema(c);
		const now = Date.now();
		const hour = Math.floor(now / 3600000);
		const day = Math.floor(now / 86400000);
		const statement = `
			INSERT INTO api_key_usage (key_id, bucket, bucket_time, count, cap)
			VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(key_id, bucket) DO UPDATE
			SET count = api_key_usage.count + 1,
				cap = excluded.cap
			RETURNING count, cap
		`;
		let results;
		try {
			results = await c.env.db.batch([
				c.env.db.prepare(statement).bind(principal.keyId, `h:${hour}`, hour * 3600, principal.hourlyLimit),
				c.env.db.prepare(statement).bind(principal.keyId, `d:${day}`, day * 86400, principal.dailyLimit)
			]);
		} catch (e) {
			if (/CHECK constraint failed/i.test(e?.message || '')) {
				throw new BizError('API key send rate limit exceeded', 429);
			}
			throw e;
		}
		const hourRow = results?.[0]?.results?.[0] || {};
		const dayRow = results?.[1]?.results?.[0] || {};
		return {
			hourCount: Number(hourRow.count) || 0,
			hourLimit: principal.hourlyLimit,
			dayCount: Number(dayRow.count) || 0,
			dayLimit: principal.dailyLimit
		};
	},

	async list(c) {
		await this.ensureSchema(c);
		const now = Date.now();
		const hourBucket = `h:${Math.floor(now / 3600000)}`;
		const dayBucket = `d:${Math.floor(now / 86400000)}`;
		const windowHour = Math.floor(now / 3600000);
		const [keyResult, usageResult, publicUsage, legacyToken] = await Promise.all([
			c.env.db.prepare(`SELECT ${RECORD_COLUMNS} FROM api_key ORDER BY key_id DESC`).all(),
			c.env.db.prepare(`
				SELECT key_id AS keyId, bucket, count
				FROM api_key_usage
				WHERE bucket IN (?, ?)
			`).bind(hourBucket, dayBucket).all(),
			c.env.db.prepare(`
				SELECT count FROM public_send_rate_limit WHERE window_hour = ?
			`).bind(windowHour).first().catch(() => null),
			c.env.kv.get(KvConst.PUBLIC_KEY)
		]);

		const usageByKey = new Map();
		for (const row of usageResult.results || []) {
			const usage = usageByKey.get(row.keyId) || { hour: 0, day: 0 };
			if (row.bucket === hourBucket) usage.hour = Number(row.count) || 0;
			if (row.bucket === dayBucket) usage.day = Number(row.count) || 0;
			usageByKey.set(row.keyId, usage);
		}

		return {
			list: (keyResult.results || []).map(row => {
				const record = toRecord(row);
				return {
					...record,
					expired: !!record.expiresAt && Date.parse(record.expiresAt) <= now,
					usage: usageByKey.get(record.keyId) || { hour: 0, day: 0 }
				};
			}),
			legacyTokenActive: !!legacyToken,
			publicHourlyLimit: resolvePublicHourlyLimit(c),
			publicHourlyUsed: Number(publicUsage?.count) || 0,
			maxKeys: API_KEY_MAX_COUNT
		};
	},

	async create(c, params, userId) {
		params = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
		await this.ensureSchema(c);
		const name = normalizeName(params.name);
		const scopes = normalizeScopes(params.scopes);
		const allowedSenders = normalizeAllowedSenders(params.allowedSenders);
		const hourlyLimit = normalizeLimit(params.hourlyLimit, 'hourlyLimit');
		const dailyLimit = normalizeLimit(params.dailyLimit, 'dailyLimit');
		const expiresAt = normalizeExpiresAt(params.expiresAt);

		const key = generateApiKey();
		const keyHash = await hashSecret(key);
		const now = new Date().toISOString();
		const row = await c.env.db.prepare(`
			INSERT INTO api_key (
				name, key_prefix, key_hash, scopes, allowed_senders,
				hourly_limit, daily_limit, status, expires_at, create_user_id, create_time, update_time
			)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE (SELECT COUNT(*) FROM api_key) < ?
			RETURNING ${RECORD_COLUMNS}
		`).bind(
			name,
			key.slice(0, API_KEY_DISPLAY_LENGTH),
			keyHash,
			scopes.join(','),
			JSON.stringify(allowedSenders),
			hourlyLimit,
			dailyLimit,
			apiKeyConst.status.ACTIVE,
			expiresAt,
			Number(userId) || 0,
			now,
			now,
			API_KEY_MAX_COUNT
		).first();

		if (!row) {
			throw new BizError(`A maximum of ${API_KEY_MAX_COUNT} API keys can be created`, 409);
		}

		return { ...toRecord(row), key };
	},

	async update(c, params) {
		params = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
		await this.ensureSchema(c);
		const keyId = normalizeKeyId(params.keyId);
		const assignments = [];
		const binds = [];

		if (params.name !== undefined) {
			assignments.push('name = ?');
			binds.push(normalizeName(params.name));
		}
		if (params.scopes !== undefined) {
			assignments.push('scopes = ?');
			binds.push(normalizeScopes(params.scopes).join(','));
		}
		if (params.allowedSenders !== undefined) {
			assignments.push('allowed_senders = ?');
			binds.push(JSON.stringify(normalizeAllowedSenders(params.allowedSenders)));
		}
		if (params.hourlyLimit !== undefined) {
			assignments.push('hourly_limit = ?');
			binds.push(normalizeLimit(params.hourlyLimit, 'hourlyLimit'));
		}
		if (params.dailyLimit !== undefined) {
			assignments.push('daily_limit = ?');
			binds.push(normalizeLimit(params.dailyLimit, 'dailyLimit'));
		}
		if (params.expiresAt !== undefined) {
			assignments.push('expires_at = ?');
			binds.push(normalizeExpiresAt(params.expiresAt));
		}
		if (params.status !== undefined) {
			assignments.push('status = ?');
			binds.push(normalizeStatus(params.status));
		}

		if (assignments.length === 0) {
			throw new BizError('No API key fields to update', 400);
		}

		assignments.push('update_time = ?');
		binds.push(new Date().toISOString());

		const row = await c.env.db.prepare(`
			UPDATE api_key
			SET ${assignments.join(', ')}
			WHERE key_id = ?
			RETURNING ${RECORD_COLUMNS}
		`).bind(...binds, keyId).first();

		if (!row) {
			throw new BizError('API key not found', 404);
		}
		this.clearCache();
		return toRecord(row);
	},

	async rotate(c, params) {
		await this.ensureSchema(c);
		const keyId = normalizeKeyId(params?.keyId);
		const key = generateApiKey();
		const row = await c.env.db.prepare(`
			UPDATE api_key
			SET key_prefix = ?, key_hash = ?, update_time = ?
			WHERE key_id = ?
			RETURNING ${RECORD_COLUMNS}
		`).bind(
			key.slice(0, API_KEY_DISPLAY_LENGTH),
			await hashSecret(key),
			new Date().toISOString(),
			keyId
		).first();

		if (!row) {
			throw new BizError('API key not found', 404);
		}
		this.clearCache();
		return { ...toRecord(row), key };
	},

	async remove(c, params) {
		await this.ensureSchema(c);
		const keyId = normalizeKeyId(params?.keyId);
		const [deleteResult] = await c.env.db.batch([
			c.env.db.prepare('DELETE FROM api_key WHERE key_id = ?').bind(keyId),
			c.env.db.prepare('DELETE FROM api_key_usage WHERE key_id = ?').bind(keyId)
		]);
		if (Number(deleteResult?.meta?.changes || 0) === 0) {
			throw new BizError('API key not found', 404);
		}
		this.clearCache();
	},

	async revokeLegacyToken(c) {
		await c.env.kv.delete(KvConst.PUBLIC_KEY);
	},

	async clearExpired(c) {
		const nowSeconds = Math.floor(Date.now() / 1000);
		try {
			await c.env.db.batch([
				c.env.db.prepare('DELETE FROM api_key_usage WHERE bucket_time < ?')
					.bind(nowSeconds - USAGE_RETENTION_SECONDS),
				c.env.db.prepare('DELETE FROM api_idempotency WHERE expires_at < ?')
					.bind(nowSeconds)
			]);
		} catch (e) {
			if (!/no such table/i.test(e?.message || '')) {
				throw e;
			}
		}
	}
};

export default apiKeyService;
