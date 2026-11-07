import { afterEach, describe, expect, it, vi } from 'vitest';
import analysisService from '../src/service/analysis-service';
import analysisDao from '../src/dao/analysis-dao';

function createCacheContext(enabled = true) {
	let now = 0;
	const entries = new Map();
	const kv = {
		get: vi.fn(async (key, options) => {
			const entry = entries.get(key);
			if (!entry || entry.expires <= now) return null;
			return options?.type === 'json' ? JSON.parse(entry.value) : entry.value;
		}),
		put: vi.fn(async (key, value, { expirationTtl }) => {
			entries.set(key, { value, expires: now + expirationTtl * 1000 });
		})
	};
	return {
		c: { env: { analysis_cache: enabled, kv } },
		entries,
		advanceTo: value => { now = value; }
	};
}

function stubAggregates() {
	const numberCount = vi.spyOn(analysisDao, 'numberCount').mockResolvedValue({ users: 1 });
	const nameRatio = vi.spyOn(analysisService, 'nameRatio').mockResolvedValue([{ name: 'sender', total: 2 }]);
	vi.spyOn(analysisDao, 'userDayCount').mockResolvedValue([]);
	vi.spyOn(analysisDao, 'receiveDayCount').mockResolvedValue([]);
	vi.spyOn(analysisDao, 'sendDayCount').mockResolvedValue([]);
	const daySendTotal = vi.spyOn(analysisDao, 'daySendTotal').mockResolvedValue(0);
	return { numberCount, nameRatio, daySendTotal };
}

describe('on-demand analysis snapshots', () => {
	afterEach(() => vi.restoreAllMocks());

	it('reuses a timezone snapshot without querying or extending its expiry, then refreshes on demand', async () => {
		const { c, entries, advanceTo } = createCacheContext();
		const { numberCount, nameRatio } = stubAggregates();
		const first = await analysisService.echarts(c, { timeZone: 'Asia/Shanghai' });
		const cacheKey = analysisService.echartsCacheKey({ timeZone: 'Asia/Shanghai' });
		const expiry = entries.get(cacheKey).expires;
		expect(expiry).toBe(35 * 60 * 1000);

		advanceTo(expiry - 1);
		expect(await analysisService.echarts(c, { timeZone: ' asia/shanghai ' })).toEqual(first);
		expect(numberCount).toHaveBeenCalledTimes(1);
		expect(nameRatio).toHaveBeenCalledTimes(1);
		expect(entries.get(cacheKey).expires).toBe(expiry);

		advanceTo(expiry);
		numberCount.mockResolvedValue({ users: 2 });
		const refreshed = await analysisService.echarts(c, { timeZone: 'Asia/Shanghai' });
		expect(refreshed.numberCount).toEqual({ users: 2 });
		expect(numberCount).toHaveBeenCalledTimes(2);
		expect(nameRatio).toHaveBeenCalledTimes(2);
		expect(entries.size).toBe(1);
	});

	it('creates a fresh chart snapshot without inheriting an older nested count cache', async () => {
		const { c, entries } = createCacheContext();
		entries.set('analysis_number_count:', {
			value: JSON.stringify({ users: 0 }),
			expires: 35 * 60 * 1000
		});
		const { numberCount } = stubAggregates();

		const result = await analysisService.echarts(c, { timeZone: 'UTC' });

		expect(result.numberCount).toEqual({ users: 1 });
		expect(numberCount).toHaveBeenCalledTimes(1);
		expect(c.env.kv.put).toHaveBeenCalledTimes(1);
	});

	it('returns live aggregates when caching is disabled', async () => {
		const { c } = createCacheContext(false);
		const { numberCount, daySendTotal } = stubAggregates();
		await analysisService.echarts(c, { timeZone: 'UTC' });
		numberCount.mockResolvedValue({ users: 2 });
		daySendTotal.mockResolvedValue(3);

		const result = await analysisService.echarts(c, { timeZone: 'UTC' });
		expect(result.numberCount).toEqual({ users: 2 });
		expect(result.daySendTotal).toBe(3);
		expect(numberCount).toHaveBeenCalledTimes(2);
		expect(c.env.kv.put).not.toHaveBeenCalled();
		expect(c.env.kv.get).not.toHaveBeenCalled();
	});

	it.each([true, false])('falls back to UTC for invalid timezones with caching=%s', async enabled => {
		const { c } = createCacheContext(enabled);
		stubAggregates();
		const invalid = await analysisService.echarts(c, { timeZone: 'not-a-timezone' });
		const utc = await analysisService.echarts(c, { timeZone: 'UTC' });
		expect(invalid).toEqual(utc);
	});
});
