import BizError from '../error/biz-error';
import { emailConst } from '../const/entity-const';
import emailSearchService from './email-search-service';

export const deliveryAttemptConst = Object.freeze({
	provider: Object.freeze({
		CLOUDFLARE_EMAIL: 'CLOUDFLARE_EMAIL',
		RESEND: 'RESEND'
	}),
	status: Object.freeze({
		PREPARED: 'PREPARED',
		IN_FLIGHT: 'IN_FLIGHT',
		PENDING_ACK: 'PENDING_ACK',
		ACCEPTED: 'ACCEPTED',
		FAILED: 'FAILED',
		UNKNOWN: 'UNKNOWN'
	})
});

const VALID_PROVIDERS = new Set(Object.values(deliveryAttemptConst.provider));
const UNRESOLVED_STATUSES = new Set([
	deliveryAttemptConst.status.PREPARED,
	deliveryAttemptConst.status.IN_FLIGHT,
	deliveryAttemptConst.status.PENDING_ACK,
	deliveryAttemptConst.status.UNKNOWN
]);
const DEFAULT_RECONCILE_LIMIT = 4;

function createAttemptKey(emailId) {
	return `cloud-mail/${emailId}/${crypto.randomUUID()}`;
}

async function transition(c, {
	attemptId,
	fromStatus,
	toStatus,
	providerMessageId = null,
	errorSummary = null
}) {
	const row = await c.env.db.prepare(`
		UPDATE delivery_attempt
		SET status = ?,
			provider_message_id = ?,
			error_summary = ?,
			update_time = CURRENT_TIMESTAMP
		WHERE attempt_id = ? AND status = ?
		RETURNING
			attempt_id AS attemptId,
			email_id AS emailId,
			provider,
			attempt_key AS attemptKey,
			status,
			provider_message_id AS providerMessageId,
			error_summary AS errorSummary,
			create_time AS createTime,
			update_time AS updateTime
	`).bind(
		toStatus,
		providerMessageId,
		errorSummary,
		attemptId,
		fromStatus
	).first();
	if (!row) {
		throw new BizError('Delivery attempt state conflict', 409);
	}
	return row;
}

const deliveryAttemptService = {
	async prepare(c, { emailId, provider, attemptKey }) {
		const normalizedEmailId = Number(emailId);
		if (!Number.isInteger(normalizedEmailId) || normalizedEmailId <= 0) {
			throw new BizError('Invalid delivery email id', 400);
		}
		if (!VALID_PROVIDERS.has(provider)) {
			throw new BizError('Invalid delivery provider', 400);
		}

		const stableKey = attemptKey || createAttemptKey(normalizedEmailId);
		if (typeof stableKey !== 'string' || stableKey.length === 0 || stableKey.length > 256) {
			throw new BizError('Invalid delivery attempt key', 400);
		}

		return await c.env.db.prepare(`
			INSERT INTO delivery_attempt (
				email_id,
				provider,
				attempt_key,
				status
			) VALUES (?, ?, ?, ?)
			RETURNING
				attempt_id AS attemptId,
				email_id AS emailId,
				provider,
				attempt_key AS attemptKey,
				status,
				provider_message_id AS providerMessageId,
				error_summary AS errorSummary,
				create_time AS createTime,
				update_time AS updateTime
		`).bind(
			normalizedEmailId,
			provider,
			stableKey,
			deliveryAttemptConst.status.PREPARED
		).first();
	},

	async markInFlight(c, attemptId) {
		return await transition(c, {
			attemptId,
			fromStatus: deliveryAttemptConst.status.PREPARED,
			toStatus: deliveryAttemptConst.status.IN_FLIGHT
		});
	},

	async markAccepted(c, attemptId, providerMessageId = null) {
		return await transition(c, {
			attemptId,
			fromStatus: deliveryAttemptConst.status.IN_FLIGHT,
			toStatus: deliveryAttemptConst.status.ACCEPTED,
			providerMessageId
		});
	},

	async markPendingAck(c, attemptId, providerMessageId = null) {
		return await transition(c, {
			attemptId,
			fromStatus: deliveryAttemptConst.status.IN_FLIGHT,
			toStatus: deliveryAttemptConst.status.PENDING_ACK,
			providerMessageId,
			errorSummary: 'ACCEPTED_STATE_WRITE_FAILED'
		});
	},

	async markPreparationFailed(c, attemptId, errorSummary = 'LOCAL_PREPARATION_FAILED') {
		return await transition(c, {
			attemptId,
			fromStatus: deliveryAttemptConst.status.PREPARED,
			toStatus: deliveryAttemptConst.status.FAILED,
			errorSummary
		});
	},

	async markUnknown(c, attemptId, errorSummary = 'PROVIDER_CALL_UNCERTAIN') {
		return await transition(c, {
			attemptId,
			fromStatus: deliveryAttemptConst.status.IN_FLIGHT,
			toStatus: deliveryAttemptConst.status.UNKNOWN,
			errorSummary
		});
	},

	async markFailed(c, attemptId, errorSummary = 'PROVIDER_REJECTED') {
		return await transition(c, {
			attemptId,
			fromStatus: deliveryAttemptConst.status.IN_FLIGHT,
			toStatus: deliveryAttemptConst.status.FAILED,
			errorSummary
		});
	},

	async health(c) {
		const { results = [] } = await c.env.db.prepare(`
			SELECT status, COUNT(*) AS total
			FROM delivery_attempt
			GROUP BY status
		`).all();
		const counts = Object.fromEntries(
			Object.values(deliveryAttemptConst.status).map(status => [status, 0])
		);
		let total = 0;
		let unresolved = 0;
		for (const row of results) {
			const count = Number(row.total || 0);
			counts[row.status] = count;
			total += count;
			if (UNRESOLVED_STATUSES.has(row.status)) {
				unresolved += count;
			}
		}
		return { total, unresolved, counts };
	},

	async reconcile(c, { limit = DEFAULT_RECONCILE_LIMIT, staleMinutes = 10 } = {}) {
		const batchLimit = Math.max(1, Math.min(
			Number(limit) || DEFAULT_RECONCILE_LIMIT,
			20
		));
		const staleAge = Math.max(1, Math.min(Number(staleMinutes) || 10, 24 * 60));
		const { results: staleAttempts = [] } = await c.env.db.prepare(`
			SELECT
				da.attempt_id AS attemptId,
				da.email_id AS emailId,
				da.status,
				da.provider_message_id AS providerMessageId,
				e.status AS emailStatus,
				e.resend_email_id AS emailProviderMessageId
			FROM delivery_attempt da
			LEFT JOIN email e ON e.email_id = da.email_id AND e.type = ?
			WHERE da.status IN (?, ?)
			  AND da.update_time <= datetime('now', ?)
			ORDER BY da.attempt_id
			LIMIT ${batchLimit}
		`).bind(
			emailConst.type.SEND,
			deliveryAttemptConst.status.PREPARED,
			deliveryAttemptConst.status.IN_FLIGHT,
			`-${staleAge} minutes`
		).all();

		let unknown = 0;
		let failed = 0;
		let repaired = 0;
		const changedEmailIds = new Set();
		for (const attempt of staleAttempts) {
			if (attempt.status === deliveryAttemptConst.status.PREPARED) {
				const result = await c.env.db.prepare(`
					UPDATE delivery_attempt
					SET status = ?, error_summary = ?, update_time = CURRENT_TIMESTAMP
					WHERE attempt_id = ? AND status = ?
				`).bind(
					deliveryAttemptConst.status.FAILED,
					'ATTEMPT_NOT_STARTED',
					attempt.attemptId,
					deliveryAttemptConst.status.PREPARED
				).run();
				if (Number(result?.meta?.changes || 0) !== 1) {
					continue;
				}
				failed += 1;
				const emailResult = await c.env.db.prepare(`
					UPDATE email
					SET status = ?, message = ?
					WHERE email_id = ? AND type = ? AND status = ?
				`).bind(
					emailConst.status.FAILED,
					'DELIVERY_ATTEMPT_NOT_STARTED',
					attempt.emailId,
					emailConst.type.SEND,
					emailConst.status.SAVING
				).run();
				if (Number(emailResult?.meta?.changes || 0) === 1) {
					changedEmailIds.add(attempt.emailId);
				}
				continue;
			}
			if (attempt.status !== deliveryAttemptConst.status.IN_FLIGHT) {
				continue;
			}
			const acceptedProviderMessageId = attempt.providerMessageId
				|| attempt.emailProviderMessageId;
			if (acceptedProviderMessageId
				&& Number(attempt.emailStatus) !== emailConst.status.SAVING) {
				const result = await c.env.db.prepare(`
					UPDATE delivery_attempt
					SET status = ?,
						provider_message_id = ?,
						error_summary = NULL,
						update_time = CURRENT_TIMESTAMP
					WHERE attempt_id = ? AND status = ?
				`).bind(
					deliveryAttemptConst.status.ACCEPTED,
					acceptedProviderMessageId,
					attempt.attemptId,
					deliveryAttemptConst.status.IN_FLIGHT
				).run();
				if (Number(result?.meta?.changes || 0) === 1) {
					repaired += 1;
					changedEmailIds.add(attempt.emailId);
				}
				continue;
			}
			const result = await c.env.db.prepare(`
				UPDATE delivery_attempt
				SET status = ?, error_summary = ?, update_time = CURRENT_TIMESTAMP
				WHERE attempt_id = ? AND status = ?
			`).bind(
				deliveryAttemptConst.status.UNKNOWN,
				'PROVIDER_OUTCOME_UNKNOWN',
				attempt.attemptId,
				deliveryAttemptConst.status.IN_FLIGHT
			).run();
			if (Number(result?.meta?.changes || 0) !== 1) {
				continue;
			}
			unknown += 1;
			await c.env.db.prepare(`
				UPDATE email
				SET message = ?
				WHERE email_id = ? AND type = ? AND status = ?
			`).bind(
				'DELIVERY_OUTCOME_UNKNOWN',
				attempt.emailId,
				emailConst.type.SEND,
				emailConst.status.SAVING
			).run();
		}

		// 三段各自持有 batchLimit，不再共用一份额度：共用时只要每轮都有 batchLimit 条 stale 记录，
		// 后两段就恒定分到 0，PENDING_ACK 转正和有证据的 UNKNOWN 收敛会被无限期饿死
		// CROSS JOIN 固定每个分支的驱动表：PENDING_ACK 从状态索引取，ACCEPTED/FAILED 只从仍为 SAVING 的发件取；
		// 原来的 OR 写法每轮都会遍历全部发件
		const { results: attempts = [] } = await c.env.db.prepare(`
			SELECT * FROM (
				SELECT
					da.attempt_id AS attemptId,
					da.email_id AS emailId,
					da.provider,
					da.status,
					da.provider_message_id AS providerMessageId,
					e.status AS emailStatus
				FROM delivery_attempt da
				CROSS JOIN email e ON e.email_id = da.email_id AND e.type = ?
				WHERE da.status = ?
				UNION ALL
				SELECT da.attempt_id, da.email_id, da.provider, da.status, da.provider_message_id, e.status
				FROM email e
				CROSS JOIN delivery_attempt da ON da.email_id = e.email_id
				WHERE e.type = ? AND e.status = ? AND da.status IN (?, ?)
			)
			ORDER BY attemptId
			LIMIT ${batchLimit}
		`).bind(
			emailConst.type.SEND,
			deliveryAttemptConst.status.PENDING_ACK,
			emailConst.type.SEND,
			emailConst.status.SAVING,
			deliveryAttemptConst.status.ACCEPTED,
			deliveryAttemptConst.status.FAILED
		).all();

		for (const attempt of attempts) {
			if (attempt.status === deliveryAttemptConst.status.FAILED) {
				const emailResult = await c.env.db.prepare(`
					UPDATE email
					SET status = ?, message = ?
					WHERE email_id = ? AND type = ? AND status = ?
				`).bind(
					emailConst.status.FAILED,
					'DELIVERY_PROVIDER_REJECTED',
					attempt.emailId,
					emailConst.type.SEND,
					emailConst.status.SAVING
				).run();
				if (Number(emailResult?.meta?.changes || 0) === 1) {
					repaired += 1;
					changedEmailIds.add(attempt.emailId);
				}
				continue;
			}
			let changed = false;
			if (attempt.status === deliveryAttemptConst.status.PENDING_ACK) {
				const transitionResult = await c.env.db.prepare(`
					UPDATE delivery_attempt
					SET status = ?, error_summary = NULL, update_time = CURRENT_TIMESTAMP
					WHERE attempt_id = ? AND status = ?
				`).bind(
					deliveryAttemptConst.status.ACCEPTED,
					attempt.attemptId,
					deliveryAttemptConst.status.PENDING_ACK
				).run();
				if (Number(transitionResult?.meta?.changes || 0) !== 1) {
					continue;
				}
				changed = true;
			}

			const targetStatus = attempt.provider === deliveryAttemptConst.provider.CLOUDFLARE_EMAIL
				? emailConst.status.DELIVERED
				: emailConst.status.SENT;
			const emailResult = await c.env.db.prepare(`
				UPDATE email
				SET status = ?, resend_email_id = ?, message = NULL
				WHERE email_id = ? AND type = ? AND status = ?
			`).bind(
				targetStatus,
				attempt.providerMessageId,
				attempt.emailId,
				emailConst.type.SEND,
				emailConst.status.SAVING
			).run();
			if (Number(emailResult?.meta?.changes || 0) === 1) {
				changed = true;
				changedEmailIds.add(attempt.emailId);
			}
			if (changed) {
				repaired += 1;
				changedEmailIds.add(attempt.emailId);
			}
		}
		// 有 webhook 证据的 UNKNOWN 自动收敛：邮件状态已被回调推进（非 SAVING/FAILED），
		// 或已记录 provider message id，说明供应商实际接受过这次投递。
		const { results: unknownAttempts = [] } = await c.env.db.prepare(`
			SELECT
				da.attempt_id AS attemptId,
				da.email_id AS emailId,
				da.provider,
				da.provider_message_id AS providerMessageId,
				e.status AS emailStatus,
				e.resend_email_id AS emailProviderMessageId
			FROM delivery_attempt da
			JOIN email e ON e.email_id = da.email_id AND e.type = ?
			WHERE da.status = ?
			  AND (e.status NOT IN (?, ?) OR e.resend_email_id IS NOT NULL)
			ORDER BY da.attempt_id
			LIMIT ${batchLimit}
		`).bind(
			emailConst.type.SEND,
			deliveryAttemptConst.status.UNKNOWN,
			emailConst.status.SAVING,
			emailConst.status.FAILED
		).all();

		for (const attempt of unknownAttempts) {
			const evidenceMessageId = attempt.providerMessageId || attempt.emailProviderMessageId || null;
			const transitionResult = await c.env.db.prepare(`
				UPDATE delivery_attempt
				SET status = ?, provider_message_id = ?, error_summary = NULL, update_time = CURRENT_TIMESTAMP
				WHERE attempt_id = ? AND status = ?
			`).bind(
				deliveryAttemptConst.status.ACCEPTED,
				evidenceMessageId,
				attempt.attemptId,
				deliveryAttemptConst.status.UNKNOWN
			).run();
			if (Number(transitionResult?.meta?.changes || 0) !== 1) {
				continue;
			}
			repaired += 1;
			changedEmailIds.add(attempt.emailId);
			if (Number(attempt.emailStatus) === emailConst.status.SAVING) {
				const evidenceTarget = attempt.provider === deliveryAttemptConst.provider.CLOUDFLARE_EMAIL
					? emailConst.status.DELIVERED
					: emailConst.status.SENT;
				await c.env.db.prepare(`
					UPDATE email
					SET status = ?, message = NULL
					WHERE email_id = ? AND type = ? AND status = ?
				`).bind(
					evidenceTarget,
					attempt.emailId,
					emailConst.type.SEND,
					emailConst.status.SAVING
				).run();
			}
		}

		if (changedEmailIds.size > 0) {
			try {
				await emailSearchService.syncEmailIds(c, [...changedEmailIds]);
			} catch {
				// The authoritative email rows are repaired; search can be rebuilt separately.
			}
		}

		return {
			scanned: staleAttempts.length + attempts.length + unknownAttempts.length,
			repaired,
			unknown,
			failed
		};
	},

	// 管理员人工判定：把 UNKNOWN 投递统一改为已发（accepted）或失败（failed）。
	// 只在管理员已于供应商后台核实真实结果后使用；判为失败后发件人可重发。
	async resolveUnknown(c, { outcome, limit = 50 } = {}) {
		if (outcome !== 'accepted' && outcome !== 'failed') {
			throw new BizError('Invalid unknown-delivery outcome', 400);
		}
		const batchLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
		const { results: attempts = [] } = await c.env.db.prepare(`
			SELECT
				da.attempt_id AS attemptId,
				da.email_id AS emailId,
				da.provider,
				da.provider_message_id AS providerMessageId,
				e.status AS emailStatus
			FROM delivery_attempt da
			LEFT JOIN email e ON e.email_id = da.email_id AND e.type = ?
			WHERE da.status = ?
			ORDER BY da.attempt_id
			LIMIT ${batchLimit}
		`).bind(
			emailConst.type.SEND,
			deliveryAttemptConst.status.UNKNOWN
		).all();

		let resolved = 0;
		const changedEmailIds = new Set();
		for (const attempt of attempts) {
			const toStatus = outcome === 'accepted'
				? deliveryAttemptConst.status.ACCEPTED
				: deliveryAttemptConst.status.FAILED;
			const errorSummary = outcome === 'accepted' ? 'MANUALLY_MARKED_ACCEPTED' : 'MANUALLY_MARKED_FAILED';
			const result = await c.env.db.prepare(`
				UPDATE delivery_attempt
				SET status = ?, error_summary = ?, update_time = CURRENT_TIMESTAMP
				WHERE attempt_id = ? AND status = ?
			`).bind(
				toStatus,
				errorSummary,
				attempt.attemptId,
				deliveryAttemptConst.status.UNKNOWN
			).run();
			if (Number(result?.meta?.changes || 0) !== 1) {
				continue;
			}
			resolved += 1;
			if (Number(attempt.emailStatus) !== emailConst.status.SAVING) {
				continue;
			}
			if (outcome === 'accepted') {
				const targetStatus = attempt.provider === deliveryAttemptConst.provider.CLOUDFLARE_EMAIL
					? emailConst.status.DELIVERED
					: emailConst.status.SENT;
				const emailResult = await c.env.db.prepare(`
					UPDATE email
					SET status = ?, resend_email_id = COALESCE(?, resend_email_id), message = ?
					WHERE email_id = ? AND type = ? AND status = ?
				`).bind(
					targetStatus,
					attempt.providerMessageId,
					'MANUALLY_MARKED_ACCEPTED',
					attempt.emailId,
					emailConst.type.SEND,
					emailConst.status.SAVING
				).run();
				if (Number(emailResult?.meta?.changes || 0) === 1) {
					changedEmailIds.add(attempt.emailId);
				}
			} else {
				const emailResult = await c.env.db.prepare(`
					UPDATE email
					SET status = ?, message = ?
					WHERE email_id = ? AND type = ? AND status = ?
				`).bind(
					emailConst.status.FAILED,
					'DELIVERY_MANUALLY_MARKED_FAILED',
					attempt.emailId,
					emailConst.type.SEND,
					emailConst.status.SAVING
				).run();
				if (Number(emailResult?.meta?.changes || 0) === 1) {
					changedEmailIds.add(attempt.emailId);
				}
			}
		}
		if (changedEmailIds.size > 0) {
			try {
				await emailSearchService.syncEmailIds(c, [...changedEmailIds]);
			} catch {
				// The authoritative email rows are updated; search can be rebuilt separately.
			}
		}

		return { outcome, scanned: attempts.length, resolved };
	}
};

export default deliveryAttemptService;
