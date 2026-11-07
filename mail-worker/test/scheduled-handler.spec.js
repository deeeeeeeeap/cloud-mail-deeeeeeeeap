import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	clearRecord: vi.fn(),
	resetDaySendCount: vi.fn(),
	completeReceiveAll: vi.fn(),
	clearNoBindOathUser: vi.fn(),
	clearExpiredOAuthSecurity: vi.fn(),
	clearExpiredAuthFailures: vi.fn(),
	refreshEchartsCache: vi.fn(),
	clearStaleCodes: vi.fn(),
	reconcileDeliveryAttempts: vi.fn(),
	clearExpiredApiUsage: vi.fn()
}));

vi.mock('../src/service/api-key-service', () => ({
	default: { clearExpired: mocks.clearExpiredApiUsage }
}));

vi.mock('../src/service/verify-record-service', () => ({
	default: { clearRecord: mocks.clearRecord }
}));

vi.mock('../src/service/user-service', () => ({
	default: { resetDaySendCount: mocks.resetDaySendCount }
}));

vi.mock('../src/service/email-service', () => ({
	default: { completeReceiveAll: mocks.completeReceiveAll }
}));

vi.mock('../src/service/oauth-service', () => ({
	default: {
		clearNoBindOathUser: mocks.clearNoBindOathUser,
		clearExpiredOAuthSecurity: mocks.clearExpiredOAuthSecurity
	}
}));

vi.mock('../src/service/auth-rate-limit-service', () => ({
	default: { clearExpired: mocks.clearExpiredAuthFailures }
}));

vi.mock('../src/service/analysis-service', () => ({
	default: { refreshEchartsCache: mocks.refreshEchartsCache }
}));

vi.mock('../src/service/maintenance-service', () => ({
	default: { clearStaleCodes: mocks.clearStaleCodes }
}));

vi.mock('../src/service/delivery-attempt-service', () => ({
	default: { reconcile: mocks.reconcileDeliveryAttempts }
}));

const { default: worker } = await import('../src/index');

describe('scheduled handler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('recovers stale incoming mail without generating dashboard snapshots on the half-hour cron', async () => {
		await worker.scheduled({ cron: '*/30 * * * *' }, {}, {});

		expect(mocks.refreshEchartsCache).not.toHaveBeenCalled();
		expect(mocks.completeReceiveAll).toHaveBeenCalledWith({ env: {} }, { limit: 2 });
		expect(mocks.reconcileDeliveryAttempts).toHaveBeenCalledWith({ env: {} }, { limit: 2 });
		expect(mocks.clearExpiredAuthFailures).toHaveBeenCalledTimes(1);
		expect(mocks.clearExpiredOAuthSecurity).toHaveBeenCalledTimes(1);
		expect(mocks.clearRecord).not.toHaveBeenCalled();
		expect(mocks.resetDaySendCount).not.toHaveBeenCalled();
		expect(mocks.clearNoBindOathUser).not.toHaveBeenCalled();
		expect(mocks.clearStaleCodes).not.toHaveBeenCalled();
		expect(mocks.clearExpiredApiUsage).not.toHaveBeenCalled();
	});

	it('continues daily maintenance tasks after one task fails', async () => {
		mocks.clearRecord.mockRejectedValueOnce(new Error('kv unavailable'));

		await worker.scheduled({ cron: '0 0 * * *' }, {}, {});

		expect(mocks.clearRecord).toHaveBeenCalledTimes(1);
		expect(mocks.resetDaySendCount).toHaveBeenCalledTimes(1);
		expect(mocks.completeReceiveAll).toHaveBeenCalledWith({ env: {} }, { limit: 2 });
		expect(mocks.reconcileDeliveryAttempts).toHaveBeenCalledWith({ env: {} }, { limit: 2 });
		expect(mocks.clearNoBindOathUser).toHaveBeenCalledTimes(1);
		expect(mocks.clearExpiredAuthFailures).toHaveBeenCalledTimes(1);
		expect(mocks.clearExpiredApiUsage).toHaveBeenCalledTimes(1);
		expect(mocks.refreshEchartsCache).not.toHaveBeenCalled();
		expect(mocks.clearStaleCodes).not.toHaveBeenCalled();
	});

	it('runs expired code cleanup only when explicitly enabled', async () => {
		await worker.scheduled({ cron: '0 0 * * *' }, {
			code_clear_stale_cron: 'true',
			code_stale_minutes: '30'
		}, {});

		expect(mocks.clearStaleCodes).toHaveBeenCalledWith({
			env: {
				code_clear_stale_cron: 'true',
				code_stale_minutes: '30'
			}
		}, {
			staleMinutes: '30'
		});
	});
});
