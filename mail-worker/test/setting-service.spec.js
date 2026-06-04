import { describe, expect, it, vi } from 'vitest';
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

describe('setting service', () => {
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
});
