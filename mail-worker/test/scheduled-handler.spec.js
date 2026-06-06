import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	clearRecord: vi.fn(),
	resetDaySendCount: vi.fn(),
	completeReceiveAll: vi.fn(),
	clearNoBindOathUser: vi.fn(),
	refreshEchartsCache: vi.fn()
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
	default: { clearNoBindOathUser: mocks.clearNoBindOathUser }
}));

vi.mock('../src/service/analysis-service', () => ({
	default: { refreshEchartsCache: mocks.refreshEchartsCache }
}));

const { default: worker } = await import('../src/index');

describe('scheduled handler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('runs only analysis cache refresh for the half-hour cron', async () => {
		await worker.scheduled({ cron: '*/30 * * * *' }, {}, {});

		expect(mocks.refreshEchartsCache).toHaveBeenCalledTimes(1);
		expect(mocks.clearRecord).not.toHaveBeenCalled();
		expect(mocks.resetDaySendCount).not.toHaveBeenCalled();
		expect(mocks.completeReceiveAll).not.toHaveBeenCalled();
		expect(mocks.clearNoBindOathUser).not.toHaveBeenCalled();
	});

	it('continues daily maintenance tasks after one task fails', async () => {
		mocks.clearRecord.mockRejectedValueOnce(new Error('kv unavailable'));

		await worker.scheduled({ cron: '0 0 * * *' }, {}, {});

		expect(mocks.clearRecord).toHaveBeenCalledTimes(1);
		expect(mocks.resetDaySendCount).toHaveBeenCalledTimes(1);
		expect(mocks.completeReceiveAll).toHaveBeenCalledTimes(1);
		expect(mocks.clearNoBindOathUser).toHaveBeenCalledTimes(1);
		expect(mocks.refreshEchartsCache).toHaveBeenCalledTimes(1);
	});
});
