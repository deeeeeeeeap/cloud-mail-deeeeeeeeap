import { beforeEach, describe, expect, it, vi } from 'vitest';
import KvConst from '../src/const/kv-const';

const mocks = vi.hoisted(() => ({
	getSetting: vi.fn()
}));

vi.mock('../src/entity/orm', () => ({
	default: vi.fn(() => ({
		select: () => ({
			from: () => ({
				get: mocks.getSetting
			})
		})
	}))
}));

vi.mock('../src/service/verify-record-service', () => ({
	default: {
		selectListByIP: vi.fn(async () => [])
	}
}));

vi.mock('../src/service/r2-service', () => ({
	default: {
		storageType: vi.fn(async () => 'kv')
	}
}));

describe('setting service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
	});

	it('restores the settings KV cache from D1 when the cache is empty', async () => {
		const { default: settingService } = await import('../src/service/setting-service');
		const settingRow = {
			title: 'Cloud Mail',
			resendTokens: '{}',
			emailPrefixFilter: '',
			loginDomain: 0
		};
		const put = vi.fn(async () => {});
		const c = {
			env: {
				domain: '["589497.xyz"]',
				kv: {
					get: vi.fn(async () => null),
					put
				}
			},
			get: vi.fn(() => null),
			set: vi.fn()
		};

		mocks.getSetting.mockResolvedValueOnce(settingRow);

		const result = await settingService.query(c);

		expect(result.title).toBe('Cloud Mail');
		expect(result.domainList).toEqual(['@589497.xyz']);
		expect(result.resendTokens).toEqual({});
		expect(put).toHaveBeenCalledWith(KvConst.SETTING, expect.stringContaining('"title":"Cloud Mail"'));
	}, 15000);

	it('normalizes legacy settings read from KV cache', async () => {
		const { default: settingService } = await import('../src/service/setting-service');
		const c = {
			env: {
				domain: '["589497.xyz"]',
				kv: {
					get: vi.fn(async () => ({
						title: 'Cloud Mail',
						resendTokens: '{}',
						emailPrefixFilter: null,
						loginDomain: 0
					}))
				}
			},
			get: vi.fn(() => null),
			set: vi.fn()
		};

		const result = await settingService.query(c);

		expect(result.resendTokens).toEqual({});
		expect(result.emailPrefixFilter).toEqual([]);
		expect(result.domainList).toEqual(['@589497.xyz']);
	});

	it('falls back to D1 when the KV settings cache is malformed', async () => {
		const { default: settingService } = await import('../src/service/setting-service');
		const put = vi.fn(async () => {});
		const c = {
			env: {
				domain: '["589497.xyz"]',
				kv: {
					get: vi.fn(async () => ({
						title: 'Broken Cache',
						resendTokens: '{',
						emailPrefixFilter: '',
						loginDomain: 0
					})),
					put
				}
			},
			get: vi.fn(() => null),
			set: vi.fn()
		};

		mocks.getSetting.mockResolvedValueOnce({
			title: 'D1 Settings',
			resendTokens: '{}',
			emailPrefixFilter: '',
			loginDomain: 0
		});

		const result = await settingService.query(c);

		expect(result.title).toBe('D1 Settings');
		expect(put).toHaveBeenCalledWith(KvConst.SETTING, expect.stringContaining('"title":"D1 Settings"'));
	}, 15000);

	it('returns Turnstile configured flags without exposing the secret key', async () => {
		const { default: settingService } = await import('../src/service/setting-service');
		const c = {
			env: {
				domain: '["589497.xyz"]',
				kv: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {})
				}
			},
			get: vi.fn(() => null),
			set: vi.fn()
		};

		mocks.getSetting.mockResolvedValueOnce({
			title: 'Cloud Mail',
			resendTokens: '{}',
			emailPrefixFilter: '',
			loginDomain: 0,
			siteKey: '0x4AAAA_SITE',
			secretKey: '0x4AAAA_SECRET'
		});

		const result = await settingService.get(c);

		expect(result.siteKeyConfigured).toBe(true);
		expect(result.secretKeyConfigured).toBe(true);
		expect(result.siteKey).toBe('0x4AAA******');
		expect(result.secretKey).toBeNull();
		expect(JSON.stringify(result)).not.toContain('0x4AAAA_SECRET');
	});
});
