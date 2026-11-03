import { isDel, userConst } from '../const/entity-const';
import constant from '../const/constant';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

const REQUIRED_TABLES = [
	'email_search',
	'public_send_rate_limit',
	'auth_failure_limit',
	'oauth_auth_state',
	'oauth_bind_challenge',
	'oauth',
	'setting',
	'verify_record',
	'reg_key',
	'user',
	'account',
	'role',
	'perm',
	'role_perm',
	'email',
	'star',
	'attachments',
	'delivery_attempt',
	'resend_webhook_event'
];

const REQUIRED_INDEXES = [
	'idx_oauth_platform_user_unique',
	'idx_oauth_auth_state_initiator_expires_at',
	'idx_email_receive_recovery',
	'idx_email_receive_recovery_due',
	'idx_attachments_email_status_key',
	'idx_delivery_attempt_key',
	'idx_delivery_attempt_status_time',
	'idx_delivery_attempt_email',
	'idx_delivery_attempt_provider_message',
	'idx_resend_webhook_event_key',
	'idx_resend_webhook_event_status_time',
	'idx_resend_webhook_event_provider_email',
	'idx_verify_record_ip_type'
];

const REQUIRED_UNIQUE_INDEXES = {
	deliveryAttempt: [
		'idx_delivery_attempt_key',
		'idx_delivery_attempt_email',
		'idx_delivery_attempt_provider_message'
	],
	resendWebhookEvent: ['idx_resend_webhook_event_key']
};

export const BOOTSTRAP_STATUS_CACHE_TTL_MS = 15_000;
// 未就绪的结果默认不缓存，好让另一个 isolate 跑完 /init 后立刻可见。
// 但匿名的 /init/status 一旦被刷，每个请求都要跑整套 PRAGMA 与索引探测，
// 所以只给该入口开一个远短于就绪缓存的窗口，够挡住重放又不影响安装向导的手感。
export const BOOTSTRAP_PENDING_STATUS_CACHE_TTL_MS = 3_000;
export const BOOTSTRAP_STATUS_CHECK_VERSION = 'bootstrap-v3.8-verify-record-index';

const readyCacheByDb = new WeakMap();
const inFlightByDb = new WeakMap();
const cacheEpochByDb = new WeakMap();

const REQUIRED_COLUMNS = {
	email: ['attachment_count', 'recovery_after'],
	attachments: ['status', 'message'],
	deliveryAttempt: [
		'attempt_id',
		'email_id',
		'provider',
		'attempt_key',
		'status',
		'provider_message_id',
		'error_summary',
		'create_time',
		'update_time'
	],
	resendWebhookEvent: [
		'event_key',
		'svix_id',
		'body_sha256',
		'event_type',
		'provider_email_id',
		'status',
		'outcome',
		'received_at',
		'processed_at'
	]
};

function hasText(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

function hasDomainConfig(value) {
	if (Array.isArray(value)) {
		return value.length > 0 && value.every(item => hasText(item));
	}

	if (!hasText(value)) {
		return false;
	}

	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) && parsed.length > 0 && parsed.every(item => hasText(item));
	} catch {
		return false;
	}
}

function cacheKeyFor(c, version) {
	const env = c.env || {};
	const admin = typeof env.admin === 'string' ? env.admin.trim().toLowerCase() : '';
	return JSON.stringify([
		version,
		hasDomainConfig(env.domain),
		admin,
		!!env.kv,
		!!env.assets,
		hasText(env.init_secret) || hasText(env.jwt_secret)
	]);
}

function cloneStatus(status) {
	return {
		...status,
		bindings: { ...status.bindings },
		configuration: { ...status.configuration }
	};
}

export function invalidateBootstrapStatusCache(target) {
	const db = target?.env?.db || target;
	if (!db || (typeof db !== 'object' && typeof db !== 'function')) return;
	cacheEpochByDb.set(db, (cacheEpochByDb.get(db) || 0) + 1);
	readyCacheByDb.delete(db);
	inFlightByDb.delete(db);
}

async function computeBootstrapStatus(c) {
	const bindings = {
		d1: !!c.env?.db,
		kv: !!c.env?.kv,
		assets: !!c.env?.assets
	};
	const configuration = {
		domain: hasDomainConfig(c.env?.domain),
		admin: hasText(c.env?.admin),
		initSecret: hasText(c.env?.init_secret) || hasText(c.env?.jwt_secret)
	};

	let initialized = false;
	let adminCreated = false;
	let schemaReady = false;
	if (bindings.d1) {
		try {
			const tablePlaceholders = REQUIRED_TABLES.map(() => '?').join(',');
			const indexPlaceholders = REQUIRED_INDEXES.map(() => '?').join(',');
			const [
				tableRows,
				indexRows,
				emailColumnRows,
				attachmentColumnRows,
				deliveryAttemptColumnRows,
				resendWebhookEventColumnRows,
				deliveryAttemptIndexRows,
				resendWebhookEventIndexRows
			] = await c.env.db.batch([
				c.env.db.prepare(`
					SELECT name
					FROM sqlite_master
					WHERE type = 'table' AND name IN (${tablePlaceholders})
				`).bind(...REQUIRED_TABLES),
				c.env.db.prepare(`
					SELECT name
					FROM sqlite_master
					WHERE type = 'index' AND name IN (${indexPlaceholders})
				`).bind(...REQUIRED_INDEXES),
				c.env.db.prepare('PRAGMA table_info(email)'),
				c.env.db.prepare('PRAGMA table_info(attachments)'),
				c.env.db.prepare('PRAGMA table_info(delivery_attempt)'),
				c.env.db.prepare('PRAGMA table_info(resend_webhook_event)'),
				c.env.db.prepare('PRAGMA index_list(delivery_attempt)'),
				c.env.db.prepare('PRAGMA index_list(resend_webhook_event)')
			]);
			const tableNames = new Set((tableRows.results || []).map(row => row.name));
			const indexNames = new Set((indexRows.results || []).map(row => row.name));
			const hasRequiredTables = REQUIRED_TABLES.every(name => tableNames.has(name));
			const hasRequiredIndexes = REQUIRED_INDEXES.every(name => indexNames.has(name));
			const emailColumnNames = new Set((emailColumnRows.results || []).map(row => row.name));
			const attachmentColumnNames = new Set((attachmentColumnRows.results || []).map(row => row.name));
			const deliveryAttemptColumnNames = new Set(
				(deliveryAttemptColumnRows.results || []).map(row => row.name)
			);
			const resendWebhookEventColumnNames = new Set(
				(resendWebhookEventColumnRows.results || []).map(row => row.name)
			);
			const hasRequiredColumns = REQUIRED_COLUMNS.email.every(name => emailColumnNames.has(name))
				&& REQUIRED_COLUMNS.attachments.every(name => attachmentColumnNames.has(name))
				&& REQUIRED_COLUMNS.deliveryAttempt.every(name => deliveryAttemptColumnNames.has(name))
				&& REQUIRED_COLUMNS.resendWebhookEvent.every(name => resendWebhookEventColumnNames.has(name));
			const uniqueDeliveryAttemptIndexes = new Set(
				(deliveryAttemptIndexRows.results || [])
					.filter(row => Number(row.unique) === 1)
					.map(row => row.name)
			);
			const uniqueWebhookIndexes = new Set(
				(resendWebhookEventIndexRows.results || [])
					.filter(row => Number(row.unique) === 1)
					.map(row => row.name)
			);
			const hasRequiredUniqueIndexes = REQUIRED_UNIQUE_INDEXES.deliveryAttempt
				.every(name => uniqueDeliveryAttemptIndexes.has(name))
				&& REQUIRED_UNIQUE_INDEXES.resendWebhookEvent
					.every(name => uniqueWebhookIndexes.has(name));
			schemaReady = hasRequiredTables
				&& hasRequiredIndexes
				&& hasRequiredColumns
				&& hasRequiredUniqueIndexes;

			if (schemaReady) {
				const adminEmail = configuration.admin ? c.env.admin.trim() : '';
				const bootstrapRow = await c.env.db.prepare(`
					WITH bootstrap AS (
						SELECT EXISTS(SELECT 1 FROM setting LIMIT 1) AS initialized
					)
					SELECT initialized,
						CASE WHEN initialized = 1 AND ? <> '' THEN EXISTS(
							SELECT 1
							FROM user u
							JOIN account a
							  ON a.user_id = u.user_id
							 AND a.email COLLATE NOCASE = u.email
							WHERE u.email COLLATE NOCASE = ?
							  AND u.is_del = ?
							  AND u.status = ?
							  AND a.is_del = ?
							LIMIT 1
						) ELSE 0 END AS adminCreated
					FROM bootstrap
				`).bind(
					adminEmail,
					adminEmail,
					isDel.NORMAL,
					userConst.status.NORMAL,
					isDel.NORMAL
				).first();
				initialized = Number(bootstrapRow?.initialized) === 1;
				adminCreated = Number(bootstrapRow?.adminCreated) === 1;
			}
		} catch (error) {
			console.warn(`Unable to check database initialization status: ${error.message}`);
			throw new BizError(t('serviceUnavailable'), 503);
		}
	}

	return {
		initialized,
		adminCreated,
		schemaReady,
		ready: initialized
			&& adminCreated
			&& bindings.d1
			&& bindings.kv
			&& configuration.domain
			&& configuration.admin
			&& configuration.initSecret,
		bindings,
		configuration
	};
}

export async function getBootstrapStatus(c, options = {}) {
	const db = c.env?.db;
	if (!db || (typeof db !== 'object' && typeof db !== 'function')) {
		return computeBootstrapStatus(c);
	}

	const version = options.version || BOOTSTRAP_STATUS_CHECK_VERSION;
	const now = options.now || (() => Date.now());
	const ttlMs = Number.isFinite(options.ttlMs)
		? Math.max(0, options.ttlMs)
		: BOOTSTRAP_STATUS_CACHE_TTL_MS;
	const cachePending = options.cachePending === true;
	const pendingTtlMs = Number.isFinite(options.pendingTtlMs)
		? Math.max(0, options.pendingTtlMs)
		: BOOTSTRAP_PENDING_STATUS_CACHE_TTL_MS;
	const key = cacheKeyFor(c, version);
	const epoch = cacheEpochByDb.get(db) || 0;
	const cache = readyCacheByDb.get(db);
	const cached = cache?.get(key);
	if (cached
		&& cached.version === version
		&& cached.epoch === epoch
		&& cached.expiresAt > now()) {
		return cloneStatus(cached.status);
	}
	if (cached) cache.delete(key);

	const inFlight = inFlightByDb.get(db);
	const pending = inFlight?.get(key);
	if (pending?.epoch === epoch) {
		return cloneStatus(await pending.promise);
	}

	const promise = computeBootstrapStatus(c);
	const entry = { epoch, promise };
	if (!inFlightByDb.has(db)) inFlightByDb.set(db, new Map());
	inFlightByDb.get(db).set(key, entry);
	try {
		const status = await promise;
		const cacheable = status.ready || cachePending;
		if (cacheable && (cacheEpochByDb.get(db) || 0) === epoch) {
			if (!readyCacheByDb.has(db)) readyCacheByDb.set(db, new Map());
			readyCacheByDb.get(db).set(key, {
				version,
				epoch,
				expiresAt: now() + (status.ready ? ttlMs : pendingTtlMs),
				status: cloneStatus(status)
			});
		}
		return cloneStatus(status);
	} finally {
		const current = inFlightByDb.get(db);
		if (current?.get(key) === entry) current.delete(key);
	}
}

export function createBootstrapWebsiteConfig(status) {
	return {
		initialized: status.initialized,
		adminCreated: status.adminCreated,
		ready: status.ready,
		bootstrap: status,
		register: 1,
		title: 'Cloud Mail',
		manyEmail: 1,
		addEmail: 1,
		autoRefresh: 0,
		addEmailVerify: 1,
		registerVerify: 1,
		send: 1,
		r2Domain: null,
		siteKey: null,
		background: '',
		loginOpacity: 1,
		domainList: [],
		regKey: 1,
		regVerifyOpen: false,
		addVerifyOpen: false,
		noticeTitle: '',
		noticeContent: '',
		noticeType: 'info',
		noticeDuration: 0,
		noticePosition: 'top-right',
		noticeWidth: 0,
		noticeOffset: 0,
		notice: 1,
		loginDomain: 0,
		linuxdoClientId: '',
		linuxdoCallbackUrl: '',
		linuxdoSwitch: false,
		minEmailPrefix: 1,
		projectLink: constant.DEFAULT_PROJECT_LINK
	};
}
