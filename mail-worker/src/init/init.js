import settingService from '../service/setting-service';
import emailUtils from '../utils/email-utils';
import {emailConst} from "../const/entity-const";
import secretUtils from '../utils/secret-utils';
import { EMAIL_SEARCH_BODY_LIMIT } from '../service/email-search-service';
import BizError from '../error/biz-error';
import cryptoUtils from '../utils/crypto-utils';
import { readBoundedJson } from '../utils/request-body-utils';
import { getBootstrapStatus, invalidateBootstrapStatusCache } from './status';
import { API_SCHEMA_SQL } from '../service/api-key-service';

export const INIT_SECRET_HEADER = 'X-Cloud-Mail-Init-Secret';
const ADMIN_BOOTSTRAP_JSON_MAX_BYTES = 32 * 1024;

const dbInit = {
	invalidateBootstrapStatus(c) {
		invalidateBootstrapStatusCache(c);
	},

	async init(c) {

		const secret = c.req.header(INIT_SECRET_HEADER);

		if (!await secretUtils.timingSafeEqual(secret, c.env.init_secret || c.env.jwt_secret)) {
			return c.text('Init secret mismatch', 401);
		}

		this.invalidateBootstrapStatus(c);
		await this.runMigrationSteps([
			['base-schema', () => this.intDB(c)],
			['v1.1', () => this.v1_1DB(c)],
			['v1.2', () => this.v1_2DB(c)],
			['v1.3', () => this.v1_3DB(c)],
			['v1.3.1', () => this.v1_3_1DB(c)],
			['v1.4', () => this.v1_4DB(c)],
			['v1.5', () => this.v1_5DB(c)],
			['v1.6', () => this.v1_6DB(c)],
			['v1.7', () => this.v1_7DB(c)],
			['v2.0', () => this.v2DB(c)],
			['v2.3', () => this.v2_3DB(c)],
			['v2.4', () => this.v2_4DB(c)],
			['v2.5', () => this.v2_5DB(c)],
			['v2.6', () => this.v2_6DB(c)],
			['v2.7', () => this.v2_7DB(c)],
			['v2.8', () => this.v2_8DB(c)],
			['v2.9', () => this.v2_9DB(c)],
			['v3.0', () => this.v3_0DB(c)],
			['v3.1', () => this.v3_1DB(c)],
			['v3.2', () => this.v3_2DB(c)],
			['v3.3', () => this.v3_3DB(c)],
			['v3.4', () => this.v3_4DB(c)],
			['v3.5', () => this.v3_5DB(c)],
			['v3.6', () => this.v3_6DB(c)],
			['v3.7', () => this.v3_7DB(c)],
			['v3.8', () => this.v3_8DB(c)],
			['v3.9', () => this.v3_9DB(c)],
			['settings-cache', () => settingService.refresh(c)]
		]);
		this.invalidateBootstrapStatus(c);
		await this.assertBootstrapReady(c, { requireAdmin: false });
		return c.text('success');
	},

	async runMigrationSteps(steps) {
		for (const [name, operation] of steps) {
			try {
				await operation();
			} catch (error) {
				console.error(`Database migration failed at ${name}`, error);
				if (error?.name === 'BizError') {
					throw new BizError(
						`Database migration failed at ${name}: ${error.message}`,
						error.code
					);
				}
				throw new BizError(`Database migration failed at ${name}`, 500);
			}
		}
	},

	async assertBootstrapReady(c, { requireAdmin = true } = {}) {
		const status = await getBootstrapStatus(c);
		const ready = requireAdmin
			? status.ready
			: status.initialized && status.schemaReady;
		if (!ready) {
			throw new BizError('Database migration failed at bootstrap-health', 503);
		}
		return status;
	},

	async createAdmin(c, params) {
		const secret = c.req.header(INIT_SECRET_HEADER);
		if (!await secretUtils.timingSafeEqual(secret, c.env.init_secret || c.env.jwt_secret)) {
			return c.text('Init secret mismatch', 401);
		}
		if (params === undefined) {
			params = await readBoundedJson(
				c,
				ADMIN_BOOTSTRAP_JSON_MAX_BYTES,
				'administrator bootstrap JSON body exceeds 32 KiB'
			);
		}
		if (!params || typeof params !== 'object' || Array.isArray(params)) {
			throw new BizError('Invalid administrator bootstrap request', 400);
		}

		const password = params?.password;
		if (typeof password !== 'string' || password.length < 6 || password.length > 30) {
			throw new BizError('Administrator password must contain between 6 and 30 characters', 400);
		}

		const adminEmail = typeof c.env.admin === 'string' ? c.env.admin.trim() : '';
		if (!emailUtils.getName(adminEmail) || !emailUtils.getDomain(adminEmail)) {
			throw new BizError('Administrator email is not configured correctly', 400);
		}

		const existingAdmin = await c.env.db.prepare(`
			SELECT user_id
			FROM user
			WHERE email COLLATE NOCASE = ?
			LIMIT 1
		`).bind(adminEmail).first();
		if (existingAdmin) {
			throw new BizError('Administrator account already exists', 409);
		}

		const defaultRole = await c.env.db.prepare(`
			SELECT role_id AS roleId
			FROM role
			WHERE is_default = 1
			ORDER BY role_id
			LIMIT 1
		`).first();
		if (!defaultRole) {
			throw new BizError('Default role is not initialized', 409);
		}

		const { salt, hash } = await cryptoUtils.hashPassword(password);
		const [userInsertResult, accountInsertResult] = await c.env.db.batch([
			c.env.db.prepare(`
				INSERT INTO user (email, type, password, salt)
				SELECT ?, ?, ?, ?
				WHERE NOT EXISTS (
					SELECT 1
					FROM user
					WHERE email COLLATE NOCASE = ?
				)
				  AND NOT EXISTS (
					SELECT 1
					FROM account
					WHERE email COLLATE NOCASE = ?
				  )
			`).bind(adminEmail, defaultRole.roleId, hash, salt, adminEmail, adminEmail),
			c.env.db.prepare(`
				INSERT INTO account (email, name, user_id)
				SELECT ?, ?, user_id
				FROM user
				WHERE email COLLATE NOCASE = ?
				  AND password = ?
				  AND salt = ?
				  AND NOT EXISTS (
					SELECT 1
					FROM account
					WHERE email COLLATE NOCASE = ?
				  )
				ORDER BY user_id DESC
				LIMIT 1
			`).bind(adminEmail, emailUtils.getName(adminEmail), adminEmail, hash, salt, adminEmail)
		]);
		if (Number(userInsertResult?.meta?.changes || 0) !== 1
			|| Number(accountInsertResult?.meta?.changes || 0) !== 1) {
			throw new BizError('Administrator account already exists', 409);
		}

		this.invalidateBootstrapStatus(c);
		return c.text('success');
	},

	async v3_1DB(c) {
		const queryList = [
			`CREATE INDEX IF NOT EXISTS idx_attachments_key ON attachments(key);`,
			`CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);`,
			`CREATE INDEX IF NOT EXISTS idx_attachments_account ON attachments(account_id);`,
			`CREATE INDEX IF NOT EXISTS idx_account_user_del ON account(user_id, is_del);`,
			`CREATE INDEX IF NOT EXISTS idx_email_resend_email_id ON email(resend_email_id);`,
			`CREATE INDEX IF NOT EXISTS idx_email_account ON email(account_id);`,
			`CREATE INDEX IF NOT EXISTS idx_star_email ON star(email_id);`,
			`CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth(user_id);`,
			`CREATE INDEX IF NOT EXISTS idx_email_type_create_time ON email(type, create_time);`,
			`CREATE INDEX IF NOT EXISTS idx_user_create_time ON user(create_time);`,
			`DROP INDEX IF EXISTS idx_email_user_id_account_id;`
		];

		await this.runOptionalSqlList(c, queryList);
	},

	async v3_2DB(c) {
		await c.env.db.prepare(`
			CREATE TABLE IF NOT EXISTS public_send_rate_limit (
				window_hour INTEGER PRIMARY KEY,
				count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
			)
		`).run();
	},

	async v3_3DB(c) {
		await c.env.db.prepare(`
			CREATE TABLE IF NOT EXISTS auth_failure_limit (
				scope TEXT NOT NULL,
				identity_hash TEXT NOT NULL,
				fail_count INTEGER NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
				in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight >= 0),
				window_started_at INTEGER NOT NULL,
				in_flight_started_at INTEGER NOT NULL DEFAULT 0,
				reservation_generation TEXT NOT NULL DEFAULT '',
				lock_until INTEGER NOT NULL DEFAULT 0,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (scope, identity_hash)
			)
		`).run();
		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_auth_failure_limit_updated_at
			ON auth_failure_limit (updated_at)
		`).run();
	},

	async v3_4DB(c) {
		await c.env.db.prepare(`
			CREATE TABLE IF NOT EXISTS oauth_auth_state (
				state_hash TEXT PRIMARY KEY,
				code_verifier TEXT NOT NULL,
				initiator_hash TEXT NOT NULL DEFAULT '',
				consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
				expires_at INTEGER NOT NULL
			)
		`).run();
		const oauthStateColumns = await c.env.db.prepare(`
			PRAGMA table_info(oauth_auth_state)
		`).all();
		const oauthStateColumnNames = new Set(
			(oauthStateColumns.results || []).map(row => row.name)
		);
		if (!oauthStateColumnNames.has('initiator_hash')) {
			await c.env.db.prepare(`
				ALTER TABLE oauth_auth_state
				ADD COLUMN initiator_hash TEXT NOT NULL DEFAULT ''
			`).run();
		}
		if (!oauthStateColumnNames.has('consumed')) {
			await c.env.db.prepare(`
				ALTER TABLE oauth_auth_state
				ADD COLUMN consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
			`).run();
		}
		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_oauth_auth_state_expires_at
			ON oauth_auth_state (expires_at)
		`).run();
		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_oauth_auth_state_initiator_expires_at
			ON oauth_auth_state (initiator_hash, expires_at)
		`).run();
		await c.env.db.prepare(`
			CREATE TABLE IF NOT EXISTS oauth_bind_challenge (
				oauth_user_id TEXT PRIMARY KEY,
				token_hash TEXT NOT NULL UNIQUE,
				expires_at INTEGER NOT NULL
			)
		`).run();
		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_oauth_bind_challenge_expires_at
			ON oauth_bind_challenge (expires_at)
		`).run();

		const duplicateOauthIdentity = await c.env.db.prepare(`
			SELECT 1
			FROM oauth
			WHERE oauth_user_id IS NOT NULL
			GROUP BY platform, oauth_user_id
			HAVING COUNT(*) > 1
			LIMIT 1
		`).first();
		if (duplicateOauthIdentity) {
			throw new BizError('Duplicate OAuth identities must be repaired before enabling secure OAuth', 409);
		}
		await c.env.db.prepare(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_platform_user_unique
			ON oauth (platform, oauth_user_id)
		`).run();
	},

	async v3_5DB(c) {
		const emailColumns = await c.env.db.prepare('PRAGMA table_info(email)').all();
		const emailColumnNames = new Set((emailColumns.results || []).map(row => row.name));
		if (!emailColumnNames.has('attachment_count')) {
			await c.env.db.prepare(`
				ALTER TABLE email ADD COLUMN attachment_count INTEGER
			`).run();
		}
		if (!emailColumnNames.has('recovery_after')) {
			await c.env.db.prepare(`
				ALTER TABLE email ADD COLUMN recovery_after DATETIME
			`).run();
		}

		const attachmentColumns = await c.env.db.prepare('PRAGMA table_info(attachments)').all();
		const attachmentColumnNames = new Set((attachmentColumns.results || []).map(row => row.name));
		if (!attachmentColumnNames.has('message')) {
			await c.env.db.prepare(`
				ALTER TABLE attachments ADD COLUMN message TEXT
			`).run();
		}

		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_email_receive_recovery
			ON email(type, status, create_time, email_id)
		`).run();
		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_email_receive_recovery_due
			ON email(type, status, recovery_after, create_time, email_id)
		`).run();
		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_attachments_email_status_key
			ON attachments(email_id, status, key)
		`).run();
	},

	async v3_6DB(c) {
		await c.env.db.prepare(`
			CREATE TABLE IF NOT EXISTS delivery_attempt (
				attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
				email_id INTEGER NOT NULL,
				provider TEXT NOT NULL,
				attempt_key TEXT NOT NULL,
				status TEXT NOT NULL,
				provider_message_id TEXT,
				error_summary TEXT,
				create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`).run();
		const deliveryAttemptColumns = await c.env.db.prepare(`
			PRAGMA table_info(delivery_attempt)
		`).all();
		const deliveryAttemptColumnNames = new Set(
			(deliveryAttemptColumns.results || []).map(row => row.name)
		);
		if (!deliveryAttemptColumnNames.has('attempt_id')) {
			throw new BizError('Delivery attempt table is missing its primary key', 409);
		}
		const deliveryAttemptColumnAdditions = [
			['email_id', 'email_id INTEGER NOT NULL DEFAULT 0'],
			['provider', "provider TEXT NOT NULL DEFAULT ''"],
			['attempt_key', 'attempt_key TEXT'],
			['status', "status TEXT NOT NULL DEFAULT 'UNKNOWN'"],
			['provider_message_id', 'provider_message_id TEXT'],
			['error_summary', 'error_summary TEXT'],
			['create_time', 'create_time DATETIME'],
			['update_time', 'update_time DATETIME']
		];
		for (const [name, definition] of deliveryAttemptColumnAdditions) {
			if (!deliveryAttemptColumnNames.has(name)) {
				await c.env.db.prepare(`
					ALTER TABLE delivery_attempt ADD COLUMN ${definition}
				`).run();
			}
		}
		await c.env.db.prepare(`
			UPDATE delivery_attempt
			SET attempt_key = 'legacy/' || attempt_id
			WHERE attempt_key IS NULL OR attempt_key = ''
		`).run();
		await c.env.db.prepare(`
			UPDATE delivery_attempt
			SET create_time = COALESCE(create_time, CURRENT_TIMESTAMP),
				update_time = COALESCE(update_time, CURRENT_TIMESTAMP)
			WHERE create_time IS NULL OR update_time IS NULL
		`).run();
		const duplicateIdentity = await c.env.db.prepare(`
			SELECT duplicate_type AS duplicateType
			FROM (
				SELECT 'attempt_key' AS duplicate_type
				FROM delivery_attempt
				WHERE attempt_key IS NOT NULL AND attempt_key <> ''
				GROUP BY attempt_key
				HAVING COUNT(*) > 1
				UNION ALL
				SELECT 'email_id' AS duplicate_type
				FROM delivery_attempt
				GROUP BY email_id
				HAVING COUNT(*) > 1
				UNION ALL
				SELECT 'provider_message_id' AS duplicate_type
				FROM delivery_attempt
				WHERE provider_message_id IS NOT NULL AND provider_message_id <> ''
				GROUP BY provider, provider_message_id
				HAVING COUNT(*) > 1
			)
			LIMIT 1
		`).first();
		if (duplicateIdentity) {
			throw new BizError(
				`Delivery attempt ${duplicateIdentity.duplicateType} duplicates require manual review`,
				409
			);
		}
		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_delivery_attempt_status_time
			ON delivery_attempt(status, update_time, attempt_id)
		`).run();
		const deliveryAttemptIndexes = await c.env.db.prepare(`
			PRAGMA index_list(delivery_attempt)
		`).all();
		const deliveryAttemptKeyIndex = (deliveryAttemptIndexes.results || [])
			.find(row => row.name === 'idx_delivery_attempt_key');
		const deliveryAttemptEmailIndex = (deliveryAttemptIndexes.results || [])
			.find(row => row.name === 'idx_delivery_attempt_email');
		const deliveryAttemptProviderMessageIndex = (deliveryAttemptIndexes.results || [])
			.find(row => row.name === 'idx_delivery_attempt_provider_message');
		if (deliveryAttemptKeyIndex && Number(deliveryAttemptKeyIndex.unique) !== 1) {
			await c.env.db.prepare(`
				DROP INDEX idx_delivery_attempt_key
			`).run();
		}
		if (deliveryAttemptEmailIndex && Number(deliveryAttemptEmailIndex.unique) !== 1) {
			await c.env.db.prepare(`
				DROP INDEX idx_delivery_attempt_email
			`).run();
		}
		if (deliveryAttemptProviderMessageIndex
			&& Number(deliveryAttemptProviderMessageIndex.unique) !== 1) {
			await c.env.db.prepare(`
				DROP INDEX idx_delivery_attempt_provider_message
			`).run();
		}
		await c.env.db.prepare(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_attempt_key
			ON delivery_attempt(attempt_key)
		`).run();
		await c.env.db.prepare(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_attempt_email
			ON delivery_attempt(email_id)
		`).run();
		await c.env.db.prepare(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_attempt_provider_message
			ON delivery_attempt(provider, provider_message_id)
			WHERE provider_message_id IS NOT NULL AND provider_message_id <> ''
		`).run();
	},

	async v3_7DB(c) {
		await c.env.db.prepare(`
			CREATE TABLE IF NOT EXISTS resend_webhook_event (
				event_key TEXT PRIMARY KEY,
				svix_id TEXT,
				body_sha256 TEXT NOT NULL,
				event_type TEXT NOT NULL,
				provider_email_id TEXT,
				status TEXT NOT NULL DEFAULT 'PROCESSING',
				outcome TEXT,
				received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				processed_at DATETIME
			)
		`).run();
		const webhookColumns = await c.env.db.prepare(`
			PRAGMA table_info(resend_webhook_event)
		`).all();
		const webhookColumnNames = new Set(
			(webhookColumns.results || []).map(row => row.name)
		);
		if (!webhookColumnNames.has('event_key')) {
			throw new BizError('Webhook event table is missing its primary key', 409);
		}
		const webhookColumnAdditions = [
			['svix_id', 'svix_id TEXT'],
			['body_sha256', "body_sha256 TEXT NOT NULL DEFAULT ''"],
			['event_type', "event_type TEXT NOT NULL DEFAULT ''"],
			['provider_email_id', 'provider_email_id TEXT'],
			['status', "status TEXT NOT NULL DEFAULT 'PROCESSING'"],
			['outcome', 'outcome TEXT'],
			['received_at', 'received_at DATETIME'],
			['processed_at', 'processed_at DATETIME']
		];
		for (const [name, definition] of webhookColumnAdditions) {
			if (!webhookColumnNames.has(name)) {
				await c.env.db.prepare(`
					ALTER TABLE resend_webhook_event ADD COLUMN ${definition}
				`).run();
			}
		}
		await c.env.db.prepare(`
			UPDATE resend_webhook_event
			SET received_at = CURRENT_TIMESTAMP
			WHERE received_at IS NULL
		`).run();
		const webhookIndexes = await c.env.db.prepare(`
			PRAGMA index_list(resend_webhook_event)
		`).all();
		const webhookEventKeyIndex = (webhookIndexes.results || [])
			.find(row => row.name === 'idx_resend_webhook_event_key');
		if (webhookEventKeyIndex && Number(webhookEventKeyIndex.unique) !== 1) {
			await c.env.db.prepare(`
				DROP INDEX idx_resend_webhook_event_key
			`).run();
		}
		await c.env.db.prepare(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_resend_webhook_event_key
			ON resend_webhook_event(event_key)
		`).run();
		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_resend_webhook_event_status_time
			ON resend_webhook_event(status, received_at, event_key)
		`).run();
		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_resend_webhook_event_provider_email
			ON resend_webhook_event(provider_email_id, received_at)
		`).run();
	},

	async v3_8DB(c) {
		await c.env.db.prepare(`
			CREATE INDEX IF NOT EXISTS idx_verify_record_ip_type
			ON verify_record(ip, type)
		`).run();
	},

	// API 密钥相关表只服务可选的自动化接口，不进入启动就绪检查；服务首次使用时也会幂等补建
	async v3_9DB(c) {
		await c.env.db.batch(API_SCHEMA_SQL.map(sql => c.env.db.prepare(sql)));
	},

	async v3_0DB(c) {
		const queryList = [
			`ALTER TABLE email ADD COLUMN code TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN ai_code INTEGER NOT NULL DEFAULT 1;`,
			`ALTER TABLE setting ADD COLUMN ai_code_filter TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN black_subject TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN black_content TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN black_from TEXT NOT NULL DEFAULT '';`,
			`CREATE INDEX IF NOT EXISTS idx_email_user_account_type_del_id ON email(user_id, account_id, type, is_del, email_id);`,
			`CREATE INDEX IF NOT EXISTS idx_email_user_type_del_id ON email(user_id, type, is_del, email_id);`,
			`CREATE INDEX IF NOT EXISTS idx_email_type_status_id ON email(type, status, email_id);`,
			`CREATE INDEX IF NOT EXISTS idx_attachments_email_type ON attachments(email_id, type);`,
			`CREATE INDEX IF NOT EXISTS idx_star_user_email ON star(user_id, email_id);`,
			`CREATE INDEX IF NOT EXISTS idx_email_user_code_id ON email(user_id, code, email_id);`,
			`CREATE INDEX IF NOT EXISTS idx_email_code_id ON email(code, email_id);`,
			`CREATE TABLE IF NOT EXISTS email_search (
				email_id INTEGER PRIMARY KEY,
				user_id INTEGER NOT NULL DEFAULT 0,
				account_id INTEGER NOT NULL DEFAULT 0,
				name TEXT NOT NULL DEFAULT '',
				subject TEXT NOT NULL DEFAULT '',
				send_email TEXT NOT NULL DEFAULT '',
				to_email TEXT NOT NULL DEFAULT '',
				user_email TEXT NOT NULL DEFAULT '',
				search_text TEXT NOT NULL DEFAULT '',
				type INTEGER NOT NULL DEFAULT 0,
				status INTEGER NOT NULL DEFAULT 0,
				is_del INTEGER NOT NULL DEFAULT 0,
				create_time DATETIME DEFAULT CURRENT_TIMESTAMP
			);`,
			`CREATE INDEX IF NOT EXISTS idx_email_search_type_status_id ON email_search(type, status, email_id);`,
			`CREATE INDEX IF NOT EXISTS idx_email_search_del_id ON email_search(is_del, email_id);`,
			`CREATE INDEX IF NOT EXISTS idx_email_search_user_id ON email_search(user_id, email_id);`,
			`INSERT OR REPLACE INTO email_search (
				email_id, user_id, account_id, name, subject, send_email, to_email, user_email,
				search_text, type, status, is_del, create_time
			)
			SELECT
				e.email_id,
				e.user_id,
				e.account_id,
				COALESCE(e.name, ''),
				COALESCE(e.subject, ''),
				COALESCE(e.send_email, ''),
				COALESCE(e.to_email, ''),
				COALESCE(u.email, ''),
				LOWER(
					COALESCE(e.name, '') || ' ' ||
					COALESCE(e.subject, '') || ' ' ||
					COALESCE(e.send_email, '') || ' ' ||
					COALESCE(e.to_email, '') || ' ' ||
					COALESCE(u.email, '') || ' ' ||
					SUBSTR(COALESCE(e.text, ''), 1, ${EMAIL_SEARCH_BODY_LIMIT})
				),
				e.type,
				e.status,
				e.is_del,
				e.create_time
			FROM email e
			LEFT JOIN user u ON u.user_id = e.user_id;`,
			`INSERT INTO perm (name, perm_key, pid, type, sort)
			SELECT 'Maintenance Query', 'maintenance:query', 17, 2, 2
			WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_key = 'maintenance:query');`,
			`INSERT INTO perm (name, perm_key, pid, type, sort)
			SELECT 'Maintenance Repair', 'maintenance:repair', 17, 2, 3
			WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_key = 'maintenance:repair');`
		];

		await this.runOptionalSqlList(c, queryList);

	},

	async runOptionalSqlList(c, queryList) {
		for (const query of queryList) {
			try {
				await c.env.db.prepare(query).run();
			} catch (e) {
				if (!isIdempotentMigrationError(e)) {
					throw e;
				}
				console.warn(`Skip idempotent migration SQL: ${e.message}`);
			}
		}
	},

	async v2_9DB(c) {
		await c.env.db.prepare(`UPDATE setting SET auto_refresh = 5 WHERE auto_refresh = 1;`).run();
	},

	async v2_8DB(c) {
		await this.runOptionalSqlList(c, [
			`ALTER TABLE account ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;`
		]);
	},

	async v2_7DB(c) {
		const columns = await c.env.db.prepare(`PRAGMA table_info(setting)`).all();
		const names = new Set((columns.results || []).map(row => row.name));
		if (names.has('auto_refresh')) {
			return;
		}
		if (!names.has('auto_refresh_time')) {
			throw new Error('setting auto refresh column is missing');
		}
		await c.env.db.prepare(
			`ALTER TABLE setting RENAME COLUMN auto_refresh_time TO auto_refresh;`
		).run();
	},

	async v2_6DB(c) {
		await this.runOptionalSqlList(c, [
			`ALTER TABLE account ADD COLUMN all_receive INTEGER NOT NULL DEFAULT 0;`
		]);
	},

	async v2_5DB(c) {
		await this.runOptionalSqlList(c, [
			`ALTER TABLE setting ADD COLUMN email_prefix_filter text NOT NULL DEFAULT '';`
		]);

		const emailColumns = await c.env.db.prepare('PRAGMA table_info(email)').all();
		const emailColumnNames = new Set((emailColumns.results || []).map(row => row.name));
		if (emailColumnNames.has('unread')) {
			return;
		}

		try {
			await c.env.db.batch([
				c.env.db.prepare(`
					ALTER TABLE email ADD COLUMN unread INTEGER NOT NULL DEFAULT 0
				`),
				c.env.db.prepare('UPDATE email SET unread = 1;')
			]);
		} catch (error) {
			if (!isIdempotentMigrationError(error)) {
				throw error;
			}
			console.warn(`Skip idempotent migration SQL: ${error.message}`);
		}
	},

	async v2_4DB(c) {
		await c.env.db.prepare(`
				CREATE TABLE IF NOT EXISTS oauth (
					oauth_id INTEGER PRIMARY KEY AUTOINCREMENT,
					oauth_user_id TEXT,
					username TEXT,
					name TEXT,
					avatar TEXT,
					active INTEGER,
					trust_level INTEGER,
					silenced INTEGER,
					create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
					platform INTEGER NOT NULL DEFAULT 0,
					user_id INTEGER NOT NULL DEFAULT 0
				)
			`).run();

		await this.runOptionalSqlList(c, [
			`ALTER TABLE setting ADD COLUMN min_email_prefix INTEGER NOT NULL DEFAULT 1;`
		]);

	},

	async v2_3DB(c) {
		await this.runOptionalSqlList(c, [
			`ALTER TABLE setting ADD COLUMN force_path_style INTEGER NOT NULL DEFAULT 1;`,
			`ALTER TABLE setting ADD COLUMN custom_domain TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN tg_msg_to TEXT NOT NULL DEFAULT 'show';`,
			`ALTER TABLE setting ADD COLUMN tg_msg_from TEXT NOT NULL DEFAULT 'only-name';`,
			`ALTER TABLE setting ADD COLUMN tg_msg_text TEXT NOT NULL DEFAULT 'show';`
		]);
	},

	async v2DB(c) {
		await this.runOptionalSqlList(c, [
			`ALTER TABLE setting ADD COLUMN bucket TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN region TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN endpoint TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN s3_access_key TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN s3_secret_key TEXT NOT NULL DEFAULT '';`,
			`DELETE FROM perm WHERE perm_key = 'setting:clean'`
		]);
	},

	async v1_7DB(c) {
		await this.runOptionalSqlList(c, [
			`ALTER TABLE setting ADD COLUMN login_domain INTEGER NOT NULL DEFAULT 0;`
		]);
	},

	async v1_6DB(c) {

		const noticeContent = '本项目仅供学习交流，禁止用于违法业务\n' +
			'<br>\n' +
			'请遵守当地法规，作者不承担任何法律责任'

		const ADD_COLUMN_SQL_LIST = [
			`ALTER TABLE setting ADD COLUMN reg_verify_count INTEGER NOT NULL DEFAULT 1;`,
			`ALTER TABLE setting ADD COLUMN add_verify_count INTEGER NOT NULL DEFAULT 1;`,
			`CREATE TABLE IF NOT EXISTS verify_record (
				vr_id INTEGER PRIMARY KEY AUTOINCREMENT,
				ip TEXT NOT NULL DEFAULT '',
				count INTEGER NOT NULL DEFAULT 1,
				type INTEGER NOT NULL DEFAULT 0,
				update_time DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
			`ALTER TABLE setting ADD COLUMN notice_title TEXT NOT NULL DEFAULT 'Cloud Mail';`,
			`ALTER TABLE setting ADD COLUMN notice_content TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN notice_type TEXT NOT NULL DEFAULT 'none';`,
			`ALTER TABLE setting ADD COLUMN notice_duration INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE setting ADD COLUMN notice_offset INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE setting ADD COLUMN notice_position TEXT NOT NULL DEFAULT 'top-right';`,
			`ALTER TABLE setting ADD COLUMN notice_width INTEGER NOT NULL DEFAULT 340;`,
			`ALTER TABLE setting ADD COLUMN notice INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE setting ADD COLUMN no_recipient INTEGER NOT NULL DEFAULT 1;`,
			`UPDATE role SET avail_domain = '' WHERE role.avail_domain LIKE '@%';`,
			`CREATE INDEX IF NOT EXISTS idx_email_user_id_account_id ON email(user_id, account_id);`
		];

		await this.runOptionalSqlList(c, ADD_COLUMN_SQL_LIST);
		await c.env.db.prepare(`UPDATE setting SET notice_content = ? WHERE notice_content = '';`).bind(noticeContent).run();
		await c.env.db.batch([
			c.env.db.prepare(`DROP INDEX IF EXISTS idx_account_email`),
			c.env.db.prepare(`DROP INDEX IF EXISTS idx_user_email`),
			c.env.db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_nocase ON account (email COLLATE NOCASE)`),
			c.env.db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_nocase ON user (email COLLATE NOCASE)`)
		]);

	},

	async v1_5DB(c) {
		await c.env.db.prepare(`UPDATE perm SET perm_key = 'all-email:query' WHERE perm_key = 'sys-email:query'`).run();
		await c.env.db.prepare(`UPDATE perm SET perm_key = 'all-email:delete' WHERE perm_key = 'sys-email:delete'`).run();
		await this.runOptionalSqlList(c, [
			`ALTER TABLE role ADD COLUMN avail_domain TEXT NOT NULL DEFAULT ''`
		]);
	},

	async v1_4DB(c) {
		await c.env.db.prepare(`
      CREATE TABLE IF NOT EXISTS reg_key (
				rege_key_id INTEGER PRIMARY KEY AUTOINCREMENT,
				code TEXT NOT NULL COLLATE NOCASE DEFAULT '',
				count INTEGER NOT NULL DEFAULT 0,
				role_id INTEGER NOT NULL DEFAULT 0,
				user_id INTEGER NOT NULL DEFAULT 0,
				expire_time DATETIME,
				create_time DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

		// 添加不区分大小写的唯一索引；重复业务数据必须显式失败，不能跳过。
		await c.env.db.prepare(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_setting_code ON reg_key(code COLLATE NOCASE)
		`).run();

		await c.env.db.prepare(`
        INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) VALUES
        (33,'注册密钥', NULL, 0, 1, 5.1),
        (34,'密钥查看', 'reg-key:query', 33, 2, 0),
        (35,'密钥添加', 'reg-key:add', 33, 2, 1),
        (36,'密钥删除', 'reg-key:delete', 33, 2, 2)
		ON CONFLICT(perm_id) DO UPDATE SET
			name = excluded.name,
			perm_key = excluded.perm_key,
			pid = excluded.pid,
			type = excluded.type,
			sort = excluded.sort`).run();

		const ADD_COLUMN_SQL_LIST = [
			`ALTER TABLE setting ADD COLUMN reg_key INTEGER NOT NULL DEFAULT 1;`,
			`ALTER TABLE role ADD COLUMN ban_email TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE role ADD COLUMN ban_email_type INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE user ADD COLUMN reg_key_id INTEGER NOT NULL DEFAULT 0;`
		];

		await this.runOptionalSqlList(c, ADD_COLUMN_SQL_LIST);

	},

	async v1_3_1DB(c) {
		await c.env.db.prepare(`UPDATE email SET name = SUBSTR(send_email, 1, INSTR(send_email, '@') - 1) WHERE (name IS NULL OR name = '') AND type = ${emailConst.type.RECEIVE}`).run();
	},

	async v1_3DB(c) {

		const ADD_COLUMN_SQL_LIST = [
			`ALTER TABLE setting ADD COLUMN tg_bot_token TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN tg_chat_id TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN tg_bot_status INTEGER NOT NULL DEFAULT 1;`,
			`ALTER TABLE setting ADD COLUMN forward_email TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN forward_status INTEGER TIME NOT NULL DEFAULT 1;`,
			`ALTER TABLE setting ADD COLUMN rule_email TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE setting ADD COLUMN rule_type INTEGER NOT NULL DEFAULT 0;`
		];

		await this.runOptionalSqlList(c, ADD_COLUMN_SQL_LIST);

		const nameColumn = await c.env.db.prepare(`SELECT * FROM pragma_table_info('email') WHERE name = 'to_email' limit 1`).first();

		if (nameColumn) {
			return
		}

		const queryList = []

		queryList.push(c.env.db.prepare(`ALTER TABLE email ADD COLUMN to_email TEXT NOT NULL DEFAULT ''`));
		queryList.push(c.env.db.prepare(`ALTER TABLE email ADD COLUMN to_name TEXT NOT NULL DEFAULT ''`));
		queryList.push(c.env.db.prepare(`UPDATE email SET to_email = json_extract(recipient, '$[0].address'), to_name = json_extract(recipient, '$[0].name')`));

		await c.env.db.batch(queryList);

	},

	async v1_2DB(c){

		const ADD_COLUMN_SQL_LIST = [
			`ALTER TABLE email ADD COLUMN recipient TEXT NOT NULL DEFAULT '[]';`,
			`ALTER TABLE email ADD COLUMN cc TEXT NOT NULL DEFAULT '[]';`,
			`ALTER TABLE email ADD COLUMN bcc TEXT NOT NULL DEFAULT '[]';`,
			`ALTER TABLE email ADD COLUMN message_id TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN in_reply_to TEXT NOT NULL DEFAULT '';`,
			`ALTER TABLE email ADD COLUMN relation TEXT NOT NULL DEFAULT '';`
		];

		await this.runOptionalSqlList(c, ADD_COLUMN_SQL_LIST);

		await this.receiveEmailToRecipient(c);
		await this.initAccountName(c);

		await c.env.db.prepare(`
        INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) VALUES
        (31,'分析页', NULL, 0, 1, 2.1),
        (32,'数据查看', 'analysis:query', 31, 2, 1)
		ON CONFLICT(perm_id) DO UPDATE SET
			name = excluded.name,
			perm_key = excluded.perm_key,
			pid = excluded.pid,
			type = excluded.type,
			sort = excluded.sort`).run();

	},

	async v1_1DB(c) {
		// 添加字段
		const ADD_COLUMN_SQL_LIST = [
			`ALTER TABLE email ADD COLUMN type INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE email ADD COLUMN status INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE email ADD COLUMN resend_email_id TEXT;`,
			`ALTER TABLE email ADD COLUMN message TEXT;`,

			`ALTER TABLE setting ADD COLUMN resend_tokens TEXT NOT NULL DEFAULT '{}';`,
			`ALTER TABLE setting ADD COLUMN send INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE setting ADD COLUMN r2_domain TEXT;`,
			`ALTER TABLE setting ADD COLUMN site_key TEXT;`,
			`ALTER TABLE setting ADD COLUMN secret_key TEXT;`,
			`ALTER TABLE setting ADD COLUMN background TEXT;`,
			`ALTER TABLE setting ADD COLUMN login_opacity INTEGER NOT NULL DEFAULT 0.90;`,

			`ALTER TABLE user ADD COLUMN create_ip TEXT;`,
			`ALTER TABLE user ADD COLUMN active_ip TEXT;`,
			`ALTER TABLE user ADD COLUMN os TEXT;`,
			`ALTER TABLE user ADD COLUMN browser TEXT;`,
			`ALTER TABLE user ADD COLUMN device TEXT;`,
			`ALTER TABLE user ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE user ADD COLUMN send_count INTEGER NOT NULL DEFAULT 0;`,

			`ALTER TABLE attachments ADD COLUMN status INTEGER NOT NULL DEFAULT 0;`,
			`ALTER TABLE attachments ADD COLUMN type INTEGER NOT NULL DEFAULT 0;`
		];

		await this.runOptionalSqlList(c, ADD_COLUMN_SQL_LIST);

		// 创建 perm 表并初始化
		await c.env.db.prepare(`
      CREATE TABLE IF NOT EXISTS perm (
        perm_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        perm_key TEXT,
        pid INTEGER NOT NULL DEFAULT 0,
        type INTEGER NOT NULL DEFAULT 2,
        sort INTEGER
      )
    `).run();

		const {permTotal} = await c.env.db.prepare(`SELECT COUNT(*) as permTotal FROM perm`).first();

		if (permTotal === 0) {
			await c.env.db.prepare(`
        INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) VALUES
        (1, '邮件', NULL, 0, 0, 0),
        (2, '邮件删除', 'email:delete', 1, 2, 1),
        (3, '邮件发送', 'email:send', 1, 2, 0),
        (4, '个人设置', '', 0, 1, 2),
        (5, '用户注销', 'my:delete', 4, 2, 0),
        (6, '用户信息', NULL, 0, 1, 3),
        (7, '用户查看', 'user:query', 6, 2, 0),
        (8, '密码修改', 'user:set-pwd', 6, 2, 2),
        (9, '状态修改', 'user:set-status', 6, 2, 3),
        (10, '权限修改', 'user:set-type', 6, 2, 4),
        (11, '用户删除', 'user:delete', 6, 2, 7),
        (12, '用户收藏', 'user:star', 6, 2, 5),
        (13, '权限控制', '', 0, 1, 5),
        (14, '身份查看', 'role:query', 13, 2, 0),
        (15, '身份修改', 'role:set', 13, 2, 1),
        (16, '身份删除', 'role:delete', 13, 2, 2),
        (17, '系统设置', '', 0, 1, 6),
        (18, '设置查看', 'setting:query', 17, 2, 0),
        (19, '设置修改', 'setting:set', 17, 2, 1),
        (21, '邮箱侧栏', '', 0, 0, 1),
        (22, '邮箱查看', 'account:query', 21, 2, 0),
        (23, '邮箱添加', 'account:add', 21, 2, 1),
        (24, '邮箱删除', 'account:delete', 21, 2, 2),
        (25, '用户添加', 'user:add', 6, 2, 1),
        (26, '发件重置', 'user:reset-send', 6, 2, 6),
        (27, '邮件列表', '', 0, 1, 4),
        (28, '邮件查看', 'all-email:query', 27, 2, 0),
        (29, '邮件删除', 'all-email:delete', 27, 2, 0),
				(30, '身份添加', 'role:add', 13, 2, -1)
      `).run();
		}

		await c.env.db.prepare(`UPDATE perm SET perm_key = 'setting:clean' WHERE perm_key = 'seting:clear'`).run();
		await c.env.db.prepare(`DELETE FROM perm WHERE perm_key = 'user:star'`).run();
		// 创建 role 表并插入默认身份
		await c.env.db.prepare(`
      CREATE TABLE IF NOT EXISTS role (
        role_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key TEXT,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        sort INTEGER DEFAULT 0,
        description TEXT,
        user_id INTEGER,
        is_default INTEGER DEFAULT 0,
        send_count INTEGER,
        send_type TEXT NOT NULL DEFAULT 'count',
        account_count INTEGER
      )
    `).run();

		const { roleCount } = await c.env.db.prepare(`SELECT COUNT(*) as roleCount FROM role`).first();
		if (roleCount === 0) {
			await c.env.db.prepare(`
        INSERT INTO role (
          role_id, name, key, create_time, sort, description, user_id, is_default, send_count, send_type, account_count
        ) VALUES (
          1, '普通用户', NULL, '0000-00-00 00:00:00', 0, '只有普通使用权限', 0, 1, NULL, 'ban', 10
        )
      `).run();
		}

		// 创建 role_perm 表并初始化数据
		await c.env.db.prepare(`
      CREATE TABLE IF NOT EXISTS role_perm (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_id INTEGER,
        perm_id INTEGER
      )
    `).run();

		const {rolePermCount} = await c.env.db.prepare(`SELECT COUNT(*) as rolePermCount FROM role_perm`).first();
		if (rolePermCount === 0) {
			await c.env.db.prepare(`
        INSERT INTO role_perm (id, role_id, perm_id) VALUES
          (100, 1, 2),
          (101, 1, 21),
          (102, 1, 22),
          (103, 1, 23),
          (104, 1, 24),
          (105, 1, 4),
          (106, 1, 5),
          (107, 1, 1),
          (108, 1, 3)
      `).run();
		}
	},

	async intDB(c) {
		// 初始化数据库表结构
		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS email (
			email_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			send_email TEXT,
			name TEXT,
			account_id INTEGER NOT NULL,
			user_id INTEGER NOT NULL,
			subject TEXT,
			content TEXT,
			text TEXT,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
			is_del INTEGER DEFAULT 0 NOT NULL
		  )
		`).run();

		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS star (
			star_id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			email_id INTEGER NOT NULL,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
		  )
		`).run();

		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS attachments (
			att_id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			email_id INTEGER NOT NULL,
			account_id INTEGER NOT NULL,
			key TEXT NOT NULL,
			filename TEXT,
			mime_type TEXT,
			size INTEGER,
			disposition TEXT,
			related TEXT,
			content_id TEXT,
			encoding TEXT,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
		  )
		`).run();

		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS user (
			user_id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL,
			type INTEGER DEFAULT 1 NOT NULL,
			password TEXT NOT NULL,
			salt TEXT NOT NULL,
			status INTEGER DEFAULT 0 NOT NULL,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
			active_time DATETIME,
			is_del INTEGER DEFAULT 0 NOT NULL
		  )
		`).run();

		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS account (
			account_id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL,
			status INTEGER DEFAULT 0 NOT NULL,
			latest_email_time DATETIME,
			create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
			user_id INTEGER NOT NULL,
			is_del INTEGER DEFAULT 0 NOT NULL
		  )
		`).run();

		await c.env.db.prepare(`
		  CREATE TABLE IF NOT EXISTS setting (
			register INTEGER NOT NULL,
			receive INTEGER NOT NULL,
			add_email INTEGER NOT NULL,
			many_email INTEGER NOT NULL,
			title TEXT NOT NULL,
			auto_refresh INTEGER NOT NULL,
			register_verify INTEGER NOT NULL,
			add_email_verify INTEGER NOT NULL,
			ai_code INTEGER NOT NULL DEFAULT 1,
			ai_code_filter TEXT NOT NULL DEFAULT ''
		  )
		`).run();

		await c.env.db.prepare(`
			  INSERT INTO setting (
				register, receive, add_email, many_email, title, auto_refresh, register_verify, add_email_verify
			  )
			  SELECT 0, 0, 0, 0, 'Cloud Mail', 0, 1, 1
			  WHERE NOT EXISTS (SELECT 1 FROM setting)
			`).run();

	},

	async receiveEmailToRecipient(c) {

		const receiveEmailColumn = await c.env.db.prepare(`SELECT * FROM pragma_table_info('email') WHERE name = 'receive_email' limit 1`).first();

		if (!receiveEmailColumn) {
			return
		}

		const queryList = []
		const {results} = await c.env.db.prepare('SELECT receive_email,email_id FROM email').all();
		results.forEach(emailRow => {
			const recipient = {}
			recipient.address = emailRow.receive_email
			recipient.name = ''
			const recipientStr = JSON.stringify([recipient]);
			const sql = c.env.db.prepare('UPDATE email SET recipient = ? WHERE email_id = ?').bind(recipientStr,emailRow.email_id);
			queryList.push(sql)
		})

		queryList.push(c.env.db.prepare("ALTER TABLE email DROP COLUMN receive_email"));

		await c.env.db.batch(queryList);
	},


	async initAccountName(c) {

		const nameColumn = await c.env.db.prepare(`SELECT * FROM pragma_table_info('account') WHERE name = 'name' limit 1`).first();

		if (nameColumn) {
			return
		}

		const queryList = []

		queryList.push(c.env.db.prepare(`ALTER TABLE account ADD COLUMN name TEXT NOT NULL DEFAULT ''`));

		const {results} = await c.env.db.prepare(`SELECT account_id, email FROM account`).all();

		results.forEach(accountRow => {
			const name = emailUtils.getName(accountRow.email);
			const sql = c.env.db.prepare('UPDATE account SET name = ? WHERE account_id = ?').bind(name,accountRow.account_id);
			queryList.push(sql)
		})

		await c.env.db.batch(queryList);
	}
};
export { dbInit };

function isIdempotentMigrationError(error) {
	return /duplicate column name:/i.test(error?.message || '');
}
