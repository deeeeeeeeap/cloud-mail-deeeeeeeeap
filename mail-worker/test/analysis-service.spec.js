import { afterEach, describe, expect, it, vi } from 'vitest';
import analysisService from '../src/service/analysis-service';

describe('analysis service cache refresh', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('paginates KV keys, reuses one numberCount snapshot, and isolates key refresh failures', async () => {
		const numberCount = { users: 1, receive: 2, send: 3 };
		const list = vi.fn()
			.mockResolvedValueOnce({
				keys: [{ name: 'analysis_echarts:UTC' }, { name: 'analysis_echarts:Asia%2FShanghai' }],
				list_complete: false,
				cursor: 'next-page'
			})
			.mockResolvedValueOnce({
				keys: [{ name: 'analysis_echarts:Europe%2FLondon' }],
				list_complete: true
			});
		const c = {
			env: {
				analysis_cache: 'true',
				kv: { list }
			}
		};
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const refreshNumberCountCache = vi.spyOn(analysisService, 'refreshNumberCountCache')
			.mockResolvedValue(numberCount);
		const refreshEchartsCacheByKey = vi.spyOn(analysisService, 'refreshEchartsCacheByKey')
			.mockImplementation(async (_c, key) => {
				if (key === 'analysis_echarts:Asia%2FShanghai') {
					throw new Error('refresh failed');
				}
			});

		await analysisService.refreshEchartsCache(c);

		expect(refreshNumberCountCache).toHaveBeenCalledTimes(1);
		expect(list).toHaveBeenNthCalledWith(1, { prefix: 'analysis_echarts:', cursor: undefined });
		expect(list).toHaveBeenNthCalledWith(2, { prefix: 'analysis_echarts:', cursor: 'next-page' });
		expect(refreshEchartsCacheByKey).toHaveBeenCalledTimes(3);
		expect(refreshEchartsCacheByKey.mock.calls.every(call => call[2].numberCount === numberCount)).toBe(true);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});
});
